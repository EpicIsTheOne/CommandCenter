const BASE = window.__BASE_PATH__ || '';

function normalizeFiles(files = []) {
  return Array.isArray(files) ? files : [];
}

export function normalizeSessionMessage(msg = {}) {
  return {
    id: msg.id,
    role: msg.role === 'user' ? 'user' : 'agent',
    kind: msg.meta?.error ? 'error' : 'text',
    text: String(msg.text || ''),
    timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
    files: normalizeFiles(msg.meta?.files),
    raw: msg,
  };
}

export async function listAgentSessions(agentId, { mode = 'agent', limit = 40 } = {}) {
  if (!agentId) return [];
  try {
    const res = await fetch(`${BASE}/api/chat/sessions?agent=${encodeURIComponent(agentId)}&mode=${encodeURIComponent(mode)}&limit=${encodeURIComponent(limit)}`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data.sessions) ? data.sessions : [];
  } catch (_) {
    return [];
  }
}

export async function loadSessionMessages(sessionId) {
  if (!sessionId) return [];
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    const messages = Array.isArray(data.messages) ? data.messages : [];
    return messages.map(normalizeSessionMessage);
  } catch (_) {
    return [];
  }
}

export async function createSession({ agent, title = '', mode = 'agent', model = '', roleplayProvider = null } = {}) {
  const res = await fetch(`${BASE}/api/chat/sessions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agent, title, mode, model, roleplayProvider }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to create session');
  return data.session || null;
}

export async function sendDirectMessage({ message, sessionId = '', agent = '', fileIds = [], mode = 'agent', model = '', roleplayProvider = null } = {}) {
  const payload = sessionId
    ? { message, sessionId, fileIds, mode, model, roleplayProvider }
    : { message, agent, fileIds, mode, model, roleplayProvider };
  const res = await fetch(`${BASE}/api/chat/direct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Failed to send');
  return data;
}
