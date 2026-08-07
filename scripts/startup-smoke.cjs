const { spawn } = require('node:child_process');
const http = require('node:http');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

// Honor BASE_PATH the same way the server does, so the smoke works for
// path-prefixed deployments (e.g. behind a reverse proxy subpath).
const basePath = (process.env.BASE_PATH || '').trim().replace(/\/$/, '');
const bp = (p) => `${basePath}${p}`;

const port = 33000 + Math.floor(Math.random() * 800);
const localPort = port + 1000;
const dataDir = mkdtempSync(join(tmpdir(), 'cc-startup-'));
const apiKey = 'startup-smoke-key';
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: join(__dirname, '..'),
  env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOCAL_API_ENABLED: 'true', LOCAL_API_PORT: String(localPort), LOCAL_API_HOST: '127.0.0.1', DEMO_MODE: 'true', PYTHON_BIN: 'definitely-missing-python', COMMANDCENTER_DATA_DIR: dataDir, COMMANDCENTER_API_KEY: apiKey },
  stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

function request(targetPort, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({ host: '127.0.0.1', port: targetPort, path, method, headers: { ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function run() {
  const deadline = Date.now() + 45000;
  while (true) {
    try { if ((await request(port, bp('/api/auth/status'))).status === 200) break; } catch {}
    if (Date.now() > deadline || child.exitCode !== null) throw new Error('Server did not become healthy.');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  if ((await request(port, bp('/'))).status !== 200) throw new Error('Main UI did not load.');
  if ((await request(port, bp('/api/setup/capabilities'))).status !== 403) throw new Error('Sensitive browser API was not setup-gated.');
  const setup = await request(port, bp('/api/auth/setup'), { method: 'POST', body: { password: 'correct horse battery staple' } });
  if (setup.status !== 200) throw new Error(`Password setup failed: ${setup.status} ${setup.body}`);
  const cookie = String(setup.headers['set-cookie']?.[0] || '').split(';')[0];
  if ((await request(port, bp('/api/setup/capabilities'), { headers: { Cookie: cookie } })).status !== 200) throw new Error('Authenticated browser API failed.');
  if ((await request(port, bp('/api/fairy/memory'))).status !== 401) throw new Error('Anonymous sensitive API was not rejected.');
  if ((await request(port, bp('/api/v1/agents'), { headers: { Authorization: `Bearer ${apiKey}` } })).status !== 200) throw new Error('Bearer API authentication failed.');
  const local = await request(localPort, bp('/api/v1/agents'));
  if (local.status !== 200 || local.headers['x-commandcenter-auth-mode'] !== 'local-bypass') throw new Error('Verified local-listener bypass failed.');
  console.log('Demo startup/UI/auth/bearer/local-listener smoke passed.');
}

run().catch((err) => { console.error(err.stack || err); console.error(output); process.exitCode = 1; }).finally(() => {
  child.kill();
  rmSync(dataDir, { recursive: true, force: true });
});

setTimeout(() => { child.kill(); console.error(output); process.exit(1); }, 55000).unref();
