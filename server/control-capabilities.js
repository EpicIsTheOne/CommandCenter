const READ_CAPABILITIES = Object.freeze([
  'agent.roster.read',
  'agent.status.read',
  'task.status.read',
  'task.progress.read',
  'task.review.read',
]);

const COMMON_TASK_CAPABILITIES = Object.freeze([
  'task.start',
  'task.queue',
  'task.cancel',
  'task.retry',
]);

const RISKY_CAPABILITIES = Object.freeze([
  'file.write',
  'command.execute',
  'network.request',
  'deployment.execute',
  'external.communication',
  'settings.change',
  'device.control',
]);

function clean(value, max = 120) {
  return String(value ?? '').trim().slice(0, max);
}

function unique(values = []) {
  return Array.from(new Set(values.map((value) => clean(value)).filter(Boolean)));
}

function inferRuntime(agent = {}) {
  const source = clean(agent.source || agent.bridge || '').toLowerCase();
  if (source === 'relay' || agent.relay === true || agent.relayDeviceId) return 'relay';
  if (source === 'hermes' || source === 'hermes-bridge') return 'hermes';
  return clean(agent.runtime || 'openclaw') || 'openclaw';
}

function defaultCapabilities(agent = {}) {
  const runtime = inferRuntime(agent);
  const explicit = Array.isArray(agent.capabilities) ? agent.capabilities : [];
  const result = [...READ_CAPABILITIES, ...COMMON_TASK_CAPABILITIES];
  if (agent.steerSupported === true || agent.supportsSteer === true) result.push('task.steer');
  if (runtime === 'relay' && agent.relayControlV2 === true) result.push('task.steer');
  return unique([...result, ...explicit]);
}

export function normalizeAgentCapabilityRecord(agent = {}) {
  const runtime = inferRuntime(agent);
  return {
    id: clean(agent.id || agent.agentId, 160),
    label: clean(agent.label || agent.name || agent.id || agent.agentId, 160),
    name: clean(agent.name || agent.label || agent.id || agent.agentId, 160),
    source: clean(agent.source || agent.bridge || (runtime === 'relay' ? 'relay' : runtime), 80),
    runtime,
    provider: clean(agent.provider || agent.relayProviderId || agent.relayProviderLabel, 120),
    deviceId: clean(agent.deviceId || agent.relayDeviceId, 160),
    deviceName: clean(agent.deviceName || agent.relayDeviceName, 160),
    status: clean(agent.status || agent.relayAgentStatus || agent.relayDeviceState || 'unknown', 80),
    capabilities: defaultCapabilities(agent),
    riskyCapabilities: unique(Array.isArray(agent.riskyCapabilities) ? agent.riskyCapabilities : RISKY_CAPABILITIES),
    relayControlVersion: agent.relayControlV2 === true ? 2 : 1,
    steerSupported: defaultCapabilities(agent).includes('task.steer'),
  };
}

export function buildCapabilityRegistry({ roster = {}, relayAgents = [] } = {}) {
  const records = new Map();
  for (const agent of Array.isArray(roster?.agents) ? roster.agents : []) {
    const record = normalizeAgentCapabilityRecord(agent);
    if (record.id) records.set(record.id, record);
  }
  for (const agent of Array.isArray(relayAgents) ? relayAgents : []) {
    const record = normalizeAgentCapabilityRecord({ ...agent, source: 'relay', relay: true });
    if (!record.id) continue;
    records.set(record.id, { ...(records.get(record.id) || {}), ...record });
  }
  return [...records.values()].sort((a, b) => a.label.localeCompare(b.label));
}

export function getAgentCapability(agentId, options = {}) {
  const id = clean(agentId, 160);
  return buildCapabilityRegistry(options).find((agent) => agent.id === id) || null;
}

export { COMMON_TASK_CAPABILITIES, READ_CAPABILITIES, RISKY_CAPABILITIES };
