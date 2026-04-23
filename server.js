const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const TRUST_PROXY = /^(1|true)$/i.test(process.env.TRUST_PROXY || '');

if (TRUST_PROXY) {
  app.set('trust proxy', 1);
}

// ========== 配置 ==========
// 初始密码：从环境变量读取（后台修改后存入 settings.json，重启仍有效）
const INITIAL_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!INITIAL_ADMIN_PASSWORD) {
  console.error('❌ 必须设置 ADMIN_PASSWORD 环境变量后再启动服务');
  process.exit(1);
}

// ========== JSON 文件存储 ==========
const DATA_DIR = path.join(__dirname, 'data');
const CARDS_FILE = path.join(DATA_DIR, 'cards.json');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');

// 确保数据目录存在
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ========== 设置管理（API Key / Base URL 在后台配置）==========
function loadSettings() {
  try {
    if (fs.existsSync(SETTINGS_FILE)) {
      return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('加载设置失败:', e.message);
  }
  return { apiKey: '', baseUrl: '' };
}

function saveSettings(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf-8');
}

// 运行时设置对象（动态，无需重启）
let settings = loadSettings();

// 初始化时如果 settings 中没有密码，写入初始密码
if (!settings.adminPassword) {
  settings.adminPassword = INITIAL_ADMIN_PASSWORD;
  saveSettings(settings);
}

function getAdminPassword() { return settings.adminPassword || INITIAL_ADMIN_PASSWORD; }
function getApiKey() { return settings.apiKey || ''; }
function getBaseUrl() { return settings.baseUrl || ''; }

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

// 兑换：同一 IP 1 分钟内最多 5 次
const redeemAttempts = new Map();
function checkRedeemRate(ip) {
  const now = Date.now();
  const rec = redeemAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60 * 1000; }
  rec.count++;
  redeemAttempts.set(ip, rec);
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
  next();
}

// ========== 工具函数 ==========
function generateCardCode(type) {
  const prefix = type.toUpperCase();
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let random = '';
  for (let i = 0; i < 10; i++) {
    random += chars.charAt(crypto.randomInt(chars.length));
  }
  return `CDK-${prefix}-${random}`;
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

// ========== 管理员 API ==========

// 登录（含暴力破解保护）
app.post('/api/admin/login', (req, res) => {
  const ip = getClientIP(req);
  const rec = checkLoginRate(ip);
  if (rec.count >= 5) {
    return res.status(429).json({ error: `登录尝试次数过多，请 ${Math.ceil((rec.resetAt - Date.now()) / 60000)} 分钟后重试` });
  }
  const { password } = req.body;
  if (!password || password !== getAdminPassword()) {
    recordLoginFail(ip);
    return res.status(401).json({ error: '密码错误' });
  }
  clearLoginAttempts(ip);
  const token = generateSessionToken();
  adminSessions.set(token, { createdAt: Date.now() });
  res.json({ token, message: '登录成功' });
});

// 登出
app.post('/api/admin/logout', adminAuth, (req, res) => {
  const token = req.headers['x-admin-token'];
  adminSessions.delete(token);
  res.json({ message: '已登出' });
});

// 修改管理员密码
app.post('/api/admin/password', adminAuth, (req, res) => {
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

// 获取系统设置
app.get('/api/admin/settings', adminAuth, (req, res) => {
  res.json({
    apiKey: settings.apiKey ? '***已配置***' : '',
    baseUrl: settings.baseUrl || '',
    configured: !!(settings.apiKey && settings.baseUrl)
  });
});

// 保存系统设置
app.post('/api/admin/settings', adminAuth, (req, res) => {
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

// 统计数据
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const stats = {
    plus: {
      total: cards.filter(c => c.type === 'plus').length,
      unused: cards.filter(c => c.type === 'plus' && c.status === 'unused').length,
      used: cards.filter(c => c.type === 'plus' && c.status === 'used').length,
      disabled: cards.filter(c => c.type === 'plus' && c.status === 'disabled').length,
    },
    pro: {
      total: cards.filter(c => c.type === 'pro').length,
      unused: cards.filter(c => c.type === 'pro' && c.status === 'unused').length,
      used: cards.filter(c => c.type === 'pro' && c.status === 'used').length,
      disabled: cards.filter(c => c.type === 'pro' && c.status === 'disabled').length,
    },
    redeemRecords: {
      total: records.length,
      done: records.filter(r => r.status === 'done').length,
      failed: records.filter(r => r.status === 'failed').length,
      pending: records.filter(r => r.status === 'pending' || r.status === 'processing').length,
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
  if (!['plus', 'pro'].includes(type)) {
    return res.status(400).json({ error: '类型必须是 plus 或 pro' });
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
      batch_id: batchId
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

  let filtered = [...cards];

  if (status && status !== 'all') {
    filtered = filtered.filter(c => c.status === status);
  }
  if (type && type !== 'all') {
    filtered = filtered.filter(c => c.type === type);
  }
  if (search) {
    const q = search.toUpperCase();
    filtered = filtered.filter(c => c.code.includes(q));
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
  const { page = 1, pageSize = 20, status, type } = req.query;
  const pg = Math.max(1, parseInt(page) || 1);
  const ps = Math.min(Math.max(1, parseInt(pageSize) || 20), 100); // 上限 100

  let filtered = [...records];

  if (status && status !== 'all') {
    filtered = filtered.filter(r => r.status === status);
  }
  if (type && type !== 'all') {
    filtered = filtered.filter(r => r.card_type === type);
  }

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
    const card = cards.find(c => c.code === code && c.status === 'unused');
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
    const card = cards.find(c => c.code === code && c.status === 'disabled');
    if (card) {
      card.status = 'unused';
      count++;
    }
  }

  saveCards(cards);
  res.json({ message: `成功启用 ${count} 张卡密`, enabled: count });
});

// ========== 用户卡密 API ==========

// 验证卡密
app.post('/api/card/verify', (req, res) => {
  const { code } = req.body;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请输入卡密' });
  }

  const cardCode = code.trim().toUpperCase();
  const card = cards.find(c => c.code === cardCode);

  if (!card) {
    return res.status(404).json({ error: '卡密不存在' });
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
  const clientIP = getClientIP(req);
  if (checkRedeemRate(clientIP) > 5) {
    return res.status(429).json({ error: '操作过于频繁，请 1 分钟后重试' });
  }

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

  const cardCode = code.trim().toUpperCase();

  // 查找并标记卡密（原子性：通过 find 锁定）
  const card = cards.find(c => c.code === cardCode && c.status === 'unused');
  if (!card) {
    return res.status(400).json({ error: '卡密无效或已被使用' });
  }

  // 立即标记为已使用（防止并发）
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
    email: sessionEmail || null,
    access_token_hash: hashAccessToken(access_token),
    job_id: null,
    status: 'pending',
    error_message: null,
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

    if (!submitRes.ok) {
      const errData = await submitRes.json().catch(() => ({ detail: '未知错误' }));
      // 兑换失败，退回卡密
      card.status = 'unused';
      card.used_at = null;
      card.used_by = null;
      card.used_email = null;
      saveCards(cards);
      record.status = 'failed';
      record.error_message = errData.detail || `HTTP ${submitRes.status}`;
      saveRecords(records);
      return res.status(submitRes.status).json({ error: errData.detail || '兑换提交失败' });
    }

    const jobData = await submitRes.json();
    record.status = 'processing';
    record.job_id = jobData.job_id;
    saveRecords(records);

    res.json({
      success: true,
      job_id: jobData.job_id,
      type: card.type,
      status: jobData.status,
      message: '兑换已提交，正在处理中...'
    });

  } catch (err) {
    console.error('兑换请求失败:', err);
    // 网络错误，退回卡密
    card.status = 'unused';
    card.used_at = null;
    card.used_by = null;
    card.used_email = null;
    saveCards(cards);
    record.status = 'failed';
    record.error_message = err.message;
    saveRecords(records);
    res.status(500).json({ error: '兑换服务暂时不可用，卡密已退回' });
  }
});

// ========== 公开卡密查询 API ==========
// 用户可查询自己卡密的状态，邮箱脱敏显示
const queryAttempts = new Map();
function checkQueryRate(ip) {
  const now = Date.now();
  const rec = queryAttempts.get(ip) || { count: 0, resetAt: now + 60 * 1000 };
  if (now > rec.resetAt) { rec.count = 0; rec.resetAt = now + 60 * 1000; }
  rec.count++;
  queryAttempts.set(ip, rec);
  return rec.count;
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return null;
  const [local, domain] = email.split('@');
  if (local.length <= 2) return local[0] + '***@' + domain;
  return local[0] + '*'.repeat(Math.min(local.length - 2, 4)) + local[local.length - 1] + '@' + domain;
}

app.get('/api/card/query', (req, res) => {
  const clientIP = getClientIP(req);
  if (checkQueryRate(clientIP) > 20) {
    return res.status(429).json({ error: '查询过于频繁，请稍后重试' });
  }

  const { code } = req.query;
  if (!code || typeof code !== 'string') {
    return res.status(400).json({ error: '请提供卡密' });
  }

  const cardCode = code.trim().toUpperCase();
  const card = cards.find(c => c.code === cardCode);

  if (!card) {
    return res.status(404).json({ error: '卡密不存在' });
  }

  // 查找对应兑换记录
  const record = records.find(r => r.card_code === cardCode);

  const statusMap = { unused: '未使用', used: '已使用', disabled: '已禁用' };

  res.json({
    code: card.code,
    type: card.type,
    status: card.status,
    status_label: statusMap[card.status] || card.status,
    created_at: card.created_at,
    used_at: card.used_at || null,
    email: card.used_email ? maskEmail(card.used_email) : null,
    redeem_status: record ? record.status : null,
    redeem_status_label: record ? {
      pending: '等待中',
      processing: '处理中',
      done: '兑换成功',
      failed: '兑换失败'
    }[record.status] || record.status : null
  });
});

// 查询兑换任务状态
app.get('/api/card/job/:jobId', async (req, res) => {
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务未配置' });
  }

  const { jobId } = req.params;
  // 校验 jobId 格式，防止路径注入
  if (!/^[a-zA-Z0-9_-]{4,128}$/.test(jobId)) {
    return res.status(400).json({ error: '无效的 Job ID' });
  }
  // wait 最大 30 秒
  const wait = Math.min(Math.max(0, parseInt(req.query.wait) || 0), 30);

  try {
    const upstreamUrl = getBaseUrl();
    const jobRes = await fetch(`${upstreamUrl}/job/${jobId}?wait=${wait}`, {
      headers: { 'X-API-Key': getApiKey() }
    });

    if (!jobRes.ok) {
      return res.status(jobRes.status).json({ error: '查询任务状态失败' });
    }

    const jobData = await jobRes.json();

    // 更新兑换记录状态
    if (jobData.status === 'done' || jobData.status === 'failed') {
      const record = records.find(r => r.job_id === jobId);
      if (record) {
        record.status = jobData.status;
        record.error_message = jobData.error || null;

        // 如果任务失败，退回卡密
        if (jobData.status === 'failed') {
          const card = cards.find(c => c.code === record.card_code && c.status === 'used');
          if (card) {
            card.status = 'unused';
            card.used_at = null;
            card.used_by = null;
            card.used_email = null;
            saveCards(cards);
          }
        }
        saveRecords(records);
      }
    }

    res.json(jobData);
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
