import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RELAY_OWNER_ID } from '../server/relay-protocol.js';
import { RelayAgentSource } from '../server/relay-agent-source.js';

function snapshot(deviceId, payload) {
  return { ownerId: RELAY_OWNER_ID, deviceId, type: 'device.state.snapshot', payload };
}

function roster(deviceId, agents) {
  return { ownerId: RELAY_OWNER_ID, deviceId, type: 'agent.roster.snapshot', payload: { activeProviderId: 'hermes', agents } };
}

test('authenticated device snapshots feed the dashboard roster without enabling legacy app relay', () => {
  const source = new RelayAgentSource();
  const manager = new EventEmitter();
  manager.listPresence = () => [];
  source.attachLocalManager(manager);

  manager.emit('message', { ...roster('device-foreign', [{ id: 'foreign-agent', name: 'Foreign' }]), ownerId: 'owner:future' });
  assert.deepEqual(source.getAgents(), []);

  manager.emit('message', snapshot('device-windows', {
    device: { name: 'Epic Windows Hermes', platform: 'win32', version: '1.0.0' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  manager.emit('message', roster('device-windows', [
    { id: 'hermes:default', name: 'default', status: 'online' },
    { id: 'hermes:velvet', name: 'velvet', status: 'online' },
  ]));

  const agents = source.getAgents();
  assert.equal(source.getStatus().enabled, true);
  assert.equal(source.getStatus().legacyEnabled, false);
  assert.equal(source.getStatus().localEnabled, true);
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((agent) => agent.relayAgentId), ['hermes:default', 'hermes:velvet']);
  assert.ok(agents.every((agent) => agent.relayDeviceId === 'device-windows'));
  assert.ok(agents.every((agent) => agent.relayDeviceName === 'Epic Windows Hermes'));
});

test('local relay connection lifecycle is owner-bound and does not trust payload identity', () => {
  const source = new RelayAgentSource();
  const manager = new EventEmitter();
  manager.listPresence = () => [];
  source.attachLocalManager(manager);

  manager.emit('connected', { ownerId: 'owner:future', deviceId: 'device-foreign' });
  assert.equal(source.getStatus().connected, false);
  manager.emit('connected', { ownerId: RELAY_OWNER_ID, deviceId: 'device-bound' });
  assert.equal(source.getStatus().connected, true);
  manager.emit('message', snapshot('device-bound', {
    device: { name: 'Bound Device', platform: 'win32' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  manager.emit('message', roster('device-bound', [{ id: 'agent-one', name: 'One' }]));

  const agent = source.getAgents()[0];
  assert.equal(agent.relayDeviceId, 'device-bound');
  assert.equal(agent.relayDeviceName, 'Bound Device');
  manager.emit('message', snapshot('device-bound', {
    device: { name: 'Spoof Attempt', platform: 'win32' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  assert.equal(source.getAgents()[0].relayDeviceId, 'device-bound');
  manager.emit('disconnected', { ownerId: RELAY_OWNER_ID, deviceId: 'device-bound' });
  assert.equal(source.getStatus().connected, false);
  assert.equal(source.getAgents()[0].relayDeviceId, 'device-bound');
});

test('relay activity remains available for agent inspection without an active chat request', () => {
  const source = new RelayAgentSource();
  const manager = new EventEmitter();
  manager.listPresence = () => [{ ownerId: RELAY_OWNER_ID, deviceId: 'device-activity', state: 'online' }];
  source.attachLocalManager(manager);
  manager.emit('message', snapshot('device-activity', {
    device: { name: 'Activity Device', platform: 'win32' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  manager.emit('message', roster('device-activity', [{ id: 'hermes:default', name: 'Reika', status: 'online' }]));
  manager.emit('message', {
    ownerId: RELAY_OWNER_ID,
    deviceId: 'device-activity',
    type: 'agent.activity',
    payload: { agent: 'hermes:default', status: 'tool_use', message: 'Inspecting the repository.', tool: 'workspace' },
  });

  const agent = source.getAgents()[0];
  assert.equal(agent.relayAgentStatus, 'tool_use');
  assert.equal(agent.relayAgentMessage, 'Inspecting the repository.');
  assert.equal(agent.relayAgentTool, 'workspace');
  assert.equal(agent.relayDeviceState, 'online');
});

test('local device chat uses the authenticated manager transport and correlation binding', async () => {
  const source = new RelayAgentSource();
  const manager = new EventEmitter();
  const sent = [];
  manager.listPresence = () => [{ ownerId: RELAY_OWNER_ID, deviceId: 'device-chat', state: 'online' }];
  manager.sendChatRequest = (deviceId, request) => {
    sent.push({ deviceId, request });
    return true;
  };
  source.attachLocalManager(manager);
  manager.emit('message', snapshot('device-chat', {
    device: { name: 'Chat Device', platform: 'win32' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  manager.emit('message', roster('device-chat', [{ id: 'hermes:default', name: 'Reika' }]));

  const resultPromise = source.runRelayChatTurn({
    session: {
      id: 'session-chat',
      agent: 'relay:device-chat:hermes:hermes-default',
      metadata: {
        relay: true,
        relayTransport: 'device',
        relayDeviceId: 'device-chat',
        relayProviderId: 'hermes',
        relayAgentId: 'hermes:default',
        relayVirtualAgentId: 'relay:device-chat:hermes:hermes-default',
      },
    },
    latestMessage: 'hello Reika',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deviceId, 'device-chat');
  assert.equal(sent[0].request.type, 'relay.chat.request');
  assert.equal(sent[0].request.payload.agentId, 'hermes:default');
  assert.equal(sent[0].request.payload.providerId, 'hermes');
  manager.emit('message', {
    ownerId: RELAY_OWNER_ID,
    deviceId: 'device-chat',
    type: 'relay.chat.response',
    replyTo: sent[0].request.id,
    payload: { ok: true, text: 'Hello from Reika', providerSessionId: sent[0].request.payload.providerSessionId },
  });
  const result = await resultPromise;
  assert.equal(result.text, 'Hello from Reika');
  assert.equal(result.providerSessionId, sent[0].request.payload.providerSessionId);
});

test('existing relay sessions adopt the current authenticated device transport', async () => {
  const source = new RelayAgentSource();
  const manager = new EventEmitter();
  const sent = [];
  manager.listPresence = () => [{ ownerId: RELAY_OWNER_ID, deviceId: 'device-existing', state: 'online' }];
  manager.sendChatRequest = (deviceId, request) => {
    sent.push({ deviceId, request });
    return true;
  };
  source.attachLocalManager(manager);
  manager.emit('message', snapshot('device-existing', {
    device: { name: 'Existing Device', platform: 'win32' },
    activeProviderId: 'hermes',
    providers: [{ id: 'hermes', name: 'Hermes' }],
  }));
  manager.emit('message', roster('device-existing', [{ id: 'hermes:default', name: 'Reika' }]));

  const resultPromise = source.runRelayChatTurn({
    session: {
      id: 'session-existing',
      agent: 'relay:device-existing:hermes:hermes-default',
      metadata: {
        relay: true,
        chatTransport: 'relay',
        relayDeviceId: 'device-existing',
        relayProviderId: 'hermes',
        relayAgentId: 'hermes:default',
        relayVirtualAgentId: 'relay:device-existing:hermes:hermes-default',
      },
    },
    latestMessage: 'hello from an existing session',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].deviceId, 'device-existing');
  assert.equal(sent[0].request.type, 'relay.chat.request');
  manager.emit('message', {
    ownerId: RELAY_OWNER_ID,
    deviceId: 'device-existing',
    type: 'relay.chat.response',
    replyTo: sent[0].request.id,
    payload: { ok: true, text: 'Existing session reached Reika', providerSessionId: sent[0].request.payload.providerSessionId },
  });
  const result = await resultPromise;
  assert.equal(result.text, 'Existing session reached Reika');
});
