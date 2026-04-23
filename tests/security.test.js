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

async function loginAdmin(port) {
  const { data } = await requestJson(port, '/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ password: 'correct horse battery staple' })
  });
  return data.token;
}

async function configureUpstream(port, token, baseUrl) {
  const { res } = await requestJson(port, '/api/admin/settings', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ apiKey: 'test-api-key', baseUrl })
  });
  assert.equal(res.status, 200);
}

async function generateOneCard(port, token) {
  const { res, data } = await requestJson(port, '/api/admin/cards/generate', {
    method: 'POST',
    headers: { 'X-Admin-Token': token },
    body: JSON.stringify({ count: 1, type: 'plus' })
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

test('query page renders redeem status even when the card was refunded', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.doesNotMatch(html, /const\s+redeemRows\s*=\s*data\.used_at\s*\?/);
  assert.match(html, /const\s+redeemRows\s*=\s*data\.redeem_status\s*\?/);
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

test('admin records expose per-row cancel controls', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'admin.html'), 'utf-8');
  assert.match(html, /<th>操作<\/th>/);
  assert.match(html, /cancelRecordJob/);
  assert.match(html, /\/api\/card\/cancel/);
  assert.match(html, /取消/);
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

test('invalid card scanning is blocked before normal verify rate limit', async () => {
  const server = await startServer('invalid cdk scan block');

  try {
    let last;
    for (let i = 0; i < 8; i += 1) {
      last = await verifyCard(server.port, `CDK-PLUS-NOTREAL${i}AA`);
    }

    assert.equal(last.res.status, 404);

    const blocked = await verifyCard(server.port, 'CDK-PLUS-NOTREAL9AA');
    assert.equal(blocked.res.status, 429);
    assert.match(blocked.data.error, /尝试次数过多|扫描|稍后/);
  } finally {
    await server.stop();
  }
});

test('trusted proxy mode separates scanner blocks by forwarded client ip', async () => {
  const server = await startServer('trusted proxy scan block', { TRUST_PROXY: '1' });

  try {
    for (let i = 0; i < 8; i += 1) {
      const res = await verifyCardFromIp(server.port, `CDK-PLUS-NOTREAL${i}AA`, '198.51.100.10');
      assert.equal(res.res.status, 404);
    }

    const blockedScanner = await verifyCardFromIp(server.port, 'CDK-PLUS-NOTREAL9AA', '198.51.100.10');
    assert.equal(blockedScanner.res.status, 429);

    const otherClient = await verifyCardFromIp(server.port, 'CDK-PLUS-NOTREALXAA', '198.51.100.11');
    assert.equal(otherClient.res.status, 404);
  } finally {
    await server.stop();
  }
});

test('frontend validation accepts both legacy and strengthened cdk formats', async () => {
  const html = await fs.readFile(path.join(REPO_ROOT, 'index.html'), 'utf-8');
  assert.match(html, /CDK_PATTERN\s*=\s*\/\^CDK-\(PLUS\|PRO\)-\(\?:\[A-Z0-9\]\{10\}\|\[A-Z2-9\]\{5\}/);
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
