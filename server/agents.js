import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import relayAgentSource from './relay-agent-source.js';

const DEFAULT_COLORS = ['#FFD700', '#00DDFF', '#AA66FF', '#FF7A59', '#7CFF6B', '#FF66C4', '#66FFD9', '#FFA726'];
const VOICES = ['onyx', 'echo', 'fable', 'nova', 'shimmer', 'alloy'];

function titleize(s = '') {
  return s
    .replace(/[-_]+/g, ' ')
    .replace(/\b\w/g, (m) => m.toUpperCase())
    .trim();
}

function shortName(agent, index) {
  const fromName = (agent.name || '').split('/')[0].trim();
  if (fromName) return fromName;
  if (agent.id === 'main') return 'Main';
  return titleize(agent.id || `Agent ${index + 1}`);
}

function envFlag(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function normalizeAgent(agent, index, source = 'openclaw') {
  const id = String(agent?.id || '').trim();
  if (!id) return null;
  const label = shortName(agent, index);
  const name = String(agent?.name || label).trim() || label;
  return {
    id,
    label,
    name,
    color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
    voice: VOICES[index % VOICES.length],
    isBoss: index === 0 || id === 'main' || id === 'orchestrator',
    workspace: agent.workspace || null,
    model: typeof agent.model === 'string' ? agent.model : agent.model?.primary || null,
    aliases: Array.from(new Set([id, label, name].filter(Boolean).map((v) => String(v).trim()))),
    bridge: source,
    source,
  };
}

export function detectOpenClawAgents() {
  const configPath = process.env.HOME + '/.openclaw/openclaw.json';
  try {
    const raw = readFileSync(configPath, 'utf8');
    const json = JSON.parse(raw);
    const list = Array.isArray(json?.agents?.list) ? json.agents.list : [];
    const agents = list.map((agent, index) => normalizeAgent(agent, index, 'openclaw')).filter(Boolean);
    return {
      source: 'openclaw',
      label: 'OpenClaw',
      enabled: envFlag('OPENCLAW_AGENT_SOURCE_ENABLED', true),
      available: agents.length > 0,
      agents,
      error: '',
      configPath,
    };
  } catch (err) {
    return {
      source: 'openclaw',
      label: 'OpenClaw',
      enabled: envFlag('OPENCLAW_AGENT_SOURCE_ENABLED', true),
      available: false,
      agents: [],
      error: err?.message || 'Could not read OpenClaw config',
      configPath,
    };
  }
}

function parseHermesProfilesTable(text = '') {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trimEnd());
  const profiles = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Profile') || trimmed.startsWith('─')) continue;
    const clean = trimmed.replace(/^◆\s*/, '').trim();
    const cols = clean.split(/\s{2,}/).map((col) => col.trim()).filter(Boolean);
    const profile = cols[0] || '';
    const model = cols[1] || '';
    if (profile) profiles.push({ profile, model });
  }
  return profiles;
}

function showHermesProfile(profile) {
  try {
    const stdout = execFileSync(process.env.HERMES_BIN || 'hermes', ['profile', 'show', profile], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 2,
    });
    const details = {};
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const match = line.match(/^([^:]+):\s+(.*)$/);
      if (!match) continue;
      details[String(match[1] || '').trim().toLowerCase()] = String(match[2] || '').trim();
    }
    return {
      path: details.path || '',
      model: details.model || '',
      gateway: details.gateway || '',
    };
  } catch {
    return { path: '', model: '', gateway: '' };
  }
}

function parseAssistantNameFromSoul(path = '') {
  if (!path) return '';
  try {
    const soul = readFileSync(`${path.replace(/\/$/, '')}/SOUL.md`, 'utf8');
    const match = soul.match(/(?:You are|Name:|#\s*)([^,\n.]{2,80})/i);
    return String(match?.[1] || '').trim();
  } catch {
    return '';
  }
}

function buildHermesAgent(record, index) {
  const profile = String(record?.profile || '').trim();
  const details = record?.details || {};
  const profileTitle = titleize(profile);
  const isDefault = index === 0 || profile === 'default';
  const configuredPrimaryId = String(process.env.HERMES_AGENT_ID || 'hermes').trim() || 'hermes';
  const configuredPrimaryLabel = String(process.env.HERMES_AGENT_LABEL || 'Nyxie').trim() || 'Nyxie';
  const configuredPrimaryName = String(process.env.HERMES_AGENT_NAME || configuredPrimaryLabel).trim() || configuredPrimaryLabel;
  const soulName = parseAssistantNameFromSoul(details.path || '');
  const label = isDefault ? (configuredPrimaryLabel || soulName || profileTitle || 'Hermes') : (soulName || profileTitle || profile);
  const name = isDefault ? (configuredPrimaryName || label) : (soulName || label);
  const id = isDefault ? configuredPrimaryId : `hermes:${profile}`;
  return {
    id,
    profile,
    hermesProfile: profile,
    hermesHome: details.path || '',
    label,
    name,
    color: process.env.HERMES_AGENT_COLOR || '#FF66C4',
    voice: process.env.HERMES_AGENT_VOICE || 'nova',
    isBoss: false,
    workspace: details.path || null,
    model: record?.model || details.model || process.env.HERMES_AGENT_MODEL || null,
    aliases: Array.from(new Set([
      id,
      profile,
      profileTitle,
      label,
      name,
      soulName,
      isDefault ? 'Hermes' : '',
      isDefault ? 'hermes' : '',
      isDefault ? 'Nyxie' : '',
      isDefault ? 'nyxie' : '',
    ].filter(Boolean).map((v) => String(v).trim()))),
    bridge: 'hermes',
    source: 'hermes',
  };
}

export function detectHermesAgents() {
  try {
    const stdout = execFileSync(process.env.HERMES_BIN || 'hermes', ['profile', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 4,
    });
    const profiles = parseHermesProfilesTable(stdout);
    const agents = profiles.map((record, index) => buildHermesAgent({ ...record, details: showHermesProfile(record.profile) }, index));
    return {
      source: 'hermes',
      label: 'Hermes',
      enabled: envFlag('HERMES_BRIDGE_ENABLED', false),
      available: agents.length > 0,
      agents,
      error: '',
    };
  } catch (err) {
    return {
      source: 'hermes',
      label: 'Hermes',
      enabled: envFlag('HERMES_BRIDGE_ENABLED', false),
      available: false,
      agents: [],
      error: err?.message || 'Could not query Hermes profiles',
    };
  }
}

export function detectRelayAgents() {
  const agents = relayAgentSource.getAgents();
  const status = relayAgentSource.getStatus();
  return {
    source: 'relay',
    label: 'Relay',
    enabled: status.enabled,
    available: agents.length > 0,
    connected: status.connected,
    url: status.url,
    agents,
    error: status.enabled && !status.connected ? 'Relay enabled but not connected yet.' : '',
  };
}

export function detectAgentSources() {
  const openclaw = detectOpenClawAgents();
  const hermes = detectHermesAgents();
  const relay = detectRelayAgents();
  return {
    openclaw,
    hermes,
    relay,
    summary: {
      hasOpenClaw: openclaw.enabled && openclaw.agents.length > 0,
      hasHermes: hermes.enabled && hermes.agents.length > 0,
      hasRelay: relay.enabled && relay.agents.length > 0,
      openclawAvailable: openclaw.available,
      hermesAvailable: hermes.available,
      relayAvailable: relay.available,
      relayConnected: relay.connected,
    },
  };
}

export function loadAgentRoster() {
  const sources = detectAgentSources();
  const openclawAgents = sources.openclaw.enabled ? sources.openclaw.agents : [];
  const hermesAgents = sources.hermes.enabled ? sources.hermes.agents : [];
  const relayAgents = sources.relay.enabled ? sources.relay.agents : [];
  const agents = [...openclawAgents];
  for (const hermesAgent of hermesAgents) {
    if (!agents.some((agent) => agent.id === hermesAgent.id)) agents.push(hermesAgent);
  }
  for (const relayAgent of relayAgents) {
    if (!agents.some((agent) => agent.id === relayAgent.id)) agents.push(relayAgent);
  }
  if (!agents.length) {
    return {
      agents: [
        { id: 'main', label: 'Main', name: 'Main', color: DEFAULT_COLORS[0], voice: 'onyx', isBoss: true, aliases: ['main', 'Main'], source: 'fallback', bridge: 'fallback' },
      ],
      primaryAgentId: 'main',
      sources,
      error: 'No OpenClaw or Hermes agents are currently enabled.',
    };
  }
  const primaryAgentId = agents.find((a) => a.id === 'orchestrator')?.id || agents.find((a) => a.isBoss)?.id || agents[0]?.id || 'main';
  return { agents, primaryAgentId, sources };
}

export function searchAgents(query = '', roster = loadAgentRoster(), limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return (roster?.agents || [])
    .filter((agent) => [agent.id, agent.label, agent.name, ...(agent.aliases || [])].filter(Boolean).some((value) => String(value).toLowerCase().includes(q)))
    .slice(0, Math.max(1, Number(limit) || 10));
}

export function getVoiceForAgent(agentId, roster) {
  return roster?.agents?.find(a => a.id === agentId)?.voice || 'nova';
}

export function getHermesAgent(target = '', roster = loadAgentRoster()) {
  const needle = String(target || '').trim().toLowerCase();
  if (!needle) return null;
  return (roster?.agents || []).find((agent) => {
    if (agent?.source !== 'hermes' && agent?.bridge !== 'hermes') return false;
    const haystack = [agent.id, agent.label, agent.name, agent.profile, agent.hermesProfile, ...(agent.aliases || [])]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase());
    return haystack.includes(needle);
  }) || null;
}

export function getHermesAgents(roster = loadAgentRoster()) {
  return (roster?.agents || []).filter((agent) => agent?.source === 'hermes' || agent?.bridge === 'hermes');
}
