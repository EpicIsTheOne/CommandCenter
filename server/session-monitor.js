import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
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



function newestSessionFileByMtime(agentId) {
  try {
    const sessionsDir = join(HOME, '.openclaw', 'agents', agentId, 'sessions');
    if (!existsSync(sessionsDir)) return null;
    let best = null;
    for (const entry of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const file = join(sessionsDir, entry.name);
      const stat = statSync(file);
      if (!best || stat.mtimeMs > best.mtimeMs) best = { file, mtimeMs: stat.mtimeMs };
    }
    return best?.file || null;
  } catch {
    return null;
  }
}

function readRecentEntries(sessionFile, maxEntries = 30) {
  if (!sessionFile || !existsSync(sessionFile)) return [];
  const maxBytes = 512 * 1024;
  const size = statSync(sessionFile).size;
  const fd = readFileSync(sessionFile);
  const text = fd.subarray(Math.max(0, size - maxBytes)).toString('utf8');
  const lines = text.split('\n').filter((line) => line.trim());
  return lines.slice(-Math.max(1, Number(maxEntries) || 30))
    .map((line) => safeJsonParse(line.trim()))
    .filter(Boolean);
}

function latestAssistantText(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'message' || entry?.message?.role !== 'assistant') continue;
    const text = summarizeAssistantText(entry.message);
    if (text) return text;
  }
  return '';
}

function latestUserText(entries) {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'message' || entry?.message?.role !== 'user') continue;
    const content = Array.isArray(entry.message?.content) ? entry.message.content : [];
    const text = content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text.trim())
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (text) return text;
  }
  return '';
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
  const emittedEntries = new Set();
  const initializedFiles = new Set();

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

  function emitFromEntry(agentId, entry, sessionFile = '') {
    if (!entry || entry.type !== 'message' || !entry.message) return;
    const entryKey = `${sessionFile || agentId}:${entry.id || createHash('sha1').update(JSON.stringify(entry)).digest('hex')}`;
    if (emittedEntries.has(entryKey)) return;
    const message = entry.message;

    if (message.role === 'user') {
      emittedEntries.add(entryKey);
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
      emittedEntries.add(entryKey);
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
      emittedEntries.add(entryKey);
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
      emittedEntries.add(entryKey);
      queueIdle(agentId, 900);
    }
  }

  function pruneEmittedEntries() {
    if (emittedEntries.size <= 5000) return;
    const keep = Array.from(emittedEntries).slice(-2500);
    emittedEntries.clear();
    for (const key of keep) emittedEntries.add(key);
  }

  function scanSessionFile(agentId, sessionFile) {
    if (!sessionFile || !existsSync(sessionFile)) return;

    const size = statSync(sessionFile).size;
    const prior = fileState.get(sessionFile);
    if (!prior) {
      fileState.set(sessionFile, { offset: size, agentId });
      if (!initializedFiles.has(sessionFile)) {
        initializedFiles.add(sessionFile);
        for (const entry of readRecentEntries(sessionFile, 40)) {
          if (entry?.type !== 'message' || entry?.message?.role !== 'assistant') continue;
          const text = summarizeAssistantText(entry.message);
          if (!text) continue;
          const entryKey = `${sessionFile}:${entry.id || createHash('sha1').update(JSON.stringify(entry)).digest('hex')}`;
          emittedEntries.add(entryKey);
        }
      }
      return;
    }

    const readFullFile = size < prior.offset;
    const offset = readFullFile ? 0 : prior.offset;
    if (!readFullFile && size === prior.offset) return;

    const chunk = readFileSync(sessionFile).subarray(offset).toString('utf8');
    fileState.set(sessionFile, { offset: size, agentId });

    for (const line of chunk.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const entry = safeJsonParse(trimmed);
      if (entry) emitFromEntry(agentId, entry, sessionFile);
    }
    pruneEmittedEntries();
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

  function getDebugState() {
    return existingAgentIds(roster).map((agentId) => {
      const latestFile = newestSessionFileByMtime(agentId);
      const entries = readRecentEntries(latestFile, 40);
      const indexedFiles = [];
      try {
        const index = safeJsonParse(readFileSync(sessionIndexPath(agentId), 'utf8'));
        for (const session of newestSessionEntries(index, 8)) indexedFiles.push(session.sessionFile);
      } catch {}
      return {
        agentId,
        latestFile,
        latestTracked: latestFile ? fileState.has(latestFile) : false,
        trackedFiles: Array.from(fileState.keys()).filter((file) => file.includes(`/.openclaw/agents/${agentId}/sessions/`)).length,
        indexedFiles,
        lastUser: latestUserText(entries).slice(0, 300),
        lastAssistant: latestAssistantText(entries).slice(0, 300),
      };
    });
  }

  const stop = () => {
    clearInterval(timer);
    for (const timeout of idleTimers.values()) clearTimeout(timeout);
    idleTimers.clear();
  };

  stop.getDebugState = getDebugState;
  return stop;
}
