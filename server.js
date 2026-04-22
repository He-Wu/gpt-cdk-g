const express = require('express');
const { createProxyMiddleware } = require('http-proxy-middleware');
const path = require('path');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== 配置 ==========
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Asd=235689030466';

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
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

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
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.connection?.remoteAddress || 'unknown';
}

function nowStr() {
  return new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

// ========== 管理员 API ==========

// 登录
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: '密码错误' });
  }
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
  const pg = parseInt(page);
  const ps = parseInt(pageSize);

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
  const pg = parseInt(page);
  const ps = parseInt(pageSize);

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

// 使用卡密兑换
app.post('/api/card/redeem', async (req, res) => {
  const { code } = req.body;
  let access_token = req.body.access_token;

  if (!code || !access_token) {
    return res.status(400).json({ error: '卡密和 Session 数据不能为空' });
  }

  // 服务端自动解析：支持传入整个 api/auth/session JSON
  if (typeof access_token === 'string' && access_token.trim().startsWith('{')) {
    try {
      const sessionJson = JSON.parse(access_token.trim());
      if (sessionJson.accessToken) {
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
  const clientIP = getClientIP(req);

  // 查找并标记卡密（原子性：通过 find 锁定）
  const card = cards.find(c => c.code === cardCode && c.status === 'unused');
  if (!card) {
    return res.status(400).json({ error: '卡密无效或已被使用' });
  }

  // 立即标记为已使用（防止并发）
  card.status = 'used';
  card.used_at = nowStr();
  card.used_by = hashAccessToken(access_token);
  saveCards(cards);

  // 创建兑换记录
  const record = {
    id: records.length + 1,
    card_code: cardCode,
    card_type: card.type,
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
    saveCards(cards);
    record.status = 'failed';
    record.error_message = err.message;
    saveRecords(records);
    res.status(500).json({ error: '兑换服务暂时不可用，卡密已退回' });
  }
});

// 查询兑换任务状态
app.get('/api/card/job/:jobId', async (req, res) => {
  if (!getApiKey() || !getBaseUrl()) {
    return res.status(503).json({ error: '服务未配置' });
  }

  const { jobId } = req.params;
  const wait = req.query.wait || 0;

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
            saveCards(cards);
          }
        }
        saveRecords(records);
      }
    }

    res.json(jobData);
  } catch (err) {
    console.error('查询任务状态失败:', err);
    res.status(500).json({ error: '查询失败: ' + err.message });
  }
});

// ========== 现有代理功能（保留） ==========
app.use('/api-proxy', createProxyMiddleware({
  target: 'http://placeholder.com',
  router: (req) => {
    const target = req.headers['x-target-url'];
    if (!target) {
      console.error('Missing x-target-url header');
      return null;
    }
    return target.replace(/\/$/, '');
  },
  changeOrigin: true,
  pathRewrite: { '^/api-proxy': '' },
  onProxyReq: (proxyReq, req, res) => {
    console.log(`Proxying: ${req.method} ${req.url} -> ${req.headers['x-target-url']}${req.url}`);
  },
  onError: (err, req, res) => {
    res.status(500).json({ detail: '代理请求失败: ' + err.message });
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
  console.log(`  用户页面: http://localhost:${PORT}/index.html`);
  console.log(`  管理后台: http://localhost:${PORT}/admin.html`);
  console.log(`  卡密总数: ${cards.length} (可用: ${cards.filter(c => c.status === 'unused').length})`);
  console.log(`================================================`);
  if (!getApiKey() || !getBaseUrl()) {
    console.warn('⚠️  接口尚未配置，请登录管理后台 → 系统设置 → 填写 API Key 和 Base URL');
  } else {
    console.log(`✅ 接口已配置: ${getBaseUrl()}`);
  }
});
