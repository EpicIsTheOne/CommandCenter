export const RELAY_PROTOCOL_VERSION = 1;
export const RELAY_CONTROL_PROTOCOL_VERSION = 2;
export const RELAY_OWNER_ID = 'owner:default';
export const RELAY_DEVICE_WS_PATH = '/relay/v1/device';
export const RELAY_MAX_PAYLOAD_BYTES = 64 * 1024;
export const RELAY_MAX_TEXT_BYTES = 16 * 1024;
export const RELAY_CHAT_TEXT_MAX_BYTES = 48 * 1024;

const TYPES = new Set([
  'relay.auth', 'relay.auth.ok', 'relay.auth.error', 'relay.heartbeat',
  'relay.presence', 'relay.disconnect', 'device.state.snapshot',
  'agent.roster.snapshot', 'agent.activity', 'relay.chat.request',
  'relay.chat.response',
  'relay.control.request', 'relay.control.response', 'relay.control.event',
  'relay.capabilities.snapshot', 'relay.replay.response',
]);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUTH_KEYS = new Set(['method', 'secret', 'deviceId', 'device']);
const DEVICE_KEYS = new Set(['name', 'label', 'platform', 'type', 'version']);
const HEARTBEAT_KEYS = new Set(['sequence']);
const PRESENCE_KEYS = new Set(['state']);
const DEVICE_SNAPSHOT_KEYS = new Set(['device', 'providers', 'activeProviderId']);
const ROSTER_SNAPSHOT_KEYS = new Set(['agents', 'activeProviderId']);
const ACTIVITY_KEYS = new Set(['status', 'message', 'tool', 'input', 'agent']);
const SNAPSHOT_DEVICE_KEYS = new Set(['name', 'label', 'platform', 'type', 'version']);
const PROVIDER_KEYS = new Set(['id', 'providerId', 'kind', 'name', 'label', 'model', 'agents']);
const AGENT_KEYS = new Set(['id', 'agentId', 'name', 'label', 'model', 'status', 'capabilities', 'steerSupported']);
const IDENTITY_KEYS = new Set(['ownerId', 'deviceId']);
const CHAT_REQUEST_KEYS = new Set(['providerId', 'agentId', 'providerSessionId', 'sessionId', 'message']);
const CHAT_RESPONSE_KEYS = new Set(['ok', 'text', 'sessionId', 'providerSessionId', 'model', 'errorCode', 'errorMessage']);
const CONTROL_REQUEST_KEYS = new Set([
  'operation', 'operationId', 'taskId', 'threadId', 'attemptId', 'agentId', 'providerId',
  'title', 'prompt', 'guidance', 'capability', 'summary', 'approvalId', 'decision',
  'expectedTaskRevision', 'expectedApprovalRevision', 'afterEventSequence', 'eventSequence',
]);
const CONTROL_RESPONSE_KEYS = new Set([
  'ok', 'operation', 'operationId', 'taskId', 'threadId', 'attemptId', 'agentId', 'providerId', 'state', 'revision',
  'progressSequence', 'result', 'summary', 'errorCode', 'errorMessage', 'eventSequence',
]);
const CONTROL_EVENT_KEYS = new Set([
  'eventType', 'operation', 'operationId', 'taskId', 'threadId', 'attemptId', 'agentId', 'providerId',
  'state', 'revision', 'progressSequence', 'summary', 'result', 'errorCode', 'eventSequence', 'payload',
]);
const CONTROL_OPERATIONS = new Set(['status', 'start', 'queue', 'steer', 'cancel', 'retry', 'review', 'approve', 'deny', 'replay']);
const CONTROL_TYPES = new Set(['relay.control.request', 'relay.control.response', 'relay.control.event', 'relay.capabilities.snapshot', 'relay.replay.response']);

export class RelayProtocolError extends Error {
  constructor(message, code = 'INVALID_MESSAGE') {
    super(message);
    this.name = 'RelayProtocolError';
    this.code = code;
  }
}

function text(value, max = RELAY_MAX_TEXT_BYTES) {
  if (typeof value !== 'string') throw new RelayProtocolError('Expected string.');
  if (!value || Buffer.byteLength(value, 'utf8') > max) throw new RelayProtocolError('String is empty or too large.');
  return value;
}

function optionalText(value, max = RELAY_MAX_TEXT_BYTES) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, max);
}

function id(value, field) {
  const result = text(value, 128);
  if (!ID_RE.test(result)) throw new RelayProtocolError(`Invalid ${field}.`);
  return result;
}
function strictKeys(value, allowed, name) {
  for (const key of Object.keys(value || {})) if (!allowed.has(key)) throw new RelayProtocolError(`Unknown ${name} field.`, 'INVALID_SCHEMA');
}
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function boundedRecord(value, allowed, name, maxKeys = 8) {
  if (!isPlainObject(value)) throw new RelayProtocolError(`${name} must be a plain object.`);
  for (const key of Object.keys(value)) if (IDENTITY_KEYS.has(key)) throw new RelayProtocolError('Owner and device identity are server-bound.', 'IDENTITY_SPOOF');
  strictKeys(value, allowed, name);
  if (Object.keys(value).length > maxKeys) throw new RelayProtocolError(`${name} has too many fields.`, 'PAYLOAD_TOO_LARGE');
  for (const [key, item] of Object.entries(value)) {
    if (IDENTITY_KEYS.has(key)) throw new RelayProtocolError('Owner and device identity are server-bound.', 'IDENTITY_SPOOF');
    if (typeof item === 'string' && Buffer.byteLength(item, 'utf8') > 256) throw new RelayProtocolError(`${name} field is too large.`, 'PAYLOAD_TOO_LARGE');
  }
  return value;
}
function boundedAgent(value, name = 'agent') {
  const record = boundedRecord(value, AGENT_KEYS, name, 8);
  for (const key of ['id', 'agentId', 'name', 'label', 'model', 'status']) if (record[key] !== undefined && typeof record[key] !== 'string') throw new RelayProtocolError(`${name} field must be text.`);
  return record;
}
function boundedProvider(value) {
  const record = boundedRecord(value, PROVIDER_KEYS, 'provider', 7);
  for (const key of ['id', 'providerId', 'kind', 'name', 'label', 'model']) if (record[key] !== undefined && typeof record[key] !== 'string') throw new RelayProtocolError('Provider field must be text.');
  if (record.agents !== undefined) {
    if (!Array.isArray(record.agents) || record.agents.length > 200) throw new RelayProtocolError('Provider agents must be a bounded array.', 'PAYLOAD_TOO_LARGE');
    record.agents.forEach((agent) => boundedAgent(agent, 'provider agent'));
  }
  return record;
}
function boundedSnapshotDevice(value) {
  const record = boundedRecord(value, SNAPSHOT_DEVICE_KEYS, 'snapshot device', 5);
  for (const item of Object.values(record)) if (typeof item !== 'string' || Buffer.byteLength(item, 'utf8') > 120) throw new RelayProtocolError('Snapshot device fields must be bounded text.');
  return record;
}

export function parseRelayMessage(raw) {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ''), 'utf8');
  if (buffer.length > RELAY_MAX_PAYLOAD_BYTES) throw new RelayProtocolError('Payload exceeds relay limit.', 'PAYLOAD_TOO_LARGE');
  let value;
  try { value = JSON.parse(buffer.toString('utf8')); } catch { throw new RelayProtocolError('Message must be valid JSON.', 'MALFORMED_MESSAGE'); }
  return validateRelayEnvelope(value);
}

export function validateRelayEnvelope(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new RelayProtocolError('Envelope must be an object.');
  const version = Number(input.v);
  if (![RELAY_PROTOCOL_VERSION, RELAY_CONTROL_PROTOCOL_VERSION].includes(version)) throw new RelayProtocolError('Unsupported relay protocol version.', 'UNSUPPORTED_VERSION');
  const type = id(input.type, 'type');
  if (!TYPES.has(type)) throw new RelayProtocolError('Unsupported relay message type.', 'UNSUPPORTED_TYPE');
  const messageId = id(input.id, 'id');
  const timestamp = text(input.timestamp, 64);
  if (Number.isNaN(Date.parse(timestamp))) throw new RelayProtocolError('Invalid timestamp.');
  if (!input.payload || typeof input.payload !== 'object' || Array.isArray(input.payload)) throw new RelayProtocolError('Payload must be an object.');
  const normalized = { v: version, id: messageId, type, timestamp, payload: input.payload };
  if (input.replyTo !== undefined) normalized.replyTo = id(input.replyTo, 'replyTo');
  return normalized;
}

export function validateRelayAuth(input) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.v !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError('Authentication requires relay protocol v1.', 'UNSUPPORTED_VERSION');
  if (envelope.type !== 'relay.auth') throw new RelayProtocolError('First device message must be relay.auth.', 'AUTH_REQUIRED');
  const payload = envelope.payload;
  strictKeys(payload, AUTH_KEYS, 'auth');
  const method = payload.method === 'pairing' || payload.method === 'credential' ? payload.method : '';
  if (!method) throw new RelayProtocolError('Unsupported authentication method.', 'AUTH_REQUIRED');
  const secret = text(payload.secret, 256);
  const deviceId = optionalText(payload.deviceId, 128);
  const device = payload.device;
  if (device !== undefined) {
    if (!device || typeof device !== 'object' || Array.isArray(device)) throw new RelayProtocolError('Device metadata must be an object.');
    strictKeys(device, DEVICE_KEYS, 'device metadata');
    if (Object.keys(device).length > 5) throw new RelayProtocolError('Device metadata is too large.', 'PAYLOAD_TOO_LARGE');
    for (const value of Object.values(device)) if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 120) throw new RelayProtocolError('Invalid device metadata.');
  }
  if (method === 'pairing' && !device) throw new RelayProtocolError('Pairing requires device metadata.');
  return { ...envelope, payload: { method, secret, ...(deviceId ? { deviceId: id(deviceId, 'deviceId') } : {}), ...(device ? { device } : {}) } };
}

function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return '';
  return id(value, field);
}

function chatText(value, field) {
  if (typeof value !== 'string' || !value) throw new RelayProtocolError(`Invalid ${field}.`, 'INVALID_SCHEMA');
  if (Buffer.byteLength(value, 'utf8') > RELAY_CHAT_TEXT_MAX_BYTES) throw new RelayProtocolError(`${field} is too large.`, 'PAYLOAD_TOO_LARGE');
  return value;
}

function assertNoPayloadIdentity(payload) {
  if (payload?.ownerId !== undefined || payload?.deviceId !== undefined) throw new RelayProtocolError('Owner and device identity are server-bound.', 'IDENTITY_SPOOF');
}

export function validateRelayChatRequest(input) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.v !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError('Chat requires relay protocol v1.', 'UNSUPPORTED_VERSION');
  if (envelope.type !== 'relay.chat.request') throw new RelayProtocolError('Expected a relay chat request.', 'UNSUPPORTED_TYPE');
  if (envelope.replyTo !== undefined) throw new RelayProtocolError('Chat requests cannot reply to another message.', 'INVALID_SCHEMA');
  const payload = envelope.payload;
  assertNoPayloadIdentity(payload);
  strictKeys(payload, CHAT_REQUEST_KEYS, 'chat request');
  const providerId = id(payload.providerId, 'providerId');
  if (providerId !== 'hermes') throw new RelayProtocolError('Only Hermes relay chat is supported.', 'UNSUPPORTED_TYPE');
  const agentId = id(payload.agentId, 'agentId');
  const providerSessionId = optionalId(payload.providerSessionId, 'providerSessionId');
  const sessionId = optionalId(payload.sessionId, 'sessionId');
  const message = chatText(payload.message, 'message');
  if (!providerSessionId) throw new RelayProtocolError('Chat requests require providerSessionId.', 'INVALID_SCHEMA');
  return {
    ...envelope,
    payload: {
      providerId,
      agentId,
      providerSessionId,
      ...(sessionId ? { sessionId } : {}),
      message,
    },
  };
}

export function validateRelayChatResponse(input) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.v !== RELAY_PROTOCOL_VERSION) throw new RelayProtocolError('Chat requires relay protocol v1.', 'UNSUPPORTED_VERSION');
  if (envelope.type !== 'relay.chat.response') throw new RelayProtocolError('Expected a relay chat response.', 'UNSUPPORTED_TYPE');
  if (!envelope.replyTo) throw new RelayProtocolError('Chat responses require replyTo.', 'INVALID_SCHEMA');
  const payload = envelope.payload;
  assertNoPayloadIdentity(payload);
  strictKeys(payload, CHAT_RESPONSE_KEYS, 'chat response');
  if (typeof payload.ok !== 'boolean') throw new RelayProtocolError('Chat response ok must be boolean.', 'INVALID_SCHEMA');
  const sessionId = optionalId(payload.sessionId, 'sessionId');
  const providerSessionId = optionalId(payload.providerSessionId, 'providerSessionId');
  const model = optionalText(payload.model, 256);
  const textValue = payload.text === undefined ? '' : chatText(payload.text, 'response text');
  const errorCode = optionalId(payload.errorCode, 'errorCode');
  const errorMessage = payload.errorMessage === undefined ? '' : text(payload.errorMessage, 1024);
  if (payload.ok && !textValue) throw new RelayProtocolError('Successful chat responses require text.', 'INVALID_SCHEMA');
  if (!payload.ok && !errorCode && !errorMessage) throw new RelayProtocolError('Failed chat responses require an error.', 'INVALID_SCHEMA');
  return {
    ...envelope,
    payload: {
      ok: payload.ok,
      ...(textValue ? { text: textValue } : {}),
      ...(sessionId ? { sessionId } : {}),
      ...(providerSessionId ? { providerSessionId } : {}),
      ...(model ? { model } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

function controlEnvelope(input, expectedType) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.v !== RELAY_CONTROL_PROTOCOL_VERSION || envelope.type !== expectedType) {
    throw new RelayProtocolError(`Expected ${expectedType} on relay protocol v2.`, 'UNSUPPORTED_TYPE');
  }
  if (envelope.replyTo && expectedType === 'relay.control.request') throw new RelayProtocolError('Control requests cannot reply to another message.', 'INVALID_SCHEMA');
  return envelope;
}

function optionalSafeInteger(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new RelayProtocolError(`Invalid ${field}.`, 'INVALID_SCHEMA');
  return value;
}

function controlPayloadBase(payload, name) {
  assertNoPayloadIdentity(payload);
  strictKeys(payload, name === 'control request' ? CONTROL_REQUEST_KEYS : name === 'control response' ? CONTROL_RESPONSE_KEYS : CONTROL_EVENT_KEYS, name);
  if (Object.keys(payload).length > 18) throw new RelayProtocolError(`${name} has too many fields.`, 'PAYLOAD_TOO_LARGE');
  return payload;
}

function normalizeControlFields(payload, { requireOperation = true } = {}) {
  const operation = text(payload.operation || '', 32).toLowerCase();
  if (!CONTROL_OPERATIONS.has(operation)) throw new RelayProtocolError('Unsupported control operation.', 'UNSUPPORTED_TYPE');
  const opId = id(payload.operationId, 'operationId');
  const taskId = optionalId(payload.taskId, 'taskId');
  const threadId = optionalId(payload.threadId, 'threadId');
  const attemptId = optionalId(payload.attemptId, 'attemptId');
  const agentId = optionalId(payload.agentId, 'agentId');
  const providerId = optionalText(payload.providerId, 80);
  const title = optionalText(payload.title, 240);
  const prompt = payload.prompt === undefined ? '' : chatText(payload.prompt, 'prompt');
  const guidance = payload.guidance === undefined ? '' : text(payload.guidance, 4096);
  const capability = optionalText(payload.capability, 120);
  const summary = optionalText(payload.summary, 1200);
  const approvalId = optionalId(payload.approvalId, 'approvalId');
  const decision = optionalText(payload.decision, 32);
  const expectedTaskRevision = optionalSafeInteger(payload.expectedTaskRevision, 'expectedTaskRevision');
  const expectedApprovalRevision = optionalSafeInteger(payload.expectedApprovalRevision, 'expectedApprovalRevision');
  const afterEventSequence = optionalSafeInteger(payload.afterEventSequence, 'afterEventSequence');
  const eventSequence = optionalSafeInteger(payload.eventSequence, 'eventSequence');
  if (requireOperation && !operation) throw new RelayProtocolError('Control operation is required.', 'INVALID_SCHEMA');
  return {
    operation,
    operationId: opId,
    ...(taskId ? { taskId } : {}),
    ...(threadId ? { threadId } : {}),
    ...(attemptId ? { attemptId } : {}),
    ...(agentId ? { agentId } : {}),
    ...(providerId ? { providerId } : {}),
    ...(title ? { title } : {}),
    ...(prompt ? { prompt } : {}),
    ...(guidance ? { guidance } : {}),
    ...(capability ? { capability } : {}),
    ...(summary ? { summary } : {}),
    ...(approvalId ? { approvalId } : {}),
    ...(decision ? { decision } : {}),
    ...(expectedTaskRevision !== undefined ? { expectedTaskRevision } : {}),
    ...(expectedApprovalRevision !== undefined ? { expectedApprovalRevision } : {}),
    ...(afterEventSequence !== undefined ? { afterEventSequence } : {}),
    ...(eventSequence !== undefined ? { eventSequence } : {}),
  };
}

export function validateRelayControlRequest(input) {
  const envelope = controlEnvelope(input, 'relay.control.request');
  const payload = controlPayloadBase(envelope.payload, 'control request');
  return { ...envelope, payload: normalizeControlFields(payload) };
}

export function validateRelayControlResponse(input) {
  const envelope = controlEnvelope(input, 'relay.control.response');
  if (!envelope.replyTo) throw new RelayProtocolError('Control responses require replyTo.', 'INVALID_SCHEMA');
  const payload = controlPayloadBase(envelope.payload, 'control response');
  const normalized = normalizeControlFields(payload);
  if (typeof payload.ok !== 'boolean') throw new RelayProtocolError('Control response ok must be boolean.', 'INVALID_SCHEMA');
  const state = optionalText(payload.state, 64);
  const errorCode = optionalId(payload.errorCode, 'errorCode');
  const errorMessage = optionalText(payload.errorMessage, 1200);
  const result = payload.result === undefined ? '' : (typeof payload.result === 'string' ? text(payload.result, 16 * 1024) : (() => { throw new RelayProtocolError('Control result must be bounded text.', 'INVALID_SCHEMA'); })());
  return {
    ...envelope,
    payload: {
      ...normalized,
      ok: payload.ok,
      ...(state ? { state } : {}),
      ...(payload.revision !== undefined ? { revision: optionalSafeInteger(payload.revision, 'revision') } : {}),
      ...(payload.progressSequence !== undefined ? { progressSequence: optionalSafeInteger(payload.progressSequence, 'progressSequence') } : {}),
      ...(result ? { result } : {}),
      ...(payload.summary !== undefined ? { summary: text(payload.summary, 1200) } : {}),
      ...(errorCode ? { errorCode } : {}),
      ...(errorMessage ? { errorMessage } : {}),
    },
  };
}

export function validateRelayControlEvent(input) {
  const envelope = controlEnvelope(input, 'relay.control.event');
  const payload = controlPayloadBase(envelope.payload, 'control event');
  const normalized = normalizeControlFields({ ...payload, operation: payload.operation || 'status' });
  const eventType = text(payload.eventType, 96);
  const state = optionalText(payload.state, 64);
  const boundedEventPayload = payload.payload === undefined ? undefined : payload.payload;
  if (boundedEventPayload !== undefined && (!isPlainObject(boundedEventPayload) || Buffer.byteLength(JSON.stringify(boundedEventPayload), 'utf8') > 12 * 1024)) throw new RelayProtocolError('Control event payload is too large.', 'PAYLOAD_TOO_LARGE');
  return {
    ...envelope,
    payload: {
      ...normalized,
      eventType,
      ...(state ? { state } : {}),
      ...(payload.revision !== undefined ? { revision: optionalSafeInteger(payload.revision, 'revision') } : {}),
      ...(payload.progressSequence !== undefined ? { progressSequence: optionalSafeInteger(payload.progressSequence, 'progressSequence') } : {}),
      ...(payload.summary !== undefined ? { summary: text(payload.summary, 1200) } : {}),
      ...(payload.result !== undefined ? { result: text(payload.result, 16 * 1024) } : {}),
      ...(payload.errorCode ? { errorCode: id(payload.errorCode, 'errorCode') } : {}),
      ...(payload.eventSequence !== undefined ? { eventSequence: optionalSafeInteger(payload.eventSequence, 'eventSequence') } : {}),
      ...(boundedEventPayload !== undefined ? { payload: boundedEventPayload } : {}),
    },
  };
}

export function validateRelayCapabilitiesSnapshot(input) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.v !== RELAY_CONTROL_PROTOCOL_VERSION || envelope.type !== 'relay.capabilities.snapshot') throw new RelayProtocolError('Expected relay capabilities snapshot on protocol v2.', 'UNSUPPORTED_TYPE');
  const payload = envelope.payload;
  assertNoPayloadIdentity(payload);
  strictKeys(payload, new Set(['agents', 'eventSequence']), 'capabilities snapshot');
  if (!Array.isArray(payload.agents) || payload.agents.length > 200) throw new RelayProtocolError('Capabilities agents must be a bounded array.', 'PAYLOAD_TOO_LARGE');
  const agents = payload.agents.map((agent) => {
    const record = boundedRecord(agent, new Set(['id', 'label', 'name', 'model', 'status', 'capabilities', 'steerSupported']), 'capability agent', 7);
    const normalized = {
      id: id(record.id, 'agent id'),
      label: optionalText(record.label, 160),
      name: optionalText(record.name, 160),
      model: optionalText(record.model, 160),
      status: optionalText(record.status, 80),
      capabilities: Array.isArray(record.capabilities) ? record.capabilities.map((value) => text(value, 96)).slice(0, 64) : [],
      steerSupported: record.steerSupported === true,
    };
    return normalized;
  });
  return { ...envelope, payload: { agents, ...(payload.eventSequence !== undefined ? { eventSequence: optionalSafeInteger(payload.eventSequence, 'eventSequence') } : {}) } };
}

export function validateDeviceEnvelope(input, { deviceId } = {}) {
  const envelope = validateRelayEnvelope(input);
  if (envelope.type === 'relay.auth') throw new RelayProtocolError('Authentication is only accepted as the first device message.', 'AUTH_REQUIRED');
  if (['relay.auth.ok', 'relay.auth.error'].includes(envelope.type)) throw new RelayProtocolError('Message type is not accepted from devices.', 'UNSUPPORTED_TYPE');
  if (envelope.type === 'relay.chat.request') throw new RelayProtocolError('Chat requests are server-to-device only.', 'UNSUPPORTED_TYPE');
  if (envelope.type === 'relay.chat.response') return validateRelayChatResponse(envelope);
  if (envelope.v === RELAY_CONTROL_PROTOCOL_VERSION) {
    if (envelope.type === 'relay.control.request') throw new RelayProtocolError('Control requests are server-to-device only.', 'UNSUPPORTED_TYPE');
    if (envelope.type === 'relay.control.response') return { ...validateRelayControlResponse(envelope), ownerId: RELAY_OWNER_ID, deviceId: deviceId || '' };
    if (envelope.type === 'relay.control.event') return { ...validateRelayControlEvent(envelope), ownerId: RELAY_OWNER_ID, deviceId: deviceId || '' };
    if (envelope.type === 'relay.capabilities.snapshot') return { ...validateRelayCapabilitiesSnapshot(envelope), ownerId: RELAY_OWNER_ID, deviceId: deviceId || '' };
    if (envelope.type === 'relay.replay.response') return { ...validateRelayControlEvent({ ...envelope, type: 'relay.control.event', payload: { ...envelope.payload, eventType: 'replay' } }), type: 'relay.replay.response', ownerId: RELAY_OWNER_ID, deviceId: deviceId || '' };
    throw new RelayProtocolError('Unsupported relay v2 device message.', 'UNSUPPORTED_TYPE');
  }
  if (['relay.heartbeat', 'relay.presence', 'relay.disconnect'].includes(envelope.type)) {
    if (envelope.payload.deviceId !== undefined) throw new RelayProtocolError('Device identity is server-bound.', 'IDENTITY_SPOOF');
  }
  assertNoPayloadIdentity(envelope.payload);
  if (envelope.type === 'relay.heartbeat') {
    strictKeys(envelope.payload, HEARTBEAT_KEYS, 'heartbeat');
    if (envelope.payload.sequence !== undefined && (!Number.isSafeInteger(envelope.payload.sequence) || envelope.payload.sequence < 0)) throw new RelayProtocolError('Invalid heartbeat sequence.');
  }
  if (envelope.type === 'relay.presence') {
    strictKeys(envelope.payload, PRESENCE_KEYS, 'presence');
    if (typeof envelope.payload.state !== 'string' || !/^(online|idle|busy|offline)$/.test(envelope.payload.state)) throw new RelayProtocolError('Invalid presence state.');
  }
  if (['device.state.snapshot', 'agent.roster.snapshot'].includes(envelope.type)) {
    strictKeys(envelope.payload, envelope.type === 'device.state.snapshot' ? DEVICE_SNAPSHOT_KEYS : ROSTER_SNAPSHOT_KEYS, 'snapshot');
    if (envelope.payload.activeProviderId !== undefined && (typeof envelope.payload.activeProviderId !== 'string' || Buffer.byteLength(envelope.payload.activeProviderId, 'utf8') > 128 || !envelope.payload.activeProviderId)) throw new RelayProtocolError('Invalid activeProviderId.');
    if (envelope.type === 'device.state.snapshot') {
      if (envelope.payload.device !== undefined) boundedSnapshotDevice(envelope.payload.device);
      if (envelope.payload.providers !== undefined) {
        if (!Array.isArray(envelope.payload.providers) || envelope.payload.providers.length > 200) throw new RelayProtocolError('Providers must be a bounded array.', 'PAYLOAD_TOO_LARGE');
        envelope.payload.providers.forEach(boundedProvider);
      }
    }
    if (envelope.type === 'agent.roster.snapshot' && envelope.payload.agents !== undefined) {
      if (!Array.isArray(envelope.payload.agents) || envelope.payload.agents.length > 200) throw new RelayProtocolError('Agents must be a bounded array.', 'PAYLOAD_TOO_LARGE');
      envelope.payload.agents.forEach((agent) => boundedAgent(agent));
    }
  }
  if (envelope.type === 'agent.activity') {
    strictKeys(envelope.payload, ACTIVITY_KEYS, 'activity');
    for (const key of ['status', 'message', 'tool', 'agent']) if (envelope.payload[key] !== undefined && (typeof envelope.payload[key] !== 'string' || Buffer.byteLength(envelope.payload[key], 'utf8') > RELAY_MAX_TEXT_BYTES)) throw new RelayProtocolError(`Invalid activity ${key}.`);
    if (envelope.payload.input !== undefined && envelope.payload.input !== null && typeof envelope.payload.input !== 'string' && typeof envelope.payload.input !== 'number' && typeof envelope.payload.input !== 'boolean' && !isPlainObject(envelope.payload.input)) throw new RelayProtocolError('Invalid activity input.');
  }
  return { ...envelope, ownerId: RELAY_OWNER_ID, deviceId: deviceId || '' };
}

export function redactRelayAudit(value = {}) {
  if (Array.isArray(value)) return value.map((item) => redactRelayAudit(item));
  if (!value || typeof value !== 'object') return value;
  const copy = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^(secret|pairingCode|credential|token|authorization)$/i.test(key)) copy[key] = '[redacted]';
    else copy[key] = redactRelayAudit(item);
  }
  return copy;
}
