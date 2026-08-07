import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// Regression guard: DEMO_MODE=true must NOT disable operator UI auth. Demo
// mode only changes agent/runtime behavior, never the setup gate or session
// cookies. If a refactor ever couples demo mode to auth bypass, this fails.
// Honor BASE_PATH exactly like the server does, so path-prefixed deployments
// (and sandboxes that export BASE_PATH) probe the real mounted path.
const BASE = process.env.BASE_PATH || '';
function request(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path: `${BASE}${path}`, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('DEMO_MODE=true does not downgrade UI auth (anon + setup-gated)', { timeout: 90000 }, async () => {
  const port = 34800;
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-demo-auth-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEMO_MODE: 'true', PYTHON_BIN: 'definitely-missing-python', COMMANDCENTER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const cleanup = () => { try { child.kill(); } catch {} };
  try {
    const deadline = Date.now() + 75000;
    while (true) {
      try { if ((await request(port, '/api/auth/status')).status === 200) break; } catch {}
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Server did not become healthy.');
      await new Promise((r) => setTimeout(r, 300));
    }
    // Demo mode must still require operator setup before exposing sensitive APIs.
    assert.equal((await request(port, '/api/setup/capabilities')).status, 403, 'setup/capabilities must stay 403 pre-setup even in demo mode');
    // An authenticated API must still reject anonymous callers (401 before
    // setup, 403 after — either proves demo mode did not disable auth).
    const fairy = await request(port, '/api/fairy/memory');
    assert.notEqual(fairy.status, 200, 'fairy/memory must reject anonymous users in demo mode (got ' + fairy.status + ')');

    // Perform the loopback operator setup (allowed pre-setup from localhost),
    // which proves setup still works AND yields a session cookie we can use to
    // confirm demo mode is genuinely active via the authed status payload.
    const setupRes = await request(port, '/api/auth/setup', {
      method: 'POST',
      body: { password: 'correct horse battery staple' },
    });
    assert.equal(setupRes.status, 200, 'operator setup must succeed in demo mode');
    const setCookie = setupRes.headers['set-cookie'];
    assert.ok(setCookie && setCookie.length, 'setup must issue a session cookie');
    const cookie = String(setCookie[0]).split(';')[0];

    // Demo flag is actually on (so we are testing the right configuration).
    const status = await request(port, '/api/status', { headers: { Cookie: cookie } });
    assert.equal(status.status, 200, 'authed /api/status should succeed after setup');
    const statusBody = JSON.parse(status.body);
    assert.equal(statusBody.setup?.demoMode, true, 'demoMode should be true in this configuration');
  } finally {
    cleanup();
  }
});
