import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const HOME = process.env.HOME || '/root';

function safeJsonParse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function sessionIndexPath(agentId) {
  return join(HOME, '.openclaw', 'agents', agentId, 'sessions', 'sessions.json');
}

function newestSessionEntry(index) {
  if (!index || typeof index !== 'object') return null;
  let best = null;
  for (const value of Object.values(index)) {
    if (!value?.sessionFile) continue;
    if (!best || Number(value.updatedAt || 0) > Number(best.updatedAt || 0)) best = value;
  }
  return best;
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

  function scanAgent(agentId) {
    const indexPath = sessionIndexPath(agentId);
    if (!existsSync(indexPath)) return;

    const index = safeJsonParse(readFileSync(indexPath, 'utf8'));
    const session = newestSessionEntry(index);
    if (!session?.sessionFile || !existsSync(session.sessionFile)) return;

    const size = statSync(session.sessionFile).size;
    const prior = fileState.get(session.sessionFile);
    if (!prior) {
      fileState.set(session.sessionFile, { offset: size, agentId });
      return;
    }

    if (size < prior.offset) {
      prior.offset = size;
      return;
    }
    if (size === prior.offset) return;

    const chunk = readFileSync(session.sessionFile).subarray(prior.offset).toString('utf8');
    prior.offset = size;
    prior.agentId = agentId;

    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = safeJsonParse(trimmed);
      if (entry) emitFromEntry(agentId, entry);
    }
  }

  const timer = setInterval(() => {
    for (const agent of roster?.agents || []) {
      try { scanAgent(agent.id); } catch {}
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
    for (const timeout of idleTimers.values()) clearTimeout(timeout);
    idleTimers.clear();
  };
}
