import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import relayAgentSource from './relay-agent-source.js';
import { resolveHermesBin } from './hermes-bin.js';
import { parseProfilesTable, parseProfileShow } from './harnesses.js';
import { USER_HOME } from './runtime-paths.js';

const DEFAULT_COLORS = ['#FFD700', '#00DDFF', '#AA66FF', '#FF7A59', '#7CFF6B', '#FF66C4', '#66FFD9', '#FFA726'];
const VOICES = ['onyx', 'echo', 'fable', 'nova', 'shimmer', 'alloy'];
const execFileAsync = promisify(execFile);

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
  const configPath = join(USER_HOME, '.openclaw', 'openclaw.json');
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

async function showHermesProfile(profile, bin = '') {
  if (!bin) return { path: '', model: '', gateway: '' };
  try {
    const { stdout } = await execFileAsync(bin, ['profile', 'show', profile], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 2,
    });
    const details = parseProfileShow(stdout);
    return { path: details.path || '', model: details.model || '', gateway: details.gateway || '' };
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

export async function detectHermesAgents() {
  try {
    const bin = process.env.HERMES_BIN || resolveHermesBin();
    if (!bin) throw new Error('Hermes CLI not found');
    const { stdout } = await execFileAsync(bin, ['profile', 'list'], {
      encoding: 'utf8',
      timeout: 15000,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    });
    const profiles = parseProfilesTable(stdout);
    const agents = await Promise.all(profiles.map(async (record, index) => buildHermesAgent({ ...record, details: await showHermesProfile(record.profile, bin) }, index)));
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

export async function detectAgentSources({ includeHermes = envFlag('HERMES_BRIDGE_ENABLED', false) } = {}) {
  const openclaw = detectOpenClawAgents();
  const hermes = includeHermes
    ? await detectHermesAgents()
    : {
      source: 'hermes',
      label: 'Hermes',
      enabled: false,
      available: false,
      agents: [],
      error: 'Hermes bridge is disabled.',
    };
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

let rosterCache = { at: 0, value: null, promise: null };
const ROSTER_CACHE_MS = 20000;
const FALLBACK_AGENT = { id: 'main', label: 'Main', name: 'Main', color: DEFAULT_COLORS[0], voice: 'onyx', isBoss: true, aliases: ['main', 'Main'], source: 'fallback', bridge: 'fallback' };
let refreshScheduled = false;

export function invalidateRosterCache() {
  rosterCache = { at: 0, value: null, promise: null };
}

export function loadAgentRoster() {
  const now = Date.now();
  if (rosterCache.value && now - rosterCache.at < ROSTER_CACHE_MS) {
    return structuredClone(rosterCache.value);
  }
  scheduleAgentRosterRefresh();
  return structuredClone(rosterCache.value || fallbackRoster());
}

function scheduleAgentRosterRefresh() {
  if (rosterCache.promise || refreshScheduled) return;
  refreshScheduled = true;
  setImmediate(() => {
    refreshScheduled = false;
    void refreshAgentRoster().catch(() => {});
  });
}

function fallbackRoster() {
  return {
    agents: [{ ...FALLBACK_AGENT }],
    primaryAgentId: 'main',
    sources: {
      openclaw: { source: 'openclaw', label: 'OpenClaw', enabled: false, available: false, agents: [], error: 'Agent discovery is still running.' },
      hermes: { source: 'hermes', label: 'Hermes', enabled: false, available: false, agents: [], error: 'Agent discovery is still running.' },
      relay: { source: 'relay', label: 'Relay', enabled: false, available: false, connected: false, agents: [], error: 'Agent discovery is still running.' },
      summary: { hasOpenClaw: false, hasHermes: false, hasRelay: false, openclawAvailable: false, hermesAvailable: false, relayAvailable: false, relayConnected: false },
    },
    error: 'Agent discovery is still running.',
  };
}

function buildRoster(sources) {
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
  let result;
  if (!agents.length) {
    result = {
      agents: [{ ...FALLBACK_AGENT }],
      primaryAgentId: 'main',
      sources,
      error: 'No OpenClaw or Hermes agents are currently enabled.',
    };
  } else {
    const primaryAgentId = agents.find((a) => a.id === 'orchestrator')?.id || agents.find((a) => a.isBoss)?.id || agents[0]?.id || 'main';
    result = { agents, primaryAgentId, sources };
  }
  return result;
}

export async function refreshAgentRoster() {
  if (rosterCache.promise) return rosterCache.promise;
  rosterCache.promise = detectAgentSources().then((sources) => {
    const value = buildRoster(sources);
    rosterCache = { at: Date.now(), value, promise: null };
    return structuredClone(value);
  }).catch(() => {
    const value = fallbackRoster();
    rosterCache = { at: Date.now(), value, promise: null };
    return structuredClone(value);
  });
  return rosterCache.promise;
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
