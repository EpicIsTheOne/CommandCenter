import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/root';

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sessionIndexPath(agentId) {
  return join(HOME, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
}

function newestSessionEntries(index, limit = 8) {
  if (!index || typeof index !== 'object') return [];
  const seen = new Set();
  return Object.values(index)
    .filter((value) => value?.sessionFile)
    .sort((a, b) => Number(b.updatedAt || 0) - Number(a.updatedAt || 0))
    .filter((value) => {
      const file = String(value.sessionFile || '');
      if (!file || seen.has(file)) return false;
      seen.add(file);
      return true;
    })
    .slice(0, Math.max(1, Number(limit) || 8));
}

function newestSessionEntry(index) {
  return newestSessionEntries(index, 1)[0] || null;
}

function existingAgentIds(roster) {
  const ids = new Set((roster?.agents || []).map((agent) => String(agent.id || '').trim()).filter(Boolean));
  try {
    const agentsDir = join(HOME, '.openclaw', 'agents');
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isDirectory()) ids.add(entry.name);
    }
  } catch {}
  return Array.from(ids);
}

function summarizeAssistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  const text = content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/^\s*\[\[\s*reply_to[^\]]*\]\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text;

  const thinking = content.find((part) => part?.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim());
  if (thinking?.thinking) return 'Thinking...';
  return '';
}

function extractToolCalls(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === 'toolCall' && part.name)
    .map((part) => ({
      tool: String(part.name),
      input: part.arguments ? JSON.stringify(part.arguments) : '',
    }));
}

export function startSessionMonitor({ broadcast, roster, intervalMs = 1000, emitResponses = false } = {}) {
  const fileState = new Map();
  const idleTimers = new Map();

  function queueIdle(agentId, delay = 1800) {
    clearTimeout(idleTimers.get(agentId));
    idleTimers.set(agentId, setTimeout(() => {
      broadcast({ type: 'agent:idle', data: { agent: agentId, source: 'session-monitor' } });
      idleTimers.delete(agentId);
    }, delay));
  }

  function cancelIdle(agentId) {
    clearTimeout(idleTimers.get(agentId));
    idleTimers.delete(agentId);
  }

  function emitFromEntry(agentId, entry) {
    if (!entry || entry.type !== 'message' || !entry.message) return;
    const message = entry.message;

    if (message.role === 'user') {
      cancelIdle(agentId);
      broadcast({
        type: 'agent:thinking',
        data: { agent: agentId, status: 'Processing...', source: 'session-monitor' },
      });
      return;
    }

    if (message.role !== 'assistant') return;

    const toolCalls = extractToolCalls(message);
    if (toolCalls.length) {
      cancelIdle(agentId);
      for (const toolCall of toolCalls) {
        broadcast({
          type: 'agent:tool_use',
          data: { agent: agentId, tool: toolCall.tool, input: toolCall.input, source: 'session-monitor' },
        });
      }
    }

    const text = summarizeAssistantText(message);
    if (text) {
      cancelIdle(agentId);
      if (emitResponses) {
        broadcast({
          type: 'agent:responding',
          data: { agent: agentId, message: text, source: 'session-monitor' },
        });
      }
      if (message.stopReason !== 'toolUse') queueIdle(agentId);
      return;
    }

    if (message.stopReason && message.stopReason !== 'toolUse') {
      queueIdle(agentId, 900);
    }
  }

  function scanSessionFile(agentId, sessionFile) {
    if (!sessionFile || !existsSync(sessionFile)) return;

    const size = statSync(sessionFile).size;
    const prior = fileState.get(sessionFile);
    if (!prior) {
      fileState.set(sessionFile, { offset: size, agentId });
      return;
    }

    if (size < prior.offset) {
      prior.offset = size;
      return;
    }
    if (size === prior.offset) return;

    const chunk = readFileSync(sessionFile).subarray(prior.offset).toString('utf8');
    prior.offset = size;
    prior.agentId = agentId;

    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = safeJsonParse(trimmed);
      if (entry) emitFromEntry(agentId, entry);
    }
  }

  function scanAgent(agentId) {
    const indexPath = sessionIndexPath(agentId);
    if (!existsSync(indexPath)) return;

    const index = safeJsonParse(readFileSync(indexPath, 'utf8'));
    for (const session of newestSessionEntries(index, 12)) {
      scanSessionFile(agentId, session.sessionFile);
    }
  }

  const timer = setInterval(() => {
    for (const agentId of existingAgentIds(roster)) {
      try { scanAgent(agentId); } catch {}
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    for (const timeout of idleTimers.values()) clearTimeout(timeout);
    idleTimers.clear();
  };
}
