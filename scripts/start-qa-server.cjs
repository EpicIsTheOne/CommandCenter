#!/usr/bin/env node
// Starts the CommandCenter QA server detached (survives this script's exit),
// waits for liveness, and performs one-time UI auth setup on a fresh data dir.
// Idempotent: if our QA server is already healthy on 3100, exits 0.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const PID_FILE = path.join(os.tmpdir(), 'cc-qa-server.pid');
const LOG_FILE = path.join(os.tmpdir(), 'cc-qa-server.log');
const DATA_DIR = process.env.QA_DATA_DIR || path.join(os.tmpdir(), 'cc-qa-data');
const HOST = '127.0.0.1';
const PORT = Number(process.env.QA_PORT || 3100);
const BASE_URL = `http://${HOST}:${PORT}`;
const PASSWORD = 'qa-pass-2026';

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      `${BASE_URL}${urlPath}`,
      {
        method,
        headers: {
          ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}),
        },
        timeout: 4000,
      },
      (res) => {
        let out = '';
        res.on('data', (chunk) => { out += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, json: (() => { try { return JSON.parse(out); } catch { return null; } })() }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

async function health() {
  try {
    const res = await request('GET', '/api/auth/status');
    return res.status === 200 ? res.json : null;
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // Already running? (tracked pid + healthy)
  let existing = Number.NaN;
  try { existing = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10); } catch {}
  const trackedOk = Number.isFinite(existing) && pidAlive(existing);
  const healthy = await health();
  if (healthy && trackedOk) {
    console.log(`[start-qa] already running (pid ${existing}) at ${BASE_URL}`);
    return;
  }

  // Port busy but not ours → refuse to touch it.
  if (healthy && !trackedOk) {
    console.error('[start-qa] port ' + PORT + ' is served by an untracked process — refusing to start or kill it.');
    process.exit(2);
  }

  const logFd = fs.openSync(LOG_FILE, 'a');
  fs.writeSync(logFd, `\n===== boot ${new Date().toISOString()} =====\n`);
  const child = spawn(process.execPath, [path.join(REPO, 'server', 'index.js')], {
    cwd: REPO,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      COMMANDCENTER_DATA_DIR: DATA_DIR,
      HOST: HOST,
      PORT: String(PORT),
      LOCAL_API_ENABLED: 'false',
      DEMO_MODE: 'false',
    },
  });
  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  child.unref();
  console.log(`[start-qa] spawned pid ${child.pid} -> ${BASE_URL} (log: ${LOG_FILE})`);

  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    await sleep(700);
    if (!pidAlive(child.pid)) {
      console.error('[start-qa] server process died during startup. Log tail:');
      try { console.error(fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')); } catch {}
      process.exit(1);
    }
    const h = await health();
    if (h) break;
  }
  const finalHealth = await health();
  if (!finalHealth) {
    console.error('[start-qa] server did not become healthy in time. Log tail:');
    try { console.error(fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-25).join('\n')); } catch {}
    process.exit(1);
  }

  // One-time setup so the UI modal shows LOGIN (single field), not SETUP.
  if (!finalHealth.passwordSet) {
    const setup = await request('POST', '/api/auth/setup', { password: PASSWORD });
    if (setup.status !== 200) {
      console.error('[start-qa] auth setup failed:', setup.status, JSON.stringify(setup.json));
      process.exit(1);
    }
    console.log('[start-qa] UI password configured for fresh QA data dir.');
  }
  console.log(`[start-qa] ready: ${BASE_URL} (pid ${child.pid}, data: ${DATA_DIR})`);
}

main().catch((err) => {
  console.error('[start-qa] failed:', err.message);
  process.exit(1);
});
