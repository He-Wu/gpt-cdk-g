const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const net = require('node:net');
const http = require('node:http');

const REPO_ROOT = path.resolve(__dirname, '..');
const FIXTURE_FILES = ['server.js', 'index.html', 'admin.html', 'cancel.html', 'package.json'];

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function makeTempProject(testName) {
  const slug = testName.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
  const baseDir = await fs.mkdtemp(path.join(REPO_ROOT, 'tests', `.tmp-${slug}-`));

  await Promise.all(FIXTURE_FILES.map(async (file) => {
    await fs.copyFile(path.join(REPO_ROOT, file), path.join(baseDir, file));
  }));

  return baseDir;
}

async function waitForServer(port, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode !== null) {
      throw new Error(`server exited early with code ${child.exitCode}`);
    }

    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      await res.text();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error('server did not become ready in time');
}

async function startServer(testName, env = {}, seed = {}) {
  const cwd = await makeTempProject(testName);
  const port = await getFreePort();
  if (seed.cards || seed.records || seed.settings || seed.costRecords) {
    await fs.mkdir(path.join(cwd, 'data'), { recursive: true });
    if (seed.cards) {
      await fs.writeFile(path.join(cwd, 'data', 'cards.json'), JSON.stringify(seed.cards, null, 2), 'utf-8');
    }
    if (seed.records) {
      await fs.writeFile(path.join(cwd, 'data', 'records.json'), JSON.stringify(seed.records, null, 2), 'utf-8');
    }
    if (seed.settings) {
      await fs.writeFile(path.join(cwd, 'data', 'settings.json'), JSON.stringify(seed.settings, null, 2), 'utf-8');
    }
    if (seed.costRecords) {
      await fs.writeFile(path.join(cwd, 'data', 'cost-records.json'), JSON.stringify(seed.costRecords, null, 2), 'utf-8');
    }
  }
  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env: {
      ...process.env,
      PORT: String(port),
      ADMIN_PASSWORD: 'correct horse battery staple',
      ADMIN_PATH: 'secret-admin',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(port, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${stderr}`.trim());
  }

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(cwd, { recursive: true, force: true });
  };

  return { port, cwd, stop };
}

async function startServerWithoutAdminPassword(testName) {
  const cwd = await makeTempProject(testName);
  const port = await getFreePort();
  const env = { ...process.env, PORT: String(port), ADMIN_PATH: 'secret-admin' };
  delete env.ADMIN_PASSWORD;

  const child = spawn(process.execPath, ['server.js'], {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await waitForServer(port, child);
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}\n${stderr}`.trim());
  }

  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    await fs.rm(cwd, { recursive: true, force: true });
  };

  return { port, cwd, stop };
}

async function startMockUpstream(handler) {
  const port = await getFreePort();
  const server = http.createServer(handler);

  await new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', resolve);
    server.on('error', reject);
  });

  return {
    port,
    baseUrl: `http://127.0.0.1:${port}`,
    stop: () => new Promise((resolve) => server.close(resolve))
  };
}

async function requestJson(port, pathName, options = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathName}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  return {
    res,
    data: text ? JSON.parse(text) : null
  };
}

function formatShanghaiRecordTime(timestampMs) {
  const date = new Date(timestampMs + 8 * 60 * 60 * 1000);
  const yyyy = date.getUTCFullYear();
  const mm = date.getUTCMonth() + 1;
  const dd = date.getUTCDate();
  const hh = date.getUTCHours();
  const mi = date.getUTCMinutes();
  const ss = date.getUTCSeconds();
  return `${yyyy}/${mm}/${dd} ${hh}:${mi}:${ss}`;
}

async function loginAdmin(port) {
  const { data } = await requestJson(port, '/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'correct horse battery staple' })
  });
  return data.token;
}

async function loginSubAdmin(port, username, password) {
  return requestJson(port, '/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username, password })
  });
}

async function createSubAdmin(port, token, username, password) {
  return requestJson(port, '/api/admin/sub-admins', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ username, password })
  });
}

async function configureUpstream(port, token, baseUrl) {
  const { res } = await requestJson(port, '/api/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ apiKey: 'test-api-key', baseUrl })
  });
  assert.equal(res.status, 200);
}

async function updateMaintenance(port, token, body) {
  return requestJson(port, '/api/admin/maintenance', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify(body)
  });
}

async function generateOneCard(port, token, type = 'plus', overrides = {}) {
  const { res, data } = await requestJson(port, '/api/admin/cards/generate', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({
      count: 1,
      type,
      remark: '测试生成',
      cost: 10,
      sale_price: 20,
      ...overrides
    })
  });
  assert.equal(res.status, 200);
  return data.codes[0];
}

async function redeemCard(port, code) {
  return requestJson(port, '/api/card/redeem', {
    method: 'POST',
    body: JSON.stringify({
      code,
      access_token: `eyJ.${'a'.repeat(120)}.${'b'.repeat(40)}`
    })
  });
}

async function redeemCardWithSessionJson(port, code, email) {
  return requestJson(port, '/api/card/redeem', {
    method: 'POST',
    body: JSON.stringify({
      code,
      access_token: JSON.stringify({
        user: { id: 'user-test', email },
        expires: '2099-01-01T00:00:00.000Z',
        accessToken: `eyJ.${'s'.repeat(120)}.${'t'.repeat(40)}`
      })
    })
  });
}

async function queryCard(port, code) {
  return requestJson(port, `/api/card/query?code=${encodeURIComponent(code)}`);
}

async function queryCardsBatch(port, codes) {
  return requestJson(port, '/api/card/query/batch', {
    method: 'POST',
    body: JSON.stringify({ codes })
  });
}

async function adminQueryCardsBatch(port, token, codes) {
  return requestJson(port, '/api/admin/cards/query/batch', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ codes })
  });
}

async function adminReplaceCards(port, token, codes) {
  return requestJson(port, '/api/admin/cards/replace', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ codes })
  });
}

async function verifyCard(port, code) {
  return requestJson(port, '/api/card/verify', {
    method: 'POST',
    body: JSON.stringify({ code })
  });
}

async function verifyCardFromIp(port, code, ip) {
  return requestJson(port, '/api/card/verify', {
    method: 'POST',
    headers: { 'X-Forwarded-For': ip },
    body: JSON.stringify({ code })
  });
}

async function cancelJob(port, jobId, code) {
  const body = code ? { code, job_id: jobId } : { job_id: jobId };
  return requestJson(port, '/api/card/cancel', {
    method: 'POST',
    body: JSON.stringify(body)
  });
}

async function adminCancelJob(port, token, jobId) {
  return requestJson(port, '/api/admin/job/cancel', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ job_id: jobId })
  });
}

async function adminCancelRecord(port, token, recordId) {
  return requestJson(port, '/api/admin/job/cancel', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ record_id: recordId })
  });
}

async function adminMarkRecordSuccess(port, token, recordId) {
  return requestJson(port, `/api/admin/records/${encodeURIComponent(recordId)}/mark-success`, {
    method: 'POST',
    headers: { 'X-Admin-Token': token }
  });
}

async function adminMarkRecordFailed(port, token, recordId) {
  return requestJson(port, `/api/admin/records/${encodeURIComponent(recordId)}/mark-failed`, {
    method: 'POST',
    headers: { 'X-Admin-Token': token }
  });
}

async function adminDiagnoseRecord(port, token, recordId, wait = 0) {
  return requestJson(port, `/api/admin/records/${encodeURIComponent(recordId)}/diagnose?wait=${wait}`, {
    headers: { 'X-Admin-Token': token }
  });
}

async function adminQueryJobStatus(port, token, jobId, wait = 0) {
  return requestJson(port, `/api/admin/job-status/${encodeURIComponent(jobId)}?wait=${wait}`, {
    headers: { 'X-Admin-Token': token }
  });
}

async function queryQueue(port, workflow) {
  const suffix = workflow ? `?workflow=${encodeURIComponent(workflow)}` : '';
  return requestJson(port, `/api/card/queue${suffix}`);
}

test('admin.html is not directly accessible but the configured admin path is', async () => {
  const server = await startServer('admin page routing');

  try {
    const hiddenRes = await fetch(`http://127.0.0.1:${server.port}/admin.html`);
    assert.equal(hiddenRes.status, 404);

    const adminRes = await fetch(`http://127.0.0.1:${server.port}/secret-admin`);
    assert.equal(adminRes.status, 200);
    assert.match(await adminRes.text(), /<title>/i);
  } finally {
    await server.stop();
  }
});

test('login rate limiting ignores spoofed x-forwarded-for headers', async () => {
  const server = await startServer('spoofed xff rate limit');

  try {
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/admin/login`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Forwarded-For': `198.51.100.${i + 1}`
        },
        body: JSON.stringify({ password: 'wrong-password' })
      });
      statuses.push(res.status);
      await res.text();
    }

    assert.deepEqual(statuses.slice(0, 5), [401, 401, 401, 401, 401]);
    assert.equal(statuses[5], 429);
  } finally {
    await server.stop();
  }
});

test('trusted proxy real ip is saved on redeem records', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-real-ip' }));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ detail: 'not found' }));
  });
  const server = await startServer('trusted proxy real ip', { TRUST_PROXY: '1' });

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await requestJson(server.port, '/api/card/redeem', {
      method: 'POST',
      headers: { 'X-Real-IP': '203.0.113.66' },
      body: JSON.stringify({
        code,
        access_token: `eyJ.${'a'.repeat(120)}.${'b'.repeat(40)}`
      })
    });
    assert.equal(redeem.res.status, 200);

    const recordsRes = await requestJson(server.port, `/api/admin/records?search=${encodeURIComponent(code)}`, {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records[0].ip_address, '203.0.113.66');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('server starts without ADMIN_PASSWORD by generating a saved admin password', async () => {
  const server = await startServerWithoutAdminPassword('starts without admin password');

  try {
    const settings = JSON.parse(await fs.readFile(path.join(server.cwd, 'data', 'settings.json'), 'utf-8'));
    assert.equal(typeof settings.adminPassword, 'string');
    assert.ok(settings.adminPassword.length >= 24);

    const login = await requestJson(server.port, '/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: settings.adminPassword })
    });
    assert.equal(login.res.status, 200);
  } finally {
    await server.stop();
  }
});

test('admin settings can configure public user notice dynamically', async () => {
  const server = await startServer('dynamic user notice settings');

  try {
    const token = await loginAdmin(server.port);
    const saved = await requestJson(server.port, '/api/admin/settings', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        userNotice: {
          enabled: true,
          zhTitle: '兑换提示',
          zhBody: '请确认账号状态后再提交。',
          enTitle: 'Redeem Notice',
          enBody: 'Confirm your account status before submitting.'
        }
      })
    });
    assert.equal(saved.res.status, 200);

    const adminSettings = await requestJson(server.port, '/api/admin/settings', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(adminSettings.res.status, 200);
    assert.equal(adminSettings.data.userNotice.enabled, true);
    assert.equal(adminSettings.data.userNotice.zhTitle, '兑换提示');
    assert.equal(adminSettings.data.userNotice.enBody, 'Confirm your account status before submitting.');

    const status = await requestJson(server.port, '/api/status');
    assert.equal(status.res.status, 200);
    assert.equal(status.data.userNotice.enabled, true);
    assert.equal(status.data.userNotice.zhBody, '请确认账号状态后再提交。');
  } finally {
    await server.stop();
  }
});

test('admin settings can configure public user page channel name', async () => {
  const server = await startServer('public channel name settings');

  try {
    const token = await loginAdmin(server.port);
    const saved = await requestJson(server.port, '/api/admin/settings', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({ channelName: '91' })
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.data.channelName, '91');

    const adminSettings = await requestJson(server.port, '/api/admin/settings', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(adminSettings.res.status, 200);
    assert.equal(adminSettings.data.channelName, '91');

    const status = await requestJson(server.port, '/api/status');
    assert.equal(status.res.status, 200);
    assert.equal(status.data.channelName, '91');
  } finally {
    await server.stop();
  }
});

test('admin settings can configure default card cost and generated cards store commercial fields', async () => {
  const server = await startServer('default card cost and commercial fields');

  try {
    const token = await loginAdmin(server.port);
    const saved = await requestJson(server.port, '/api/admin/settings', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({ defaultCost: 12.5 })
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.data.defaultCost, 12.5);

    const generated = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 2,
        type: 'plus',
        remark: '首批客户退款补发',
        sale_price: 39.9
      })
    });
    assert.equal(generated.res.status, 200);
    assert.equal(generated.data.count, 2);

    const cardsRes = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(cardsRes.res.status, 200);
    const generatedCards = cardsRes.data.cards.filter((card) => generated.data.codes.includes(card.code));
    assert.equal(generatedCards.length, 2);
    assert.ok(generatedCards.every((card) => card.remark === '首批客户退款补发'));
    assert.ok(generatedCards.every((card) => card.cost === 12.5));
    assert.ok(generatedCards.every((card) => card.sale_price === 39.9));
  } finally {
    await server.stop();
  }
});

test('super admin cost records calculate weighted cost and seed generated card cost', async () => {
  const server = await startServer('cost records weighted average');

  try {
    const token = await loginAdmin(server.port);
    const purchase = await requestJson(server.port, '/api/admin/cost-records', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        record_type: 'purchase',
        card_type: 'plus',
        quantity: 10,
        total_cost: 80,
        supplier: '上游 A',
        remark: '首批进货'
      })
    });
    assert.equal(purchase.res.status, 200);
    assert.equal(purchase.data.record.unit_cost, 8);
    assert.equal(purchase.data.summary.by_type.plus.current_average_cost, 8);

    const generated = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 1,
        type: 'plus',
        remark: '按进货成本生成',
        sale_price: 20
      })
    });
    assert.equal(generated.res.status, 200);
    assert.equal(generated.data.cost, 8);

    const summaryRes = await requestJson(server.port, '/api/admin/cost-records', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(summaryRes.res.status, 200);
    assert.equal(summaryRes.data.summary.by_type.plus.purchase_quantity, 10);
    assert.equal(summaryRes.data.summary.by_type.plus.remaining_quantity, 9);
    assert.equal(summaryRes.data.summary.by_type.plus.remaining_cost, 72);

    const created = await createSubAdmin(server.port, token, 'cost_reader', 'sub-admin-pass-123');
    assert.equal(created.res.status, 200);
    const subLogin = await loginSubAdmin(server.port, 'cost_reader', 'sub-admin-pass-123');
    assert.equal(subLogin.res.status, 200);
    const blocked = await requestJson(server.port, '/api/admin/cost-records', {
      headers: { 'X-Admin-Token': subLogin.data.token }
    });
    assert.equal(blocked.res.status, 403);
  } finally {
    await server.stop();
  }
});

test('admin compensation card generation uses original card cost and zero sale price', async () => {
  const originalCode = 'CDK-PLUS-COMPA-AAAAA-AAAAA-AAAAA-AAAAA';
  const unusedCode = 'CDK-PLUS-COMPB-BBBBB-BBBBB-BBBBB-BBBBB';
  const legacyNoCostCode = 'CDK-PLUS-COMPC-CCCCC-CCCCC-CCCCC-CCCCC';
  const server = await startServer('compensation card generation', {}, {
    cards: [
      {
        id: 1,
        code: originalCode,
        type: 'plus',
        status: 'used',
        created_at: '2026/4/24 10:00:00',
        used_at: '2026/4/24 10:20:00',
        used_by: 'hash-used',
        used_email: 'buyer@example.com',
        cost: 12.5,
        sale_price: 39,
        batch_id: 'comp-a'
      },
      {
        id: 2,
        code: unusedCode,
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        batch_id: 'comp-b'
      },
      {
        id: 3,
        code: legacyNoCostCode,
        type: 'plus',
        status: 'used',
        created_at: '2026/4/24 10:30:00',
        used_at: '2026/4/24 10:40:00',
        used_by: 'hash-legacy',
        used_email: 'legacy@example.com',
        batch_id: 'comp-c'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const saved = await requestJson(server.port, '/api/admin/settings', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({ defaultCost: 18 })
    });
    assert.equal(saved.res.status, 200);

    const unusedCompensation = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 1,
        type: 'plus',
        issue_type: 'compensation',
        original_code: unusedCode
      })
    });
    assert.equal(unusedCompensation.res.status, 400);
    assert.match(unusedCompensation.data.error, /必须已使用/);

    const generated = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 1,
        type: 'plus',
        issue_type: 'compensation',
        original_code: originalCode,
        cost: 1,
        sale_price: 99
      })
    });
    assert.equal(generated.res.status, 200);
    assert.equal(generated.data.issue_type, 'compensation');
    assert.equal(generated.data.compensation_for_code, originalCode);
    assert.equal(generated.data.compensation_reason, '充值未到账补卡');
    assert.equal(generated.data.cost, 12.5);
    assert.equal(generated.data.sale_price, 0);

    const duplicate = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 1,
        type: 'plus',
        issue_type: 'compensation',
        original_code: originalCode,
        compensation_reason: '再次补卡'
      })
    });
    assert.equal(duplicate.res.status, 409);

    const legacyGenerated = await requestJson(server.port, '/api/admin/cards/generate', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({
        count: 1,
        type: 'plus',
        issue_type: 'compensation',
        original_code: legacyNoCostCode,
        compensation_reason: '旧数据无成本补卡'
      })
    });
    assert.equal(legacyGenerated.res.status, 200);
    assert.equal(legacyGenerated.data.cost, 18);
    assert.equal(legacyGenerated.data.sale_price, 0);

    const cardsRes = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(cardsRes.res.status, 200);
    const card = cardsRes.data.cards.find((item) => item.code === generated.data.codes[0]);
    assert.equal(card.remark, '充值未到账补卡');
    assert.equal(card.cost, 12.5);
    assert.equal(card.sale_price, 0);
    assert.equal(card.issue_type, 'compensation');
    assert.equal(card.compensation_reason, '充值未到账补卡');
    assert.equal(card.compensation_for_code, originalCode);

    const oldCard = cardsRes.data.cards.find((item) => item.code === originalCode);
    assert.equal(oldCard.compensation_code, generated.data.codes[0]);
    assert.equal(oldCard.compensation_reason, '充值未到账补卡');

    const legacyCompensation = cardsRes.data.cards.find((item) => item.code === legacyGenerated.data.codes[0]);
    assert.equal(legacyCompensation.cost, 18);
    assert.equal(legacyCompensation.compensation_for_code, legacyNoCostCode);
  } finally {
    await server.stop();
  }
});

test('admin maintenance can configure localized public messages', async () => {
  const server = await startServer('localized maintenance messages');

  try {
    const token = await loginAdmin(server.port);
    const saved = await updateMaintenance(server.port, token, {
      enabled: true,
      messageZh: '系统升级中，请稍后再试。',
      messageEn: 'System upgrade in progress. Please try again later.'
    });
    assert.equal(saved.res.status, 200);
    assert.equal(saved.data.maintenanceMessages.zh, '系统升级中，请稍后再试。');
    assert.equal(saved.data.maintenanceMessages.en, 'System upgrade in progress. Please try again later.');

    const status = await requestJson(server.port, '/api/status');
    assert.equal(status.res.status, 200);
    assert.equal(status.data.maintenance, true);
    assert.equal(status.data.maintenanceMessages.zh, '系统升级中，请稍后再试。');
    assert.equal(status.data.maintenanceMessages.en, 'System upgrade in progress. Please try again later.');
  } finally {
    await server.stop();
  }
});

test('type maintenance blocks only the targeted card type during verify', async () => {
  const server = await startServer('type maintenance verify gate', {}, {
    settings: {
      adminPassword: 'correct horse battery staple',
      apiKey: '',
      baseUrl: '',
      maintenanceEnabled: false,
      maintenanceMessage: '',
      typedMaintenance: {
        plus: { enabled: false, message: '' },
        plus_1y: { enabled: false, message: '' },
        pro: { enabled: false, message: '' },
        pro_20x: { enabled: true, message: 'pro 20x paused' }
      },
      subAdmins: []
    },
    cards: [
      { id: 1, code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', type: 'plus', status: 'unused', created_at: '2026/4/24 10:00:00', used_at: null, used_by: null, batch_id: 'plus' },
      { id: 2, code: 'CDK-PRO_20X-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB', type: 'pro_20x', status: 'unused', created_at: '2026/4/24 10:01:00', used_at: null, used_by: null, batch_id: 'pro20x' }
    ]
  });

  try {
    const blocked = await verifyCard(server.port, 'CDK-PRO_20X-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB');
    assert.equal(blocked.res.status, 503);
    assert.equal(blocked.data.maintenance, true);
    assert.equal(blocked.data.maintenance_scope, 'type');
    assert.equal(blocked.data.type, 'pro_20x');
    assert.match(blocked.data.error, /pro 20x paused/i);

    const allowed = await verifyCard(server.port, 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA');
    assert.equal(allowed.res.status, 200);
    assert.equal(allowed.data.valid, true);
    assert.equal(allowed.data.type, 'plus');
  } finally {
    await server.stop();
  }
});

test('redeem rechecks type maintenance enabled after verification', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-should-not-submit', status: 'pending' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('type maintenance redeem recheck');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token, 'pro');

    const verified = await verifyCard(server.port, code);
    assert.equal(verified.res.status, 200);

    const maintenance = await updateMaintenance(server.port, token, {
      enabled: false,
      message: '',
      typedMaintenance: {
        plus: { enabled: false, message: '' },
        plus_1y: { enabled: false, message: '' },
        pro: { enabled: true, message: 'pro paused' },
        pro_20x: { enabled: false, message: '' }
      }
    });
    assert.equal(maintenance.res.status, 200);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 503);
    assert.equal(redeem.data.maintenance, true);
    assert.equal(redeem.data.maintenance_scope, 'type');
    assert.equal(redeem.data.type, 'pro');
    assert.match(redeem.data.error, /pro paused/i);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('admin stats counts plus total as monthly plus plus one year cards', async () => {
  const server = await startServer('admin plus aggregate stats', {}, {
    cards: [
      { id: 1, code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', type: 'plus', status: 'unused', created_at: '2026/4/23 12:00:00', used_at: null, used_by: null, batch_id: 'a' },
      { id: 2, code: 'CDK-PLUS_1Y-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB', type: 'plus_1y', status: 'unused', created_at: '2026/4/23 12:00:00', used_at: null, used_by: null, batch_id: 'b' },
      { id: 3, code: 'CDK-PLUS_1Y-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC', type: 'plus_1y', status: 'used', created_at: '2026/4/23 12:00:00', used_at: '2026/4/23 12:01:00', used_by: 'hash', batch_id: 'b' },
      { id: 4, code: 'CDK-PRO-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD', type: 'pro', status: 'unused', created_at: '2026/4/23 12:00:00', used_at: null, used_by: null, batch_id: 'c' },
      { id: 5, code: 'CDK-PRO_20X-EEEEE-EEEEE-EEEEE-EEEEE-EEEEE', type: 'pro_20x', status: 'used', created_at: '2026/4/23 12:00:00', used_at: '2026/4/23 12:02:00', used_by: 'hash2', batch_id: 'd' }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const { res, data } = await requestJson(server.port, '/api/admin/stats', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(res.status, 200);
    assert.equal(data.plus.total, 3);
    assert.equal(data.plus.unused, 2);
    assert.equal(data.plus.used, 1);
    assert.equal(data.plus_monthly.total, 1);
    assert.equal(data.plus_1y.total, 2);
    assert.equal(data.pro.total, 1);
    assert.equal(data.pro_20x.total, 1);
    assert.equal(data.pro_total.total, 2);
    assert.equal(data.pro_total.unused, 1);
    assert.equal(data.pro_total.used, 1);
  } finally {
    await server.stop();
  }
});

test('admin system endpoint returns host cpu memory disk and process metrics', async () => {
  const server = await startServer('admin system metrics');

  try {
    const token = await loginAdmin(server.port);
    const { res, data } = await requestJson(server.port, '/api/admin/system', {
      headers: { 'X-Admin-Token': token }
    });

    assert.equal(res.status, 200);
    assert.equal(typeof data.collected_at, 'string');
    assert.equal(typeof data.host.hostname, 'string');
    assert.equal(typeof data.cpu.usage_percent, 'number');
    assert.ok(data.cpu.cores >= 1);
    assert.ok(data.memory.total > 0);
    assert.ok(data.memory.used >= 0);
    assert.equal(typeof data.memory.usage_percent, 'number');
    assert.ok(data.disk === null || typeof data.disk === 'object');
    assert.equal(typeof data.process.node_version, 'string');
    assert.equal(typeof data.process.uptime_seconds, 'number');
  } finally {
    await server.stop();
  }
});

test('admin stats fetches available totals from upstream balance api', async () => {
  let balanceCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'GET' && req.url === '/balance') {
      balanceCalled++;
      assert.equal(req.headers['x-api-key'], 'test-api-key');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        balances: {
          plus: 12,
          plus_1y: 4,
          pro: 2
        }
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin stats upstream balances', {}, {
    cards: [
      { id: 1, code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA', type: 'plus', status: 'unused', created_at: '2026/4/23 12:00:00', used_at: null, used_by: null, batch_id: 'a' },
      { id: 2, code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB', type: 'pro', status: 'unused', created_at: '2026/4/23 12:00:00', used_at: null, used_by: null, batch_id: 'b' }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const { res, data } = await requestJson(server.port, '/api/admin/stats', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(res.status, 200);
    assert.equal(balanceCalled, 1);
    assert.deepEqual(data.apiBalances, { plus: 12, plus_1y: 4, pro: 2 });
    assert.equal(data.apiBalanceTotal.plus, 16);
    assert.equal(data.apiBalanceTotal.pro, 2);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('admin stats returns ranged redeem summaries for recent windows', async () => {
  const now = Date.now();
  const server = await startServer('admin stats redeem range summary', {}, {
    records: [
      {
        id: 1,
        card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        card_type: 'plus',
        job_id: 'job-range-1',
        status: 'done',
        error_message: null,
        created_at: formatShanghaiRecordTime(now - 10 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        job_id: 'job-range-2',
        status: 'failed',
        error_message: 'payment rejected',
        created_at: formatShanghaiRecordTime(now - 20 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 3,
        card_code: 'CDK-PLUS_1Y-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
        card_type: 'plus_1y',
        job_id: 'job-range-3',
        status: 'done',
        error_message: null,
        created_at: formatShanghaiRecordTime(now - 50 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 4,
        card_code: 'CDK-PRO_20X-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD',
        card_type: 'pro_20x',
        job_id: 'job-range-4',
        status: 'done',
        error_message: null,
        created_at: formatShanghaiRecordTime(now - 26 * 60 * 60 * 1000),
        ip_address: '127.0.0.1'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);

    const recent = await requestJson(server.port, '/api/admin/stats?range=1h', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recent.res.status, 200);
    assert.equal(recent.data.redeemSummary.range, '1h');
    assert.equal(recent.data.redeemSummary.done, 2);
    assert.equal(recent.data.redeemSummary.failed, 1);
    assert.equal(recent.data.redeemSummary.success_by_type.plus, 1);
    assert.equal(recent.data.redeemSummary.success_by_type.plus_1y, 1);
    assert.equal(recent.data.redeemSummary.success_by_type.pro, 0);
    assert.equal(recent.data.redeemSummary.success_by_type.pro_20x, 0);

    const all = await requestJson(server.port, '/api/admin/stats?range=all', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(all.res.status, 200);
    assert.equal(all.data.redeemSummary.range, 'all');
    assert.equal(all.data.redeemSummary.done, 3);
    assert.equal(all.data.redeemSummary.failed, 1);
    assert.equal(all.data.redeemSummary.success_by_type.pro_20x, 1);
  } finally {
    await server.stop();
  }
});

test('admin stats thirty minute window parses stored shanghai timestamps correctly', async () => {
  const now = Date.now();
  const server = await startServer('admin stats thirty minute shanghai window', {}, {
    records: [
      {
        id: 1,
        card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        card_type: 'plus',
        job_id: 'job-29-minutes',
        status: 'done',
        error_message: null,
        created_at: formatShanghaiRecordTime(now - 29 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        job_id: 'job-31-minutes',
        status: 'done',
        error_message: null,
        created_at: formatShanghaiRecordTime(now - 31 * 60 * 1000),
        ip_address: '127.0.0.1'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const recent = await requestJson(server.port, '/api/admin/stats?range=30m', {
      headers: { 'X-Admin-Token': token }
    });

    assert.equal(recent.res.status, 200);
    assert.equal(recent.data.redeemSummary.range, '30m');
    assert.equal(recent.data.redeemSummary.done, 1);
    assert.equal(recent.data.redeemSummary.success_by_type.plus, 1);
    assert.equal(recent.data.redeemSummary.success_by_type.pro, 0);
  } finally {
    await server.stop();
  }
});

test('admin records can be searched by card code job id email ip or error', async () => {
  const server = await startServer('admin records search', {}, {
    records: [
      {
        id: 1,
        card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        card_type: 'plus',
        email: 'alpha@example.com',
        job_id: 'job-alpha',
        status: 'done',
        error_message: null,
        created_at: '2026/4/23 12:00:00',
        ip_address: '203.0.113.10'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        email: 'beta@example.com',
        job_id: 'job-beta',
        status: 'failed',
        error_message: 'payment rejected',
        created_at: '2026/4/23 12:01:00',
        ip_address: '203.0.113.20'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const byJob = await requestJson(server.port, '/api/admin/records?search=job-beta', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(byJob.res.status, 200);
    assert.equal(byJob.data.total, 1);
    assert.equal(byJob.data.records[0].id, 2);

    const byEmail = await requestJson(server.port, '/api/admin/records?search=alpha@example.com', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(byEmail.data.total, 1);
    assert.equal(byEmail.data.records[0].id, 1);

    const byError = await requestJson(server.port, '/api/admin/records?search=rejected', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(byError.data.total, 1);
    assert.equal(byError.data.records[0].id, 2);
  } finally {
    await server.stop();
  }
});

test('super admin can create a sub admin who logs in with username and generates attributed cards', async () => {
  const server = await startServer('sub admin create and login');

  try {
    const adminToken = await loginAdmin(server.port);
    const created = await createSubAdmin(server.port, adminToken, 'alice_ops', 'sub-admin-pass-123');
    assert.equal(created.res.status, 200);
    assert.equal(created.data.subAdmin.username, 'alice_ops');
    assert.equal(created.data.subAdmin.status, 'active');

    const subLogin = await loginSubAdmin(server.port, 'alice_ops', 'sub-admin-pass-123');
    assert.equal(subLogin.res.status, 200);
    assert.equal(subLogin.data.username, 'alice_ops');
    assert.equal(subLogin.data.role, 'sub_admin');

    const code = await generateOneCard(server.port, subLogin.data.token, 'plus');
    const cardsRes = await requestJson(server.port, '/api/admin/cards', {
      headers: { 'X-Admin-Token': subLogin.data.token }
    });

    assert.equal(cardsRes.res.status, 200);
    assert.equal(cardsRes.data.total, 1);
    assert.equal(cardsRes.data.cards[0].code, code);
    assert.equal(cardsRes.data.cards[0].created_by_username, 'alice_ops');
    assert.equal(cardsRes.data.cards[0].created_by_role, 'sub_admin');
  } finally {
    await server.stop();
  }
});

test('super admin can impersonate a sub admin account to view scoped data', async () => {
  const server = await startServer('sub admin impersonation');

  try {
    const adminToken = await loginAdmin(server.port);
    const created = await createSubAdmin(server.port, adminToken, 'viewer_ops', 'sub-admin-pass-123');
    assert.equal(created.res.status, 200);

    const impersonated = await requestJson(server.port, `/api/admin/sub-admins/${created.data.subAdmin.id}/impersonate`, {
      method: 'POST',
      headers: { 'X-Admin-Token': adminToken }
    });
    assert.equal(impersonated.res.status, 200);
    assert.equal(impersonated.data.role, 'sub_admin');
    assert.equal(impersonated.data.username, 'viewer_ops');
    assert.equal(impersonated.data.impersonatedBy, 'super_admin');
    assert.equal(impersonated.data.permissions.manage_accounts, false);

    const ownCode = await generateOneCard(server.port, impersonated.data.token, 'plus', {
      remark: '模拟登录生成',
      cost: 8,
      sale_price: 18
    });
    await generateOneCard(server.port, adminToken, 'plus', {
      remark: '主管理员生成',
      cost: 9,
      sale_price: 19
    });

    const scopedCards = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': impersonated.data.token }
    });
    assert.equal(scopedCards.res.status, 200);
    assert.equal(scopedCards.data.total, 1);
    assert.equal(scopedCards.data.cards[0].code, ownCode);
    assert.equal(scopedCards.data.cards[0].created_by_username, 'viewer_ops');

    const settingsBlocked = await requestJson(server.port, '/api/admin/settings', {
      headers: { 'X-Admin-Token': impersonated.data.token }
    });
    assert.equal(settingsBlocked.res.status, 403);

    const nestedBlocked = await requestJson(server.port, `/api/admin/sub-admins/${created.data.subAdmin.id}/impersonate`, {
      method: 'POST',
      headers: { 'X-Admin-Token': impersonated.data.token }
    });
    assert.equal(nestedBlocked.res.status, 403);
  } finally {
    await server.stop();
  }
});

test('sub admins can only access their own cards and records and cannot open admin-only settings', async () => {
  const server = await startServer('sub admin scoped data access', {}, {
    settings: {
      adminPassword: 'correct horse battery staple',
      apiKey: '',
      baseUrl: '',
      subAdmins: [
        {
          id: 'sub-1',
          username: 'alice_ops',
          passwordHash: 'plain:sub-admin-pass-123',
          status: 'active',
          created_at: '2026/4/24 10:00:00'
        }
      ]
    },
    cards: [
      {
        id: 1,
        code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        batch_id: 'sub-a',
        created_by_username: 'alice_ops',
        created_by_role: 'sub_admin'
      },
      {
        id: 2,
        code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        type: 'pro',
        status: 'unused',
        created_at: '2026/4/24 10:20:00',
        used_at: null,
        used_by: null,
        batch_id: 'root-a',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      }
    ],
    records: [
      {
        id: 1,
        card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        card_type: 'plus',
        job_id: 'job-sub-1',
        status: 'done',
        error_message: null,
        created_at: '2026/4/24 10:30:00',
        ip_address: '203.0.113.10',
        created_by_username: 'alice_ops',
        created_by_role: 'sub_admin'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        job_id: 'job-root-1',
        status: 'failed',
        error_message: 'manual failure',
        created_at: '2026/4/24 10:40:00',
        ip_address: '203.0.113.20',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      }
    ]
  });

  try {
    const subLogin = await loginSubAdmin(server.port, 'alice_ops', 'sub-admin-pass-123');
    assert.equal(subLogin.res.status, 200);

    const cardsRes = await requestJson(server.port, '/api/admin/cards', {
      headers: { 'X-Admin-Token': subLogin.data.token }
    });
    assert.equal(cardsRes.res.status, 200);
    assert.equal(cardsRes.data.total, 1);
    assert.equal(cardsRes.data.cards[0].created_by_username, 'alice_ops');

    const recordsRes = await requestJson(server.port, '/api/admin/records', {
      headers: { 'X-Admin-Token': subLogin.data.token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.total, 1);
    assert.equal(recordsRes.data.records[0].created_by_username, 'alice_ops');

    const settingsRes = await requestJson(server.port, '/api/admin/settings', {
      headers: { 'X-Admin-Token': subLogin.data.token }
    });
    assert.equal(settingsRes.res.status, 403);
  } finally {
    await server.stop();
  }
});

test('admin cards support created and used minute range filtering', async () => {
  const server = await startServer('admin cards datetime range filters', {}, {
    cards: [
      {
        id: 1,
        code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        batch_id: 'range-a'
      },
      {
        id: 2,
        code: 'CDK-PLUS-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        type: 'plus',
        status: 'used',
        created_at: '2026/4/24 10:35:00',
        used_at: '2026/4/24 11:15:00',
        used_by: 'hash-b',
        batch_id: 'range-b'
      },
      {
        id: 3,
        code: 'CDK-PLUS-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
        type: 'plus',
        status: 'used',
        created_at: '2026/4/24 11:05:00',
        used_at: '2026/4/24 12:00:00',
        used_by: 'hash-c',
        batch_id: 'range-c'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const createdRange = await requestJson(
      server.port,
      '/api/admin/cards?created_from=2026-04-24T10:30&created_to=2026-04-24T11:00',
      { headers: { 'X-Admin-Token': token } }
    );
    assert.equal(createdRange.res.status, 200);
    assert.deepEqual(createdRange.data.cards.map((card) => card.id), [2]);

    const usedRange = await requestJson(
      server.port,
      '/api/admin/cards?used_from=2026-04-24T11:00&used_to=2026-04-24T11:30',
      { headers: { 'X-Admin-Token': token } }
    );
    assert.equal(usedRange.res.status, 200);
    assert.deepEqual(usedRange.data.cards.map((card) => card.id), [2]);
  } finally {
    await server.stop();
  }
});

test('uncertain submit success keeps card locked for manual review instead of refunding', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end('{not-json');
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('uncertain submit keeps card locked');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

  const redeem = await redeemCard(server.port, code);
  assert.equal(redeem.res.status, 502);
  assert.equal(redeem.data.status, 'unknown');

  const query = await queryCard(server.port, code);
  assert.equal(query.res.status, 200);
  assert.equal(query.data.status, 'used');
  assert.equal(query.data.redeem_status, 'unknown');
  assert.equal(query.data.needs_manual_review, true);
  assert.equal(query.data.manual_review_stage, 'submit_parse_error');
  assert.match(query.data.manual_review_reason, /响应解析失败/);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('submit network errors keep detailed upstream diagnostics without job id', async () => {
  const server = await startServer('submit network error diagnostics');
  const deadPort = await getFreePort();

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, `http://127.0.0.1:${deadPort}`);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 502);
    assert.equal(redeem.data.status, 'unknown');

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'used');
    assert.equal(query.data.job_id, null);
    assert.equal(query.data.redeem_status, 'unknown');
    assert.equal(query.data.needs_manual_review, true);
    assert.equal(query.data.manual_review_stage, 'submit_network_error');
    assert.match(query.data.upstream_detail || '', /fetch failed/i);
    assert.match(query.data.upstream_detail || '', /ECONNREFUSED|connect/i);
  } finally {
    await server.stop();
  }
});

test('submit TLS invalid session id errors are retried up to five attempts and classified clearly', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf-8');
  assert.match(source, /SUBMIT_TLS_MAX_ATTEMPTS\s*=\s*5/);
  assert.match(source, /TLS_SUBMIT_RETRY_CODES\s*=\s*new Set\(\['ERR_SSL_INVALID_SESSION_ID'\]\)/);
  assert.match(source, /isRetryableSubmitTlsError/);
  assert.match(source, /submitUpstreamRedeem/);
  assert.match(source, /attempt\s*<\s*SUBMIT_TLS_MAX_ATTEMPTS/);
  assert.match(source, /attempt\s*<\s*SUBMIT_TLS_MAX_ATTEMPTS\s*-\s*1/);
  assert.match(source, /submit_tls_handshake_error/);
  assert.match(source, /上游 TLS 握手失败/);
  assert.doesNotMatch(source, /ECONNREFUSED'[\s\S]*TLS_SUBMIT_RETRY_CODES/);
});

test('submit queue full refunds the card without manual review', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'Queue full' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('submit queue full refunds card');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 429);
    assert.match(redeem.data.error, /Queue full/i);

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.equal(query.data.needs_manual_review, false);
    assert.equal(query.data.upstream_status_code, null);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('redeem submit and user card query responses include the full session email', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-email-display', status: 'pending' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('redeem submit returns full email');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCardWithSessionJson(server.port, code, 'redeemer@example.com');
    assert.equal(redeem.res.status, 200);
    assert.equal(redeem.data.email, 'redeemer@example.com');

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.email, 'redeemer@example.com');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('card query refreshes in-flight job status from upstream', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-query-refresh', status: 'pending' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-query-refresh')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-query-refresh',
        status: 'done',
        result: { ok: true },
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('query refreshes in flight job');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.redeem_status, 'done');
    assert.equal(query.data.job_id, 'job-query-refresh');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('failed job refresh keeps a visible failure reason even when upstream omits error', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-query-failed-no-error', status: 'pending' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-query-failed-no-error')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-query-failed-no-error',
        status: 'failed',
        result: null,
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('query refresh keeps fallback failed error');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.redeem_status, 'failed');
    assert.match(query.data.redeem_error || '', /未提供原因|failed/i);

    const recordsRes = await requestJson(server.port, '/api/admin/records', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records[0].status, 'failed');
    assert.match(recordsRes.data.records[0].error_message || '', /未提供原因|failed/i);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('admin records support inclusive date range filtering', async () => {
  const server = await startServer('admin records date range', {}, {
    records: [
      {
        id: 1,
        card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        card_type: 'plus',
        email: 'alpha@example.com',
        job_id: 'job-alpha',
        status: 'done',
        error_message: null,
        created_at: '2026/4/22 23:59:59',
        ip_address: '203.0.113.10'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        email: 'beta@example.com',
        job_id: 'job-beta',
        status: 'done',
        error_message: null,
        created_at: '2026/4/23 12:00:00',
        ip_address: '203.0.113.20'
      },
      {
        id: 3,
        card_code: 'CDK-PRO-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
        card_type: 'pro',
        email: 'gamma@example.com',
        job_id: 'job-gamma',
        status: 'failed',
        error_message: 'timeout',
        created_at: '2026/4/24 23:59:59',
        ip_address: '203.0.113.30'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);

    const fromOnly = await requestJson(server.port, '/api/admin/records?date_from=2026-04-23', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(fromOnly.res.status, 200);
    assert.deepEqual(fromOnly.data.records.map((item) => item.id), [3, 2]);

    const toOnly = await requestJson(server.port, '/api/admin/records?date_to=2026-04-23', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(toOnly.res.status, 200);
    assert.deepEqual(toOnly.data.records.map((item) => item.id), [2, 1]);

    const inRange = await requestJson(server.port, '/api/admin/records?date_from=2026-04-23&date_to=2026-04-23', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(inRange.res.status, 200);
    assert.equal(inRange.data.total, 1);
    assert.deepEqual(inRange.data.records.map((item) => item.id), [2]);
  } finally {
    await server.stop();
  }
});

test('public batch card query returns mixed card states for multiple codes', async () => {
  const server = await startServer('public batch card query mixed states', {}, {
    cards: [
      {
        code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/25 10:00:00',
        used_at: null,
        used_by: null,
        used_email: null,
        batch_id: 'batch-a'
      },
      {
        code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        type: 'pro',
        status: 'used',
        created_at: '2026/4/25 10:01:00',
        used_at: '2026/4/25 10:10:00',
        used_by: 'hash-b',
        used_email: 'user@example.com',
        batch_id: 'batch-b'
      }
    ],
    records: [{
      id: 1,
      card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
      card_type: 'pro',
      job_id: 'job-batch-done',
      status: 'done',
      error_message: null,
      workflow: 'pro',
      queue_position: null,
      estimated_wait_seconds: null,
      created_at: '2026/4/25 10:10:00',
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const { res, data } = await queryCardsBatch(server.port, [
      'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
      'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
      'CDK-PLUS-NOTFOUND-NOTFOUND-NOTFOUND'
    ]);

    assert.equal(res.status, 200);
    assert.equal(data.results.length, 3);
    assert.equal(data.results[0].status, 'unused');
    assert.equal(data.results[1].redeem_status, 'done');
    assert.equal(data.results[1].email, 'user@example.com');
    assert.equal(data.results[2].status, 'not_found');
    assert.match(data.results[2].error || '', /不存在|不可用/);
  } finally {
    await server.stop();
  }
});

test('admin batch card query returns multiple card states through the admin endpoint', async () => {
  const server = await startServer('admin batch card query', {}, {
    cards: [
      {
        code: 'CDK-PLUS-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
        type: 'plus',
        status: 'disabled',
        created_at: '2026/4/25 11:00:00',
        used_at: null,
        used_by: null,
        used_email: null,
        batch_id: 'batch-c'
      },
      {
        code: 'CDK-PRO_20X-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD',
        type: 'pro_20x',
        status: 'used',
        created_at: '2026/4/25 11:01:00',
        used_at: '2026/4/25 11:05:00',
        used_by: 'hash-d',
        used_email: 'pro@example.com',
        batch_id: 'batch-d'
      }
    ],
    records: [{
      id: 1,
      card_code: 'CDK-PRO_20X-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD',
      card_type: 'pro_20x',
      job_id: 'job-batch-processing',
      status: 'processing',
      error_message: null,
      workflow: 'pro_20x',
      queue_position: 2,
      estimated_wait_seconds: 90,
      created_at: '2026/4/25 11:05:00',
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const { res, data } = await adminQueryCardsBatch(server.port, token, [
      'CDK-PLUS-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
      'CDK-PRO_20X-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD'
    ]);

    assert.equal(res.status, 200);
    assert.equal(data.results.length, 2);
    assert.equal(data.results[0].status, 'disabled');
    assert.equal(data.results[1].redeem_status, 'processing');
    assert.equal(data.results[1].job_id, 'job-batch-processing');
  } finally {
    await server.stop();
  }
});

test('query page renders redeem status even when the card was refunded', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.doesNotMatch(html, /const\s+redeemRows\s*=\s*data\.used_at\s*\?/);
  assert.match(html, /const\s+redeemRows\s*=\s*data\.redeem_status\s*\?/);
});

test('user page exposes batch card query controls and results table', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /批量卡密查询/);
  assert.match(html, /id="batchQueryInput"/);
  assert.match(html, /queryCardsBatch\(/);
  assert.match(html, /\/api\/card\/query\/batch/);
  assert.match(html, /id="batchQueryResult"/);
  assert.match(html, /query\.email/);
  assert.match(html, /escapeHtml\(item\.email \|\| '-'\)/);
});

test('user page exposes chinese and english language switching', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /id="languageToggle"/);
  assert.match(html, /setLanguage\('zh'\)/);
  assert.match(html, /setLanguage\('en'\)/);
  assert.match(html, /const\s+I18N\s*=/);
  assert.match(html, /applyLanguage\(\)/);
  assert.match(html, /data-i18n="hero\.subtitle"/);
  assert.match(html, /Batch card query/);
  assert.match(html, /Redeem email/);
  assert.match(html, /'query\.searchButton': '查询'/);
  assert.doesNotMatch(html, /'query\.searchButton': '.*&nbsp;/);
});

test('frontend pages use custom modal dialogs instead of native browser dialogs', async () => {
  const adminHtml = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  const userHtml = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  for (const [name, source] of [['admin.html', adminHtml], ['index.html', userHtml]]) {
    assert.doesNotMatch(source, /\balert\s*\(/, `${name} should not use alert()`);
    assert.doesNotMatch(source, /\bconfirm\s*\(/, `${name} should not use confirm()`);
    assert.doesNotMatch(source, /\bprompt\s*\(/, `${name} should not use prompt()`);
  }
  assert.match(adminHtml, /admin-modal-overlay/);
  assert.match(adminHtml, /showAdminConfirm/);
  assert.match(userHtml, /user-modal-overlay/);
  assert.match(userHtml, /showUserConfirm/);
});

test('user notice is rendered from public settings instead of hardcoded warning copy', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /id="userNotice"/);
  assert.match(html, /function renderUserNotice/);
  assert.match(html, /data\.userNotice/);
  assert.doesNotMatch(html, /以下账号类型请勿兑换/);
  assert.doesNotMatch(html, /已订阅 Plus \/ Pro 且未到期/);
  assert.doesNotMatch(html, /Read Before Redeeming/);
});

test('user maintenance overlay uses localized messages from public status', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /currentMaintenanceMessages/);
  assert.match(html, /function maintenanceMessageForCurrentLanguage/);
  assert.match(html, /data\.maintenanceMessages/);
  assert.match(html, /maintenanceMessageForCurrentLanguage\(\)/);
});

test('maintenance overlay exposes language switching while active', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /id="maintenanceLanguageToggle"/);
  assert.match(html, /maintenance-language-toggle/);
  assert.match(html, /data-lang-option="zh" onclick="setLanguage\('zh'\)"/);
  assert.match(html, /data-lang-option="en" onclick="setLanguage\('en'\)"/);
});

test('user page treats unknown redeem submit responses as locked terminal state', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,500}\['unknown',\s*'expired'\]\.includes\(data\.status\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,800}step1Card'\)\.classList\.add\('hidden'\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,1000}step2Card'\)\.classList\.add\('hidden'\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,1200}showJobStatus\(\{/);
});

test('user job status panel shows the submitted session email without masking', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /id="jobEmailRow"/);
  assert.match(html, /id="jobEmailText"/);
  assert.match(html, /jobEmailRow[\s\S]{0,500}job\.email/);
  assert.match(html, /jobEmailText\.textContent\s*=\s*job\.email/);
});

test('user page previews session email while typing before submit', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /id="sessionEmailPreview"/);
  assert.match(html, /id="sessionEmailText"/);
  assert.match(html, /oninput="handleSessionInput\(\)"/);
  assert.match(html, /function extractSessionEmail/);
  assert.match(html, /parsed\?\.user\?\.email/);
  assert.match(html, /function updateSessionEmailPreview/);
  assert.match(html, /preview\.classList\.add\('visible'\)/);
  assert.match(html, /currentSubmittedEmail = email/);
  assert.match(html, /'redeem\.detectedEmail': '识别邮箱:'/);
  assert.match(html, /'redeem\.detectedEmail': 'Detected email:'/);
});

test('user query page exposes manual review diagnostics and no-retry guidance', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /needs_manual_review/);
  assert.match(html, /manual_review_reason/);
  assert.match(html, /manual_review_stage/);
  assert.match(html, /卡密已锁定，请勿重复提交/);
});

test('job polling does not convert upstream 404 into a failed redemption', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.doesNotMatch(html, /res\.status\s*===\s*404[\s\S]{0,300}status:\s*['"]failed['"]/);
});

test('admin records expose manual review statuses', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /<option value="unknown">待人工核验<\/option>/);
  assert.match(html, /<option value="expired">已过期待核验<\/option>/);
  assert.match(html, /unknown:\s*'待人工核验'/);
  assert.match(html, /expired:\s*'已过期待核验'/);
});

test('admin page exposes per-type maintenance controls for all four card types', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /typedMaintenance/);
  assert.match(html, /maint-type-plus/);
  assert.match(html, /maint-type-plus_1y/);
  assert.match(html, /maint-type-pro/);
  assert.match(html, /maint-type-pro_20x/);
});

test('admin page exposes localized maintenance message controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="maintMessageZh"/);
  assert.match(html, /id="maintMessageEn"/);
  assert.match(html, /messageZh/);
  assert.match(html, /messageEn/);
});

test('admin page exposes user notice configuration controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="userNoticePanel"/);
  assert.match(html, /id="userNoticeEnabled"/);
  assert.match(html, /id="userNoticeZhBody"/);
  assert.match(html, /id="userNoticeEnBody"/);
  assert.match(html, /function saveUserNotice/);
  assert.match(html, /userNotice/);
});

test('admin and user pages expose channel name branding controls', async () => {
  const adminHtml = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(adminHtml, /id="settingsChannelName"/);
  assert.match(adminHtml, /channelName/);

  const userHtml = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(userHtml, /let currentChannelName/);
  assert.match(userHtml, /function brandTitle/);
  assert.match(userHtml, /data\.channelName/);
  assert.match(userHtml, /brandTitle\(\)/);
});

test('admin dashboard exposes redeem summary range controls and summary grid', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /redeemSummaryPanel/);
  assert.match(html, /statsRangeSelect/);
  assert.match(html, /30 分钟内/);
  assert.match(html, /1 小时内/);
  assert.match(html, /1 天内/);
  assert.match(html, /全部/);
  assert.match(html, /redeemSummaryGrid/);
});

test('admin dashboard exposes api stock warning thresholds', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /apiStockWarningPanel/);
  assert.match(html, /apiStockWarningList/);
  assert.match(html, /API 库存预警/);
  assert.match(html, /API_STOCK_WARNING_RULES/);
  assert.match(html, /key:\s*'plus_monthly'[\s\S]{0,120}threshold:\s*100/);
  assert.match(html, /key:\s*'plus_1y'[\s\S]{0,120}threshold:\s*5/);
  assert.match(html, /key:\s*'pro'[\s\S]{0,120}threshold:\s*5/);
  assert.match(html, /key:\s*'pro_20x'[\s\S]{0,120}threshold:\s*5/);
  assert.match(html, /renderApiStockWarnings\(stats\)/);
});

test('admin dashboard groups operational signals into focused sections', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /dashboard-kpi-grid/);
  assert.match(html, /dashboardInventoryPanel/);
  assert.match(html, /dashboardInventoryBoard/);
  assert.match(html, /inventory-row/);
  assert.match(html, /renderDashboardInventory\(stats\)/);
  assert.match(html, /运行状态/);
  assert.match(html, /库存总览/);
});

test('admin records expose per-row cancel controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /<th>操作<\/th>/);
  assert.match(html, /cancelRecordJob/);
  assert.match(html, /\/api\/admin\/job\/cancel/);
  assert.match(html, /取消/);
});

test('admin records page exposes bulk cancel selection controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /recordsSelectAll/);
  assert.match(html, /selectedRecordIds/);
  assert.match(html, /toggleAllRecordSelections/);
  assert.match(html, /toggleRecordSelection/);
  assert.match(html, /applyBulkRecordCancel/);
  assert.match(html, /批量取消/);
});

test('admin records expired filter exposes mark failed controls instead of cancel controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /bulkMarkFailedRecordsBtn/);
  assert.match(html, /applyBulkRecordMarkFailed/);
  assert.match(html, /isExpiredRecordsFilterActive/);
  assert.match(html, /recordMarkFailedButton/);
  assert.match(html, /\/api\/admin\/records\/\$\{encodeURIComponent\(recordId\)\}\/mark-failed/);
  assert.match(html, /设为失败/);
  assert.match(html, /recordsFilterStatus'\)\?\.value\s*===\s*'expired'/);
});

test('admin records keep cancel available for manual-review rows without job id', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /hasManualReviewSignal/);
  assert.match(html, /normalizedStatus === 'unknown'/);
  assert.match(html, /record_id/);
  assert.match(html, /data-record-cancel/);
  assert.match(html, /function renderRecordSelectCell/);
  assert.match(html, /record-select-checkbox/);
  assert.match(html, /recordCancelButton\(record\)/);
  assert.match(html, /loadCards\(\)/);
  assert.match(html, /该记录没有 Job ID，将直接按本地记录取消并退回卡密/);
});

test('admin cancel proxies job id cancellation through the admin-only endpoint', async () => {
  let deleteCalled = 0;
  let deleteHeaders = null;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-admin-cancel', status: 'pending' }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/job/job-admin-cancel') {
      deleteCalled += 1;
      deleteHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-admin-cancel', status: 'failed', error: 'cancelled' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin cancel uses dedicated endpoint');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const cancelled = await adminCancelJob(server.port, token, 'job-admin-cancel');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');
    assert.equal(deleteCalled, 1);
    assert.equal(deleteHeaders['x-api-key'], 'test-api-key');

    const query = await queryCard(server.port, code);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.equal(query.data.redeem_error, 'cancelled');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('super admin job status query proxies upstream json through an admin-only endpoint', async () => {
  let getCalled = 0;
  let receivedHeaders = null;
  const upstreamPayload = {
    job_id: 'job-admin-status',
    status: 'processing',
    workflow: 'pro',
    queue_position: 2,
    estimated_wait_seconds: 321.5,
    result: null,
    error: null
  };
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'GET' && req.url === '/job/job-admin-status?wait=15') {
      getCalled += 1;
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(upstreamPayload));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin job status query');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);

    const queried = await adminQueryJobStatus(server.port, token, 'job-admin-status', 15);
    assert.equal(queried.res.status, 200);
    assert.deepEqual(queried.data, upstreamPayload);
    assert.equal(getCalled, 1);
    assert.equal(receivedHeaders['x-api-key'], 'test-api-key');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('sub admins can disable and enable only their own cards', async () => {
  const server = await startServer('sub admin own card status actions', {}, {
    settings: {
      adminPassword: 'correct horse battery staple',
      apiKey: '',
      baseUrl: '',
      subAdmins: [
        {
          id: 'sub-1',
          username: 'alice_ops',
          passwordHash: 'plain:sub-admin-pass-123',
          status: 'active',
          created_at: '2026/4/24 10:00:00'
        }
      ]
    },
    cards: [
      {
        id: 1,
        code: 'CDK-PLUS-OWNDIS-AAAAA-AAAAA-AAAAA-AAAAA',
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        batch_id: 'sub-a',
        created_by_username: 'alice_ops',
        created_by_role: 'sub_admin'
      },
      {
        id: 2,
        code: 'CDK-PRO-OWNENA-BBBBB-BBBBB-BBBBB-BBBBB',
        type: 'pro',
        status: 'disabled',
        created_at: '2026/4/24 10:11:00',
        used_at: null,
        used_by: null,
        batch_id: 'sub-b',
        created_by_username: 'alice_ops',
        created_by_role: 'sub_admin'
      },
      {
        id: 3,
        code: 'CDK-PLUS-ROOTUN-CCCCC-CCCCC-CCCCC-CCCCC',
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:12:00',
        used_at: null,
        used_by: null,
        batch_id: 'root-a',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      },
      {
        id: 4,
        code: 'CDK-PRO-ROOTDIS-DDDDD-DDDDD-DDDDD-DDDDD',
        type: 'pro',
        status: 'disabled',
        created_at: '2026/4/24 10:13:00',
        used_at: null,
        used_by: null,
        batch_id: 'root-b',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      }
    ]
  });

  try {
    const subLogin = await loginSubAdmin(server.port, 'alice_ops', 'sub-admin-pass-123');
    assert.equal(subLogin.res.status, 200);

    const disabled = await requestJson(server.port, '/api/admin/cards/disable', {
      method: 'POST',
      headers: { 'X-Admin-Token': subLogin.data.token },
      body: JSON.stringify({
        codes: [
          'CDK-PLUS-OWNDIS-AAAAA-AAAAA-AAAAA-AAAAA',
          'CDK-PLUS-ROOTUN-CCCCC-CCCCC-CCCCC-CCCCC'
        ]
      })
    });
    assert.equal(disabled.res.status, 200);
    assert.equal(disabled.data.disabled, 1);

    const enabled = await requestJson(server.port, '/api/admin/cards/enable', {
      method: 'POST',
      headers: { 'X-Admin-Token': subLogin.data.token },
      body: JSON.stringify({
        codes: [
          'CDK-PRO-OWNENA-BBBBB-BBBBB-BBBBB-BBBBB',
          'CDK-PRO-ROOTDIS-DDDDD-DDDDD-DDDDD-DDDDD'
        ]
      })
    });
    assert.equal(enabled.res.status, 200);
    assert.equal(enabled.data.enabled, 1);

    const adminToken = await loginAdmin(server.port);
    const cardsRes = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': adminToken }
    });
    assert.equal(cardsRes.res.status, 200);

    const statuses = new Map(cardsRes.data.cards.map((card) => [card.code, card.status]));
    assert.equal(statuses.get('CDK-PLUS-OWNDIS-AAAAA-AAAAA-AAAAA-AAAAA'), 'disabled');
    assert.equal(statuses.get('CDK-PRO-OWNENA-BBBBB-BBBBB-BBBBB-BBBBB'), 'unused');
    assert.equal(statuses.get('CDK-PLUS-ROOTUN-CCCCC-CCCCC-CCCCC-CCCCC'), 'unused');
    assert.equal(statuses.get('CDK-PRO-ROOTDIS-DDDDD-DDDDD-DDDDD-DDDDD'), 'disabled');
  } finally {
    await server.stop();
  }
});

test('admin batch replace generates same-type new cards and disables old unused cards', async () => {
  const oldPlus = 'CDK-PLUS-REPLA-AAAAA-AAAAA-AAAAA-AAAAA';
  const oldPro = 'CDK-PRO-REPLB-BBBBB-BBBBB-BBBBB-BBBBB';
  const server = await startServer('admin batch replace unused cards', {}, {
    cards: [
      {
        id: 1,
        code: oldPlus,
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        remark: '客户原卡',
        cost: 3,
        sale_price: 88,
        batch_id: 'refund-a',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      },
      {
        id: 2,
        code: oldPro,
        type: 'pro',
        status: 'unused',
        created_at: '2026/4/24 10:11:00',
        used_at: null,
        used_by: null,
        remark: '客户原卡',
        cost: 4,
        sale_price: 128,
        batch_id: 'refund-b',
        created_by_username: 'super_admin',
        created_by_role: 'super_admin'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const settingsSaved = await requestJson(server.port, '/api/admin/settings', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: JSON.stringify({ defaultCost: 16 })
    });
    assert.equal(settingsSaved.res.status, 200);

    const replaced = await adminReplaceCards(server.port, token, [oldPlus, oldPro]);
    assert.equal(replaced.res.status, 200);
    assert.equal(replaced.data.replaced, 2);
    assert.equal(replaced.data.codes.length, 2);
    assert.equal(replaced.data.replacements.length, 2);

    const replacementMap = new Map(replaced.data.replacements.map((item) => [item.old_code, item]));
    assert.equal(replacementMap.get(oldPlus).type, 'plus');
    assert.equal(replacementMap.get(oldPro).type, 'pro');
    assert.notEqual(replacementMap.get(oldPlus).new_code, oldPlus);
    assert.notEqual(replacementMap.get(oldPro).new_code, oldPro);

    const cardsRes = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(cardsRes.res.status, 200);
    const cardMap = new Map(cardsRes.data.cards.map((card) => [card.code, card]));
    assert.equal(cardMap.get(oldPlus).status, 'disabled');
    assert.equal(cardMap.get(oldPro).status, 'disabled');
    assert.equal(cardMap.get(replacementMap.get(oldPlus).new_code).status, 'unused');
    assert.equal(cardMap.get(replacementMap.get(oldPlus).new_code).type, 'plus');
    assert.equal(cardMap.get(replacementMap.get(oldPlus).new_code).remark, '卡密替换');
    assert.equal(cardMap.get(replacementMap.get(oldPlus).new_code).cost, 16);
    assert.equal(cardMap.get(replacementMap.get(oldPlus).new_code).sale_price, 88);
    assert.equal(cardMap.get(replacementMap.get(oldPro).new_code).status, 'unused');
    assert.equal(cardMap.get(replacementMap.get(oldPro).new_code).type, 'pro');
    assert.equal(cardMap.get(replacementMap.get(oldPro).new_code).remark, '卡密替换');
    assert.equal(cardMap.get(replacementMap.get(oldPro).new_code).cost, 16);
    assert.equal(cardMap.get(replacementMap.get(oldPro).new_code).sale_price, 128);
  } finally {
    await server.stop();
  }
});

test('admin batch replace fails atomically and lists used cards', async () => {
  const unusedCode = 'CDK-PLUS-RFAIL-AAAAA-AAAAA-AAAAA-AAAAA';
  const usedCode = 'CDK-PRO-RFAIL-BBBBB-BBBBB-BBBBB-BBBBB';
  const server = await startServer('admin batch replace blocks used cards', {}, {
    cards: [
      {
        id: 1,
        code: unusedCode,
        type: 'plus',
        status: 'unused',
        created_at: '2026/4/24 10:10:00',
        used_at: null,
        used_by: null,
        batch_id: 'refund-a'
      },
      {
        id: 2,
        code: usedCode,
        type: 'pro',
        status: 'used',
        created_at: '2026/4/24 10:11:00',
        used_at: '2026/4/24 10:20:00',
        used_by: 'hash-b',
        used_email: 'buyer@example.com',
        batch_id: 'refund-b'
      }
    ]
  });

  try {
    const token = await loginAdmin(server.port);
    const replaced = await adminReplaceCards(server.port, token, [unusedCode, usedCode]);
    assert.equal(replaced.res.status, 409);
    assert.match(replaced.data.error, /已使用/);
    assert.deepEqual(replaced.data.used_codes, [usedCode]);

    const cardsRes = await requestJson(server.port, '/api/admin/cards?page=1&pageSize=10', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(cardsRes.res.status, 200);
    const cardMap = new Map(cardsRes.data.cards.map((card) => [card.code, card]));
    assert.equal(cardsRes.data.total, 2);
    assert.equal(cardMap.get(unusedCode).status, 'unused');
    assert.equal(cardMap.get(usedCode).status, 'used');
  } finally {
    await server.stop();
  }
});

test('sub admin cannot query admin job status endpoint', async () => {
  const server = await startServer('sub admin blocked from job status');

  try {
    const adminToken = await loginAdmin(server.port);
    const created = await createSubAdmin(server.port, adminToken, 'status_reader', 'sub-admin-pass-123');
    assert.equal(created.res.status, 200);

    const subLogin = await loginSubAdmin(server.port, 'status_reader', 'sub-admin-pass-123');
    assert.equal(subLogin.res.status, 200);

    const queried = await adminQueryJobStatus(server.port, subLogin.data.token, 'job-admin-status', 0);
    assert.equal(queried.res.status, 403);
  } finally {
    await server.stop();
  }
});

test('admin job status query does not update local records', async () => {
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'GET' && req.url === '/job/job-admin-status-no-sync?wait=0') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-admin-status-no-sync',
        status: 'done',
        workflow: 'plus',
        result: { ok: true },
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin job status no local sync', {}, {
    records: [{
      id: 91,
      card_code: 'CDK-PLUS-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-admin-status-no-sync',
      status: 'pending',
      error_message: null,
      workflow: 'plus',
      queue_position: 4,
      estimated_wait_seconds: 480,
      created_at: '2026/4/25 10:00:00'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);

    const queried = await adminQueryJobStatus(server.port, token, 'job-admin-status-no-sync', 0);
    assert.equal(queried.res.status, 200);
    assert.equal(queried.data.status, 'done');

    const recordsRes = await requestJson(server.port, '/api/admin/records?search=job-admin-status-no-sync', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records.length, 1);
    assert.equal(recordsRes.data.records[0].status, 'pending');
    assert.equal(recordsRes.data.records[0].queue_position, 4);
    assert.equal(recordsRes.data.records[0].estimated_wait_seconds, 480);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('card queue endpoint proxies upstream queue data for the requested workflow', async () => {
  let getCalled = 0;
  let receivedHeaders = null;
  const upstreamPayload = {
    queues: {
      plus: {
        pending: 3,
        processing: 1,
        workers: 2,
        avg_duration_seconds: 205.4,
        estimated_next_wait_seconds: 513.5
      },
      pro_20x: {
        pending: 6,
        processing: 1,
        workers: 2,
        avg_duration_seconds: 180,
        estimated_next_wait_seconds: 720
      }
    }
  };
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'GET' && req.url === '/queue') {
      getCalled += 1;
      receivedHeaders = req.headers;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(upstreamPayload));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('card queue proxy');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);

    const queried = await queryQueue(server.port, 'pro_20x');
    assert.equal(queried.res.status, 200);
    assert.deepEqual(queried.data, {
      workflow: 'pro_20x',
      queue: upstreamPayload.queues.pro_20x
    });
    assert.equal(getCalled, 1);
    assert.equal(receivedHeaders['x-api-key'], 'test-api-key');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('admin cancel refunds manual-review records without job id by local record id', async () => {
  const server = await startServer('admin cancel refunds local manual review record', {}, {
    cards: [{
      code: 'MANUAL-CANCEL-LOCAL-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 7,
      card_code: 'MANUAL-CANCEL-LOCAL-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: null,
      status: 'unknown',
      error_message: '提交请求结果不确定: fetch failed',
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: true,
      manual_review_reason: '请求上游时出现网络错误，无法确认是否已成功受理',
      manual_review_stage: 'submit_network_error',
      upstream_status_code: null,
      upstream_detail: 'fetch failed',
      created_at: '2026/4/24 12:01:00',
      ip_address: '::ffff:172.22.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const cancelled = await adminCancelRecord(server.port, token, 7);
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');

    const query = await queryCard(server.port, 'MANUAL-CANCEL-LOCAL-0001');
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.match(query.data.redeem_error, /管理员已取消|人工取消/);
  } finally {
    await server.stop();
  }
});

test('admin can mark manual-review records as successful after verification', async () => {
  const server = await startServer('admin mark manual review success', {}, {
    cards: [{
      code: 'MANUAL-SUCCESS-LOCAL-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 17,
      card_code: 'MANUAL-SUCCESS-LOCAL-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: null,
      status: 'unknown',
      error_message: '提交请求结果不确定: fetch failed',
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: true,
      manual_review_reason: '请求上游时出现网络错误，无法确认是否已成功受理',
      manual_review_stage: 'submit_network_error',
      upstream_status_code: null,
      upstream_detail: 'fetch failed',
      created_at: '2026/4/24 12:01:00',
      ip_address: '::ffff:172.22.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const marked = await adminMarkRecordSuccess(server.port, token, 17);
    assert.equal(marked.res.status, 200);
    assert.equal(marked.data.status, 'done');
    assert.equal(marked.data.record.status, 'done');
    assert.equal(marked.data.record.needs_manual_review, false);
    assert.equal(marked.data.record.manual_review_reason, null);
    assert.equal(marked.data.record.manual_resolution, 'success');
    assert.equal(marked.data.record.manual_resolved_by, 'super_admin');

    const recordsRes = await requestJson(server.port, '/api/admin/records?search=MANUAL-SUCCESS-LOCAL-0001', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records[0].status, 'done');
    assert.equal(recordsRes.data.records[0].needs_manual_review, false);

    const query = await queryCard(server.port, 'MANUAL-SUCCESS-LOCAL-0001');
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'used');
    assert.equal(query.data.redeem_status, 'done');
    assert.equal(query.data.needs_manual_review, false);
  } finally {
    await server.stop();
  }
});

test('admin can mark expired manual-review records as failed and refund the card', async () => {
  const server = await startServer('admin mark expired manual review failed', {}, {
    cards: [{
      code: 'EXPIRED-MARK-FAILED-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 27,
      card_code: 'EXPIRED-MARK-FAILED-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-expired-mark-failed',
      status: 'expired',
      error_message: 'Job 已过期或不存在，需人工核验最终兑换状态',
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: true,
      manual_review_reason: '上游 Job 已过期或不存在，无法自动确认最终兑换结果',
      manual_review_stage: 'job_expired',
      upstream_status_code: 404,
      upstream_detail: 'job not found or expired',
      created_at: '2026/4/24 12:01:00',
      ip_address: '::ffff:172.22.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const marked = await adminMarkRecordFailed(server.port, token, 27);
    assert.equal(marked.res.status, 200);
    assert.equal(marked.data.status, 'failed');
    assert.equal(marked.data.record.status, 'failed');
    assert.equal(marked.data.record.needs_manual_review, false);
    assert.equal(marked.data.record.manual_resolution, 'failed');
    assert.equal(marked.data.record.manual_resolved_by, 'super_admin');

    const expiredRecords = await requestJson(server.port, '/api/admin/records?status=expired&search=EXPIRED-MARK-FAILED-0001', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(expiredRecords.res.status, 200);
    assert.equal(expiredRecords.data.total, 0);

    const failedRecords = await requestJson(server.port, '/api/admin/records?status=failed&search=EXPIRED-MARK-FAILED-0001', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(failedRecords.res.status, 200);
    assert.equal(failedRecords.data.total, 1);
    assert.equal(failedRecords.data.records[0].status, 'failed');

    const query = await queryCard(server.port, 'EXPIRED-MARK-FAILED-0001');
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.equal(query.data.needs_manual_review, false);
  } finally {
    await server.stop();
  }
});

test('admin mark failed keeps card used when the same card already has a successful redemption', async () => {
  const server = await startServer('admin mark expired failed preserves successful card', {}, {
    cards: [{
      code: 'EXPIRED-MARK-FAILED-DONE-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:10:00',
      used_by: 'hash-token-success',
      used_email: 'success@example.com'
    }],
    records: [{
      id: 31,
      card_code: 'EXPIRED-MARK-FAILED-DONE-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'old@example.com',
      access_token_hash: 'hash-token-expired',
      job_id: 'job-expired-before-success',
      status: 'expired',
      error_message: 'Job 已过期或不存在，需人工核验最终兑换状态',
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: true,
      manual_review_reason: '上游 Job 已过期或不存在，无法自动确认最终兑换结果',
      manual_review_stage: 'job_expired',
      upstream_status_code: 404,
      upstream_detail: 'job not found or expired',
      created_at: '2026/4/24 12:01:00',
      ip_address: '::ffff:172.22.0.1'
    }, {
      id: 32,
      card_code: 'EXPIRED-MARK-FAILED-DONE-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'success@example.com',
      access_token_hash: 'hash-token-success',
      job_id: 'job-success-after-expired',
      status: 'done',
      error_message: null,
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: false,
      manual_review_reason: null,
      manual_review_stage: null,
      upstream_status_code: null,
      upstream_detail: null,
      created_at: '2026/4/24 12:10:00',
      ip_address: '::ffff:172.22.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const marked = await adminMarkRecordFailed(server.port, token, 31);
    assert.equal(marked.res.status, 200);
    assert.equal(marked.data.status, 'failed');
    assert.equal(marked.data.record.status, 'failed');
    assert.equal(marked.data.record.needs_manual_review, false);
    assert.match(marked.data.record.error_message, /已有成功兑换记录|未退回卡密/);

    const query = await queryCard(server.port, 'EXPIRED-MARK-FAILED-DONE-0001');
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'used');
    assert.equal(query.data.email, 'success@example.com');
    assert.equal(query.data.redeem_status, 'done');
    assert.equal(query.data.needs_manual_review, false);
  } finally {
    await server.stop();
  }
});

test('admin record diagnostics queries upstream and enables one-click success when job is done', async () => {
  let getCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'GET' && req.url === '/job/job-diagnose-done?wait=0') {
      getCalled += 1;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-diagnose-done',
        status: 'done',
        workflow: 'plus',
        result: { ok: true },
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin diagnose record upstream done', {}, {
    cards: [{
      code: 'MANUAL-DIAGNOSE-DONE-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 19,
      card_code: 'MANUAL-DIAGNOSE-DONE-0001',
      card_type: 'plus',
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-diagnose-done',
      status: 'unknown',
      error_message: '提交状态不确定，等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '上游响应不确定',
      manual_review_stage: 'submit_unknown',
      created_at: '2026/4/24 12:01:00',
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const diagnosed = await adminDiagnoseRecord(server.port, token, 19);
    assert.equal(diagnosed.res.status, 200);
    assert.equal(diagnosed.data.can_query_upstream, true);
    assert.equal(diagnosed.data.upstream_status_code, 200);
    assert.equal(diagnosed.data.upstream.status, 'done');
    assert.equal(diagnosed.data.can_mark_success, true);
    assert.equal(diagnosed.data.recommendation, '上游返回成功，可以一键校验为成功');
    assert.equal(getCalled, 1);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('background reconcile resolves recent manual-review jobs only on terminal upstream status', async () => {
  const freshCreatedAt = formatShanghaiRecordTime(Date.now() - 10 * 60 * 1000);
  const oldCreatedAt = formatShanghaiRecordTime(Date.now() - 2 * 60 * 60 * 1000);
  const upstreamStatuses = {
    'job-auto-done': { status: 'done', result: { ok: true }, error: null },
    'job-auto-failed': { status: 'failed', result: null, error: 'subscription failed' },
    'job-auto-processing': { status: 'processing', result: null, error: null, queue_position: 1 },
    'job-auto-old-done': { status: 'done', result: { ok: true }, error: null }
  };
  let getCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    const match = req.url.match(/^\/job\/([^?]+)\?wait=0$/);
    if (req.method === 'GET' && match) {
      getCalled += 1;
      const jobId = decodeURIComponent(match[1]);
      const payload = upstreamStatuses[jobId];
      if (payload) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ job_id: jobId, workflow: 'plus', ...payload }));
        return;
      }
    }
    res.writeHead(404).end();
  });
  const server = await startServer('background manual review reconciliation', {}, {
    settings: { apiKey: 'test-api-key', baseUrl: upstream.baseUrl },
    cards: [{
      code: 'AUTO-MANUAL-DONE-0001',
      type: 'plus',
      status: 'used',
      created_at: freshCreatedAt,
      used_at: freshCreatedAt,
      used_by: 'hash-token',
      used_email: 'done@example.com'
    }, {
      code: 'AUTO-MANUAL-FAILED-0001',
      type: 'plus',
      status: 'used',
      created_at: freshCreatedAt,
      used_at: freshCreatedAt,
      used_by: 'hash-token',
      used_email: 'failed@example.com'
    }, {
      code: 'AUTO-MANUAL-PROCESS-0001',
      type: 'plus',
      status: 'used',
      created_at: freshCreatedAt,
      used_at: freshCreatedAt,
      used_by: 'hash-token',
      used_email: 'processing@example.com'
    }, {
      code: 'AUTO-MANUAL-OLD-0001',
      type: 'plus',
      status: 'used',
      created_at: oldCreatedAt,
      used_at: oldCreatedAt,
      used_by: 'hash-token',
      used_email: 'old@example.com'
    }],
    records: [{
      id: 31,
      card_code: 'AUTO-MANUAL-DONE-0001',
      card_type: 'plus',
      email: 'done@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-auto-done',
      status: 'unknown',
      error_message: '等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '状态不确定',
      manual_review_stage: 'submit_unknown',
      created_at: freshCreatedAt,
      ip_address: '127.0.0.1'
    }, {
      id: 32,
      card_code: 'AUTO-MANUAL-FAILED-0001',
      card_type: 'plus',
      email: 'failed@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-auto-failed',
      status: 'unknown',
      error_message: '等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '状态不确定',
      manual_review_stage: 'submit_unknown',
      created_at: freshCreatedAt,
      ip_address: '127.0.0.1'
    }, {
      id: 33,
      card_code: 'AUTO-MANUAL-PROCESS-0001',
      card_type: 'plus',
      email: 'processing@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-auto-processing',
      status: 'unknown',
      error_message: '等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '状态不确定',
      manual_review_stage: 'submit_unknown',
      created_at: freshCreatedAt,
      ip_address: '127.0.0.1'
    }, {
      id: 34,
      card_code: 'AUTO-MANUAL-OLD-0001',
      card_type: 'plus',
      email: 'old@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-auto-old-done',
      status: 'unknown',
      error_message: '等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '状态不确定',
      manual_review_stage: 'submit_unknown',
      created_at: oldCreatedAt,
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    await new Promise(resolve => setTimeout(resolve, 6500));

    const recordsRes = await requestJson(server.port, '/api/admin/records?pageSize=100&search=AUTO-MANUAL', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    const byCode = Object.fromEntries(recordsRes.data.records.map(record => [record.card_code, record]));
    assert.equal(byCode['AUTO-MANUAL-DONE-0001'].status, 'done');
    assert.equal(byCode['AUTO-MANUAL-DONE-0001'].needs_manual_review, false);
    assert.equal(byCode['AUTO-MANUAL-DONE-0001'].manual_resolution, 'success');
    assert.equal(byCode['AUTO-MANUAL-DONE-0001'].manual_resolved_by, 'system_auto_reconcile');
    assert.equal(byCode['AUTO-MANUAL-FAILED-0001'].status, 'failed');
    assert.equal(byCode['AUTO-MANUAL-FAILED-0001'].needs_manual_review, false);
    assert.equal(byCode['AUTO-MANUAL-FAILED-0001'].manual_resolution, 'failed');
    assert.equal(byCode['AUTO-MANUAL-PROCESS-0001'].status, 'unknown');
    assert.equal(byCode['AUTO-MANUAL-PROCESS-0001'].needs_manual_review, true);
    assert.equal(byCode['AUTO-MANUAL-OLD-0001'].status, 'unknown');
    assert.equal(byCode['AUTO-MANUAL-OLD-0001'].needs_manual_review, true);

    const failedCard = await queryCard(server.port, 'AUTO-MANUAL-FAILED-0001');
    assert.equal(failedCard.data.status, 'unused');
    assert.equal(failedCard.data.redeem_status, 'failed');
    assert.ok(getCalled >= 3);
    assert.ok(getCalled < 4);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('background reconcile keeps manual-review records unchanged on upstream network errors', async () => {
  const freshCreatedAt = formatShanghaiRecordTime(Date.now() - 10 * 60 * 1000);
  const deadPort = await getFreePort();
  const server = await startServer('background manual review network error safe', {}, {
    settings: { apiKey: 'test-api-key', baseUrl: `http://127.0.0.1:${deadPort}` },
    cards: [{
      code: 'AUTO-MANUAL-NETWORK-0001',
      type: 'plus',
      status: 'used',
      created_at: freshCreatedAt,
      used_at: freshCreatedAt,
      used_by: 'hash-token',
      used_email: 'network@example.com'
    }],
    records: [{
      id: 35,
      card_code: 'AUTO-MANUAL-NETWORK-0001',
      card_type: 'plus',
      email: 'network@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-auto-network-error',
      status: 'unknown',
      error_message: '等待人工核验',
      workflow: 'plus',
      needs_manual_review: true,
      manual_review_reason: '状态不确定',
      manual_review_stage: 'submit_unknown',
      created_at: freshCreatedAt,
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    await new Promise(resolve => setTimeout(resolve, 6500));

    const recordsRes = await requestJson(server.port, '/api/admin/records?search=AUTO-MANUAL-NETWORK-0001', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records[0].status, 'unknown');
    assert.equal(recordsRes.data.records[0].needs_manual_review, true);

    const query = await queryCard(server.port, 'AUTO-MANUAL-NETWORK-0001');
    assert.equal(query.data.status, 'used');
    assert.equal(query.data.redeem_status, 'unknown');
    assert.equal(query.data.needs_manual_review, true);
  } finally {
    await server.stop();
  }
});

test('admin cannot mark non-manual records as successful', async () => {
  const server = await startServer('admin rejects non manual success mark', {}, {
    cards: [{
      code: 'DONE-NON-MANUAL-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 18,
      card_code: 'DONE-NON-MANUAL-0001',
      card_type: 'plus',
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-done-0001',
      status: 'done',
      error_message: null,
      workflow: 'plus',
      created_at: '2026/4/24 12:01:00',
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const marked = await adminMarkRecordSuccess(server.port, token, 18);
    assert.equal(marked.res.status, 409);
    assert.match(marked.data.error, /待人工核验|已经是成功状态/);
  } finally {
    await server.stop();
  }
});

test('admin records expose cancel for legacy unknown records without job id or manual flag', async () => {
  const server = await startServer('admin legacy unknown local cancel record', {}, {
    cards: [{
      code: 'LEGACY-UNKNOWN-LOCAL-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 8,
      card_code: 'LEGACY-UNKNOWN-LOCAL-0001',
      card_type: 'plus',
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: null,
      status: 'unknown',
      error_message: '提交请求结果不确定: fetch failed',
      workflow: 'plus',
      created_at: '2026/4/24 12:01:00',
      ip_address: '::ffff:172.22.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    const recordsRes = await requestJson(server.port, '/api/admin/records?search=LEGACY-UNKNOWN-LOCAL-0001', {
      headers: { 'X-Admin-Token': token }
    });
    assert.equal(recordsRes.res.status, 200);
    assert.equal(recordsRes.data.records[0].needs_manual_review, true);

    const cancelled = await adminCancelRecord(server.port, token, 8);
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');

    const query = await queryCard(server.port, 'LEGACY-UNKNOWN-LOCAL-0001');
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
  } finally {
    await server.stop();
  }
});

test('admin cancel refunds manual-review records when upstream job is missing or expired', async () => {
  let deleteCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'DELETE' && req.url === '/job/job-admin-manual-review') {
      deleteCalled += 1;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'job not found or expired' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('admin cancel refunds manual review record', {}, {
    cards: [{
      code: 'MANUAL-CANCEL-PLUS-0001',
      type: 'plus',
      status: 'used',
      created_at: '2026/4/24 12:00:00',
      used_at: '2026/4/24 12:01:00',
      used_by: 'hash-token',
      used_email: 'user@example.com'
    }],
    records: [{
      id: 1,
      card_code: 'MANUAL-CANCEL-PLUS-0001',
      card_type: 'plus',
      created_by_username: null,
      created_by_role: null,
      email: 'user@example.com',
      access_token_hash: 'hash-token',
      job_id: 'job-admin-manual-review',
      status: 'unknown',
      error_message: '提交状态不确定，等待人工核验',
      workflow: 'plus',
      queue_position: null,
      estimated_wait_seconds: null,
      needs_manual_review: true,
      manual_review_reason: '上游提交响应异常，需人工核验',
      manual_review_stage: 'submit_parse_error',
      upstream_status_code: 202,
      upstream_detail: 'invalid json',
      created_at: '2026/4/24 12:01:00',
      ip_address: '127.0.0.1'
    }]
  });

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);

    const cancelled = await adminCancelJob(server.port, token, 'job-admin-manual-review');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'expired');
    assert.equal(deleteCalled, 1);

    const query = await queryCard(server.port, 'MANUAL-CANCEL-PLUS-0001');
    assert.equal(query.res.status, 200);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'expired');
    assert.match(query.data.redeem_error, /not found|expired/);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('admin records page exposes a search input wired to records api', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="recordsSearch"/);
  assert.match(html, /debounceRecordsSearch/);
  assert.match(html, /params\.set\('search', search\)/);
  assert.doesNotMatch(html, /const res = await adminFetch\(`\/api\/admin\/records\?\$\{params\}`\);\s*if \(!res\.ok\) return;/);
  assert.match(html, /登录已失效，请重新登录/);
});

test('admin records page exposes date range filters wired to records api', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="recordsDateFrom"/);
  assert.match(html, /id="recordsDateTo"/);
  assert.match(html, /params\.set\('date_from', dateFrom\)/);
  assert.match(html, /params\.set\('date_to', dateTo\)/);
});

test('admin records page exposes a refresh button wired to reload current filters', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="recordsRefreshBtn"/);
  assert.match(html, /onclick="loadRecords\(\)"/);
  assert.match(html, /刷新记录|刷新列表|刷新/);
});

test('admin records page presents a focused operations workspace', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /records-focus-grid/);
  assert.match(html, /records-toolbar/);
  assert.match(html, /recordsActiveFilters/);
  assert.match(html, /recordsSelectionHint/);
  assert.match(html, /resetRecordsFilters/);
  assert.match(html, /renderRecordsFocus/);
  assert.match(html, /renderRecordRow/);
  assert.match(html, /records-row-manual/);
  assert.match(html, /邮箱 \/ IP/);
  assert.match(html, /recordsPageSize/);
});

test('admin records page exposes jump and page-size controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="recordsPageSize"/);
  assert.match(html, /handleRecordsPageSizeChange/);
  assert.match(html, /id="recordsPageJump"/);
  assert.match(html, /applyRecordsPageJump/);
  assert.match(html, /pageSize:\s*recordsPageSize/);
});

test('generated code export filename includes type count and compact timestamp', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /function buildGeneratedCodesFilename/);
  assert.match(html, /replace\('plus_1y',\s*'plus-1y'\)/);
  assert.match(html, /replace\('pro_20x',\s*'pro-20x'\)/);
  assert.match(html, /\$\{safeType\}-\$\{count\}-\$\{timestamp\}\.txt/);
});

test('generated code panel exposes a clear action that resets the in-memory result list', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /clearGeneratedCodes/);
  assert.match(html, /清空结果/);
  assert.match(html, /generatedCodes = \[\]/);
  assert.match(html, /document\.getElementById\('genCodesList'\)\.textContent = ''/);
  assert.match(html, /document\.getElementById\('genResult'\)\.classList\.remove\('visible'\)/);
});

test('admin page exposes batch card query controls and results table', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /批量卡密查询/);
  assert.match(html, /id="adminBatchQueryInput"/);
  assert.match(html, /loadBatchCardQuery\(/);
  assert.match(html, /\/api\/admin\/cards\/query\/batch/);
  assert.match(html, /id="adminBatchQueryResult"/);
});

test('admin cards page exposes bulk selection and batch status actions', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="cardsSelectAll"/);
  assert.match(html, /toggleCardSelection\(/);
  assert.match(html, /applyBulkCardAction\(/);
  assert.match(html, /id="bulkCardActionInput"/);
  assert.match(html, /批量禁用/);
  assert.match(html, /批量启用/);
  assert.match(html, /\/api\/admin\/cards\/disable/);
  assert.match(html, /\/api\/admin\/cards\/enable/);
});

test('admin cards page exposes batch replace controls for refunds', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="bulkCardReplaceInput"/);
  assert.match(html, /批量替换/);
  assert.match(html, /applyBulkCardReplace\(/);
  assert.match(html, /\/api\/admin\/cards\/replace/);
  assert.match(html, /renderBulkReplaceResult/);
});

test('admin card generation and list expose remark cost and sale price fields', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="genIssueType"/);
  assert.match(html, /value="compensation"/);
  assert.match(html, /id="genOriginalCode"/);
  assert.match(html, /旧卡密（必须已使用）/);
  assert.match(html, /id="genCompensationReason"/);
  assert.match(html, /value="充值未到账补卡"/);
  assert.match(html, /自动使用旧卡成本/);
  assert.match(html, /handleGenerateIssueTypeChange/);
  assert.match(html, /id="genRemark"/);
  assert.match(html, /id="genCost"/);
  assert.match(html, /id="genSalePrice"/);
  assert.match(html, /remark/);
  assert.match(html, /sale_price/);
  assert.match(html, /id="settingsDefaultCost"/);
  assert.match(html, /默认成本/);
  assert.match(html, />备注</);
  assert.match(html, />成本</);
  assert.match(html, />卖价</);
});

test('admin cards page exposes created and used minute range filters', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="cardsCreatedFrom"/);
  assert.match(html, /id="cardsCreatedTo"/);
  assert.match(html, /id="cardsUsedFrom"/);
  assert.match(html, /id="cardsUsedTo"/);
  assert.match(html, /type="datetime-local"/);
  assert.match(html, /params\.set\('created_from', createdFrom\)/);
  assert.match(html, /params\.set\('used_to', usedTo\)/);
});

test('admin page exposes mobile navigation controls for switching pages on phones', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="mobileTopbar"/);
  assert.match(html, /id="mobileMenuBtn"/);
  assert.match(html, /id="mobileNavOverlay"/);
  assert.match(html, /id="mobileNavDrawer"/);
  assert.match(html, /toggleMobileNav/);
  assert.match(html, /closeMobileNav/);
  assert.match(html, /setMobileNavOpen/);
});

test('admin page includes responsive mobile layout rules for filters tables and pagination', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /@media \(max-width: 768px\)/);
  assert.match(html, /mobile-topbar/);
  assert.match(html, /table-wrapper[\s\S]*min-width:/);
  assert.match(html, /pagination[\s\S]*flex-direction:\s*column/);
  assert.match(html, /filter-bar[\s\S]*width:\s*100%/);
});

test('admin page exposes username login and sub admin account management ui', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /id="loginUsername"/);
  assert.match(html, /page-accounts/);
  assert.match(html, /loadSubAdmins/);
  assert.match(html, /createSubAdminAccount/);
  assert.match(html, /impersonateSubAdmin/);
  assert.match(html, /returnToSuperAdmin/);
  assert.match(html, /id="impersonationBar"/);
  assert.match(html, /一键登录/);
  assert.match(html, /\/api\/admin\/sub-admins\/\$\{encodeURIComponent\(id\)\}\/impersonate/);
  assert.match(html, /\/api\/admin\/sub-admins/);
  assert.match(html, /\/api\/admin\/me/);
});

test('admin page exposes a super-admin job status page', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /page-job-status/);
  assert.match(html, /switchPage\('job-status'\)/);
  assert.match(html, /loadAdminJobStatus/);
  assert.match(html, /\/api\/admin\/job-status\//);
  assert.match(html, /data-page="job-status"[\s\S]*data-permission="manage_settings"|data-permission="manage_settings"[\s\S]*data-page="job-status"/);
});

test('admin page exposes a dedicated system status page', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /page-system/);
  assert.match(html, /switchPage\('system'\)/);
  assert.match(html, /loadSystemStatus/);
  assert.match(html, /\/api\/admin\/system/);
  assert.match(html, /CPU 使用率/);
  assert.match(html, /内存使用率/);
  assert.match(html, /磁盘使用率/);
  assert.match(html, /data-page="system"[\s\S]*data-permission="manage_settings"|data-permission="manage_settings"[\s\S]*data-page="system"/);
});

test('admin page exposes a super-admin cost records page', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /page-costs/);
  assert.match(html, /switchPage\('costs'\)/);
  assert.match(html, /data-page="costs"[\s\S]*data-permission="manage_settings"|data-permission="manage_settings"[\s\S]*data-page="costs"/);
  assert.match(html, /id="costRecordType"/);
  assert.match(html, /id="costSummaryGrid"/);
  assert.match(html, /loadCostRecords/);
  assert.match(html, /\/api\/admin\/cost-records/);
  assert.match(html, /进货/);
  assert.match(html, /加权成本|加权/);
});

test('admin page script parses so login handlers are actually defined', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(match, 'expected inline admin script');
  assert.doesNotThrow(() => new Function(match[1]));
  assert.match(match[1], /async function adminLogin\(/);
});

test('user page script parses after modal dialog wiring', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(match, 'expected inline user script');
  assert.doesNotThrow(() => new Function(match[1]));
  assert.match(match[1], /function showUserModal\(/);
});

test('admin page preserves readable chinese copy for core ui labels', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /喵喵GPT源头/);
  assert.match(html, /管理后台/);
  assert.match(html, /请输入管理员密码登录/);
  assert.match(html, /请输入用户名|子管理员请输入用户名/);
  assert.match(html, /仪表盘/);
  assert.match(html, /生成卡密/);
  assert.match(html, /卡密管理/);
  assert.match(html, /兑换记录/);
  assert.match(html, /账号管理/);
  assert.match(html, /系统设置/);
  assert.match(html, /退出登录/);
  assert.doesNotMatch(html, /鍠靛柕GPT婧愬ご|绠＄悊鍚庡彴/);
  assert.doesNotMatch(html, /浠〃|鍗″瘑|鍏戞崲|璐﹀彿|绯荤粺|閫€鍑/);
});

test('admin page renders creator usernames in cards and records tables', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /created_by_username/);
  assert.match(html, /currentViewer/);
});

test('admin records expose manual review diagnostic actions', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /showRecordDiagnostics/);
  assert.match(html, /\/api\/admin\/records\/\$\{encodeURIComponent\(recordId\)\}\/diagnose/);
  assert.match(html, /upstreamJobStatusLooksSuccessful/);
  assert.match(html, /上游返回 done/);
  assert.match(html, /markRecordSuccess/);
  assert.match(html, /\/api\/admin\/records\/\$\{encodeURIComponent\(recordId\)\}\/mark-success/);
  assert.match(html, /设为成功/);
  assert.match(html, /manual_review_reason/);
  assert.match(html, /needs_manual_review/);
});

test('server reconciles manual-review jobs on a faster bounded background cadence', async () => {
  const source = await fs.readFile(path.join(REPO_ROOT, 'server.js'), 'utf-8');
  assert.match(source, /JOB_RECONCILE_INTERVAL_MS\s*=\s*10000/);
  assert.match(source, /JOB_RECONCILE_BATCH_SIZE\s*=\s*100/);
  assert.match(source, /JOB_RECONCILE_CONCURRENCY\s*=\s*10/);
  assert.match(source, /runWithConcurrency/);
});

test('admin and user pages expose plus one year and queue estimates', async () => {
  const adminHtml = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  const indexHtml = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(adminHtml, /value="plus_1y"/);
  assert.match(adminHtml, /value="pro_20x"/);
  assert.match(adminHtml, /Plus 1 年/);
  assert.match(adminHtml, /Pro 20X/);
  assert.match(adminHtml, /Pro 合计/);
  assert.match(adminHtml, /formatEstimate/);
  assert.match(indexHtml, /PLUS_1Y/);
  assert.match(indexHtml, /PRO_20X/);
  assert.match(indexHtml, /queue_position/);
  assert.match(indexHtml, /estimated_wait_seconds/);
});

test('user page labels plus one year cards as plus one year instead of pro', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /function subscriptionTypeLabel/);
  assert.match(html, /plus_1y:\s*t\('type\.plus_1y'\)/);
  assert.match(html, /pro_20x:\s*t\('type\.pro_20x'\)/);
  assert.doesNotMatch(html, /data\.type\s*===\s*'plus'\s*\?\s*'ChatGPT Plus'\s*:\s*'ChatGPT Pro'/);
});

test('user page localizes dynamic labels in english mode', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /data-i18n="brand\.title"/);
  assert.match(html, /'brand\.title': 'GPT Source'/);
  assert.match(html, /'type\.plus_1y': 'ChatGPT Plus 1 Year'/);
  assert.match(html, /'query\.diagnostics': 'Diagnostics: \{stage\} - \{reason\}'/);
  assert.match(html, /'query\.diagnostics': '诊断信息: \{stage\} - \{reason\}'/);
  assert.match(html, /t\('query\.diagnostics'/);
  assert.doesNotMatch(html, /\[Diagnostics:/);
});

test('user page exposes queue summary hooks for current queue size and estimated wait time', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /queueSummaryCard/);
  assert.match(html, /queueSummaryCount/);
  assert.match(html, /queueSummaryEta/);
  assert.match(html, /\/api\/card\/queue\?workflow=/);
  assert.match(html, /estimated_next_wait_seconds/);
  assert.match(html, /pending/);
});

test('user homepage loads visible live queue data on page load and refreshes it automatically', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /homeQueueSection/);
  assert.match(html, /homeQueueGrid/);
  assert.match(html, /refreshHomeQueueSummary/);
  assert.match(html, /fetch\('\/api\/card\/queue'\)/);
  assert.match(html, /refreshHomeQueueSummary\(\);/);
  assert.match(html, /setInterval\(refreshHomeQueueSummary,\s*30000\)/);
  assert.match(html, /homeQueueEmpty/);
});

test('user homepage collapses live queue display down to one latest summary block', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /function selectHomeQueueSummary/);
  assert.match(html, /const summary = selectHomeQueueSummary\(queues\)/);
  assert.match(html, /grid\.innerHTML = `[\s\S]*home-queue-item/);
});

test('user homepage live queue only shows the monthly plus queue', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /function selectHomeQueueSummary\(queues\)\s*{[\s\S]{0,500}queues\?\.plus/);
  assert.doesNotMatch(html, /const order = \['plus', 'plus_1y', 'pro', 'pro_20x'\]/);
});

test('newly generated cards use a longer non-legacy format', async () => {
  const server = await startServer('long cdk generation');

  try {
    const token = await loginAdmin(server.port);
    const code = await generateOneCard(server.port, token);
    assert.match(code, /^CDK-PLUS-[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/);
    assert.doesNotMatch(code, /^CDK-PLUS-[A-Z0-9]{10}$/);
  } finally {
    await server.stop();
  }
});

test('plus one year cards submit the plus_1y workflow and expose queue estimates', async () => {
  let submittedWorkflow = null;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        submittedWorkflow = JSON.parse(body).workflow;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job_id: 'job-plus-1y',
          workflow: 'plus_1y',
          status: 'pending',
          queue_position: 3,
          estimated_wait_seconds: 540
        }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-plus-1y')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-plus-1y',
        workflow: 'plus_1y',
        status: 'processing',
        queue_position: 1,
        estimated_wait_seconds: 180,
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('plus 1y workflow with queue estimates');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token, 'plus_1y');

    assert.match(code, /^CDK-PLUS_1Y-[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);
    assert.equal(submittedWorkflow, 'plus_1y');
    assert.equal(redeem.data.workflow, 'plus_1y');
    assert.equal(redeem.data.queue_position, 3);
    assert.equal(redeem.data.estimated_wait_seconds, 540);

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.type, 'plus_1y');
    assert.equal(query.data.redeem_status, 'processing');
    assert.equal(query.data.queue_position, 1);
    assert.equal(query.data.estimated_wait_seconds, 180);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('pro 20x cards submit the pro_20x workflow and remain distinct from legacy pro', async () => {
  let submittedWorkflow = null;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        submittedWorkflow = JSON.parse(body).workflow;
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          job_id: 'job-pro-20x',
          workflow: 'pro_20x',
          status: 'pending',
          queue_position: 2,
          estimated_wait_seconds: 300
        }));
      });
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-pro-20x')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id: 'job-pro-20x',
        workflow: 'pro_20x',
        status: 'processing',
        queue_position: 1,
        estimated_wait_seconds: 120,
        error: null
      }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('pro 20x workflow with queue estimates');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token, 'pro_20x');

    assert.match(code, /^CDK-PRO_20X-[A-Z2-9]{5}(?:-[A-Z2-9]{5}){4}$/);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);
    assert.equal(submittedWorkflow, 'pro_20x');
    assert.equal(redeem.data.type, 'pro_20x');
    assert.equal(redeem.data.workflow, 'pro_20x');
    assert.equal(redeem.data.queue_position, 2);
    assert.equal(redeem.data.estimated_wait_seconds, 300);

    const query = await queryCard(server.port, code);
    assert.equal(query.res.status, 200);
    assert.equal(query.data.type, 'pro_20x');
    assert.equal(query.data.redeem_status, 'processing');
    assert.equal(query.data.workflow, 'pro_20x');
    assert.equal(query.data.queue_position, 1);
    assert.equal(query.data.estimated_wait_seconds, 120);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('legacy card format remains valid after strengthening new codes', async () => {
  const legacyCode = 'CDK-PLUS-ABCDEFGHJK';
  const server = await startServer('legacy cdk remains valid', {}, {
    cards: [{
      id: 1,
      code: legacyCode,
      type: 'plus',
      status: 'unused',
      created_at: '2026/4/23 12:00:00',
      used_at: null,
      used_by: null,
      batch_id: 'legacy'
    }]
  });

  try {
    const verified = await verifyCard(server.port, legacyCode);
    assert.equal(verified.res.status, 200);
    assert.equal(verified.data.valid, true);
    assert.equal(verified.data.type, 'plus');
  } finally {
    await server.stop();
  }
});

test('invalid card scans keep returning normal not-found responses', async () => {
  const server = await startServer('invalid cdk scan block');

  try {
    for (let i = 0; i < 10; i += 1) {
      const result = await verifyCard(server.port, `CDK-PLUS-NOTREAL${i}AA`);
      assert.equal(result.res.status, 404);
    }
  } finally {
    await server.stop();
  }
});

test('trusted proxy mode still returns normal not-found responses for repeated invalid cards', async () => {
  const server = await startServer('trusted proxy scan block', { TRUST_PROXY: '1' });

  try {
    for (let i = 0; i < 10; i += 1) {
      const res = await verifyCardFromIp(server.port, `CDK-PLUS-NOTREAL${i}AA`, '198.51.100.10');
      assert.equal(res.res.status, 404);
    }

    const otherClient = await verifyCardFromIp(server.port, 'CDK-PLUS-NOTREALXAA', '198.51.100.11');
    assert.equal(otherClient.res.status, 404);
  } finally {
    await server.stop();
  }
});

test('frontend validation accepts both legacy and strengthened cdk formats', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /CDK_PATTERN\s*=\s*\/\^CDK-\(PLUS\|PLUS_1Y\|PRO\|PRO_20X\)-\(\?:\[A-Z0-9\]\{10\}\|\[A-Z2-9\]\{5\}/);
});

test('user page exposes cancel controls that call the public cancel api', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /cancelTaskByJobId/);
  assert.match(html, /\/api\/card\/cancel/);
  assert.match(html, /取消任务/);
});

test('public cancel refunds the pending job by job id without admin auth', async () => {
  let deleteCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-ok', status: 'pending' }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/job/job-cancel-ok') {
      deleteCalled++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-ok', status: 'failed', error: 'cancelled' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('public cancel matching job');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const cancelled = await cancelJob(server.port, 'job-cancel-ok');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');
    assert.equal(deleteCalled, 1);

    const query = await queryCard(server.port, code);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.equal(query.data.redeem_error, 'cancelled');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('public cancel normalizes cancelled upstream statuses into a terminal failed state', async () => {
  let deleteCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancelled-status', status: 'pending' }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/job/job-cancelled-status') {
      deleteCalled++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancelled-status', status: 'cancelled', error: 'cancelled' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-cancelled-status')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancelled-status', status: 'cancelled', error: 'cancelled' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('public cancel normalizes cancelled status');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const cancelled = await cancelJob(server.port, 'job-cancelled-status');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');
    assert.equal(deleteCalled, 1);

    const query = await queryCard(server.port, code);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'failed');
    assert.equal(query.data.redeem_error, 'cancelled');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('public cancel refunds the local card when upstream says job is missing or expired', async () => {
  let deleteCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-expired', status: 'pending' }));
      return;
    }
    if (req.method === 'DELETE' && req.url === '/job/job-cancel-expired') {
      deleteCalled++;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: 'job not found or expired' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('public cancel expired job refunds card');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const cancelled = await cancelJob(server.port, 'job-cancel-expired');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'expired');
    assert.equal(deleteCalled, 1);

    const query = await queryCard(server.port, code);
    assert.equal(query.data.status, 'unused');
    assert.equal(query.data.redeem_status, 'expired');
    assert.match(query.data.redeem_error, /not found|expired/);
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('public cancel forwards unknown local job ids to upstream', async () => {
  let deleteCalled = 0;
  const upstream = await startMockUpstream((req, res) => {
    if (req.method === 'POST' && req.url === '/submit') {
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-guard', status: 'pending' }));
      return;
    }
    if (req.method === 'GET' && req.url.startsWith('/job/job-cancel-guard')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-guard', status: 'processing', error: null }));
      return;
    }
    if (req.method === 'DELETE') {
      deleteCalled++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: 'job-cancel-missing', status: 'failed', error: 'cancelled' }));
      return;
    }
    res.writeHead(404).end();
  });
  const server = await startServer('public cancel forwards unknown job');

  try {
    const token = await loginAdmin(server.port);
    await configureUpstream(server.port, token, upstream.baseUrl);
    const code = await generateOneCard(server.port, token);

    const redeem = await redeemCard(server.port, code);
    assert.equal(redeem.res.status, 200);

    const cancelled = await cancelJob(server.port, 'job-cancel-missing');
    assert.equal(cancelled.res.status, 200);
    assert.equal(cancelled.data.status, 'failed');
    assert.equal(deleteCalled, 1);

    const query = await queryCard(server.port, code);
    assert.equal(query.data.status, 'used');
    assert.equal(query.data.redeem_status, 'processing');
  } finally {
    await server.stop();
    await upstream.stop();
  }
});

test('cancel page exists and posts to the public cancel api', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'cancel.html'), 'utf-8');
  assert.match(html, /取消兑换任务/);
  assert.match(html, /\/api\/card\/cancel/);
  assert.doesNotMatch(html, /codeInput/);
  assert.match(html, /job_id/);
});

test('public cancel page is accessible without admin auth', async () => {
  const server = await startServer('public cancel page route');

  try {
    const res = await fetch(`http://127.0.0.1:${server.port}/cancel`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /取消兑换任务/);
  } finally {
    await server.stop();
  }
});






