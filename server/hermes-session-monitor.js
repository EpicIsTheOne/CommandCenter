import { execFile } from 'node:child_process';
import { getHermesAgents, loadAgentRoster } from './agents.js';

const HERMES_PY_SCRIPT = String.raw`
import sqlite3, os, json, sys
path = os.path.expanduser(sys.argv[1])
limit = int(sys.argv[2]) if len(sys.argv) > 2 else 80
if not os.path.exists(path):
    print(json.dumps({"messages": []}))
    raise SystemExit(0)
con = sqlite3.connect(path)
con.row_factory = sqlite3.Row
cur = con.cursor()
cur.execute('''
select m.id as message_id, m.session_id, m.role, m.content, m.tool_calls, m.tool_name,
       m.timestamp, m.finish_reason, s.source as session_source, s.title as session_title,
       s.model as session_model, s.system_prompt as system_prompt
from messages m
join sessions s on s.id = m.session_id
order by m.id desc
limit ?
''', (limit,))
rows = []
for row in cur.fetchall():
    rows.append({k: row[k] for k in row.keys()})
print(json.dumps({"messages": rows}))
`;

function safeJsonParse(text, fallback = null) {
  try { return JSON.parse(text); } catch { return fallback; }
}

function cleanText(value = '') {
  return String(value || '')
    .replace(/^\s*\[\[\s*reply_to[^\]]*\]\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractAssistantText(content = '') {
  const raw = String(content || '').trim();
  if (!raw) return '';
  const parsed = safeJsonParse(raw, null);
  if (typeof parsed === 'string') return cleanText(parsed);
  if (Array.isArray(parsed)) {
    const text = parsed
      .filter((part) => part && typeof part === 'object')
      .map((part) => {
        if (typeof part.text === 'string') return part.text;
        if (part.type === 'text' && typeof part.content === 'string') return part.content;
        return '';
      })
      .filter(Boolean)
      .join(' ');
    return cleanText(text);
  }
  if (parsed && typeof parsed === 'object') {
    if (typeof parsed.text === 'string') return cleanText(parsed.text);
    if (Array.isArray(parsed.content)) {
      const text = parsed.content
        .map((part) => {
          if (!part || typeof part !== 'object') return '';
          if (typeof part.text === 'string') return part.text;
          if (part.type === 'text' && typeof part.content === 'string') return part.content;
          return '';
        })
        .filter(Boolean)
        .join(' ');
      return cleanText(text);
    }
  }
  return cleanText(raw);
}

function extractToolCalls(row) {
  const explicit = safeJsonParse(String(row?.tool_calls || '').trim(), null);
  if (Array.isArray(explicit) && explicit.length) {
    return explicit.map((call) => ({
      tool: String(call?.name || call?.tool_name || row?.tool_name || 'tool'),
      input: typeof call?.arguments === 'string' ? call.arguments : JSON.stringify(call?.arguments || {}),
    }));
  }
  if (row?.tool_name) {
    return [{ tool: String(row.tool_name), input: '' }];
  }
  return [];
}

function extractPersonaHints(row) {
  const hints = new Set();
  const title = String(row?.session_title || '').trim();
  const prompt = String(row?.system_prompt || '').trim();
  if (title) hints.add(title);
  const youAre = prompt.match(/You are\s+([^,\n.]{2,80})/i);
  if (youAre?.[1]) hints.add(String(youAre[1]).trim());
  return Array.from(hints);
}

function resolveHermesAgentForRow(row, hermesAgents = []) {
  const profile = String(row?.hermesProfile || '').trim().toLowerCase();
  if (profile) {
    const byProfile = hermesAgents.find((agent) => String(agent.hermesProfile || '').trim().toLowerCase() === profile);
    if (byProfile) return byProfile;
  }
  const hints = extractPersonaHints(row).map((value) => String(value).trim().toLowerCase());
  for (const hint of hints) {
    const match = hermesAgents.find((agent) => [agent.id, agent.label, agent.name, agent.profile, agent.hermesProfile, ...(agent.aliases || [])]
      .filter(Boolean)
      .map((value) => String(value).trim().toLowerCase())
      .includes(hint));
    if (match) return match;
  }
  return hermesAgents[0] || null;
}

export function startHermesSessionMonitor({ broadcast, intervalMs = 2200, roster = loadAgentRoster() } = {}) {
  const seenMessageIdsByDb = new Map();
  const initializedDbs = new Set();
  const idleTimers = new Map();

  function queueIdle(agentId, delay = 1800) {
    clearTimeout(idleTimers.get(agentId));
    idleTimers.set(agentId, setTimeout(() => {
      broadcast({ type: 'agent:idle', data: { agent: agentId, source: 'hermes-session-monitor' } });
      idleTimers.delete(agentId);
    }, delay));
  }

  function cancelIdle(agentId) {
    clearTimeout(idleTimers.get(agentId));
    idleTimers.delete(agentId);
  }

  function currentHermesAgents() {
    return getHermesAgents(typeof roster === 'function' ? roster() : roster);
  }

  function ensureDbSet(dbPath) {
    if (!seenMessageIdsByDb.has(dbPath)) seenMessageIdsByDb.set(dbPath, new Set());
    return seenMessageIdsByDb.get(dbPath);
  }

  function emitRow(row) {
    const agent = resolveHermesAgentForRow(row, currentHermesAgents());
    if (!agent?.id) return;

    const source = String(row?.session_source || '').trim().toLowerCase();
    if (source === 'commandcenter') return;

    if (String(row?.role || '').trim() === 'user') {
      cancelIdle(agent.id);
      broadcast({
        type: 'agent:thinking',
        data: {
          agent: agent.id,
          status: 'Processing...',
          source: 'hermes-session-monitor',
          platform: source,
          hermesSessionId: row?.session_id || '',
          hermesProfile: agent.hermesProfile || '',
        },
      });
      return;
    }

    if (String(row?.role || '').trim() !== 'assistant') return;

    const toolCalls = extractToolCalls(row);
    if (toolCalls.length) {
      cancelIdle(agent.id);
      for (const toolCall of toolCalls) {
        broadcast({
          type: 'agent:tool_use',
          data: {
            agent: agent.id,
            tool: toolCall.tool,
            input: toolCall.input,
            source: 'hermes-session-monitor',
            platform: source,
            hermesSessionId: row?.session_id || '',
            hermesProfile: agent.hermesProfile || '',
          },
        });
      }
    }

    const text = extractAssistantText(row?.content || '');
    if (text) {
      cancelIdle(agent.id);
      broadcast({
        type: 'agent:responding',
        data: {
          agent: agent.id,
          message: text,
          source: 'hermes-session-monitor',
          platform: source,
          hermesSessionId: row?.session_id || '',
          hermesProfile: agent.hermesProfile || '',
        },
      });
      queueIdle(agent.id);
      return;
    }

    queueIdle(agent.id, 900);
  }

  function pruneSeen() {
    for (const [dbPath, seen] of seenMessageIdsByDb) {
      if (seen.size <= 5000) continue;
      const keep = Array.from(seen).slice(-2500);
      seen.clear();
      for (const id of keep) seen.add(id);
      seenMessageIdsByDb.set(dbPath, seen);
    }
  }

  function pollOneDb(dbPath, profile) {
    execFile('python3', ['-c', HERMES_PY_SCRIPT, dbPath, '120'], {
      timeout: 10000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 1024 * 1024 * 4,
    }, (err, stdout) => {
      if (err) return;
      const parsed = safeJsonParse(String(stdout || '').trim(), { messages: [] });
      const rows = Array.isArray(parsed?.messages) ? parsed.messages.slice().reverse().map((row) => ({ ...row, hermesProfile: profile })) : [];
      const seen = ensureDbSet(dbPath);
      if (!initializedDbs.has(dbPath)) {
        for (const row of rows) {
          const messageId = Number(row?.message_id || 0);
          if (messageId) seen.add(messageId);
        }
        initializedDbs.add(dbPath);
        return;
      }
      for (const row of rows) {
        const messageId = Number(row?.message_id || 0);
        if (!messageId || seen.has(messageId)) continue;
        seen.add(messageId);
        emitRow(row);
      }
    });
  }

  function poll() {
    const agents = currentHermesAgents();
    const targets = agents
      .map((agent) => ({ profile: String(agent.hermesProfile || '').trim(), dbPath: `${String(agent.hermesHome || '').replace(/\/$/, '') || process.env.HOME + '/.hermes'}/state.db` }))
      .filter((item) => item.profile && item.dbPath);
    for (const target of targets) pollOneDb(target.dbPath, target.profile);
    pruneSeen();
  }

  const timer = setInterval(poll, Math.max(1000, Number(intervalMs) || 2200));
  poll();

  return () => {
    clearInterval(timer);
    for (const timeout of idleTimers.values()) clearTimeout(timeout);
    idleTimers.clear();
  };
}
