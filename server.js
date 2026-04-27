const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
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
const CARD_TYPES = ['plus', 'plus_1y', 'pro', 'pro_20x'];

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

// ========== 设置管理（API Key / Base URL 在后台配置）==========
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
      if (!Array.isArray(parsed.subAdmins)) parsed.subAdmins = [];
      parsed.typedMaintenance = normalizeTypedMaintenanceConfig(parsed.typedMaintenance);
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
    typedMaintenance: createDefaultTypedMaintenance(),
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
function getMaintenanceMessage() { return settings.maintenanceMessage || '系统正在维护中，请稍后再试。'; }

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
    message: isMaintenanceEnabled() ? getMaintenanceMessage() : null
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

// 内存缓存 + 文件持久化
let cards = loadCards();
let records = loadRecords();

// 定期保存（防止意外丢失）
setInterval(() => {
  saveCards(cards);
  saveRecords(records);
}, 30000);

setInterval(() => {
  reconcilePendingJobs().catch((err) => {
    console.error('自动对账循环失败:', err);
  });
}, 15000);

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

function normalizeCardCode(code) {
  return String(code || '').trim().toUpperCase();
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

function getClientIP(req) {
  if (TRUST_PROXY) {
    return req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
  }
  return req.socket?.remoteAddress || req.connection?.remoteAddress || 'unknown';
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
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
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

const SAFE_SUBMIT_REFUND_STATUSES = new Set([400, 401, 402, 503]);
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

function clearManualReviewDetails(record) {
  if (!record) return;
  record.needs_manual_review = false;
  record.manual_review_reason = null;
  record.manual_review_stage = null;
  record.upstream_status_code = null;
  record.upstream_detail = null;
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

const JOB_RECONCILE_INTERVAL_MS = 15000;
const JOB_RECONCILE_BATCH_SIZE = 20;
let reconcileInFlight = false;

function getReconcilableRecords(limit = JOB_RECONCILE_BATCH_SIZE) {
  return records
    .filter((record) => {
      const normalizedStatus = normalizeJobStatus(record.status);
      return !!record.job_id && (normalizedStatus === 'pending' || normalizedStatus === 'processing');
    })
    .slice(0, limit);
}

async function reconcilePendingJobs() {
  if (reconcileInFlight) return;
  if (!getApiKey() || !getBaseUrl()) return;

  const pendingRecords = getReconcilableRecords();
  if (!pendingRecords.length) return;

  reconcileInFlight = true;
  try {
    for (const record of pendingRecords) {
      try {
        await refreshRecordFromUpstream(record, 0);
      } catch (err) {
        console.error(`自动对账任务 ${record.job_id} 失败:`, err.message);
      }
    }
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

// 获取系统设置
app.get('/api/admin/settings', adminAuth, requireSuperAdmin, (req, res) => {
  res.json({
    apiKey: settings.apiKey ? '***已配置***' : '',
    baseUrl: settings.baseUrl || '',
    configured: !!(settings.apiKey && settings.baseUrl),
    maintenanceEnabled: settings.maintenanceEnabled === true,
    maintenanceMessage: settings.maintenanceMessage || '',
    typedMaintenance: getTypedMaintenance()
  });
});

// 保存系统设置
app.post('/api/admin/settings', adminAuth, requireSuperAdmin, (req, res) => {
  const { apiKey, baseUrl } = req.body;

  if (typeof apiKey !== 'undefined' && apiKey !== null) {
    settings.apiKey = apiKey.trim();
  }
  if (typeof baseUrl !== 'undefined' && baseUrl !== null) {
    settings.baseUrl = baseUrl.trim().replace(/\/$/, '');
  }

  saveSettings(settings);
  res.json({
    message: '设置已保存',
    configured: !!(settings.apiKey && settings.baseUrl)
  });
});

// 保存维护模式设置
app.post('/api/admin/maintenance', adminAuth, requireSuperAdmin, (req, res) => {
  const { enabled, message, typedMaintenance } = req.body;
  if (typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'enabled 必须为布尔值' });
  }
  settings.maintenanceEnabled = enabled;
  if (typeof message === 'string') {
    settings.maintenanceMessage = message.trim().slice(0, 500);
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

  if (!count || !Number.isInteger(count) || count < 1 || count > 500) {
    return res.status(400).json({ error: '数量必须是 1-500 的整数' });
  }
  if (!CARD_TYPES.includes(type)) {
    return res.status(400).json({ error: '类型必须是 plus、plus_1y、pro 或 pro_20x' });
  }

  const batchId = uuidv4().substring(0, 8);
  const existingCodes = new Set(cards.map(c => c.code));
  const newCodes = [];

  for (let i = 0; i < count; i++) {
    let code;
    let attempts = 0;
    do {
      code = generateCardCode(type);
      attempts++;
      if (attempts > 100) {
        return res.status(500).json({ error: '生成卡密失败，请重试' });
      }
    } while (existingCodes.has(code));

    existingCodes.add(code);
    newCodes.push(code);
    cards.push({
      id: cards.length + 1,
      code,
      type,
      status: 'unused',
      created_at: nowStr(),
      used_at: null,
      used_by: null,
      batch_id: batchId,
      created_by_username: req.admin?.username || 'super_admin',
      created_by_role: req.admin?.role || 'super_admin'
    });
  }

  saveCards(cards);
  res.json({
    message: `成功生成 ${count} 张 ${type.toUpperCase()} 卡密`,
    batchId,
    count,
    type,
    codes: newCodes
  });
});

// 查看卡密列表
app.get('/api/admin/cards', adminAuth, (req, res) => {
  const { page = 1, pageSize = 20, status, type, search, batch_id } = req.query;
  const pg = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(Math.max(1, parseInt(pageSize) || 20), 100); // 上限 100

  let filtered = cards.filter(card => cardBelongsToSession(card, req.admin));

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
      c.created_at
    ].some(value => String(value || '').toLowerCase().includes(q)));
  }
  if (batch_id) {
    filtered = filtered.filter(c => c.batch_id === batch_id);
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
    const submitRes = await fetch(`${upstreamUrl}/submit`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': getApiKey()
      },
      body: JSON.stringify({
        access_token: access_token,
        workflow: card.type
      })
    });

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
    markRecordUncertain(record, `提交请求结果不确定: ${fetchErrorDetail}`, 'unknown', {
      manual_review_reason: '请求上游时出现网络错误，无法确认是否已成功受理',
      manual_review_stage: 'submit_network_error',
      upstream_detail: fetchErrorDetail
    });
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

    res.status(jobRes.status);
    res.setHeader('Content-Type', contentType);
    res.send(JSON.stringify(payload));
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
  console.log('数据已保存，退出。');
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveCards(cards);
  saveRecords(records);
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
