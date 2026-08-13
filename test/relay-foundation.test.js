import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { scryptSync } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { RelayManager } from '../server/relay-manager.js';
import { RELAY_CHAT_TEXT_MAX_BYTES, RELAY_DEVICE_WS_PATH, RELAY_MAX_PAYLOAD_BYTES, RELAY_OWNER_ID, validateDeviceEnvelope, validateRelayAuth, validateRelayChatRequest, validateRelayChatResponse, parseRelayMessage } from '../server/relay-protocol.js';
import { createRelayDeviceUpgrade } from '../server/relay-ws.js';
import { authorizeWebSocketRequest } from '../server/request-security.js';
import { classifyApiRoute } from '../server/route-policy.js';
import { writeJsonStore } from '../server/json-store.js';

test('relay protocol enforces version, payload cap, and server-bound identity', () => {
  const base = { v: 1, id: 'msg-1', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: {} };
  assert.equal(validateDeviceEnvelope(base, { deviceId: 'device-1' }).ownerId, RELAY_OWNER_ID);
  assert.throws(() => validateDeviceEnvelope({ ...base, payload: { ownerId: 'evil' } }, { deviceId: 'device-1' }), /server-bound/);
  assert.throws(() => parseRelayMessage(Buffer.alloc(64 * 1024 + 1)), (error) => error.code === 'PAYLOAD_TOO_LARGE');
  assert.throws(() => validateRelayAuth({ ...base, type: 'relay.heartbeat' }), (error) => error.code === 'AUTH_REQUIRED');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'relay.auth', payload: { method: 'credential', secret: 'never-emit' } }, { deviceId: 'device-1' }), (error) => error.code === 'AUTH_REQUIRED');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'relay.presence', payload: { state: 'not-a-state' } }, { deviceId: 'device-1' }), (error) => error.code === 'INVALID_MESSAGE');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'device.state.snapshot', payload: { agents: {} } }, { deviceId: 'device-1' }), (error) => error.code === 'INVALID_SCHEMA');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'device.state.snapshot', payload: { device: [] } }, { deviceId: 'device-1' }), (error) => error.code === 'INVALID_MESSAGE');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'device.state.snapshot', payload: { device: { id: 'spoofed' } } }, { deviceId: 'device-1' }), (error) => error.code === 'INVALID_SCHEMA');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'device.state.snapshot', payload: { providers: [{ id: 'p', ownerId: 'spoofed' }] } }, { deviceId: 'device-1' }), (error) => error.code === 'IDENTITY_SPOOF');
  assert.throws(() => validateDeviceEnvelope({ ...base, type: 'agent.roster.snapshot', payload: { activeProviderId: 'x'.repeat(129) } }, { deviceId: 'device-1' }), (error) => error.code === 'INVALID_MESSAGE');
  const chatRequest = validateRelayChatRequest({ ...base, id: 'chat-request', type: 'relay.chat.request', payload: { providerId: 'hermes', agentId: 'hermes:default', providerSessionId: 'cc-session-1', message: 'hello' } });
  assert.equal(chatRequest.payload.agentId, 'hermes:default');
  assert.throws(() => validateDeviceEnvelope({ ...chatRequest }, { deviceId: 'device-1' }), (error) => error.code === 'UNSUPPORTED_TYPE');
  assert.throws(() => validateRelayChatRequest({ ...chatRequest, payload: { ...chatRequest.payload, ownerId: 'evil' } }), (error) => error.code === 'IDENTITY_SPOOF');
  assert.throws(() => validateRelayChatRequest({ ...chatRequest, payload: { ...chatRequest.payload, message: 'x'.repeat(RELAY_CHAT_TEXT_MAX_BYTES + 1) } }), (error) => error.code === 'PAYLOAD_TOO_LARGE');
  assert.throws(() => validateRelayChatResponse({ ...base, type: 'relay.chat.response', payload: { ok: true, text: 'hello' } }), (error) => error.code === 'INVALID_SCHEMA');
  const chatResponse = validateRelayChatResponse({ ...base, id: 'chat-response', type: 'relay.chat.response', replyTo: 'chat-request', payload: { ok: true, text: 'hello', providerSessionId: 'cc-session-1' } });
  assert.equal(chatResponse.replyTo, 'chat-request');
  for (const path of ['/api/relay/v1/pairings', '/api/relay/v1/devices', '/api/relay/v1/devices/device-1/revoke']) assert.equal(classifyApiRoute(path), 'ui-session');
});

test('relay manager rejects replay and preserves replacement/presence lifecycle', () => {
  const manager = new RelayManager();
  const events = [];
  manager.on('message', (event) => events.push(event));
  const ws = { readyState: 1, send() {}, close() {} };
  const message = { v: 1, id: 'heartbeat-1', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: {} };
  manager.connections.set('device-1', ws);
  manager.presence.set('device-1', { ownerId: RELAY_OWNER_ID, deviceId: 'device-1', state: 'online' });
  manager.handle(ws, message, 'device-1');
  assert.throws(() => manager.handle(ws, message, 'device-1'), (error) => error.code === 'REPLAYED_MESSAGE');
  assert.throws(() => manager.handle(ws, { ...message, id: 'spoof', payload: { deviceId: 'evil' } }, 'device-1'), (error) => error.code === 'IDENTITY_SPOOF');
  assert.equal(manager.sequences.get('device-1').has('spoof'), false);
  const presenceBefore = JSON.stringify(manager.listPresence());
  assert.throws(() => manager.handle(ws, { ...message, id: 'reauth', type: 'relay.auth', payload: { method: 'credential', secret: 'do-not-emit' } }, 'device-1'), (error) => error.code === 'AUTH_REQUIRED');
  assert.equal(JSON.stringify(manager.listPresence()), presenceBefore);
  assert.equal(manager.sequences.get('device-1').has('reauth'), false);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify(events), /do-not-emit/);
  assert.throws(() => manager.handle(ws, { ...message, id: 'owner-spoof', payload: { ownerId: 'evil' } }, 'device-1'), (error) => error.code === 'IDENTITY_SPOOF');
  assert.throws(() => manager.handle(ws, '{bad json', 'device-1'), (error) => error.code === 'MALFORMED_MESSAGE');
  assert.throws(() => manager.handle(ws, Buffer.alloc(RELAY_MAX_PAYLOAD_BYTES + 1), 'device-1'), (error) => error.code === 'PAYLOAD_TOO_LARGE');
  assert.throws(() => manager.handle(ws, { ...message, id: 'invalid-schema', type: 'relay.presence', payload: { state: 'invalid' } }, 'device-1'), (error) => error.code === 'INVALID_MESSAGE');
  assert.equal(JSON.stringify(manager.listPresence()), presenceBefore);
  assert.equal(manager.sequences.get('device-1').has('owner-spoof'), false);
  assert.equal(manager.sequences.get('device-1').has('invalid-schema'), false);
  const replacement = { readyState: 1, send() {}, close() { this.closed = true; } };
  manager.connections.set('device-1', replacement);
  manager.disconnect(ws, 'device-1');
  assert.equal(manager.connections.get('device-1'), replacement);
  manager.disconnect(replacement, 'device-1');
  assert.equal(manager.listPresence().find((entry) => entry.deviceId === 'device-1').state, 'offline');
  manager.presence.set('device-2', { ownerId: RELAY_OWNER_ID, deviceId: 'device-2', state: 'online', lastHeartbeatAt: Date.now() - 31_000 });
  assert.equal(manager.listPresence().find((entry) => entry.deviceId === 'device-2').state, 'stale');
});

test('heartbeat sequence baseline resets for a replacement connection epoch', async () => {
  const manager = new RelayManager({
    authenticateDeviceFn: async () => ({ id: 'device-reconnect', ownerId: RELAY_OWNER_ID }),
  });
  const auth = { payload: { method: 'credential', secret: 'valid', deviceId: 'device-reconnect' } };
  const first = { readyState: 1, close() { this.closed = true; } };
  await manager.authenticate(first, auth, '198.51.100.9');
  manager.handle(first, { v: 1, id: 'epoch-one-5', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 5 } }, 'device-reconnect');
  const replacement = { readyState: 1, close() { this.closed = true; } };
  await manager.authenticate(replacement, auth, '198.51.100.9');
  assert.equal(first.closed, true);
  assert.throws(() => manager.handle(first, { v: 1, id: 'old-connection', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 0 } }, 'device-reconnect'), (error) => error.code === 'CONNECTION_REPLACED');
  assert.doesNotThrow(() => manager.handle(replacement, { v: 1, id: 'epoch-two-0', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 0 } }, 'device-reconnect'));
  assert.throws(() => manager.handle(replacement, { v: 1, id: 'epoch-two-0', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 0 } }, 'device-reconnect'), (error) => error.code === 'REPLAYED_MESSAGE');
  manager.handle(replacement, { v: 1, id: 'epoch-two-2', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 2 } }, 'device-reconnect');
  assert.throws(() => manager.handle(replacement, { v: 1, id: 'epoch-two-1', timestamp: new Date().toISOString(), type: 'relay.heartbeat', payload: { sequence: 1 } }, 'device-reconnect'), (error) => error.code === 'REPLAYED_MESSAGE');
});

test('pairing and credentials are hashed and pairing is single-use', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commandcenter-relay-'));
  const prior = process.env.COMMANDCENTER_DATA_DIR;
  process.env.COMMANDCENTER_DATA_DIR = root;
  try {
    const { createPairing, enrollWithPairing, relayStorePaths } = await import(`../server/relay-store.js?test=${Date.now()}`);
    const pairing = await createPairing();
    const enrolled = await enrollWithPairing(pairing.pairingCode, { name: 'Test Device' });
    assert.ok(enrolled.credential);
    assert.equal(await enrollWithPairing(pairing.pairingCode, { name: 'Again' }), null);
    const devices = JSON.parse(await readFile(relayStorePaths.DEVICES_FILE, 'utf8'));
    const pairings = JSON.parse(await readFile(relayStorePaths.PAIRINGS_FILE, 'utf8'));
    const audit = JSON.parse(await readFile(relayStorePaths.AUDIT_FILE, 'utf8'));
    assert.doesNotMatch(JSON.stringify(devices), new RegExp(enrolled.credential));
    assert.doesNotMatch(JSON.stringify(pairings), new RegExp(pairing.pairingCode));
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(pairing.pairingCode));
    assert.doesNotMatch(JSON.stringify(audit), new RegExp(enrolled.credential));
    assert.ok(audit.entries.every((entry) => entry.ownerId === RELAY_OWNER_ID));
    const expired = await createPairing({ ttlMs: 1000 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await enrollWithPairing(expired.pairingCode, { name: 'Expired' }), null);
    const { authenticateDevice, revokeDevice } = await import(`../server/relay-store.js?revoke=${Date.now()}`);
    assert.ok(await authenticateDevice(enrolled.credential, enrolled.device.id));
    assert.equal(await revokeDevice(enrolled.device.id), true);
    assert.equal(await authenticateDevice(enrolled.credential, enrolled.device.id), null);
    const auditAfterRevoke = JSON.parse(await readFile(relayStorePaths.AUDIT_FILE, 'utf8'));
    assert.doesNotMatch(JSON.stringify(auditAfterRevoke), new RegExp(enrolled.credential));
    assert.equal(enrolled.device.ownerId, RELAY_OWNER_ID);
    assert.equal((await import(`../server/relay-store.js?public=${Date.now()}`)).publicDevice({ ...enrolled.device, ownerId: RELAY_OWNER_ID }).ownerId, RELAY_OWNER_ID);
  } finally {
    if (prior === undefined) delete process.env.COMMANDCENTER_DATA_DIR; else process.env.COMMANDCENTER_DATA_DIR = prior;
  }
});

test('current-owner relay operations preserve foreign-owner records', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commandcenter-relay-owners-'));
  const prior = process.env.COMMANDCENTER_DATA_DIR;
  process.env.COMMANDCENTER_DATA_DIR = root;
  try {
    const store = await import(`../server/relay-store.js?owners=${Date.now()}`);
    const foreignCode = 'future-owner-pairing';
    const foreignSalt = 'future-owner-salt';
    const foreignPairing = {
      id: 'pair_future_owner', ownerId: 'owner:future',
      codeHash: `${foreignSalt}:${scryptSync(foreignCode, foreignSalt, 32).toString('hex')}`,
      createdAt: Date.now(), expiresAt: Date.now() + 60_000, usedAt: null,
    };
    const foreignDevice = {
      id: 'device_future_owner', ownerId: 'owner:future', credentialHash: 'future-salt:future-hash',
      createdAt: Date.now(), lastSeenAt: null, revokedAt: null, expiresAt: Date.now() + 60_000,
      metadata: { name: 'Future Owner Device' },
    };
    await writeJsonStore(store.relayStorePaths.PAIRINGS_FILE, { schemaVersion: 1, ownerId: RELAY_OWNER_ID, items: [foreignPairing] });
    await writeJsonStore(store.relayStorePaths.DEVICES_FILE, { schemaVersion: 1, ownerId: RELAY_OWNER_ID, items: [foreignDevice] });
    assert.deepEqual(await store.listDevices(), []);
    const currentPairing = await store.createPairing();
    assert.deepEqual(JSON.parse(await readFile(store.relayStorePaths.PAIRINGS_FILE, 'utf8')).items.find((item) => item.id === foreignPairing.id), foreignPairing);
    assert.equal(await store.enrollWithPairing(foreignCode, { name: 'Spoofed Device' }), null);
    const enrolled = await store.enrollWithPairing(currentPairing.pairingCode, { name: 'Current Device' });
    assert.ok(enrolled);
    assert.equal((await store.listDevices()).some((device) => device.id === foreignDevice.id), false);
    assert.equal(await store.revokeDevice(foreignDevice.id), false);
    assert.deepEqual(JSON.parse(await readFile(store.relayStorePaths.DEVICES_FILE, 'utf8')).items.find((item) => item.id === foreignDevice.id), foreignDevice);
    assert.deepEqual(JSON.parse(await readFile(store.relayStorePaths.PAIRINGS_FILE, 'utf8')).items.find((item) => item.id === foreignPairing.id), foreignPairing);
    assert.equal(await store.revokeDevice(enrolled.device.id), true);
    assert.deepEqual(JSON.parse(await readFile(store.relayStorePaths.DEVICES_FILE, 'utf8')).items.find((item) => item.id === foreignDevice.id), foreignDevice);
  } finally {
    if (prior === undefined) delete process.env.COMMANDCENTER_DATA_DIR; else process.env.COMMANDCENTER_DATA_DIR = prior;
  }
});

test('all device authentication methods share a deterministic per-peer limiter', async () => {
  let calls = 0;
  const manager = new RelayManager({
    authenticateDeviceFn: async () => { calls += 1; return null; },
    enrollWithPairingFn: async () => { calls += 1; return null; },
  });
  const auth = { payload: { method: 'credential', secret: 'invalid-credential', deviceId: 'device-1' } };
  for (let index = 0; index < 6; index += 1) assert.equal(await manager.authenticate({}, auth, '198.51.100.7'), null);
  assert.equal(calls, 5);

  let successfulCalls = 0;
  const successful = new RelayManager({
    authenticateDeviceFn: async () => { successfulCalls += 1; return { id: 'device-success', ownerId: RELAY_OWNER_ID }; },
  });
  const successfulAuth = { payload: { method: 'credential', secret: 'valid-credential', deviceId: 'device-success' } };
  for (let index = 0; index < 7; index += 1) await successful.authenticate({ close() {} }, successfulAuth, '198.51.100.8');
  assert.equal(successfulCalls, 7);
  assert.equal(successful.authAttempts.has('198.51.100.8'), false);
});

test('production device upgrade seam rejects query URLs, authenticates frames, and leaves browser /ws behavior intact', async (t) => {
  const server = createServer();
  const browserWss = new WebSocketServer({ noServer: true });
  const authCalls = [];
  const relayManager = new RelayManager({
    authenticateDeviceFn: async (secret, deviceId) => { authCalls.push({ secret, deviceId }); return { id: deviceId || 'device-1', ownerId: RELAY_OWNER_ID }; },
  });
  const deviceUpgrade = createRelayDeviceUpgrade({ relayManager, authTimeoutMs: 250 });
  server.on('upgrade', (req, socket, head) => {
    if (deviceUpgrade.tryUpgrade(req, socket, head)) return;
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/ws') {
      const auth = authorizeWebSocketRequest(req, { validateSession: (token) => token === 'valid-cookie' });
      if (!auth.ok) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return; }
      browserWss.handleUpgrade(req, socket, head, (ws) => browserWss.emit('connection', ws));
      return;
    }
    socket.destroy();
  });
  browserWss.on('connection', (ws) => ws.send('browser-ok'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { browserWss.close(); deviceUpgrade.relayWss.close(); server.close(); });
  const port = server.address().port;
  const browser = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { Cookie: 'cc_auth=valid-cookie', Origin: `http://127.0.0.1:${port}` } });
    ws.once('message', (data) => { ws.close(); resolve(String(data)); });
  });
  assert.equal(browser, 'browser-ok');
  const queryStatus = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_DEVICE_WS_PATH}?credential=secret-in-url`);
    ws.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); });
    ws.once('error', () => {});
  });
  assert.equal(queryStatus, 400);
  const device = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_DEVICE_WS_PATH}`);
    ws.once('open', () => ws.send(JSON.stringify({ v: 1, id: 'auth-1', type: 'relay.auth', timestamp: new Date().toISOString(), payload: { method: 'credential', secret: 'first-frame-secret', deviceId: 'device-1' } })));
    ws.once('message', (data) => { const message = JSON.parse(String(data)); ws.close(); resolve(message); });
  });
  assert.equal(device.type, 'relay.auth.ok');
  assert.equal(authCalls[0].secret, 'first-frame-secret');
  const invalidSchemaClose = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_DEVICE_WS_PATH}`);
    ws.once('open', () => ws.send(JSON.stringify({ v: 1, id: 'auth-schema', type: 'relay.auth', timestamp: new Date().toISOString(), payload: { method: 'credential', secret: 'schema-secret', deviceId: 'device-1' } })));
    ws.on('message', (data) => {
      if (JSON.parse(String(data)).type === 'relay.auth.ok') ws.send(JSON.stringify({ v: 1, id: 'invalid-schema', type: 'relay.heartbeat', timestamp: new Date().toISOString(), payload: { unexpected: true } }));
    });
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => {});
  });
  assert.equal(invalidSchemaClose, 4008);
  const anonymous = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${RELAY_DEVICE_WS_PATH}`);
    ws.once('open', () => ws.send(JSON.stringify({ v: 1, id: 'not-auth', type: 'relay.heartbeat', timestamp: new Date().toISOString(), payload: {} })));
    ws.once('close', (code) => resolve(code));
    ws.once('error', () => {});
  });
  assert.equal(anonymous, 4008);
});
