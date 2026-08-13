const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');

const repoDir = join(__dirname, '..');
const port = 39211 + Math.floor(Math.random() * 100);
const localPort = port + 1;
const dataDir = mkdtempSync(join(tmpdir(), 'cc-control-live-'));
const child = spawn(process.execPath, ['server/index.js'], {
  cwd: repoDir,
  env: {
    ...process.env,
    PORT: String(port),
    HOST: '127.0.0.1',
    LOCAL_API_ENABLED: 'true',
    LOCAL_API_PORT: String(localPort),
    LOCAL_API_HOST: '127.0.0.1',
    DEMO_MODE: 'true',
    PYTHON_BIN: 'definitely-missing-python',
    COMMANDCENTER_DATA_DIR: dataDir,
    COMMANDCENTER_CONTROL_DATA_DIR: dataDir,
    COMMANDCENTER_API_KEY: 'control-plane-live-smoke-key',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
});

let output = '';
child.stdout.on('data', (chunk) => { output += chunk; });
child.stderr.on('data', (chunk) => { output += chunk; });

function request(portNumber, path, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === null ? null : Buffer.from(JSON.stringify(body));
    const req = http.request({
      host: '127.0.0.1',
      port: portNumber,
      path,
      method,
      headers: payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {},
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {}
        resolve({ status: res.statusCode, json, raw });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function waitForServer() {
  const deadline = Date.now() + 18000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early: ${child.exitCode}`);
    try {
      const response = await request(port, '/api/auth/status');
      if (response.status === 200) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('temporary server did not become healthy');
}

async function json(portNumber, path, options = {}) {
  const response = await request(portNumber, path, options);
  assert.equal(response.status, 200, `${options.method || 'GET'} ${path}: ${response.status} ${response.raw}`);
  return response.json;
}

async function post(path, body, expectedStatuses = [200]) {
  const response = await request(localPort, path, { method: 'POST', body });
  assert.ok(expectedStatuses.includes(response.status), `POST ${path}: ${response.status} ${response.raw}`);
  return response.json;
}

async function expectConflict(path, body, expectedCode) {
  const response = await request(localPort, path, { method: 'POST', body });
  assert.equal(response.status, 409, `expected conflict for ${path}, got ${response.status} ${response.raw}`);
  assert.equal(response.json?.code, expectedCode, `unexpected conflict code for ${path}: ${response.raw}`);
  return response.json;
}

async function run() {
  await waitForServer();
  const status = await json(localPort, '/api/v1/control/status');
  assert.equal(status.ok, true);

  const createBody = {
    title: 'Live control acceptance',
    prompt: 'bounded acceptance task',
    autoQueue: false,
    autoStart: false,
    operationId: 'live-create-1',
  };
  const createdResponse = await request(localPort, '/api/v1/control/tasks', { method: 'POST', body: createBody });
  assert.equal(createdResponse.status, 201, createdResponse.raw);
  const created = createdResponse.json;
  const duplicateResponse = await request(localPort, '/api/v1/control/tasks', { method: 'POST', body: createBody });
  assert.equal(duplicateResponse.status, 201, duplicateResponse.raw);
  assert.equal(duplicateResponse.json.task.id, created.task.id);
  assert.equal(duplicateResponse.json.task.revision, created.task.revision);
  await expectConflict('/api/v1/control/tasks', { ...createBody, title: 'conflicting reuse', prompt: 'different payload' }, 'IDEMPOTENCY_CONFLICT');

  const cancelPath = `/api/v1/control/tasks/${encodeURIComponent(created.task.id)}/cancel`;
  const cancelBody = { operationId: 'live-cancel-1', expectedTaskRevision: created.task.revision };
  const cancelled = await post(cancelPath, cancelBody);
  const cancelledAgain = await post(cancelPath, cancelBody);
  assert.equal(cancelled.task.state, 'cancelled');
  assert.equal(cancelledAgain.task.revision, cancelled.task.revision);

  const riskyResponse = await request(localPort, '/api/v1/control/tasks', {
    method: 'POST',
    body: {
      title: 'Approval acceptance',
      prompt: 'approval-gated acceptance task',
      capabilities: ['file.write'],
      autoQueue: false,
      autoStart: false,
      operationId: 'live-risky-1',
    },
  });
  assert.equal(riskyResponse.status, 201, riskyResponse.raw);
  const risky = riskyResponse.json;
  assert.equal(risky.task.state, 'waiting_for_approval');
  assert.ok(risky.approval?.id);
  const approvals = await json(localPort, `/api/v1/control/approvals?taskId=${encodeURIComponent(risky.task.id)}`);
  const approval = approvals.approvals.find((item) => item.id === risky.approval.id);
  assert.ok(approval);
  const riskCancel = await post(`/api/v1/control/tasks/${encodeURIComponent(risky.task.id)}/cancel`, {
    operationId: 'live-risk-cancel-1',
    expectedTaskRevision: risky.task.revision,
  });
  assert.equal(riskCancel.task.state, 'cancelled');
  await expectConflict(`/api/v1/control/approvals/${encodeURIComponent(approval.id)}/approve`, {
    operationId: 'live-late-approval-1',
    expectedApprovalRevision: approval.revision,
  }, 'TASK_NOT_APPROVABLE');

  const events = (await json(localPort, '/api/v1/control/events?afterEventSequence=0&limit=500')).events;
  const eventTypes = new Set(events.map((event) => event.type));
  for (const type of ['task.created', 'task.cancel_requested', 'task.cancelled', 'approval.requested']) assert.ok(eventTypes.has(type), `missing ${type}`);

  const thread = await post('/api/v1/control/threads', { title: 'Live thread', operationId: 'live-thread-1' }, [201]);
  const message = await post(`/api/v1/control/threads/${encodeURIComponent(thread.thread.id)}/messages`, { role: 'user', text: 'side chat', operationId: 'live-message-1' }, [201]);
  assert.equal(message.message.text, 'side chat');
  const fork = await post(`/api/v1/control/threads/${encodeURIComponent(thread.thread.id)}/fork`, { operationId: 'live-fork-1' }, [201]);
  assert.equal(fork.thread.parentThreadId, thread.thread.id);
  const compact = await post(`/api/v1/control/threads/${encodeURIComponent(thread.thread.id)}/compact`, { summary: 'compacted', operationId: 'live-compact-1' });
  assert.equal(compact.thread.contextSummary, 'compacted');
  const finalStatus = await json(localPort, '/api/v1/control/status');

  console.log(JSON.stringify({
    ok: true,
    taskId: created.task.id,
    duplicateCreateRevision: duplicateResponse.json.task.revision,
    cancelledState: cancelled.task.state,
    riskyState: risky.task.state,
    lateApprovalCode: 'TASK_NOT_APPROVABLE',
    eventCount: events.length,
    eventSequence: finalStatus.eventSequence,
    threadId: thread.thread.id,
    forkId: fork.thread.id,
  }));
}

run().catch((error) => {
  console.error(error.stack || error);
  console.error(output);
  process.exitCode = 1;
}).finally(() => {
  if (child.exitCode === null) child.kill();
  setTimeout(() => {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dataDir, { recursive: true, force: true });
  }, 250).unref();
});
