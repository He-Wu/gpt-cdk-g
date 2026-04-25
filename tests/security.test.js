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
  if (seed.cards || seed.records || seed.settings) {
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

function formatUtcRecordTime(timestampMs) {
  const date = new Date(timestampMs);
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

async function generateOneCard(port, token, type = 'plus') {
  const { res, data } = await requestJson(port, '/api/admin/cards/generate', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ count: 1, type })
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
        created_at: formatUtcRecordTime(now - 10 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 2,
        card_code: 'CDK-PRO-BBBBB-BBBBB-BBBBB-BBBBB-BBBBB',
        card_type: 'pro',
        job_id: 'job-range-2',
        status: 'failed',
        error_message: 'payment rejected',
        created_at: formatUtcRecordTime(now - 20 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 3,
        card_code: 'CDK-PLUS_1Y-CCCCC-CCCCC-CCCCC-CCCCC-CCCCC',
        card_type: 'plus_1y',
        job_id: 'job-range-3',
        status: 'done',
        error_message: null,
        created_at: formatUtcRecordTime(now - 50 * 60 * 1000),
        ip_address: '127.0.0.1'
      },
      {
        id: 4,
        card_code: 'CDK-PRO_20X-DDDDD-DDDDD-DDDDD-DDDDD-DDDDD',
        card_type: 'pro_20x',
        job_id: 'job-range-4',
        status: 'done',
        error_message: null,
        created_at: formatUtcRecordTime(now - 26 * 60 * 60 * 1000),
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
});

test('user page treats unknown redeem submit responses as locked terminal state', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,500}\['unknown',\s*'expired'\]\.includes\(data\.status\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,800}step1Card'\)\.classList\.add\('hidden'\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,1000}step2Card'\)\.classList\.add\('hidden'\)/);
  assert.match(html, /if\s*\(!res\.ok\)\s*{[\s\S]{0,1200}showJobStatus\(\{/);
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

test('admin records keep cancel available for manual-review rows without job id', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /record\.needs_manual_review === true/);
  assert.match(html, /record_id/);
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

test('admin page script parses so login handlers are actually defined', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  const match = html.match(/<script>([\s\S]*)<\/script>\s*<\/body>/);
  assert.ok(match, 'expected inline admin script');
  assert.doesNotThrow(() => new Function(match[1]));
  assert.match(match[1], /async function adminLogin\(/);
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
  assert.match(html, /manual_review_reason/);
  assert.match(html, /needs_manual_review/);
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
  assert.match(html, /plus_1y:\s*'ChatGPT Plus 1 骞?/);
  assert.match(html, /pro_20x:\s*'ChatGPT Pro 20X'/);
  assert.doesNotMatch(html, /data\.type\s*===\s*'plus'\s*\?\s*'ChatGPT Plus'\s*:\s*'ChatGPT Pro'/);
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






