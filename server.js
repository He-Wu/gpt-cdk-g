const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = /^(1|true)$/i.test(process.env.TRUST_PROXY || '');

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// ========== 配置 ==========
// 初始密码：从环境变量读取（后台修改后存入 settings.json，重启仍有效）
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';

// ========== JSON 文件存储 ==========
const DATA_DIR = path.join(__dirname, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const COST_RECORDS_FILE = path.join(DATA_DIR, 'cost-records.json');
const CARD_TYPES = ['plus', 'plus_1y', 'pro', 'pro_20x'];
const COST_RECORD_KINDS = ['purchase', 'loss', 'adjustment'];
const DEFAULT_COMPENSATION_REASON = '充值未到账补卡';
const JOB_RECONCILE_INTERVAL_MS = 10000;
const JOB_RECONCILE_BATCH_SIZE = 100;
const JOB_RECONCILE_CONCURRENCY = 10;
const MANUAL_REVIEW_RECONCILE_WINDOW_MS = 60 * 60 * 1000;
const SUBMIT_TLS_MAX_ATTEMPTS = 5;
const TLS_SUBMIT_RETRY_CODES = new Set(['ERR_SSL_INVALID_SESSION_ID']);

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function createDefaultTypedMaintenance() {
  return Object.fromEntries(CARD_TYPES.map((type) => [type, { enabled: false, message: '' }]));
}

function normalizeTypedMaintenanceConfig(raw) {
  const next = createDefaultTypedMaintenance();
  if (!raw || typeof raw !== 'object') return next;
  for (const type of CARD_TYPES) {
    const current = raw[type];
    if (!current || typeof current !== 'object') continue;
    next[type] = {
      enabled: current.enabled === true,
      message: typeof current.message === 'string' ? current.message.trim().slice(0, 500) : ''
    };
  }
  return next;
}

function normalizeUserNotice(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: source.enabled === true,
    zhTitle: String(source.zhTitle || '').trim().slice(0, 80),
    zhBody: String(source.zhBody || '').trim().slice(0, 1200),
    enTitle: String(source.enTitle || '').trim().slice(0, 80),
    enBody: String(source.enBody || '').trim().slice(0, 1200)
  };
}

function normalizeChannelName(value) {
  return String(value || '').trim().slice(0, 40);
}

function normalizeMoneyAmount(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount < 0) return null;
  return Math.round(amount * 100) / 100;
}

function normalizeQuantity(value, fallback = null) {
  if (value === undefined || value === null || value === '') return fallback;
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return Math.round(amount * 10000) / 10000;
}

function normalizeDefaultCost(value) {
  return normalizeMoneyAmount(value, 10) ?? 10;
}

function normalizeCardRemark(value) {
  return String(value || '').trim().slice(0, 200);
}

function normalizeCostRecordKind(value) {
  const normalized = String(value || 'purchase').trim().toLowerCase();
  return COST_RECORD_KINDS.includes(normalized) ? normalized : null;
}

function normalizeMaintenanceMessages(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  return {
    zh: String(source.zh || source.messageZh || source.maintenanceMessageZh || source.maintenanceMessage || '').trim().slice(0, 500),
    en: String(source.en || source.messageEn || source.maintenanceMessageEn || '').trim().slice(0, 500)
  };
}

// ========== 设置管理（API Key / Base URL 在后台配置）==========
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      if (!Array.isArray(parsed.subAdmins)) parsed.subAdmins = [];
      parsed.typedMaintenance = normalizeTypedMaintenanceConfig(parsed.typedMaintenance);
      parsed.userNotice = normalizeUserNotice(parsed.userNotice);
      parsed.channelName = normalizeChannelName(parsed.channelName);
      parsed.defaultCost = normalizeDefaultCost(parsed.defaultCost);
      const maintenanceMessages = normalizeMaintenanceMessages(parsed);
      parsed.maintenanceMessageZh = maintenanceMessages.zh;
      parsed.maintenanceMessageEn = maintenanceMessages.en;
      parsed.maintenanceMessage = maintenanceMessages.zh;
      return parsed;
    }
  } catch (e) {
    console.error('加载设置失败:', e.message);
  }
  return { 
    apiKey: '', 
    baseUrl: '', 
    maintenanceEnabled: false, 
    maintenanceMessage: '',
    maintenanceMessageZh: '',
    maintenanceMessageEn: '',
    typedMaintenance: createDefaultTypedMaintenance(),
    userNotice: normalizeUserNotice(),
    channelName: '',
    defaultCost: 10,
    subAdmins: []
  };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// 运行时设置对象（动态，无需重启）
let settings = loadSettings();

// 初始化时如果 settings 中没有密码，写入初始密码
if (!settings.adminPassword) {
  settings.adminPassword = INITIAL_ADMIN_PASSWORD || crypto.randomBytes(18).toString('base64url');
  saveSettings(settings);
  if (!INITIAL_ADMIN_PASSWORD) {
    console.warn('⚠️ 未设置 ADMIN_PASSWORD，已自动生成临时管理员密码并保存到 data/settings.json，请登录后尽快修改。');
    console.warn(`⚠️ 临时管理员密码: ${settings.adminPassword}`);
  }
}

function getAdminPassword() { return settings.adminPassword || INITIAL_ADMIN_PASSWORD; }
function getApiKey() { return settings.apiKey || ''; }
function getBaseUrl() { return settings.baseUrl || ''; }
function isMaintenanceEnabled() { return settings.maintenanceEnabled === true; }
function getMaintenanceMessages() {
  const normalized = normalizeMaintenanceMessages(settings);
  settings.maintenanceMessageZh = normalized.zh;
  settings.maintenanceMessageEn = normalized.en;
  settings.maintenanceMessage = normalized.zh;
  return {
    zh: normalized.zh || '系统正在维护中，请稍后再试。',
    en: normalized.en || 'The system is being upgraded. Please come back later.'
  };
}
function getMaintenanceMessage() { return getMaintenanceMessages().zh; }
function getUserNotice() {
  settings.userNotice = normalizeUserNotice(settings.userNotice);
  return settings.userNotice;
}
function getChannelName() {
  settings.channelName = normalizeChannelName(settings.channelName);
  return settings.channelName;
}
function getDefaultCost() {
  settings.defaultCost = normalizeDefaultCost(settings.defaultCost);
  return settings.defaultCost;
}

function getTypedMaintenance() {
  settings.typedMaintenance = normalizeTypedMaintenanceConfig(settings.typedMaintenance);
  return settings.typedMaintenance;
}
function getTypeMaintenance(type) {
  return getTypedMaintenance()[type] || { enabled: false, message: '' };
}
function getTypeMaintenanceBlock(type) {
  const current = getTypeMaintenance(type);
  if (!current.enabled) return null;
  const detail = current.message ? ` ${current.message}` : '';
  return {
    error: `当前卡种维护中，暂不可兑换；其他卡种可正常使用。${detail}`.trim(),
    maintenance: true,
    maintenance_scope: 'type',
    type,
    maintenance_message: current.message || ''
  };
}

function getMaintenanceBlockForCode(code) {
  if (!code || typeof code !== 'string') return null;
  const cardCode = normalizeCardCode(code);
  const card = cards.find((item) => item.code === cardCode && item.status === 'unused');
  if (!card) return null;
  return getTypeMaintenanceBlock(card.type);
}

function getSubAdmins() {
  if (!Array.isArray(settings.subAdmins)) settings.subAdmins = [];
  return settings.subAdmins;
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function sanitizeSubAdmin(subAdmin) {
  if (!subAdmin) return null;
  return {
    id: subAdmin.id,
    username: subAdmin.username,
    status: subAdmin.status || 'active',
    created_at: subAdmin.created_at || null
  };
}

function hashPassword(password) {
  const raw = String(password || '');
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(raw, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, storedHash) {
  const value = String(storedHash || '');
  if (!value) return false;
  if (value.startsWith('plain:')) {
    return String(password || '') === value.slice(6);
  }
  const [salt, hash] = value.split(':');
  if (!salt || !hash) return false;
  const actual = crypto.scryptSync(String(password || ''), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function buildViewer(session) {
  const role = session?.role || 'super_admin';
  const isSuperAdmin = role === 'super_admin';
  return {
    role,
    username: session?.username || (isSuperAdmin ? 'super_admin' : null),
    impersonatedBy: session?.impersonatedBy || null,
    defaultCost: getDefaultCost(),
    permissions: {
      manage_settings: isSuperAdmin,
      manage_accounts: isSuperAdmin,
      manage_cards: true,
      generate_cards: true,
      view_all_cards: isSuperAdmin,
      view_all_records: isSuperAdmin
    }
  };
}

// ========== 公开状态接口 ==========
// 前端页面加载时查询维护模式状态
app.get('/api/status', (req, res) => {
  res.json({
    maintenance: isMaintenanceEnabled(),
    message: isMaintenanceEnabled() ? getMaintenanceMessage() : null,
    maintenanceMessages: isMaintenanceEnabled() ? getMaintenanceMessages() : null,
    userNotice: getUserNotice(),
    channelName: getChannelName()
  });
});

// 加载数据
function loadCards() {
  try {
    if (fs.existsSync(CARDS_FILE)) {
      return JSON.parse(fs.readFileSync(CARDS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载卡密数据失败:', e.message);
  }
  return [];
}

function saveCards(cards) {
  fs.writeFileSync(CARDS_FILE, JSON.stringify(cards, null, 2), 'utf-8');
}

function loadRecords() {
  try {
    if (fs.existsSync(RECORDS_FILE)) {
      return JSON.parse(fs.readFileSync(RECORDS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载记录数据失败:', e.message);
  }
  return [];
}

function saveRecords(records) {
  fs.writeFileSync(RECORDS_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

function normalizeCostRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const recordType = normalizeCostRecordKind(raw.record_type ?? raw.recordType ?? raw.kind);
  const cardType = String(raw.card_type ?? raw.cardType ?? raw.type ?? '').trim();
  const quantity = normalizeQuantity(raw.quantity ?? raw.count, null);
  const totalCost = normalizeMoneyAmount(raw.total_cost ?? raw.totalCost ?? raw.cost, null);
  if (!recordType || !CARD_TYPES.includes(cardType) || quantity === null || totalCost === null) {
    return null;
  }
  return {
    id: String(raw.id || uuidv4()),
    record_type: recordType,
    card_type: cardType,
    quantity,
    total_cost: totalCost,
    unit_cost: normalizeMoneyAmount(raw.unit_cost ?? raw.unitCost, totalCost / quantity),
    supplier: String(raw.supplier || '').trim().slice(0, 80),
    remark: normalizeCardRemark(raw.remark ?? raw.note),
    created_at: raw.created_at || nowStr(),
    created_by_username: raw.created_by_username || 'super_admin',
    created_by_role: raw.created_by_role || 'super_admin'
  };
}

function loadCostRecords() {
  try {
    if (fs.existsSync(COST_RECORDS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(COST_RECORDS_FILE, 'utf-8'));
      if (!Array.isArray(parsed)) return [];
      return parsed.map(normalizeCostRecord).filter(Boolean);
    }
  } catch (e) {
    console.error('加载成本记录失败:', e.message);
  }
  return [];
}

function saveCostRecords(records) {
  fs.writeFileSync(COST_RECORDS_FILE, JSON.stringify(records, null, 2), 'utf-8');
}

// 内存缓存 + 文件持久化
let cards = loadCards();
let records = loadRecords();
let costRecords = loadCostRecords();

function buildCostSummary() {
  const roundMoney = (value) => Math.round((Number(value) || 0) * 100) / 100;
  const byType = {};
  for (const type of CARD_TYPES) {
    byType[type] = {
      type,
      purchase_quantity: 0,
      purchase_cost: 0,
      loss_quantity: 0,
      loss_cost: 0,
      adjustment_quantity: 0,
      adjustment_cost: 0,
      issued_quantity: 0,
      issued_cost: 0,
      remaining_quantity: 0,
      remaining_cost: 0,
      purchase_average_cost: null,
      current_average_cost: getDefaultCost()
    };
  }

  for (const record of costRecords) {
    const bucket = byType[record.card_type];
    if (!bucket) continue;
    const quantity = Number(record.quantity) || 0;
    const totalCost = Number(record.total_cost) || 0;
    if (record.record_type === 'purchase') {
      bucket.purchase_quantity += quantity;
      bucket.purchase_cost += totalCost;
    } else if (record.record_type === 'loss') {
      bucket.loss_quantity += quantity;
      bucket.loss_cost += totalCost;
    } else if (record.record_type === 'adjustment') {
      bucket.adjustment_quantity += quantity;
      bucket.adjustment_cost += totalCost;
    }
  }

  for (const card of cards) {
    const bucket = byType[card.type];
    if (!bucket) continue;
    bucket.issued_quantity += 1;
    bucket.issued_cost += normalizeMoneyAmount(card.cost, 0) || 0;
  }

  for (const bucket of Object.values(byType)) {
    bucket.purchase_quantity = Math.round(bucket.purchase_quantity * 10000) / 10000;
    bucket.purchase_cost = roundMoney(bucket.purchase_cost);
    bucket.loss_quantity = Math.round(bucket.loss_quantity * 10000) / 10000;
    bucket.loss_cost = roundMoney(bucket.loss_cost);
    bucket.adjustment_quantity = Math.round(bucket.adjustment_quantity * 10000) / 10000;
    bucket.adjustment_cost = roundMoney(bucket.adjustment_cost);
    bucket.issued_cost = roundMoney(bucket.issued_cost);
    const availableBeforeIssuedQuantity = bucket.purchase_quantity + bucket.adjustment_quantity - bucket.loss_quantity;
    const availableBeforeIssuedCost = bucket.purchase_cost + bucket.adjustment_cost - bucket.loss_cost;
    bucket.remaining_quantity = Math.round((availableBeforeIssuedQuantity - bucket.issued_quantity) * 10000) / 10000;
    bucket.remaining_cost = roundMoney(availableBeforeIssuedCost - bucket.issued_cost);
    bucket.purchase_average_cost = availableBeforeIssuedQuantity > 0
      ? roundMoney(availableBeforeIssuedCost / availableBeforeIssuedQuantity)
      : null;
    bucket.current_average_cost = bucket.remaining_quantity > 0 && bucket.remaining_cost > 0
      ? roundMoney(bucket.remaining_cost / bucket.remaining_quantity)
      : (bucket.purchase_average_cost ?? getDefaultCost());
  }

  const totals = Object.values(byType).reduce((acc, item) => {
    acc.purchase_quantity += item.purchase_quantity;
    acc.purchase_cost += item.purchase_cost;
    acc.loss_quantity += item.loss_quantity;
    acc.loss_cost += item.loss_cost;
    acc.adjustment_quantity += item.adjustment_quantity;
    acc.adjustment_cost += item.adjustment_cost;
    acc.issued_quantity += item.issued_quantity;
    acc.issued_cost += item.issued_cost;
    acc.remaining_quantity += item.remaining_quantity;
    acc.remaining_cost += item.remaining_cost;
    return acc;
  }, {
    purchase_quantity: 0,
    purchase_cost: 0,
    loss_quantity: 0,
    loss_cost: 0,
    adjustment_quantity: 0,
    adjustment_cost: 0,
    issued_quantity: 0,
    issued_cost: 0,
    remaining_quantity: 0,
    remaining_cost: 0
  });

  Object.keys(totals).forEach((key) => {
    totals[key] = key.endsWith('_cost')
      ? roundMoney(totals[key])
      : Math.round(totals[key] * 10000) / 10000;
  });

  return {
    by_type: byType,
    totals,
    default_cost: getDefaultCost()
  };
}

function getWeightedAverageCost(type) {
  const summary = buildCostSummary();
  return summary.by_type[type]?.current_average_cost ?? getDefaultCost();
}

// 定期保存（防止意外丢失）
setInterval(() => {
  saveCards(cards);
  saveRecords(records);
  saveCostRecords(costRecords);
}, 30000);

setInterval(() => {
  reconcilePendingJobs().catch((err) => {
    console.error('自动对账循环失败:', err);
  });
}, JOB_RECONCILE_INTERVAL_MS);

setTimeout(() => {
  reconcilePendingJobs().catch((err) => {
    console.error('启动后自动对账失败:', err);
  });
}, 5000);

// ========== 中间件 ==========
// CORS：只允许同源（前后端同服务器部署），如需跨域请设置 ALLOWED_ORIGIN 环境变量
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '';
app.use(cors(ALLOWED_ORIGIN ? {
  origin: (origin, cb) => {
    if (!origin || origin === ALLOWED_ORIGIN) cb(null, true);
    else cb(new Error('Not allowed by CORS'));
  },
  credentials: true
} : false));
// 请求体大小限制 64kb，防止超大 payload 攻击
app.use(express.json({ limit: '64kb' }));

// ========== Admin routing ==========
const ADMIN_PATH = (process.env.ADMIN_PATH || 'manage-' + crypto.randomBytes(6).toString('hex')).replace(/^\//, '');

app.get(['/admin.html', '/admin', '/administrator', '/backend', '/manage'], (req, res) => {
  res.status(404).send('Not Found');
});

app.get(`/${ADMIN_PATH}`, (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(__dirname, 'admin.html'));
});

app.get('/cancel', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex');
  res.sendFile(path.join(__dirname, 'cancel.html'));
});

app.use(express.static(__dirname, {
  index: 'index.html',
  fallthrough: true
}));

// ========== Rate limits ==========
const loginAttempts = new Map();
function checkLoginRate(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { count: 0, resetAt: now + 15 * 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 15 * 60 * 1000; }
  return rec;
}
function recordLoginFail(ip) {
  const rec = checkLoginRate(ip);
  rec.count++;
  loginAttempts.set(ip, rec);
}
function clearLoginAttempts(ip) { loginAttempts.delete(ip); }

// 取消：同一 IP 1 分钟内最多 10 次
// Public cancel API: allow up to 500 requests per IP per minute.
const CANCEL_RATE_LIMIT = 500;
const cancelAttempts = new Map();
function checkCancelRate(ip) {
  const now = Date.now();
  const rec = cancelAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60 * 1000; }
  rec.count++;
  cancelAttempts.set(ip, rec);
  return rec.count;
}

// ========== 管理员 Session 管理 ==========
const adminSessions = new Map();

function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

function adminAuth(req, res, next) {
  const token = req.headers['x-admin-token'];
  if (!token || !adminSessions.has(token)) {
    return res.status(401).json({ error: '未授权，请先登录' });
  }
  const session = adminSessions.get(token);
  if (Date.now() - session.createdAt > 24 * 60 * 60 * 1000) {
    adminSessions.delete(token);
    return res.status(401).json({ error: 'Session 已过期，请重新登录' });
  }
  if (session.role === 'sub_admin') {
    const subAdmin = getSubAdmins().find(item => item.id === session.userId);
    if (!subAdmin || subAdmin.status === 'disabled') {
      adminSessions.delete(token);
      return res.status(401).json({ error: '子管理员账号不可用，请联系主管理员' });
    }
    session.username = subAdmin.username;
    session.status = subAdmin.status;
  }
  req.admin = session;
  next();
}

function requireSuperAdmin(req, res, next) {
  if (req.admin?.role !== 'super_admin') {
    return res.status(403).json({ error: '仅主管理员可执行此操作' });
  }
  next();
}

function isScopedSubAdmin(session) {
  return session?.role === 'sub_admin';
}

function cardBelongsToSession(card, session) {
  if (!card) return false;
  if (!isScopedSubAdmin(session)) return true;
  return card.created_by_username === session.username;
}

function findManageableCardByCode(code, session, expectedStatus) {
  const normalizedCode = String(code || '').trim();
  if (!normalizedCode) return null;
  return cards.find((card) => (
    card.code === normalizedCode
    && card.status === expectedStatus
    && cardBelongsToSession(card, session)
  )) || null;
}

function recordBelongsToSession(record, session) {
  if (!record) return false;
  if (!isScopedSubAdmin(session)) return true;
  if (record.created_by_username) {
    return record.created_by_username === session.username;
  }
  const card = cards.find(item => item.code === record.card_code);
  return card?.created_by_username === session.username;
}

// ========== 工具函数 ==========
function generateCardCode(type) {
  const prefix = type.toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const groups = [];
  for (let group = 0; group < 5; group++) {
    let part = '';
    for (let i = 0; i < 5; i++) {
      part += chars.charAt(crypto.randomInt(chars.length));
    }
    groups.push(part);
  }
  return `CDK-${prefix}-${groups.join('-')}`;
}

function generateUniqueCardCode(type, existingCodes) {
  let code;
  let attempts = 0;
  do {
    code = generateCardCode(type);
    attempts++;
    if (attempts > 100) {
      throw new Error('生成卡密失败，请重试');
    }
  } while (existingCodes.has(code));
  existingCodes.add(code);
  return code;
}

function createAdminCard(type, batchId, admin, extra = {}) {
  return {
    id: cards.length + 1,
    type,
    status: 'unused',
    created_at: nowStr(),
    used_at: null,
    used_by: null,
    remark: '',
    cost: getDefaultCost(),
    sale_price: null,
    issue_type: 'normal',
    compensation_reason: null,
    compensation_for_code: null,
    batch_id: batchId,
    created_by_username: admin?.username || 'super_admin',
    created_by_role: admin?.role || 'super_admin',
    ...extra
  };
}

function normalizeCardCode(code) {
  return String(code || '').trim().toUpperCase();
}

function findManageableCardByAnyStatus(code, session) {
  const normalizedCode = normalizeCardCode(code);
  if (!normalizedCode) return null;
  return cards.find((card) => (
    card.code === normalizedCode
    && cardBelongsToSession(card, session)
  )) || null;
}

function findCompensationForCard(code, session) {
  const normalizedCode = normalizeCardCode(code);
  if (!normalizedCode) return null;
  return cards.find((card) => (
    card.issue_type === 'compensation'
    && normalizeCardCode(card.compensation_for_code) === normalizedCode
    && cardBelongsToSession(card, session)
  )) || null;
}

function normalizeJobStatus(status) {
  const normalized = String(status || '').trim().toLowerCase();
  if (normalized === 'cancelled' || normalized === 'canceled') {
    return 'failed';
  }
  return normalized || status;
}

const CANCELABLE_RECORD_STATUSES = new Set(['pending', 'processing', 'unknown', 'expired']);

function recordNeedsManualReview(record, normalizedStatus = normalizeJobStatus(record?.status)) {
  return record?.needs_manual_review === true ||
    !!record?.manual_review_reason ||
    !!record?.manual_review_stage ||
    !!record?.upstream_detail ||
    normalizedStatus === 'unknown' ||
    normalizedStatus === 'expired';
}

function findCancelableRecordByJobId(jobId, session = null) {
  return records.find(r =>
    r.job_id === jobId &&
    (!session || recordBelongsToSession(r, session)) &&
    CANCELABLE_RECORD_STATUSES.has(normalizeJobStatus(r.status))
  );
}

function findCancelableRecordById(recordId, session = null) {
  const numericId = Number(recordId);
  if (!Number.isInteger(numericId) || numericId <= 0) return null;
  return records.find(r =>
    r.id === numericId &&
    (!session || recordBelongsToSession(r, session)) &&
    CANCELABLE_RECORD_STATUSES.has(normalizeJobStatus(r.status))
  );
}

function isValidJobId(jobId) {
  return /^[a-zA-Z0-9_-]{4,128}$/.test(String(jobId || ''));
}

function upstreamJobStatusLooksSuccessful(payload) {
  if (!payload || normalizeJobStatus(payload.status) !== 'done') return false;
  if (payload.result && payload.result.ok === false) return false;
  return true;
}

async function fetchUpstreamJobStatus(jobId, wait = 0) {
  const upstreamUrl = getBaseUrl();
  const jobRes = await fetch(`${upstreamUrl}/job/${jobId}?wait=${wait}`, {
    headers: { 'X-API-Key': getApiKey() }
  });
  const raw = await jobRes.text();
  const contentType = jobRes.headers.get('content-type') || 'application/json; charset=utf-8';

  let payload = {};
  if (raw) {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { error: raw };
    }
  }

  return {
    statusCode: jobRes.status,
    contentType,
    payload
  };
}

async function cancelJobViaUpstream(jobId) {
  if (!getApiKey() || !getBaseUrl()) {
    return { statusCode: 503, body: { error: '服务尚未配置，请稍后再试' } };
  }

  const record = findCancelableRecordByJobId(jobId);
  const upstreamUrl = getBaseUrl();
  const cancelRes = await fetch(`${upstreamUrl}/job/${jobId}`, {
    method: 'DELETE',
    headers: { 'X-API-Key': getApiKey() }
  });

  if (!cancelRes.ok) {
    const errData = await cancelRes.json().catch(() => ({}));
    const errorMessage = errData.detail || errData.error || '任务当前不可取消';
    if (cancelRes.status === 404 && record) {
      refundCardForRecord(record);
      record.status = 'expired';
      record.error_message = errorMessage;
      saveRecords(records);
      return {
        statusCode: 200,
        body: {
          success: true,
          job_id: jobId,
          status: record.status,
          message: '任务不存在或已过期，卡密已退回'
        }
      };
    }

    return {
      statusCode: cancelRes.status,
      body: { error: errorMessage }
    };
  }

  const jobData = await cancelRes.json().catch(() => ({
    job_id: jobId,
    status: 'failed',
    error: 'cancelled'
  }));

  const cancelStatus = normalizeJobStatus(jobData.status || 'failed') || 'failed';
  if (record) {
    record.status = cancelStatus;
    record.error_message = jobData.error || 'cancelled';
    if (cancelStatus === 'failed') {
      refundCardForRecord(record);
    }
    saveRecords(records);
  }

  return {
    statusCode: 200,
    body: {
      success: true,
      job_id: jobId,
      status: cancelStatus,
      message: record ? '任务已取消，卡密已退回' : '取消请求已提交'
    }
  };
}

function cancelRecordLocally(record, reason = '管理员已取消，卡密已退回') {
  if (!record) {
    return { statusCode: 404, body: { error: '未找到可取消的兑换记录' } };
  }

  refundCardForRecord(record);
  record.status = 'failed';
  record.error_message = reason;
  clearManualReviewDetails(record);
  saveRecords(records);

  return {
    statusCode: 200,
    body: {
      success: true,
      record_id: record.id,
      status: record.status,
      message: '已人工取消，卡密已退回'
    }
  };
}

function hashAccessToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex').substring(0, 16);
}

function normalizeClientIP(value) {
  if (!value) return null;
  let ip = String(value).trim();
  if (!ip) return null;

  if (ip.startsWith('::ffff:')) {
    ip = ip.substring(7);
  }

  const bracketMatch = ip.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracketMatch) {
    ip = bracketMatch[1];
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) {
    ip = ip.replace(/:\d+$/, '');
  }

  return net.isIP(ip) ? ip : null;
}

function getFirstHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.map(getFirstHeaderValue).find(Boolean) || null;
  }
  if (!value) return null;
  return String(value).split(',').map(part => part.trim()).find(Boolean) || null;
}

function getTrustedProxyIP(req) {
  if (!TRUST_PROXY) return null;
  return normalizeClientIP(getFirstHeaderValue(req.headers['cf-connecting-ip'])) ||
    normalizeClientIP(getFirstHeaderValue(req.headers['x-real-ip'])) ||
    normalizeClientIP(getFirstHeaderValue(req.headers['x-forwarded-for'])) ||
    normalizeClientIP(req.ip);
}

function getSocketIP(req) {
  const raw = req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  return normalizeClientIP(raw) || raw || 'unknown';
}

function getClientIP(req) {
  return getTrustedProxyIP(req) || getSocketIP(req);
}

function nowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}

function getCpuTimesSnapshot() {
  return os.cpus().map((cpu) => {
    const times = cpu.times || {};
    const idle = times.idle || 0;
    const total = Object.values(times).reduce((sum, value) => sum + (Number(value) || 0), 0);
    return { idle, total };
  });
}

function calculateCpuUsagePercent(start, end) {
  if (!Array.isArray(start) || !Array.isArray(end) || start.length === 0 || end.length === 0) {
    return 0;
  }

  const usableLength = Math.min(start.length, end.length);
  let idleDelta = 0;
  let totalDelta = 0;
  for (let i = 0; i < usableLength; i += 1) {
    idleDelta += Math.max(0, end[i].idle - start[i].idle);
    totalDelta += Math.max(0, end[i].total - start[i].total);
  }
  if (totalDelta <= 0) return 0;
  return clampPercent((1 - idleDelta / totalDelta) * 100);
}

async function sampleCpuUsagePercent(delayMs = 120) {
  const start = getCpuTimesSnapshot();
  await new Promise(resolve => setTimeout(resolve, delayMs));
  return calculateCpuUsagePercent(start, getCpuTimesSnapshot());
}

function getDiskInfo(targetPath = DATA_DIR) {
  if (typeof fs.statfsSync !== 'function') return null;
  try {
    const stats = fs.statfsSync(targetPath);
    const blockSize = Number(stats.bsize || stats.frsize || 0);
    const total = blockSize * Number(stats.blocks || 0);
    const free = blockSize * Number(stats.bfree || 0);
    const available = blockSize * Number(stats.bavail || stats.bfree || 0);
    if (!Number.isFinite(total) || total <= 0) return null;
    const used = Math.max(0, total - free);
    return {
      path: targetPath,
      total,
      free,
      available,
      used,
      usage_percent: clampPercent((used / total) * 100)
    };
  } catch (err) {
    return {
      path: targetPath,
      error: err.message || '无法读取磁盘信息'
    };
  }
}

async function buildSystemInfo() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const cpus = os.cpus();
  const processMemory = process.memoryUsage();

  return {
    collected_at: nowStr(),
    host: {
      hostname: os.hostname(),
      platform: os.platform(),
      release: os.release(),
      arch: os.arch(),
      uptime_seconds: Math.round(os.uptime())
    },
    cpu: {
      usage_percent: await sampleCpuUsagePercent(),
      cores: cpus.length,
      model: cpus[0]?.model || 'unknown',
      speed_mhz: cpus[0]?.speed || null,
      loadavg: os.loadavg()
    },
    memory: {
      total: totalMem,
      free: freeMem,
      used: usedMem,
      usage_percent: totalMem > 0 ? clampPercent((usedMem / totalMem) * 100) : 0
    },
    disk: getDiskInfo(DATA_DIR),
    process: {
      pid: process.pid,
      node_version: process.version,
      uptime_seconds: Math.round(process.uptime()),
      cwd: process.cwd(),
      data_dir: DATA_DIR,
      rss: processMemory.rss,
      heap_total: processMemory.heapTotal,
      heap_used: processMemory.heapUsed,
      external: processMemory.external
    }
  };
}

const SHANGHAI_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

function parseDateInputBoundary(value, endOfDay = false) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(
    /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hasTime = typeof match[4] !== 'undefined';
  const hours = Number(match[4] || 0);
  const minutes = Number(match[5] || 0);
  const seconds = Number(match[6] || 0);

  if (!year || month < 1 || month > 12 || day < 1 || day > 31 ||
      hours < 0 || hours > 23 || minutes < 0 || minutes > 59 || seconds < 0 || seconds > 59) {
    return null;
  }

  if (hasTime) {
    if (endOfDay && typeof match[6] === 'undefined') {
      return Date.UTC(year, month - 1, day, hours, minutes, 59, 999) - SHANGHAI_UTC_OFFSET_MS;
    }
    return Date.UTC(year, month - 1, day, hours, minutes, seconds, endOfDay ? 999 : 0) - SHANGHAI_UTC_OFFSET_MS;
  }

  if (endOfDay) {
    return Date.UTC(year, month - 1, day, 23, 59, 59, 999) - SHANGHAI_UTC_OFFSET_MS;
  }
  return Date.UTC(year, month - 1, day, 0, 0, 0, 0) - SHANGHAI_UTC_OFFSET_MS;
}

function parseRecordCreatedAt(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const match = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/
  );
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hours = Number(match[4] || 0);
  const minutes = Number(match[5] || 0);
  const seconds = Number(match[6] || 0);

  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }

  return Date.UTC(year, month - 1, day, hours, minutes, seconds, 0) - SHANGHAI_UTC_OFFSET_MS;
}

function parseStatsRange(range) {
  const normalized = String(range || '1h').trim().toLowerCase();
  if (normalized === '30m') return { key: '30m', windowMs: 30 * 60 * 1000 };
  if (normalized === '1h') return { key: '1h', windowMs: 60 * 60 * 1000 };
  if (normalized === '1d') return { key: '1d', windowMs: 24 * 60 * 60 * 1000 };
  if (normalized === 'all') return { key: 'all', windowMs: null };
  return { key: '1h', windowMs: 60 * 60 * 1000 };
}

function filterRecordsByStatsRange(sourceRecords, rangeConfig) {
  if (!rangeConfig || rangeConfig.windowMs === null) return sourceRecords;
  const threshold = Date.now() - rangeConfig.windowMs;
  return sourceRecords.filter((record) => {
    const createdAtTs = parseRecordCreatedAt(record.created_at);
    return createdAtTs !== null && createdAtTs >= threshold;
  });
}

const SAFE_SUBMIT_REFUND_STATUSES = new Set([400, 401, 402, 429, 503]);
const TERMINAL_RECORD_STATUSES = new Set(['done', 'failed', 'unknown', 'expired']);

function refundCardForRecord(record) {
  const cardCode = normalizeCardCode(record?.card_code);
  const card = cards.find(c => normalizeCardCode(c.code) === cardCode);
  if (!card) return;
  card.status = 'unused';
  card.used_at = null;
  card.used_by = null;
  card.used_email = null;
  saveCards(cards);
}

function cardHasSuccessfulRedeemRecord(record) {
  const cardCode = normalizeCardCode(record?.card_code);
  if (!cardCode) return false;
  return records.some((item) =>
    item !== record &&
    normalizeCardCode(item.card_code) === cardCode &&
    normalizeJobStatus(item.status) === 'done'
  );
}

function clearManualReviewDetails(record) {
  if (!record) return;
  record.needs_manual_review = false;
  record.manual_review_reason = null;
  record.manual_review_stage = null;
  record.upstream_status_code = null;
  record.upstream_detail = null;
}

function ensureCardUsedForRecord(record) {
  const cardCode = normalizeCardCode(record?.card_code);
  const card = cards.find(c => normalizeCardCode(c.code) === cardCode);
  if (!card || card.status === 'used') return;
  card.status = 'used';
  card.used_at = card.used_at || record.created_at || nowStr();
  card.used_by = card.used_by || record.access_token_hash || null;
  card.used_email = card.used_email || record.email || null;
  saveCards(cards);
}

function summarizeUpstreamDetail(detail, fallback = null) {
  const raw = String(detail ?? '').trim();
  if (!raw) return fallback;
  return raw.replace(/\s+/g, ' ').slice(0, 240);
}

function describeFetchError(err) {
  const parts = [];
  if (err?.message) parts.push(err.message);

  const cause = err?.cause;
  if (cause) {
    if (cause.code) parts.push(`code=${cause.code}`);
    if (cause.errno) parts.push(`errno=${cause.errno}`);
    if (cause.syscall) parts.push(`syscall=${cause.syscall}`);
    if (cause.address) parts.push(`address=${cause.address}`);
    if (cause.port) parts.push(`port=${cause.port}`);
    if (cause.message && cause.message !== err.message) parts.push(`cause=${cause.message}`);
  }

  return summarizeUpstreamDetail(parts.join('; '), err?.message || 'fetch failed');
}

function getFetchErrorCode(err) {
  return err?.cause?.code || err?.code || '';
}

function isRetryableSubmitTlsError(err) {
  const code = getFetchErrorCode(err);
  const message = `${err?.message || ''} ${err?.cause?.message || ''}`.toLowerCase();
  return TLS_SUBMIT_RETRY_CODES.has(code) || message.includes('tls_process_server_hello:invalid session id');
}

function buildSubmitNetworkReviewDetails(err, fetchErrorDetail) {
  return {
    message: `提交请求结果不确定: ${fetchErrorDetail}`,
    manual_review_reason: '请求上游时出现网络错误，无法确认是否已成功受理',
    manual_review_stage: 'submit_network_error',
    upstream_detail: fetchErrorDetail
  };
}

function markSubmitTlsExhaustedFailed(record, fetchErrorDetail) {
  const errorMessage = summarizeUpstreamDetail(
    `连续 5 次 TLS 握手失败，卡密已退回，请稍后重试: ${fetchErrorDetail}`,
    '连续 5 次 TLS 握手失败，卡密已退回，请稍后重试'
  );
  refundCardForRecord(record);
  record.status = 'failed';
  record.error_message = errorMessage;
  record.queue_position = null;
  record.estimated_wait_seconds = null;
  clearManualReviewDetails(record);
  saveRecords(records);
  return errorMessage;
}

async function submitUpstreamRedeem(upstreamUrl, accessToken, workflow) {
  let lastError = null;
  for (let attempt = 0; attempt < SUBMIT_TLS_MAX_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(`${upstreamUrl}/submit`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': getApiKey()
        },
        body: JSON.stringify({
          access_token: accessToken,
          workflow
        })
      });
    } catch (err) {
      lastError = err;
      if (attempt < SUBMIT_TLS_MAX_ATTEMPTS - 1 && isRetryableSubmitTlsError(err)) {
        console.warn(`上游 /submit TLS 握手失败，正在自动重试第 ${attempt + 2} 次:`, describeFetchError(err));
        await new Promise((resolve) => setTimeout(resolve, 150));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

function fallbackRecordErrorMessage(record, status = null) {
  const normalizedStatus = normalizeJobStatus(status ?? record?.status);
  const explicitMessage = summarizeUpstreamDetail(record?.error_message, null);
  if (explicitMessage) return explicitMessage;

  const manualReason = summarizeUpstreamDetail(record?.manual_review_reason, null);
  if (manualReason) return manualReason;

  const upstreamDetail = summarizeUpstreamDetail(record?.upstream_detail, null);
  if (upstreamDetail) return upstreamDetail;

  if (normalizedStatus === 'failed') {
    return '上游返回 failed，但未提供原因';
  }

  return null;
}

function markRecordUncertain(record, message, status = 'unknown', details = {}) {
  record.status = status;
  record.error_message = message;
  record.needs_manual_review = true;
  record.manual_review_reason = details.manual_review_reason || message;
  record.manual_review_stage = details.manual_review_stage || null;
  record.upstream_status_code = Number.isInteger(details.upstream_status_code) ? details.upstream_status_code : null;
  record.upstream_detail = summarizeUpstreamDetail(details.upstream_detail, null);
  saveRecords(records);
}

function markManualReviewRecordSuccess(record, actor = 'super_admin') {
  record.status = 'done';
  record.error_message = null;
  record.queue_position = null;
  record.estimated_wait_seconds = null;
  record.manual_resolution = 'success';
  record.manual_resolved_at = nowStr();
  record.manual_resolved_by = actor;
  clearManualReviewDetails(record);
  saveRecords(records);
  ensureCardUsedForRecord(record);
  return record;
}

function markManualReviewRecordFailed(record, jobData, actor = 'system_auto_reconcile', options = {}) {
  const upstreamError = summarizeUpstreamDetail(jobData?.error, '上游返回 failed');
  record.status = 'failed';
  record.error_message = upstreamError;
  record.queue_position = null;
  record.estimated_wait_seconds = null;
  record.manual_resolution = 'failed';
  record.manual_resolved_at = nowStr();
  record.manual_resolved_by = actor;
  clearManualReviewDetails(record);
  if (!options.skipRefund) {
    refundCardForRecord(record);
  }
  saveRecords(records);
  return record;
}

function markExpiredManualReviewRecordFailed(record, actor = 'super_admin') {
  const hasSuccessfulRedeem = cardHasSuccessfulRedeemRecord(record);
  return markManualReviewRecordFailed(record, {
    error: hasSuccessfulRedeem ? '管理员人工设为失败，卡密已有成功兑换记录，未退回卡密' : '管理员人工设为失败，卡密已退回'
  }, actor, { skipRefund: hasSuccessfulRedeem });
}

function updateQueueEstimate(record, jobData) {
  if (!record || !jobData) return;
  const normalizedStatus = normalizeJobStatus(jobData.status);
  if (jobData.workflow) record.workflow = jobData.workflow;
  if (Object.prototype.hasOwnProperty.call(jobData, 'queue_position')) {
    record.queue_position = jobData.queue_position;
  }
  if (Object.prototype.hasOwnProperty.call(jobData, 'estimated_wait_seconds')) {
    record.estimated_wait_seconds = jobData.estimated_wait_seconds;
  }
  if (normalizedStatus === 'done' || normalizedStatus === 'failed') {
    record.queue_position = null;
    record.estimated_wait_seconds = null;
  }
}

function applyJobStatus(jobId, jobData) {
  const record = records.find(r => r.job_id === jobId);
  if (!record) return null;
  const normalizedStatus = normalizeJobStatus(jobData.status);

  if (['pending', 'processing', 'done', 'failed'].includes(normalizedStatus)) {
    record.status = normalizedStatus;
    clearManualReviewDetails(record);
  }
  const upstreamError = summarizeUpstreamDetail(jobData.error, null);
  record.error_message = upstreamError || fallbackRecordErrorMessage(record, normalizedStatus);
  updateQueueEstimate(record, jobData);

  if (normalizedStatus === 'failed') {
    refundCardForRecord(record);
  }

  saveRecords(records);
  return record;
}

async function refreshRecordFromUpstream(record, wait = 0) {
  if (!record?.job_id || TERMINAL_RECORD_STATUSES.has(record.status)) return record;
  if (!getApiKey() || !getBaseUrl()) return record;

  const upstreamUrl = getBaseUrl();
  const jobRes = await fetch(`${upstreamUrl}/job/${record.job_id}?wait=${wait}`, {
    headers: { 'X-API-Key': getApiKey() }
  });

  if (jobRes.status === 404) {
    markRecordUncertain(record, 'Job 已过期或不存在，需人工核验最终兑换状态', 'expired', {
      manual_review_reason: '上游 Job 已过期或不存在，无法自动确认最终兑换结果',
      manual_review_stage: 'job_expired',
      upstream_status_code: 404,
      upstream_detail: 'job not found or expired'
    });
    return record;
  }

  if (!jobRes.ok) {
    return record;
  }

  const jobData = await jobRes.json();
  return applyJobStatus(record.job_id, jobData) || record;
}

let reconcileInFlight = false;

async function runWithConcurrency(items, limit, worker) {
  const queue = [...items];
  const workerCount = Math.min(Math.max(1, limit), queue.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  }));
}

function getReconcilableRecords(limit = JOB_RECONCILE_BATCH_SIZE) {
  return records
    .filter((record) => {
      const normalizedStatus = normalizeJobStatus(record.status);
      return !!record.job_id && (normalizedStatus === 'pending' || normalizedStatus === 'processing');
    })
    .slice(0, limit);
}

function getManualReviewReconcilableRecords(limit = JOB_RECONCILE_BATCH_SIZE) {
  const threshold = Date.now() - MANUAL_REVIEW_RECONCILE_WINDOW_MS;
  return records
    .filter((record) => {
      if (!record.job_id) return false;
      const normalizedStatus = normalizeJobStatus(record.status);
      if (normalizedStatus === 'done' || normalizedStatus === 'failed') return false;
      if (normalizedStatus === 'pending' || normalizedStatus === 'processing') return false;
      if (!recordNeedsManualReview(record, normalizedStatus)) return false;
      const createdAtTs = parseRecordCreatedAt(record.created_at);
      return createdAtTs !== null && createdAtTs >= threshold;
    })
    .slice(0, limit);
}

async function reconcileManualReviewRecord(record) {
  try {
    const upstreamResult = await fetchUpstreamJobStatus(record.job_id, 0);
    if (upstreamResult.statusCode !== 200) return record;
    const jobData = upstreamResult.payload;
    const upstreamStatus = normalizeJobStatus(jobData?.status);
    if (upstreamJobStatusLooksSuccessful(jobData)) {
      return markManualReviewRecordSuccess(record, 'system_auto_reconcile');
    }
    if (upstreamStatus === 'failed') {
      return markManualReviewRecordFailed(record, jobData, 'system_auto_reconcile');
    }
    return record;
  } catch (err) {
    console.error(`自动核验人工记录 ${record.job_id} 失败:`, err.message);
    return record;
  }
}

async function reconcilePendingJobs() {
  if (reconcileInFlight) return;
  if (!getApiKey() || !getBaseUrl()) return;

  const pendingRecords = getReconcilableRecords();
  const manualReviewRecords = getManualReviewReconcilableRecords();
  if (!pendingRecords.length && !manualReviewRecords.length) return;

  reconcileInFlight = true;
  try {
    await runWithConcurrency(pendingRecords, JOB_RECONCILE_CONCURRENCY, async (record) => {
      try {
        await refreshRecordFromUpstream(record, 0);
      } catch (err) {
        console.error(`自动对账任务 ${record.job_id} 失败:`, err.message);
      }
    });
    await runWithConcurrency(manualReviewRecords, JOB_RECONCILE_CONCURRENCY, async (record) => {
      await reconcileManualReviewRecord(record);
    });
  } finally {
    reconcileInFlight = false;
  }
}

async function fetchUpstreamBalances() {
  if (!getApiKey() || !getBaseUrl()) {
    return { balances: null, error: null };
  }

  try {
    const balanceRes = await fetch(`${getBaseUrl()}/balance`, {
      headers: { 'X-API-Key': getApiKey() }
    });
    if (!balanceRes.ok) {
      return { balances: null, error: `HTTP ${balanceRes.status}` };
    }
    const data = await balanceRes.json();
    return { balances: data.balances || null, error: null };
  } catch (err) {
    console.error('查询上游余额失败:', err);
    return { balances: null, error: err.message };
  }
}

function numberBalance(balances, key) {
  const value = balances?.[key];
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

// ========== 管理员 API ==========

// 登录（含暴力破解保护）
app.post('/api/admin/login', (req, res) => {
  const ip = getClientIP(req);
  const rec = checkLoginRate(ip);
  if (rec.count >= 5) {
    return res.status(429).json({ error: `登录尝试次数过多，请 ${Math.ceil((rec.resetAt - Date.now()) / 60000)} 分钟后重试` });
  }
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');
  let session;

  if (username) {
    const subAdmin = getSubAdmins().find(item => item.username === username);
    if (!subAdmin || subAdmin.status === 'disabled' || !verifyPassword(password, subAdmin.passwordHash)) {
      recordLoginFail(ip);
      return res.status(401).json({ error: '用户名或密码错误' });
    }
    session = {
      createdAt: Date.now(),
      role: 'sub_admin',
      username: subAdmin.username,
      userId: subAdmin.id
    };
  } else if (!password || password !== getAdminPassword()) {
    recordLoginFail(ip);
    return res.status(401).json({ error: '密码错误' });
  } else {
    session = {
      createdAt: Date.now(),
      role: 'super_admin',
      username: 'super_admin',
      userId: 'super_admin'
    };
  }

  clearLoginAttempts(ip);
  const token = generateSessionToken();
  adminSessions.set(token, session);
  res.json({ token, message: '登录成功', ...buildViewer(session) });
});

// 登出
app.post('/api/admin/logout', adminAuth, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminSessions.delete(token);
  res.json({ message: '已登出' });
});

app.get('/api/admin/me', adminAuth, (req, res) => {
  res.json(buildViewer(req.admin));
});

// 修改管理员密码
app.post('/api/admin/password', adminAuth, requireSuperAdmin, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '请提供当前密码和新密码' });
  }
  if (currentPassword !== getAdminPassword()) {
    return res.status(401).json({ error: '当前密码错误' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: '新密码至少 8 个字符' });
  }

  settings.adminPassword = newPassword;
  saveSettings(settings);

  // 强制下线所有其他 Session（功能可选）
  // adminSessions.clear();

  res.json({ message: '密码已修改，下次登录请使用新密码' });
});

app.get('/api/admin/sub-admins', adminAuth, requireSuperAdmin, (req, res) => {
  res.json({ subAdmins: getSubAdmins().map(sanitizeSubAdmin) });
});

app.post('/api/admin/sub-admins', adminAuth, requireSuperAdmin, (req, res) => {
  const username = normalizeUsername(req.body.username);
  const password = String(req.body.password || '');

  if (!/^[a-z0-9_]{3,24}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-24 位小写字母、数字或下划线' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: '子管理员密码至少 8 个字符' });
  }
  if (getSubAdmins().some(item => item.username === username)) {
    return res.status(409).json({ error: '用户名已存在' });
  }

  const subAdmin = {
    id: uuidv4(),
    username,
    passwordHash: hashPassword(password),
    status: 'active',
    created_at: nowStr()
  };
  getSubAdmins().push(subAdmin);
  saveSettings(settings);
  res.json({ message: '子管理员已创建', subAdmin: sanitizeSubAdmin(subAdmin) });
});

app.post('/api/admin/sub-admins/:id/password', adminAuth, requireSuperAdmin, (req, res) => {
  const subAdmin = getSubAdmins().find(item => item.id === req.params.id);
  const newPassword = String(req.body.newPassword || '');
  if (!subAdmin) {
    return res.status(404).json({ error: '子管理员不存在' });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: '新密码至少 8 个字符' });
  }
  subAdmin.passwordHash = hashPassword(newPassword);
  saveSettings(settings);
  res.json({ message: '子管理员密码已重置', subAdmin: sanitizeSubAdmin(subAdmin) });
});

app.post('/api/admin/sub-admins/:id/status', adminAuth, requireSuperAdmin, (req, res) => {
  const subAdmin = getSubAdmins().find(item => item.id === req.params.id);
  const enabled = req.body.enabled;
  if (!subAdmin) {
    return res.status(404).json({ error: '子管理员不存在' });
  }
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须为布尔值' });
  }
  subAdmin.status = enabled ? 'active' : 'disabled';
  saveSettings(settings);
  res.json({ message: enabled ? '子管理员已启用' : '子管理员已禁用', subAdmin: sanitizeSubAdmin(subAdmin) });
});

app.post('/api/admin/sub-admins/:id/impersonate', adminAuth, requireSuperAdmin, (req, res) => {
  const subAdmin = getSubAdmins().find(item => item.id === req.params.id);
  if (!subAdmin) {
    return res.status(404).json({ error: '子管理员不存在' });
  }
  if (subAdmin.status === 'disabled') {
    return res.status(409).json({ error: '子管理员已禁用，无法一键登录' });
  }

  const session = {
    createdAt: Date.now(),
    role: 'sub_admin',
    username: subAdmin.username,
    userId: subAdmin.id,
    impersonatedBy: req.admin?.username || 'super_admin'
  };
  const token = generateSessionToken();
  adminSessions.set(token, session);
  res.json({
    token,
    message: `已切换到子管理员 ${subAdmin.username}`,
    ...buildViewer(session)
  });
});

// 获取系统设置
app.get('/api/admin/settings', adminAuth, requireSuperAdmin, (req, res) => {
  res.json({
    apiKey: settings.apiKey ? '***已配置***' : '',
    baseUrl: settings.baseUrl || '',
    configured: !!(settings.apiKey && settings.baseUrl),
    maintenanceEnabled: settings.maintenanceEnabled === true,
    maintenanceMessage: settings.maintenanceMessage || '',
    maintenanceMessageZh: settings.maintenanceMessageZh || settings.maintenanceMessage || '',
    maintenanceMessageEn: settings.maintenanceMessageEn || '',
    typedMaintenance: getTypedMaintenance(),
    userNotice: getUserNotice(),
    channelName: getChannelName(),
    defaultCost: getDefaultCost()
  });
});

// 保存系统设置
app.post('/api/admin/settings', adminAuth, requireSuperAdmin, (req, res) => {
  const { apiKey, baseUrl, userNotice, channelName, defaultCost } = req.body;

  if (typeof apiKey !== 'undefined' && apiKey !== null) {
    settings.apiKey = String(apiKey).trim();
  }
  if (typeof baseUrl !== 'undefined' && baseUrl !== null) {
    settings.baseUrl = String(baseUrl).trim().replace(/\/$/, '');
  }
  if (typeof userNotice !== 'undefined') {
    settings.userNotice = normalizeUserNotice(userNotice);
  }
  if (typeof channelName !== 'undefined') {
    settings.channelName = normalizeChannelName(channelName);
  }
  if (typeof defaultCost !== 'undefined') {
    const normalizedDefaultCost = normalizeMoneyAmount(defaultCost, null);
    if (normalizedDefaultCost === null) {
      return res.status(400).json({ error: '默认成本必须是不小于 0 的数字' });
    }
    settings.defaultCost = normalizedDefaultCost;
  }

  saveSettings(settings);
  res.json({
    message: '设置已保存',
    configured: !!(settings.apiKey && settings.baseUrl),
    userNotice: getUserNotice(),
    channelName: getChannelName(),
    defaultCost: getDefaultCost()
  });
});

// 保存维护模式设置
app.post('/api/admin/maintenance', adminAuth, requireSuperAdmin, (req, res) => {
  const { enabled, message, messageZh, messageEn, typedMaintenance } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须为布尔值' });
  }
  settings.maintenanceEnabled = enabled;
  if (typeof messageZh === 'string') {
    settings.maintenanceMessageZh = messageZh.trim().slice(0, 500);
    settings.maintenanceMessage = settings.maintenanceMessageZh;
  }
  if (typeof messageEn === 'string') {
    settings.maintenanceMessageEn = messageEn.trim().slice(0, 500);
  }
  if (typeof message === 'string') {
    settings.maintenanceMessageZh = message.trim().slice(0, 500);
    settings.maintenanceMessage = settings.maintenanceMessageZh;
  }
  if (typeof typedMaintenance !== 'undefined') {
    settings.typedMaintenance = normalizeTypedMaintenanceConfig(typedMaintenance);
  } else {
    settings.typedMaintenance = getTypedMaintenance();
  }
  saveSettings(settings);
  res.json({
    message: enabled ? '维护模式已开启' : '维护模式已关闭',
    maintenanceEnabled: settings.maintenanceEnabled,
    maintenanceMessage: settings.maintenanceMessage,
    maintenanceMessages: getMaintenanceMessages(),
    typedMaintenance: settings.typedMaintenance
  });
});

// 系统运行状态
app.get('/api/admin/system', adminAuth, requireSuperAdmin, async (req, res) => {
  try {
    res.json(await buildSystemInfo());
  } catch (err) {
    console.error('读取系统状态失败:', err);
    res.status(500).json({ error: '读取系统状态失败', detail: err.message });
  }
});

// 成本 / 进货记录
app.get('/api/admin/cost-records', adminAuth, requireSuperAdmin, (req, res) => {
  res.json({
    records: [...costRecords].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))),
    summary: buildCostSummary()
  });
});

app.post('/api/admin/cost-records', adminAuth, requireSuperAdmin, (req, res) => {
  const recordType = normalizeCostRecordKind(req.body.record_type ?? req.body.recordType ?? req.body.kind);
  const cardType = String(req.body.card_type ?? req.body.cardType ?? req.body.type ?? '').trim();
  const quantity = normalizeQuantity(req.body.quantity ?? req.body.count, null);
  const totalCost = normalizeMoneyAmount(req.body.total_cost ?? req.body.totalCost ?? req.body.cost, null);

  if (!recordType) {
    return res.status(400).json({ error: '记录类型必须是 purchase、loss 或 adjustment' });
  }
  if (!CARD_TYPES.includes(cardType)) {
    return res.status(400).json({ error: '卡种必须是 plus、plus_1y、pro 或 pro_20x' });
  }
  if (quantity === null) {
    return res.status(400).json({ error: '数量必须是大于 0 的数字' });
  }
  if (totalCost === null) {
    return res.status(400).json({ error: '总成本必须是不小于 0 的数字' });
  }

  const record = normalizeCostRecord({
    id: uuidv4(),
    record_type: recordType,
    card_type: cardType,
    quantity,
    total_cost: totalCost,
    supplier: req.body.supplier,
    remark: req.body.remark ?? req.body.note,
    created_at: nowStr(),
    created_by_username: req.admin?.username || 'super_admin',
    created_by_role: req.admin?.role || 'super_admin'
  });

  costRecords.push(record);
  saveCostRecords(costRecords);
  res.json({
    message: '成本记录已保存',
    record,
    summary: buildCostSummary()
  });
});

app.delete('/api/admin/cost-records/:id', adminAuth, requireSuperAdmin, (req, res) => {
  const before = costRecords.length;
  costRecords = costRecords.filter((record) => record.id !== req.params.id);
  if (costRecords.length === before) {
    return res.status(404).json({ error: '成本记录不存在' });
  }
  saveCostRecords(costRecords);
  res.json({
    message: '成本记录已删除',
    summary: buildCostSummary()
  });
});

// 统计数据
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const visibleCards = cards.filter(card => cardBelongsToSession(card, req.admin));
  const visibleRecords = records.filter(record => recordBelongsToSession(record, req.admin));
  const statsRange = parseStatsRange(req.query.range);
  const rangedRecords = filterRecordsByStatsRange(visibleRecords, statsRange);
  const plusCards = visibleCards.filter(c => c.type === 'plus' || c.type === 'plus_1y');
  const proCards = visibleCards.filter(c => c.type === 'pro' || c.type === 'pro_20x');
  const upstreamBalance = isScopedSubAdmin(req.admin)
    ? { balances: null, error: null }
    : await fetchUpstreamBalances();
  const { balances: apiBalances, error: apiBalanceError } = upstreamBalance;
  const apiBalanceTotal = apiBalances ? {
    plus: numberBalance(apiBalances, 'plus') + numberBalance(apiBalances, 'plus_1y'),
    plus_monthly: numberBalance(apiBalances, 'plus'),
    plus_1y: numberBalance(apiBalances, 'plus_1y'),
    pro_total: numberBalance(apiBalances, 'pro') + numberBalance(apiBalances, 'pro_20x'),
    pro: numberBalance(apiBalances, 'pro'),
    pro_20x: numberBalance(apiBalances, 'pro_20x')
  } : null;

  const stats = {
    viewer: buildViewer(req.admin),
    apiBalances,
    apiBalanceTotal,
    apiBalanceError,
    plus: {
      total: plusCards.length,
      unused: plusCards.filter(c => c.status === 'unused').length,
      used: plusCards.filter(c => c.status === 'used').length,
      disabled: plusCards.filter(c => c.status === 'disabled').length,
    },
    plus_monthly: {
      total: visibleCards.filter(c => c.type === 'plus').length,
      unused: visibleCards.filter(c => c.type === 'plus' && c.status === 'unused').length,
      used: visibleCards.filter(c => c.type === 'plus' && c.status === 'used').length,
      disabled: visibleCards.filter(c => c.type === 'plus' && c.status === 'disabled').length,
    },
    plus_1y: {
      total: visibleCards.filter(c => c.type === 'plus_1y').length,
      unused: visibleCards.filter(c => c.type === 'plus_1y' && c.status === 'unused').length,
      used: visibleCards.filter(c => c.type === 'plus_1y' && c.status === 'used').length,
      disabled: visibleCards.filter(c => c.type === 'plus_1y' && c.status === 'disabled').length,
    },
    pro_total: {
      total: proCards.length,
      unused: proCards.filter(c => c.status === 'unused').length,
      used: proCards.filter(c => c.status === 'used').length,
      disabled: proCards.filter(c => c.status === 'disabled').length,
    },
    pro: {
      total: visibleCards.filter(c => c.type === 'pro').length,
      unused: visibleCards.filter(c => c.type === 'pro' && c.status === 'unused').length,
      used: visibleCards.filter(c => c.type === 'pro' && c.status === 'used').length,
      disabled: visibleCards.filter(c => c.type === 'pro' && c.status === 'disabled').length,
    },
    pro_20x: {
      total: visibleCards.filter(c => c.type === 'pro_20x').length,
      unused: visibleCards.filter(c => c.type === 'pro_20x' && c.status === 'unused').length,
      used: visibleCards.filter(c => c.type === 'pro_20x' && c.status === 'used').length,
      disabled: visibleCards.filter(c => c.type === 'pro_20x' && c.status === 'disabled').length,
    },
    redeemRecords: {
      total: visibleRecords.length,
      done: visibleRecords.filter(r => r.status === 'done').length,
      failed: visibleRecords.filter(r => r.status === 'failed').length,
      pending: visibleRecords.filter(r => r.status === 'pending' || r.status === 'processing').length,
    },
    redeemSummary: {
      range: statsRange.key,
      total: rangedRecords.length,
      done: rangedRecords.filter(r => normalizeJobStatus(r.status) === 'done').length,
      failed: rangedRecords.filter(r => normalizeJobStatus(r.status) === 'failed').length,
      success_by_type: {
        plus: rangedRecords.filter(r => r.card_type === 'plus' && normalizeJobStatus(r.status) === 'done').length,
        plus_1y: rangedRecords.filter(r => r.card_type === 'plus_1y' && normalizeJobStatus(r.status) === 'done').length,
        pro: rangedRecords.filter(r => r.card_type === 'pro' && normalizeJobStatus(r.status) === 'done').length,
        pro_20x: rangedRecords.filter(r => r.card_type === 'pro_20x' && normalizeJobStatus(r.status) === 'done').length
      }
    }
  };
  res.json(stats);
});

// 批量生成卡密
app.post('/api/admin/cards/generate', adminAuth, (req, res) => {
  const { count, type } = req.body;
  const issueType = String(req.body.issue_type ?? req.body.issueType ?? req.body.generation_mode ?? 'normal')
    .trim()
    .toLowerCase();
  const isCompensation = req.body.compensation === true || issueType === 'compensation' || issueType === '补卡';
  const compensationReason = normalizeCardRemark(
    req.body.compensation_reason
    ?? req.body.compensationReason
    ?? req.body.remark
    ?? req.body.note
    ?? DEFAULT_COMPENSATION_REASON
  ) || DEFAULT_COMPENSATION_REASON;
  const remark = isCompensation ? compensationReason : normalizeCardRemark(req.body.remark ?? req.body.note);
  const originalCode = normalizeCardCode(
    req.body.original_code
    ?? req.body.originalCode
    ?? req.body.old_code
    ?? req.body.oldCode
    ?? req.body.source_code
    ?? req.body.sourceCode
  );
  let cost = isCompensation ? null : normalizeMoneyAmount(req.body.cost, getWeightedAverageCost(type));
  const salePrice = isCompensation ? 0 : normalizeMoneyAmount(
    req.body.sale_price ?? req.body.salePrice ?? req.body.price,
    null
  );

  if (!count || !Number.isInteger(count) || count < 1 || count > 500) {
    return res.status(400).json({ error: '数量必须是 1-500 的整数' });
  }
  if (!CARD_TYPES.includes(type)) {
    return res.status(400).json({ error: '类型必须是 plus、plus_1y、pro 或 pro_20x' });
  }
  if (isCompensation && count !== 1) {
    return res.status(400).json({ error: '补卡一次只能生成 1 张卡密' });
  }
  if (!remark) {
    return res.status(400).json({ error: '备注不能为空' });
  }
  if (!isCompensation && cost === null) {
    return res.status(400).json({ error: '成本必须是不小于 0 的数字' });
  }
  if (salePrice === null) {
    return res.status(400).json({ error: '卖价必须是不小于 0 的数字' });
  }

  const batchId = uuidv4().substring(0, 8);
  const existingCodes = new Set(cards.map(c => c.code));
  const newCodes = [];
  let originalCard = null;

  if (isCompensation) {
    if (!originalCode) {
      return res.status(400).json({ error: '补卡需要输入旧卡密' });
    }
    originalCard = findManageableCardByAnyStatus(originalCode, req.admin);
    if (!originalCard) {
      return res.status(404).json({ error: '旧卡密不存在或无权补卡' });
    }
    if (originalCard.status !== 'used') {
      return res.status(400).json({ error: '旧卡密必须已使用后才能补卡' });
    }
    cost = normalizeMoneyAmount(originalCard.cost, null);
    if (cost === null) {
      cost = getDefaultCost();
    }
    const existingCompensation = originalCard.compensation_code || findCompensationForCard(originalCode, req.admin)?.code;
    if (existingCompensation) {
      return res.status(409).json({ error: `旧卡密已补过，新卡密：${existingCompensation}` });
    }
  }

  try {
    for (let i = 0; i < count; i++) {
      const code = generateUniqueCardCode(type, existingCodes);
      newCodes.push(code);
      cards.push(createAdminCard(type, batchId, req.admin, {
        code,
        remark,
        cost,
        sale_price: salePrice,
        issue_type: isCompensation ? 'compensation' : 'normal',
        compensation_reason: isCompensation ? compensationReason : null,
        compensation_for_code: isCompensation ? originalCode : null
      }));
    }
  } catch (err) {
    return res.status(500).json({ error: err.message || '生成卡密失败，请重试' });
  }

  if (isCompensation && originalCard) {
    originalCard.compensated_at = nowStr();
    originalCard.compensation_code = newCodes[0];
    originalCard.compensation_batch_id = batchId;
    originalCard.compensation_reason = compensationReason;
  }

  saveCards(cards);
  res.json({
    message: isCompensation
      ? `成功补卡 ${count} 张 ${type.toUpperCase()} 卡密`
      : `成功生成 ${count} 张 ${type.toUpperCase()} 卡密`,
    batchId,
    count,
    type,
    remark,
    cost,
    sale_price: salePrice,
    issue_type: isCompensation ? 'compensation' : 'normal',
    compensation_reason: isCompensation ? compensationReason : null,
    compensation_for_code: isCompensation ? originalCode : null,
    codes: newCodes
  });
});

// 批量替换卡密：退款等场景下，确认旧卡未使用后生成同类型新卡并禁用旧卡
app.post('/api/admin/cards/replace', adminAuth, (req, res) => {
  const parsed = parseBatchCardCodes(req.body, 500);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error.replace('查询', '替换') });
  }

  const targetCards = [];
  const usedCodes = [];
  const unavailableCodes = [];
  const notFoundCodes = [];

  for (const code of parsed.codes) {
    const card = cards.find((item) => item.code === code && cardBelongsToSession(item, req.admin));
    if (!card) {
      notFoundCodes.push(code);
    } else if (card.status === 'used') {
      usedCodes.push(code);
    } else if (card.status !== 'unused') {
      unavailableCodes.push(code);
    } else {
      targetCards.push(card);
    }
  }

  if (usedCodes.length > 0) {
    return res.status(409).json({
      error: `批量替换失败，以下卡密已使用：${usedCodes.join(', ')}`,
      used_codes: usedCodes,
      unavailable_codes: unavailableCodes,
      not_found_codes: notFoundCodes
    });
  }

  if (unavailableCodes.length > 0 || notFoundCodes.length > 0) {
    return res.status(400).json({
      error: '批量替换失败，只能替换存在且未使用的卡密',
      unavailable_codes: unavailableCodes,
      not_found_codes: notFoundCodes
    });
  }

  const batchId = uuidv4().substring(0, 8);
  const replacedAt = nowStr();
  const existingCodes = new Set(cards.map(c => c.code));
  let generated;

  try {
    generated = targetCards.map((card) => ({
      oldCard: card,
      newCode: generateUniqueCardCode(card.type, existingCodes)
    }));
  } catch (err) {
    return res.status(500).json({ error: err.message || '生成替换卡密失败，请重试' });
  }

  const replacements = [];
  const newCodes = [];
  for (const item of generated) {
    const { oldCard, newCode } = item;
    oldCard.status = 'disabled';
    oldCard.replaced_at = replacedAt;
    oldCard.replacement_batch_id = batchId;
    oldCard.replaced_by_code = newCode;

    const newCard = createAdminCard(oldCard.type, batchId, req.admin, {
      code: newCode,
      remark: '卡密替换',
      cost: getDefaultCost(),
      sale_price: normalizeMoneyAmount(oldCard.sale_price ?? oldCard.price, null),
      replaced_from_code: oldCard.code,
      replacement_batch_id: batchId
    });
    cards.push(newCard);

    newCodes.push(newCode);
    replacements.push({
      old_code: oldCard.code,
      new_code: newCode,
      type: oldCard.type
    });
  }

  saveCards(cards);
  res.json({
    message: `成功替换 ${replacements.length} 张卡密，旧卡已禁用`,
    batchId,
    count: replacements.length,
    replaced: replacements.length,
    codes: newCodes,
    replacements
  });
});

// 查看卡密列表
app.get('/api/admin/cards', adminAuth, (req, res) => {
  const {
    page = 1,
    pageSize = 20,
    status,
    type,
    search,
    batch_id,
    created_from,
    created_to,
    used_from,
    used_to
  } = req.query;
  const pg = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(Math.max(1, parseInt(pageSize) || 20), 100); // 上限 100

  let filtered = cards.filter(card => cardBelongsToSession(card, req.admin));
  const createdFromTs = parseDateInputBoundary(created_from, false);
  const createdToTs = parseDateInputBoundary(created_to, true);
  const usedFromTs = parseDateInputBoundary(used_from, false);
  const usedToTs = parseDateInputBoundary(used_to, true);

  if (status && status !== 'all') {
    filtered = filtered.filter(c => c.status === status);
  }
  if (type && type !== 'all') {
    filtered = filtered.filter(c => c.type === type);
  }
  if (search) {
    const q = String(search).trim().toLowerCase();
    filtered = filtered.filter(c => [
      c.code,
      c.type,
      c.status,
      c.batch_id,
      c.created_by_username,
      c.created_by_role,
      c.created_at,
      c.used_at,
      c.remark,
      c.cost,
      c.sale_price
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }
  if (batch_id) {
    filtered = filtered.filter(c => c.batch_id === batch_id);
  }
  if (createdFromTs !== null || createdToTs !== null) {
    filtered = filtered.filter((card) => {
      const createdAtTs = parseRecordCreatedAt(card.created_at);
      if (createdAtTs === null) return false;
      if (createdFromTs !== null && createdAtTs < createdFromTs) return false;
      if (createdToTs !== null && createdAtTs > createdToTs) return false;
      return true;
    });
  }
  if (usedFromTs !== null || usedToTs !== null) {
    filtered = filtered.filter((card) => {
      const usedAtTs = parseRecordCreatedAt(card.used_at);
      if (usedAtTs === null) return false;
      if (usedFromTs !== null && usedAtTs < usedFromTs) return false;
      if (usedToTs !== null && usedAtTs > usedToTs) return false;
      return true;
    });
  }

  // 按 id 倒序
  filtered.sort((a, b) => b.id - a.id);

  const total = filtered.length;
  const offset = (pg - 1) * ps;
  const paged = filtered.slice(offset, offset + ps);

  res.json({ total, page: pg, pageSize: ps, cards: paged });
});

// 查看兑换记录
app.get('/api/admin/records', adminAuth, (req, res) => {
  const { page = 1, pageSize = 20, status, type, search, date_from, date_to } = req.query;
  const pg = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(Math.max(1, parseInt(pageSize) || 20), 100); // 上限 100

  let filtered = records.filter(record => recordBelongsToSession(record, req.admin));
  const dateFromTs = parseDateInputBoundary(date_from, false);
  const dateToTs = parseDateInputBoundary(date_to, true);

  if (status && status !== 'all') {
    filtered = filtered.filter(r => normalizeJobStatus(r.status) === status);
  }
  if (type && type !== 'all') {
    filtered = filtered.filter(r => r.card_type === type);
  }
  if (search) {
    const q = String(search).trim().toLowerCase();
    if (q) {
      filtered = filtered.filter(r => [
        r.card_code,
        r.card_type,
        normalizeJobStatus(r.status),
        r.job_id,
        r.email,
        r.ip_address,
        r.error_message,
        r.manual_review_reason,
        r.manual_review_stage,
        r.upstream_detail,
        r.created_at,
        r.created_by_username,
        r.created_by_role
      ].some(value => String(value || '').toLowerCase().includes(q)));
    }
  }
  if (dateFromTs !== null || dateToTs !== null) {
    filtered = filtered.filter((record) => {
      const createdAtTs = parseRecordCreatedAt(record.created_at);
      if (createdAtTs === null) {
        return false;
      }
      if (dateFromTs !== null && createdAtTs < dateFromTs) {
        return false;
      }
      if (dateToTs !== null && createdAtTs > dateToTs) {
        return false;
      }
      return true;
    });
  }

  filtered = filtered.map(record => {
    const normalizedStatus = normalizeJobStatus(record.status);
    return {
      ...record,
      status: normalizedStatus,
      needs_manual_review: recordNeedsManualReview(record, normalizedStatus),
      error_message: fallbackRecordErrorMessage(record)
    };
  });

  filtered.sort((a, b) => b.id - a.id);

  const total = filtered.length;
  const offset = (pg - 1) * ps;
  const paged = filtered.slice(offset, offset + ps);

  res.json({ total, page: pg, pageSize: ps, records: paged });
});

// 管理后台人工核验成功：将不确定记录确认为兑换成功
app.post('/api/admin/records/:id/mark-success', adminAuth, (req, res) => {
  const recordId = Number(req.params.id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return res.status(400).json({ error: '记录 ID 无效' });
  }

  const record = records.find(r => r.id === recordId && recordBelongsToSession(r, req.admin));
  if (!record) {
    return res.status(404).json({ error: '未找到兑换记录' });
  }

  const normalizedStatus = normalizeJobStatus(record.status);
  if (!recordNeedsManualReview(record, normalizedStatus)) {
    return res.status(409).json({ error: '只有待人工核验的记录可以设置成功' });
  }
  if (normalizedStatus === 'done') {
    return res.status(409).json({ error: '该记录已经是成功状态' });
  }

  markManualReviewRecordSuccess(record, req.admin?.username || 'super_admin');

  res.json({
    message: '已设置为兑换成功',
    status: 'done',
    record: {
      ...record,
      status: 'done',
      needs_manual_review: false,
      error_message: null
    }
  });
});

// 管理后台人工核验失败：仅将已过期待核验记录确认为失败并退回卡密
app.post('/api/admin/records/:id/mark-failed', adminAuth, (req, res) => {
  const recordId = Number(req.params.id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return res.status(400).json({ error: '记录 ID 无效' });
  }

  const record = records.find(r => r.id === recordId && recordBelongsToSession(r, req.admin));
  if (!record) {
    return res.status(404).json({ error: '未找到兑换记录' });
  }

  const normalizedStatus = normalizeJobStatus(record.status);
  if (normalizedStatus !== 'expired' || !recordNeedsManualReview(record, normalizedStatus)) {
    return res.status(409).json({ error: '只有已过期待核验的记录可以设置失败' });
  }

  markExpiredManualReviewRecordFailed(record, req.admin?.username || 'super_admin');

  res.json({
    message: '已设置为失败，卡密已退回',
    status: 'failed',
    record: {
      ...record,
      status: 'failed',
      needs_manual_review: false
    }
  });
});

// 管理后台兑换记录诊断：按记录查询上游 Job 状态，但不自动改写本地记录
app.get('/api/admin/records/:id/diagnose', adminAuth, async (req, res) => {
  const recordId = Number(req.params.id);
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return res.status(400).json({ error: '记录 ID 无效' });
  }

  const record = records.find(r => r.id === recordId && recordBelongsToSession(r, req.admin));
  if (!record) {
    return res.status(404).json({ error: '未找到兑换记录' });
  }

  const normalizedStatus = normalizeJobStatus(record.status);
  const local = {
    id: record.id,
    card_code: record.card_code,
    card_type: record.card_type,
    email: record.email,
    job_id: record.job_id || null,
    status: normalizedStatus,
    needs_manual_review: recordNeedsManualReview(record, normalizedStatus),
    error_message: fallbackRecordErrorMessage(record),
    manual_review_reason: record.manual_review_reason || null,
    manual_review_stage: record.manual_review_stage || null,
    upstream_detail: record.upstream_detail || null
  };

  if (!record.job_id) {
    return res.json({
      local,
      can_query_upstream: false,
      upstream_status_code: null,
      upstream: null,
      can_mark_success: false,
      recommendation: '该记录没有 Job ID，无法查询上游接口'
    });
  }

  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务尚未配置，请管理员先完成 API 设置' });
  }

  const wait = Math.min(Math.max(0, parseInt(req.query.wait, 10) || 0), 30);

  try {
    const upstreamResult = await fetchUpstreamJobStatus(record.job_id, wait);
    const upstreamStatus = normalizeJobStatus(upstreamResult.payload?.status);
    const canMarkSuccess = recordNeedsManualReview(record, normalizedStatus) &&
      upstreamResult.statusCode === 200 &&
      upstreamJobStatusLooksSuccessful(upstreamResult.payload);
    let recommendation = '上游未返回成功，请按上游状态继续处理';
    if (canMarkSuccess) {
      recommendation = '上游返回成功，可以一键校验为成功';
    } else if (upstreamStatus === 'failed') {
      recommendation = '上游返回失败，文档说明该 Job 已自动退款，请按实际情况处理本地记录';
    } else if (upstreamStatus === 'pending' || upstreamStatus === 'processing') {
      recommendation = '上游仍在处理中，暂不建议设置成功';
    } else if (upstreamResult.statusCode === 404) {
      recommendation = '上游 Job 不存在或已过期，仍需人工核验最终状态';
    }

    return res.json({
      local,
      can_query_upstream: true,
      upstream_status_code: upstreamResult.statusCode,
      upstream: upstreamResult.payload,
      can_mark_success: canMarkSuccess,
      recommendation
    });
  } catch (err) {
    console.error('管理后台诊断兑换记录失败:', err);
    return res.status(502).json({ error: '诊断请求失败，请稍后重试' });
  }
});

// 禁用卡密
app.post('/api/admin/cards/disable', adminAuth, (req, res) => {
  const { codes: codesToDisable } = req.body;
  if (!Array.isArray(codesToDisable) || codesToDisable.length === 0) {
    return res.status(400).json({ error: '请提供要禁用的卡密列表' });
  }
  if (codesToDisable.length > 500) {
    return res.status(400).json({ error: '单次最多操作 500 张卡密' });
  }

  let count = 0;
  for (const code of codesToDisable) {
    const card = findManageableCardByCode(code, req.admin, 'unused');
    if (card) {
      card.status = 'disabled';
      count++;
    }
  }

  saveCards(cards);
  res.json({ message: `成功禁用 ${count} 张卡密`, disabled: count });
});

// 启用卡密
app.post('/api/admin/cards/enable', adminAuth, (req, res) => {
  const { codes: codesToEnable } = req.body;
  if (!Array.isArray(codesToEnable) || codesToEnable.length === 0) {
    return res.status(400).json({ error: '请提供要启用的卡密列表' });
  }
  if (codesToEnable.length > 500) {
    return res.status(400).json({ error: '单次最多操作 500 张卡密' });
  }

  let count = 0;
  for (const code of codesToEnable) {
    const card = findManageableCardByCode(code, req.admin, 'disabled');
    if (card) {
      card.status = 'unused';
      count++;
    }
  }

  saveCards(cards);
  res.json({ message: `成功启用 ${count} 张卡密`, enabled: count });
});

// ========== 用户卡密 API ==========

app.post('/api/card/verify', (req, res, next) => {
  if (isMaintenanceEnabled()) return next();
  const maintenanceBlock = getMaintenanceBlockForCode(req.body?.code);
  if (maintenanceBlock) return res.status(503).json(maintenanceBlock);
  next();
});

app.post('/api/card/redeem', (req, res, next) => {
  if (isMaintenanceEnabled()) return next();
  const maintenanceBlock = getMaintenanceBlockForCode(req.body?.code);
  if (maintenanceBlock) return res.status(503).json(maintenanceBlock);
  next();
});

// 验证卡密
app.post('/api/card/verify', (req, res) => {
  // 维护模式拦截
  if (isMaintenanceEnabled()) {
    return res.status(503).json({ error: '系统维护中，暂停兑换。' + getMaintenanceMessage(), maintenance: true });
  }

  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请输入卡密' });
  }

  const cardCode = normalizeCardCode(code);
  const card = cards.find(c => c.code === cardCode);

  if (!card) {
    return res.status(404).json({ error: '卡密不存在或不可用' });
  }
  if (card.status === 'used') {
    return res.status(410).json({ error: '该卡密已被使用' });
  }
  if (card.status === 'disabled') {
    return res.status(403).json({ error: '该卡密已被禁用' });
  }

  res.json({
    valid: true,
    type: card.type,
    message: `有效的 ${card.type.toUpperCase()} 卡密`
  });
});

// 使用卡密兑换（含频率限制）
app.post('/api/card/redeem', async (req, res) => {
  // 维护模式拦截
  if (isMaintenanceEnabled()) {
    return res.status(503).json({ error: '系统维护中，暂停兑换。' + getMaintenanceMessage(), maintenance: true });
  }

  const clientIP = getClientIP(req);
  const { code } = req.body;
  let access_token = req.body.access_token;

  if (!code || !access_token) {
    return res.status(400).json({ error: '卡密和 Session 数据不能为空' });
  }

  // 服务端自动解析：支持传入整个 api/auth/session JSON
  let sessionEmail = null;
  if (typeof access_token === 'string' && access_token.trim().startsWith('{')) {
    try {
      const sessionJson = JSON.parse(access_token.trim());
      if (sessionJson.accessToken) {
        // 尝试提取邮箱
        sessionEmail = sessionJson.user?.email || null;
        access_token = sessionJson.accessToken;
      } else {
        return res.status(400).json({ error: 'Session JSON 中未找到 accessToken 字段' });
      }
    } catch (e) {
      return res.status(400).json({ error: 'Session 数据格式无效' });
    }
  }

  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务尚未配置，请管理员在后台设置 API Key 和 Base URL' });
  }

  const cardCode = normalizeCardCode(code);

  // 查找并标记卡密（原子性：通过 find 锁定）
  const card = cards.find(c => c.code === cardCode && c.status === 'unused');
  if (!card) {
    return res.status(400).json({ error: '卡密不存在或不可用' });
  }

  // 立即标记为已使用（防止并发）
  const typeMaintenanceBlock = getTypeMaintenanceBlock(card.type);
  if (typeMaintenanceBlock) return res.status(503).json(typeMaintenanceBlock);

  card.status = 'used';
  card.used_at = nowStr();
  card.used_by = hashAccessToken(access_token);
  card.used_email = sessionEmail || null;
  saveCards(cards);

  // 创建兑换记录
  const record = {
    id: records.length + 1,
    card_code: cardCode,
    card_type: card.type,
    created_by_username: card.created_by_username || null,
    created_by_role: card.created_by_role || null,
    email: sessionEmail || null,
    access_token_hash: hashAccessToken(access_token),
    job_id: null,
    status: 'pending',
    error_message: null,
    workflow: card.type,
    queue_position: null,
    estimated_wait_seconds: null,
    manual_review_reason: null,
    manual_review_stage: null,
    upstream_status_code: null,
    upstream_detail: null,
    created_at: nowStr(),
    ip_address: clientIP
  };
  records.push(record);
  saveRecords(records);

  // 调用上游 API
  try {
    const upstreamUrl = getBaseUrl();
    const submitRes = await submitUpstreamRedeem(upstreamUrl, access_token, card.type);

    const submitText = await submitRes.text();
    let submitData = null;
    let submitParseError = null;
    if (submitText) {
      try {
        submitData = JSON.parse(submitText);
      } catch (err) {
        submitParseError = err;
      }
    }
    const submitDetail = summarizeUpstreamDetail(
      submitData?.detail || submitData?.error || submitText,
      submitParseError ? `upstream response parse failed: ${submitParseError.message}` : null
    );

    if (!submitRes.ok) {
      const errorMessage = submitDetail || `HTTP ${submitRes.status}`;
      if (SAFE_SUBMIT_REFUND_STATUSES.has(submitRes.status)) {
        refundCardForRecord(record);
        record.status = 'failed';
        record.error_message = errorMessage;
        clearManualReviewDetails(record);
        saveRecords(records);
        return res.status(submitRes.status).json({ error: errorMessage });
      }

      markRecordUncertain(record, `提交状态不确定: ${errorMessage}`, 'unknown', {
        manual_review_reason: `上游返回 HTTP ${submitRes.status}，但无法确认是否已受理兑换`,
        manual_review_stage: 'submit_http_error',
        upstream_status_code: submitRes.status,
        upstream_detail: errorMessage
      });
      return res.status(502).json({
        error: '上游提交状态不确定，卡密已锁定，请联系管理员人工核验',
        status: 'unknown',
        email: sessionEmail || null
      });
    }

    let jobData = submitData;
    if (submitParseError) {
      markRecordUncertain(record, `上游已接受请求但响应解析失败: ${submitParseError.message}`, 'unknown', {
        manual_review_reason: '上游已接受请求，但响应解析失败，无法确认 Job ID',
        manual_review_stage: 'submit_parse_error',
        upstream_status_code: submitRes.status,
        upstream_detail: summarizeUpstreamDetail(submitText, submitParseError.message)
      });
      return res.status(502).json({
        error: '上游提交状态不确定，卡密已锁定，请联系管理员人工核验',
        status: 'unknown',
        email: sessionEmail || null
      });
    }

    if (!jobData || !isValidJobId(jobData.job_id)) {
      markRecordUncertain(record, '上游已接受请求但未返回 job_id', 'unknown', {
        manual_review_reason: '上游已接受请求，但没有返回合法的 Job ID',
        manual_review_stage: 'submit_missing_job_id',
        upstream_status_code: submitRes.status,
        upstream_detail: submitDetail
      });
      return res.status(502).json({
        error: '上游提交状态不确定，卡密已锁定，请联系管理员人工核验',
        status: 'unknown',
        email: sessionEmail || null
      });
    }

    record.status = ['pending', 'processing'].includes(jobData.status) ? jobData.status : 'processing';
    record.job_id = jobData.job_id;
    updateQueueEstimate(record, jobData);
    saveRecords(records);

    res.json({
      success: true,
      job_id: jobData.job_id,
      type: card.type,
      workflow: jobData.workflow || card.type,
      status: jobData.status,
      queue_position: record.queue_position,
      estimated_wait_seconds: record.estimated_wait_seconds,
      email: sessionEmail || null,
      message: '兑换已提交，正在处理中...'
    });

  } catch (err) {
    const fetchErrorDetail = describeFetchError(err);
    console.error('兑换请求失败:', fetchErrorDetail, err);
    if (isRetryableSubmitTlsError(err)) {
      const errorMessage = markSubmitTlsExhaustedFailed(record, fetchErrorDetail);
      return res.status(502).json({
        error: errorMessage,
        status: 'failed',
        email: sessionEmail || null
      });
    }
    const reviewDetails = buildSubmitNetworkReviewDetails(err, fetchErrorDetail);
    markRecordUncertain(record, reviewDetails.message, 'unknown', reviewDetails);
    res.status(502).json({
      error: '兑换提交状态不确定，卡密已锁定，请联系管理员人工核验',
      status: 'unknown',
      email: sessionEmail || null
    });
  }
});

// 公开取消兑换任务：无需管理员权限，只需要 Job ID
app.post('/api/card/cancel', async (req, res) => {
  const clientIP = getClientIP(req);
  if (checkCancelRate(clientIP) > CANCEL_RATE_LIMIT) {
    return res.status(429).json({ error: '取消操作过于频繁，请 1 分钟后重试' });
  }
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务尚未配置，请稍后再试' });
  }

  const jobId = String(req.body.job_id || req.body.jobId || '').trim();
  if (!jobId) {
    return res.status(400).json({ error: '请提供 Job ID' });
  }
  if (!isValidJobId(jobId)) {
    return res.status(400).json({ error: 'Job ID 格式无效' });
  }

  try {
    const result = await cancelJobViaUpstream(jobId);
    res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error('取消兑换任务失败:', err);
    res.status(502).json({ error: '取消请求失败，请稍后重试' });
  }
});

// 管理后台按 Job ID 取消：通过服务端代理调用上游文档 API
app.post('/api/admin/job/cancel', adminAuth, async (req, res) => {
  const jobId = String(req.body.job_id || req.body.jobId || '').trim();
  const recordId = Number(req.body.record_id || req.body.recordId || 0);

  try {
    let result;
    if (jobId) {
      if (!isValidJobId(jobId)) {
        return res.status(400).json({ error: 'Job ID 格式无效' });
      }
      const record = findCancelableRecordByJobId(jobId, req.admin);
      if (!record && isScopedSubAdmin(req.admin)) {
        return res.status(404).json({ error: '未找到可取消的兑换记录' });
      }
      result = await cancelJobViaUpstream(jobId);
    } else if (Number.isInteger(recordId) && recordId > 0) {
      const record = findCancelableRecordById(recordId, req.admin);
      if (!record) {
        return res.status(404).json({ error: '未找到可取消的兑换记录' });
      }
      result = cancelRecordLocally(record);
    } else {
      return res.status(400).json({ error: '请提供 Job ID 或记录 ID' });
    }
    res.status(result.statusCode).json(result.body);
  } catch (err) {
    console.error('管理员取消兑换任务失败:', err);
    res.status(502).json({ error: '取消请求失败，请稍后重试' });
  }
});

// 管理后台按 Job ID 查询任务状态：仅代理上游 API，不读取或更新本地兑换记录
app.get('/api/admin/job-status/:jobId', adminAuth, requireSuperAdmin, async (req, res) => {
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务尚未配置，请管理员先完成 API 设置' });
  }

  const { jobId } = req.params;
  if (!isValidJobId(jobId)) {
    return res.status(400).json({ error: 'Job ID 格式无效' });
  }

  const wait = Math.min(Math.max(0, parseInt(req.query.wait, 10) || 0), 30);

  try {
    const upstreamResult = await fetchUpstreamJobStatus(jobId, wait);
    res.status(upstreamResult.statusCode);
    res.setHeader('Content-Type', upstreamResult.contentType);
    res.send(JSON.stringify(upstreamResult.payload));
  } catch (err) {
    console.error('管理后台查询任务状态失败:', err);
    res.status(502).json({ error: '查询任务状态失败，请稍后重试' });
  }
});

// ========== 公开卡密查询 API ==========
// 用户可查询自己卡密的状态，兑换邮箱按完整值显示
app.get('/api/card/queue', async (req, res) => {
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务未配置' });
  }

  const workflow = typeof req.query.workflow === 'string' ? req.query.workflow.trim() : '';
  if (workflow && !CARD_TYPES.includes(workflow)) {
    return res.status(400).json({ error: 'workflow 不合法' });
  }

  try {
    const queueRes = await fetch(`${getBaseUrl()}/queue`, {
      headers: { 'X-API-Key': getApiKey() }
    });
    const raw = await queueRes.text();

    let payload = {};
    if (raw) {
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = { error: raw };
      }
    }

    if (!queueRes.ok) {
      return res.status(queueRes.status).json(payload);
    }

    if (!workflow) {
      return res.json(payload);
    }

    const queue = payload && payload.queues ? payload.queues[workflow] : null;
    if (!queue) {
      return res.status(404).json({ error: '未找到对应 workflow 队列' });
    }

    return res.json({ workflow, queue });
  } catch (err) {
    console.error('查询队列摘要失败', err);
    return res.status(502).json({ error: '查询队列摘要失败，请稍后重试' });
  }
});

const QUERY_RATE_LIMIT = 3000;
const queryAttempts = new Map();
function checkQueryRate(ip) {
  const now = Date.now();
  const rec = queryAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60 * 1000; }
  rec.count++;
  queryAttempts.set(ip, rec);
  return rec.count;
}

async function buildCardQueryPayload(code) {
  const cardCode = normalizeCardCode(code);
  const card = cards.find(c => c.code === cardCode);

  if (!card) {
    return {
      found: false,
      statusCode: 404,
      body: {
        code: cardCode,
        type: null,
        status: 'not_found',
        status_label: '不存在',
        created_at: null,
        used_at: null,
        email: null,
        job_id: null,
        workflow: null,
        redeem_status: null,
        redeem_status_label: null,
        redeem_error: null,
        needs_manual_review: false,
        manual_review_reason: null,
        manual_review_stage: null,
        upstream_status_code: null,
        upstream_detail: null,
        queue_position: null,
        estimated_wait_seconds: null,
        error: '卡密不存在或不可用'
      }
    };
  }

  // 查找该卡密最新的一条兑换记录（按 id 倒序取第一条，避免多次兑换时拿到旧的失败记录）
  const cardRecords = records.filter(r => r.card_code === cardCode);
  let record = cardRecords.length > 0
    ? cardRecords.reduce((a, b) => (b.id > a.id ? b : a))
    : null;

  const normalizedRecordStatus = record ? normalizeJobStatus(record.status) : null;
  if (record?.job_id && !TERMINAL_RECORD_STATUSES.has(normalizedRecordStatus)) {
    try {
      record = await refreshRecordFromUpstream(record, 0);
    } catch (err) {
      console.error('刷新兑换状态失败:', err);
    }
  }

  const statusMap = { unused: '未使用', used: '已使用', disabled: '已禁用' };
  const redeemStatusLabelMap = {
    pending: '等待中',
    processing: '处理中',
    done: '兑换成功',
    failed: '兑换失败',
    unknown: '待人工核验',
    expired: '已过期待核验'
  };

  // used_at 仅在卡密当前状态为 used 时返回，防止退回后新一轮兑换时间与旧记录状态混显
  const redeemStatus = record ? normalizeJobStatus(record.status) : null;
  const usedAt = card.status === 'used' ? (card.used_at || null) : null;
  const usedEmail = card.status === 'used' ? (card.used_email || null) : null;

  return {
    found: true,
    statusCode: 200,
    body: {
      code: card.code,
      type: card.type,
      status: card.status,
      status_label: statusMap[card.status] || card.status,
      created_at: card.created_at,
      used_at: usedAt,
      email: usedEmail,
      job_id: record && isValidJobId(record.job_id) ? record.job_id : null,
      workflow: record ? record.workflow || record.card_type || card.type : null,
      redeem_status: redeemStatus,
      redeem_status_label: redeemStatus ? redeemStatusLabelMap[redeemStatus] || redeemStatus : null,
      redeem_error: record ? fallbackRecordErrorMessage(record) : null,
      needs_manual_review: record ? record.needs_manual_review === true : false,
      manual_review_reason: record ? record.manual_review_reason || null : null,
      manual_review_stage: record ? record.manual_review_stage || null : null,
      upstream_status_code: record ? record.upstream_status_code ?? null : null,
      upstream_detail: record ? record.upstream_detail || null : null,
      queue_position: record ? record.queue_position ?? null : null,
      estimated_wait_seconds: record ? record.estimated_wait_seconds ?? null : null
    }
  };
}

function parseBatchCardCodes(input, limit = 20) {
  const rawCodes = Array.isArray(input?.codes)
    ? input.codes
    : String(input?.text || input?.codes || '')
        .split(/[\r\n,]+/);

  const codes = [];
  const seen = new Set();
  for (const item of rawCodes) {
    const normalized = normalizeCardCode(item);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    codes.push(normalized);
  }

  if (codes.length === 0) {
    return { error: '请至少提供一个卡密' };
  }
  if (codes.length > limit) {
    return { error: `单次最多查询 ${limit} 个卡密` };
  }
  return { codes };
}

app.get('/api/card/query', async (req, res) => {
  const clientIP = getClientIP(req);
  if (checkQueryRate(clientIP) > QUERY_RATE_LIMIT) {
    return res.status(429).json({ error: '查询过于频繁，请稍后重试' });
  }

  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请提供卡密' });
  }

  const result = await buildCardQueryPayload(code);
  res.status(result.statusCode).json(result.found ? result.body : { error: result.body.error });
});

app.post('/api/card/query/batch', async (req, res) => {
  const clientIP = getClientIP(req);
  if (checkQueryRate(clientIP) > QUERY_RATE_LIMIT) {
    return res.status(429).json({ error: '查询过于频繁，请稍后重试' });
  }

  const parsed = parseBatchCardCodes(req.body, 20);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const results = await Promise.all(parsed.codes.map((code) => buildCardQueryPayload(code)));
  res.json({
    total: results.length,
    results: results.map((item) => item.body)
  });
});

app.post('/api/admin/cards/query/batch', adminAuth, async (req, res) => {
  const parsed = parseBatchCardCodes(req.body, 200);
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  const results = await Promise.all(parsed.codes.map((code) => buildCardQueryPayload(code)));
  res.json({
    total: results.length,
    results: results.map((item) => item.body)
  });
});

// 查询兑换任务状态
app.get('/api/card/job/:jobId', async (req, res) => {
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务未配置' });
  }

  const { jobId } = req.params;
  // 校验 jobId 格式，防止路径注入
  if (!isValidJobId(jobId)) {
    return res.status(400).json({ error: '无效的 Job ID' });
  }
  // wait 最大 30 秒
  const wait = Math.min(Math.max(0, parseInt(req.query.wait) || 0), 30);

  try {
    const upstreamUrl = getBaseUrl();
    const jobRes = await fetch(`${upstreamUrl}/job/${jobId}?wait=${wait}`, {
      headers: { 'X-API-Key': getApiKey() }
    });

    if (jobRes.status === 404) {
      const record = records.find(r => r.job_id === jobId);
      if (record && !TERMINAL_RECORD_STATUSES.has(record.status)) {
        markRecordUncertain(record, 'Job 已过期或不存在，需人工核验最终兑换状态', 'expired');
      }
      return res.status(404).json({
        error: '任务已过期或不存在，请联系管理员人工核验',
        status: 'expired'
      });
    }

    if (!jobRes.ok) {
      return res.status(jobRes.status).json({ error: '查询任务状态失败' });
    }

    const jobData = await jobRes.json();
    const normalizedJobData = {
      ...jobData,
      status: normalizeJobStatus(jobData.status)
    };

    // 更新兑换记录状态
    if (['pending', 'processing', 'done', 'failed'].includes(normalizedJobData.status)) {
      applyJobStatus(jobId, normalizedJobData);
    }

    res.json(normalizedJobData);
  } catch (err) {
    console.error('查询任务状态失败:', err);
    res.status(500).json({ error: '查询任务状态失败，请稍后重试' }); // 不暴露内部错误
  }
});

// ========== 现有代理功能（保留，加白名单防 SSRF） ==========
// 只允许代理到这些域名，防止被用作 SSRF 跳板
const PROXY_ALLOWED_HOSTS = (process.env.PROXY_ALLOWED_HOSTS || 'chatgpt.com,chat.openai.com')
  .split(',').map(h => h.trim().toLowerCase()).filter(Boolean);

function isProxyTargetAllowed(targetUrl) {
  try {
    const url = new URL(targetUrl);
    // 只允许 https
    if (url.protocol !== 'https:') return false;
    // 主机名必须在白名单内（支持子域名）
    return PROXY_ALLOWED_HOSTS.some(h => url.hostname === h || url.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

app.use('/api-proxy', (req, res, next) => {
  const target = req.headers['x-target-url'];
  if (!target) {
    return res.status(400).json({ detail: '缺少 x-target-url 请求头' });
  }
  if (!isProxyTargetAllowed(target)) {
    console.warn(`[代理拒绝] 非白名单地址: ${target} (来自 ${getClientIP(req)})`);
    return res.status(403).json({ detail: '目标地址不在允许范围内' });
  }
  next();
}, createProxyMiddleware({
  target: 'http://placeholder.com',
  router: (req) => req.headers['x-target-url'].replace(/\/$/, ''),
  changeOrigin: true,
  pathRewrite: { '^/api-proxy': '' },
  on: {
    proxyReq: (proxyReq, req) => {
      console.log(`[代理] ${req.method} -> ${req.headers['x-target-url']}`);
    },
    error: (err, req, res) => {
      res.status(500).json({ detail: '代理请求失败' }); // 不暴露具体错误
    }
  }
}));

// ========== 优雅退出：保存数据 ==========
process.on('SIGINT', () => {
  console.log('\n正在保存数据...');
  saveCards(cards);
  saveRecords(records);
  saveCostRecords(costRecords);
  console.log('数据已保存，退出。');
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveCards(cards);
  saveRecords(records);
  saveCostRecords(costRecords);
  process.exit(0);
});

// ========== 启动服务 ==========
app.listen(PORT, () => {
  console.log(`================================================`);
  console.log(`  卡密兑换服务已启动: http://localhost:${PORT}`);
  console.log(`  用户页面: http://localhost:${PORT}/`);
  console.log(`  管理后台: http://localhost:${PORT}/${ADMIN_PATH}`);
  console.log(`  （请保存此地址，/admin.html 已封禁）`);
  console.log(`  卡密总数: ${cards.length} (可用: ${cards.filter(c => c.status === 'unused').length})`);
  console.log(`================================================`);
  if (!getApiKey() || !getBaseUrl()) {
    console.warn('⚠️  接口尚未配置，请登录管理后台 → 系统设置 → 填写 API Key 和 Base URL');
  } else {
    console.log(`✅ 接口已配置: ${getBaseUrl()}`);
  }
});
