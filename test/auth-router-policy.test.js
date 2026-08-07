import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';

// Regression guard: the UI API policy must run for routes served by the
// extracted auth router, including under a non-empty BASE_PATH. If the policy
// is mounted after the router, those handlers respond before the policy runs
// and sensitive routes become publicly readable.
function request(port, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('UI API policy gates setup/capabilities under a non-empty BASE_PATH', { timeout: 90000 }, async () => {
  const port = 34750;
  const dataDir = mkdtempSync(join(tmpdir(), 'cc-bp-policy-'));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DEMO_MODE: 'true', PYTHON_BIN: 'definitely-missing-python', BASE_PATH: '/nexus', COMMANDCENTER_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  const cleanup = () => { try { child.kill(); } catch {} };
  try {
    const deadline = Date.now() + 45000;
    while (true) {
      try { if ((await request(port, '/nexus/api/auth/status')).status === 200) break; } catch {}
      if (Date.now() > deadline || child.exitCode !== null) throw new Error('Server did not become healthy.');
      await new Promise((r) => setTimeout(r, 300));
    }
    // Before setup, the sensitive browser API must be rejected.
    assert.equal((await request(port, '/nexus/api/setup/capabilities')).status, 403, 'setup/capabilities must be 403 before operator setup');
    // Public status endpoint still works.
    assert.equal((await request(port, '/nexus/api/auth/status')).status, 200);
    // Unknown base path still rejects.
    assert.equal((await request(port, '/api/setup/capabilities')).status, 404);
  } finally {
    cleanup();
  }
});
