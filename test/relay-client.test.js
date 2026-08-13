import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RelayManager } from '../server/relay-manager.js';
import { RELAY_OWNER_ID } from '../server/relay-protocol.js';
import { createRelayDeviceUpgrade } from '../server/relay-ws.js';
import {
  buildHermesChatArgs,
  buildHermesStatusFrames,
  CommandCenterRelayClient,
  detectHermesProfiles,
  FileCredentialStore,
  HermesLocalBackend,
  MemoryCredentialStore,
  normalizeRelayDeviceUrl,
  parseHermesProfiles,
} from '../client/relay-client.mjs';

const CREDENTIAL = `ccr_${'x'.repeat(40)}`;
const DEVICE = { id: 'device-client-test', ownerId: RELAY_OWNER_ID, metadata: { name: 'Test Windows Client', platform: 'win32', version: 'test' } };

class FakeBackendChild extends EventEmitter {
  constructor() {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killed = false;
  }

  kill() {
    this.killed = true;
    this.emit('exit', null, 'SIGTERM');
  }
}

class FakeBackendSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeBackendSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit('open');
    });
  }

  send(raw) {
    const frame = JSON.parse(String(raw));
    this.sent.push(frame);
    if (frame.method === 'session.create') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        id: frame.id,
        result: { session_id: 'live-session-1', stored_session_id: 'stored-session-1' },
      })));
      return;
    }
    if (frame.method === 'prompt.submit') {
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ id: frame.id, result: { status: 'streaming' } }));
        const emitEvent = (type, payload) => this.emit('message', JSON.stringify({
          method: 'event',
          params: { type, session_id: 'live-session-1', payload },
        }));
        emitEvent('message.delta', { text: 'fast ' });
        emitEvent('message.complete', { text: 'fast reply', status: 'complete' });
      });
    }
  }

  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit('close');
  }
}

function waitFor(eventEmitter, eventName) {
  return once(eventEmitter, eventName);
}

async function startRelayServer() {
  const messages = [];
  const relayManager = new RelayManager({
    enrollWithPairingFn: async (secret) => secret === `ccp_${'p'.repeat(40)}` ? { device: DEVICE, credential: CREDENTIAL } : null,
    authenticateDeviceFn: async (credential, deviceId) => credential === CREDENTIAL && (!deviceId || deviceId === DEVICE.id) ? DEVICE : null,
  });
  relayManager.on('message', (message) => messages.push(message));
  const upgrade = createRelayDeviceUpgrade({ relayManager, authTimeoutMs: 1_000 });
  const server = createServer();
  server.on('upgrade', (request, socket, head) => {
    if (upgrade.tryUpgrade(request, socket, head)) return;
    socket.destroy();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;
  return {
    messages,
    relayManager,
    url: `ws://127.0.0.1:${port}/relay/v1/device`,
    close: async () => {
      try { upgrade.relayWss.close(); } catch {}
      if (!server.listening) return;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        server.close(() => { clearTimeout(timer); resolve(); });
      });
    },
  };
}

test('Windows client parses Hermes profiles and emits only status-shaped frames', () => {
  const profiles = parseHermesProfiles(`
 Profile          Model                        Gateway      Alias        Distribution
 ───────────────  ───────────────────────────  ───────────  ───────────  ─────────────
 ◆default         gpt-5.6-luna                 running      —            —
  velvet          z-ai/glm-5.2-free            stopped      —            —
 `);
  assert.deepEqual(profiles, [
    { name: 'default', model: 'gpt-5.6-luna', gateway: 'running' },
    { name: 'velvet', model: 'z-ai/glm-5.2-free', gateway: 'stopped' },
  ]);
  const frames = buildHermesStatusFrames({ device: { name: 'Epic Windows Hermes', ownerId: 'spoof', deviceId: 'spoof' }, profiles });
  const serialized = JSON.stringify(frames);
  assert.doesNotMatch(serialized, /ownerId|deviceId/);
  assert.doesNotMatch(serialized, /command\.|agent\.chat\./);
  assert.equal(frames[0].type, 'device.state.snapshot');
  assert.equal(frames[1].type, 'agent.roster.snapshot');
  assert.equal(frames[1].payload.agents.length, 2);
});

test('Windows client uses the Hermes SOUL name for display while retaining the profile id', async () => {
  let listOutput = `
 Profile          Model                        Gateway
 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€  â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
 â—†default         gpt-5.6-luna                 running
  velvet          z-ai/glm-5.2-free            stopped
 `;
  listOutput = 'Profile          Model                        Gateway\ndefault          gpt-5.6-luna                 running\nvelvet           z-ai/glm-5.2-free            stopped\n';
  const execFileFn = (_file, args, _options, callback) => {
    if (args.join(' ') === 'profile list') callback(null, listOutput, '');
    else callback(null, 'Profile: default\nPath: C:/hermes\n', '');
  };
  const profiles = await detectHermesProfiles({
    hermesBin: 'hermes',
    execFileFn,
    readFileFn: async () => 'You are Reika, the user\'s personal Hermes agent.\n',
  });
  assert.equal(profiles[0].name, 'default');
  assert.equal(profiles[0].displayName, 'Reika');
  const frames = buildHermesStatusFrames({ profiles });
  assert.equal(frames[1].payload.agents[0].id, 'hermes:default');
  assert.equal(frames[1].payload.agents[0].label, 'Reika');
  assert.equal(frames[1].payload.agents[0].name, 'Reika');
});

test('Windows client executes only bounded Hermes chat requests and correlates responses', async (t) => {
  const server = await startRelayServer();
  t.after(() => server.close());
  const store = new MemoryCredentialStore({ deviceId: DEVICE.id, relayUrl: server.url, credential: CREDENTIAL });
  const calls = [];
  const client = new CommandCenterRelayClient({
    url: server.url,
    device: { name: 'Epic Windows Hermes', platform: 'win32', type: 'desktop', version: 'test' },
    credentialStore: store,
    detectProfiles: async () => [{ name: 'default', displayName: 'Reika', model: 'gpt-test', gateway: 'running' }],
    execFileFn: (_file, args, _options, callback) => {
      calls.push(args);
      callback(null, `session_id: hermes-session-1\n\u21bb Resumed session hermes-session-1\nReika response`, '');
    },
    heartbeatIntervalMs: 1_000,
  });
  t.after(() => client.stop());
  const authenticated = waitFor(client, 'authenticated');
  await client.start();
  await authenticated;
  const waitForResponse = () => new Promise((resolve) => {
    const onMessage = (message) => {
      if (message.type === 'relay.chat.response') {
        server.relayManager.off('message', onMessage);
        resolve(message);
      }
    };
    server.relayManager.on('message', onMessage);
  });
  const firstResponse = waitForResponse();
  assert.equal(server.relayManager.sendChatRequest(DEVICE.id, {
    v: 1,
    id: 'chat-request-1',
    type: 'relay.chat.request',
    timestamp: new Date().toISOString(),
    payload: { providerId: 'hermes', agentId: 'hermes:default', providerSessionId: 'cc-session-1', message: 'hello' },
  }), true);
  const first = await firstResponse;
  assert.equal(first.replyTo, 'chat-request-1');
  assert.equal(first.payload.ok, true);
  assert.equal(first.payload.text, 'Reika response');
  assert.deepEqual(calls[0], buildHermesChatArgs({ profile: { name: 'default' }, message: 'hello' }));

  const secondResponse = waitForResponse();
  assert.equal(server.relayManager.sendChatRequest(DEVICE.id, {
    v: 1,
    id: 'chat-request-2',
    type: 'relay.chat.request',
    timestamp: new Date().toISOString(),
    payload: { providerId: 'hermes', agentId: 'hermes:default', providerSessionId: 'cc-session-1', message: 'again' },
  }), true);
  const second = await secondResponse;
  assert.equal(second.payload.ok, true);
  assert.ok(calls[1].includes('--resume'));
  assert.ok(calls[1].includes('hermes-session-1'));
  assert.equal(calls.some((args) => args.some((value) => String(value).includes('command.'))), false);
});

test('persistent Hermes backend uses only bounded session and prompt RPCs', async (t) => {
  FakeBackendSocket.instances = [];
  const child = new FakeBackendChild();
  const spawned = [];
  const backend = new HermesLocalBackend({
    hermesBin: 'C:/Hermes/hermes.exe',
    backendArgs: ['serve', '--host', '127.0.0.1', '--port', '0', '--skip-build'],
    spawnFn: (_file, args) => {
      spawned.push(args);
      queueMicrotask(() => child.stdout.emit('data', 'HERMES_BACKEND_READY port=9919\\n'));
      return child;
    },
    WebSocketImpl: FakeBackendSocket,
    startTimeoutMs: 1_000,
    rpcTimeoutMs: 1_000,
  });
  t.after(() => backend.stop());

  const result = await backend.chat(
    { name: 'default' },
    { providerSessionId: 'cc-session-1', message: 'hello' },
  );

  assert.equal(result.text, 'fast reply');
  assert.equal(result.sessionId, 'stored-session-1');
  assert.deepEqual(spawned, [['serve', '--host', '127.0.0.1', '--port', '0', '--skip-build']]);
  assert.match(FakeBackendSocket.instances[0].url, /^ws:\/\/127\.0\.0\.1:9919\/api\/ws\?token=[a-f0-9]{64}$/);
  assert.deepEqual(FakeBackendSocket.instances[0].sent.map((frame) => frame.method), [
    'session.create',
    'prompt.submit',
  ]);
  assert.equal(FakeBackendSocket.instances[0].sent.some((frame) => frame.method === 'command.execute'), false);
});

test('relay client prefers persistent Hermes backend and falls back only on recoverable startup failure', async () => {
  const calls = [];
  const backend = {
    async start() { calls.push('start'); },
    async chat(profile, payload) {
      calls.push(['chat', profile.name, payload.message]);
      return { text: 'persistent reply', sessionId: 'remote-session-1' };
    },
  };
  const client = new CommandCenterRelayClient({
    url: 'ws://127.0.0.1:1/relay/v1/device',
    credentialStore: new MemoryCredentialStore(),
    hermesBackend: backend,
    execFileFn: () => { throw new Error('CLI fallback should not run'); },
  });
  const result = await client.executeHermesChat(
    { name: 'default' },
    { providerSessionId: 'cc-session-1', message: 'hello' },
  );
  assert.deepEqual(calls, ['start', ['chat', 'default', 'hello']]);
  assert.deepEqual(result, { text: 'persistent reply', sessionId: 'remote-session-1' });
});

test('Windows client rejects credential-bearing or query-bearing relay URLs', () => {
  assert.equal(normalizeRelayDeviceUrl('wss://relay.example/commandcenter'), 'wss://relay.example/commandcenter/relay/v1/device');
  assert.throws(() => normalizeRelayDeviceUrl('wss://relay.example/commandcenter/relay/v1/device?credential=secret'), /query string/);
  assert.throws(() => normalizeRelayDeviceUrl('wss://user:pass@relay.example/commandcenter'), /credentials/);
});

test('Windows client enrolls, sends Hermes status, and reconnects with the stored credential', async (t) => {
  const server = await startRelayServer();
  t.after(() => server.close());
  const store = new MemoryCredentialStore();
  const profiles = [
    { name: 'default', model: 'gpt-5.6-luna', gateway: 'running' },
    { name: 'velvet', model: 'z-ai/glm-5.2-free', gateway: 'stopped' },
  ];
  const first = new CommandCenterRelayClient({
    url: server.url,
    device: { name: 'Epic Windows Hermes', platform: 'win32', type: 'desktop', version: 'test' },
    credentialStore: store,
    detectProfiles: async () => profiles,
    heartbeatIntervalMs: 1_000,
  });
  t.after(() => first.stop());
  const firstAuthenticated = waitFor(first, 'authenticated');
  await first.start({ pairingSecret: `ccp_${'p'.repeat(40)}` });
  const [firstAuth] = await firstAuthenticated;
  assert.equal(firstAuth.ownerId, RELAY_OWNER_ID);
  assert.equal(firstAuth.profiles.join(','), 'default,velvet');
  assert.equal((await store.load()).credential, CREDENTIAL);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(server.messages.some((message) => message.type === 'device.state.snapshot'));
  assert.ok(server.messages.some((message) => message.type === 'agent.roster.snapshot'));
  assert.ok(server.messages.some((message) => message.type === 'relay.heartbeat' && message.payload.sequence === 0));

  const replacement = new CommandCenterRelayClient({
    url: server.url,
    device: { name: 'Epic Windows Hermes', platform: 'win32', type: 'desktop', version: 'test' },
    credentialStore: store,
    detectProfiles: async () => profiles,
    heartbeatIntervalMs: 1_000,
  });
  t.after(() => replacement.stop());
  const firstReplaced = new Promise((resolve) => first.once('disconnected', resolve));
  const replacementAuthenticated = waitFor(replacement, 'authenticated');
  await replacement.start();
  await replacementAuthenticated;
  const replaced = await firstReplaced;
  assert.equal(replaced.code, 4002);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const heartbeats = server.messages.filter((message) => message.type === 'relay.heartbeat');
  assert.ok(heartbeats.some((message) => message.payload.sequence === 0));
  assert.equal(replacement.getStatus().authenticated, true);
});

test('Windows DPAPI credential store does not persist plaintext credentials', { skip: process.platform !== 'win32' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'command-center-client-'));
  const filePath = join(directory, 'relay-device.json');
  try {
    const store = new FileCredentialStore(filePath);
    await store.save({ deviceId: DEVICE.id, relayUrl: 'wss://relay.example/commandcenter/relay/v1/device', credential: CREDENTIAL });
    const raw = await readFile(filePath, 'utf8');
    assert.doesNotMatch(raw, /ccr_/);
    assert.equal((await store.load()).credential, CREDENTIAL);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
