import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShutdown } from '../server/shutdown.js';

function fakeServer() {
  let closed = false;
  return {
    get closed() { return closed; },
    close(cb) { closed = true; if (cb) cb(); },
  };
}

function fakeWss() {
  const clients = new Set();
  return {
    clients,
    closeCalled: false,
    close() { this.closeCalled = true; },
  };
}

test('shutdown closes HTTP server and WebSocket server', async () => {
  const server = fakeServer();
  const wss = fakeWss();
  const logs = [];
  const { shutdown, isShuttingDown } = buildShutdown({ server, wss, log: { warn: () => {}, error: () => {} } });
  assert.equal(isShuttingDown(), false);
  await shutdown('SIGTERM');
  assert.equal(isShuttingDown(), true);
  assert.equal(server.closed, true, 'HTTP server should be closed');
  assert.equal(wss.closeCalled, true, 'WebSocket server should be closed');
});

test('shutdown terminates active WebSocket clients', async () => {
  const wss = fakeWss();
  let terminated = 0;
  wss.clients.add({ terminate: () => { terminated += 1; } });
  wss.clients.add({ terminate: () => { terminated += 1; } });
  const { shutdown } = buildShutdown({ server: fakeServer(), wss, log: { warn: () => {}, error: () => {} } });
  await shutdown('SIGTERM');
  assert.equal(terminated, 2);
});

test('shutdown is idempotent', async () => {
  const server = fakeServer();
  const { shutdown, isShuttingDown } = buildShutdown({ server, wss: null, log: { warn: () => {}, error: () => {} } });
  await shutdown('SIGTERM');
  await shutdown('SIGTERM');
  assert.equal(server.closed, true);
  assert.equal(isShuttingDown(), true);
});

test('shutdown stops the bridge when it exposes stop()', async () => {
  let bridgeStopped = false;
  const bridge = { stop: async () => { bridgeStopped = true; } };
  const { shutdown } = buildShutdown({ server: fakeServer(), wss: null, bridge, log: { warn: () => {}, error: () => {} } });
  await shutdown('SIGTERM');
  assert.equal(bridgeStopped, true);
});
