import { readFileSync } from 'node:fs';

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

export function loadAgentRoster() {
  try {
    const raw = readFileSync(process.env.HOME + '/.openclaw/openclaw.json', 'utf8');
    const json = JSON.parse(raw);
    const list = Array.isArray(json?.agents?.list) ? json.agents.list : [];
    const agents = list.map((agent, index) => ({
      id: agent.id,
      label: shortName(agent, index),
      name: agent.name || shortName(agent, index),
      color: DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      voice: VOICES[index % VOICES.length],
      isBoss: index === 0 || agent.id === 'main' || agent.id === 'orchestrator',
      workspace: agent.workspace || null,
      model: typeof agent.model === 'string' ? agent.model : agent.model?.primary || null,
      aliases: Array.from(new Set([agent.id, shortName(agent, index), agent.name].filter(Boolean).map((v) => String(v).trim()))),
    })).filter(a => a.id);

    const primaryAgentId = agents.find(a => a.id === 'orchestrator')?.id || agents.find(a => a.isBoss)?.id || agents[0]?.id || 'main';
    return { agents, primaryAgentId };
  } catch (err) {
    return {
      agents: [
        { id: 'main', label: 'Main', name: 'Main', color: DEFAULT_COLORS[0], voice: 'onyx', isBoss: true, aliases: ['main', 'Main'] },
      ],
      primaryAgentId: 'main',
      error: err.message,
    };
  }
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
