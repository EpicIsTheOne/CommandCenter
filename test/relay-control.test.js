import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { RelayManager } from '../server/relay-manager.js';
import {
  RELAY_CONTROL_PROTOCOL_VERSION,
  validateDeviceEnvelope,
  validateRelayControlEvent,
  validateRelayControlRequest,
  validateRelayControlResponse,
} from '../server/relay-protocol.js';
import { CommandCenterRelayClient, MemoryCredentialStore } from '../client/relay-client.mjs';

const base = {
  v: RELAY_CONTROL_PROTOCOL_VERSION,
  id: 'control-message-1',
  timestamp: new Date().toISOString(),
};

test('relay v2 accepts bounded task control and rejects generic command envelopes', () => {
  const request = validateRelayControlRequest({
    ...base,
    type: 'relay.control.request',
    payload: {
      operation: 'start',
      operationId: 'task-op-1',
      taskId: 'task-1',
      attemptId: 'attempt-1',
      agentId: 'hermes:default',
      providerId: 'hermes',
      title: 'Bounded task',
      prompt: 'Do the bounded work.',
    },
  });
  assert.equal(request.payload.operation, 'start');
  assert.throws(() => validateRelayControlRequest({
    ...base,
    type: 'relay.control.request',
    payload: { operation: 'start', operationId: 'task-op-2', taskId: 'task-1', command: 'rm -rf /' },
  }), (error) => error.code === 'INVALID_SCHEMA');
  assert.throws(() => validateRelayControlRequest({
    ...base,
    type: 'relay.control.request',
    payload: { operation: 'start', operationId: 'task-op-3', taskId: 'task-1', shell: 'whoami' },
  }), (error) => error.code === 'INVALID_SCHEMA');
});

test('relay v1 chat and authentication stay isolated from v2 control envelopes', async () => {
  const { validateRelayAuth, validateRelayChatRequest } = await import('../server/relay-protocol.js');
  assert.throws(() => validateRelayAuth({
    ...base,
    v: RELAY_CONTROL_PROTOCOL_VERSION,
    type: 'relay.auth',
    payload: { method: 'credential', secret: 'credential' },
  }), (error) => error.code === 'UNSUPPORTED_VERSION');
  assert.throws(() => validateRelayChatRequest({
    ...base,
    type: 'relay.chat.request',
    payload: { providerId: 'hermes', agentId: 'hermes:default', providerSessionId: 'session-1', message: 'hello' },
  }), (error) => error.code === 'UNSUPPORTED_VERSION');
});

test('relay v2 correlates response/event sequences and keeps device identity server-bound', () => {
  const response = validateRelayControlResponse({
    ...base,
    id: 'control-response-1',
    type: 'relay.control.response',
    replyTo: 'control-message-1',
    payload: { operation: 'start', operationId: 'task-op-1', taskId: 'task-1', ok: true, state: 'completed', result: 'done' },
  });
  assert.equal(response.payload.state, 'completed');
  const event = validateRelayControlEvent({
    ...base,
    id: 'control-event-1',
    type: 'relay.control.event',
    replyTo: 'control-message-1',
    payload: { operation: 'start', operationId: 'task-op-1', taskId: 'task-1', eventType: 'task.progress', state: 'running', revision: 4, progressSequence: 2, summary: 'working' },
  });
  assert.equal(event.payload.progressSequence, 2);
  assert.throws(() => validateDeviceEnvelope({
    ...base,
    id: 'identity-spoof',
    type: 'relay.control.event',
    payload: { operation: 'start', operationId: 'task-op-2', taskId: 'task-1', eventType: 'task.progress', deviceId: 'spoof' },
  }, { deviceId: 'authenticated-device' }), (error) => error.code === 'IDENTITY_SPOOF');
});

test('relay manager sends v2 requests and ignores duplicate control responses without repeating side effects', () => {
  const ws = new EventEmitter();
  ws.readyState = 1;
  const manager = new RelayManager();
  manager.connections.set('device-1', ws);
  manager.presence.set('device-1', { ownerId: 'owner:default', deviceId: 'device-1', state: 'online' });
  const sent = [];
  ws.send = (raw) => sent.push(JSON.parse(raw));
  assert.equal(manager.sendControlRequest('device-1', {
    operation: 'status',
    operationId: 'status-op-1',
    taskId: 'task-1',
    agentId: 'hermes:default',
    providerId: 'hermes',
  }), true);
  assert.equal(sent[0].v, 2);
  assert.equal(sent[0].payload.operationId, 'status-op-1');
  const first = manager.handle(ws, {
    v: 2,
    id: 'response-1',
    type: 'relay.control.response',
    timestamp: new Date().toISOString(),
    replyTo: sent[0].id,
    payload: { operation: 'status', operationId: 'status-op-1', taskId: 'task-1', ok: true, state: 'running' },
  }, 'device-1');
  assert.equal(first.payload.state, 'running');
  const duplicate = manager.handle(ws, { ...first }, 'device-1');
  assert.equal(duplicate.duplicate, true);
});

test('relay client caches duplicate control operations and never repeats the Hermes side effect', async () => {
  const sent = [];
  const socket = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
  let executions = 0;
  const client = new CommandCenterRelayClient({ url: 'ws://127.0.0.1:1/relay/v1/device', credentialStore: new MemoryCredentialStore() });
  client.authenticated = true;
  client.profiles = [{ name: 'default', displayName: 'Hermes', model: 'test', gateway: 'running' }];
  client.executeHermesChat = async () => { executions += 1; return { text: 'bounded result' }; };
  const request = {
    v: 2,
    id: 'start-request-1',
    type: 'relay.control.request',
    timestamp: new Date().toISOString(),
    payload: { operation: 'start', operationId: 'task-op-duplicate', taskId: 'task-1', attemptId: 'attempt-1', agentId: 'hermes:default', providerId: 'hermes', prompt: 'bounded work' },
  };
  await client.handleControlRequest(socket, request);
  await client.handleControlRequest(socket, { ...request, id: 'start-request-2' });
  const responses = sent.filter((message) => message.type === 'relay.control.response');
  assert.equal(executions, 1);
  assert.equal(responses.length, 2);
  assert.equal(responses[0].payload.result, 'bounded result');
  assert.equal(responses[1].payload.result, 'bounded result');
  assert.equal(responses[1].replyTo, 'start-request-2');
  await client.handleControlRequest(socket, { ...request, id: 'start-request-conflict', payload: { ...request.payload, prompt: 'different work' } });
  const conflict = sent.at(-1);
  assert.equal(conflict.payload.errorCode, 'IDEMPOTENCY_CONFLICT');
  assert.equal(executions, 1);
});

test('relay client replays bounded control events after a reconnect cursor', async () => {
  const sent = [];
  const socket = { readyState: 1, send(raw) { sent.push(JSON.parse(raw)); } };
  const client = new CommandCenterRelayClient({ url: 'ws://127.0.0.1:1/relay/v1/device', credentialStore: new MemoryCredentialStore() });
  client.authenticated = true;
  client.profiles = [{ name: 'default', displayName: 'Hermes', model: 'test', gateway: 'running' }];
  client.sendControlEvent(socket, {
    operation: 'start',
    operationId: 'replay-source-op',
    taskId: 'task-replay',
    agentId: 'hermes:default',
    eventType: 'task.progress',
    state: 'running',
    summary: 'cached progress',
  });
  await client.handleControlRequest(socket, {
    v: 2,
    id: 'replay-request-1',
    type: 'relay.control.request',
    timestamp: new Date().toISOString(),
    payload: { operation: 'replay', operationId: 'replay-op-1', afterEventSequence: 0 },
  });
  const replay = sent.filter((message) => message.type === 'relay.control.event' && message.replyTo === 'replay-request-1');
  const response = sent.find((message) => message.type === 'relay.control.response' && message.replyTo === 'replay-request-1');
  assert.equal(replay.length, 1);
  assert.equal(replay[0].payload.eventType, 'task.progress');
  assert.equal(replay[0].payload.operation, 'replay');
  assert.equal(replay[0].payload.eventSequence, 1);
  assert.equal(response.payload.eventSequence, 1);
});
