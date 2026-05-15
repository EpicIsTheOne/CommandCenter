import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'api-sessions');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const INDEX_PATH = join(DATA_DIR, 'index.json');

function nowIso() {
  return new Date().toISOString();
}

function sessionPath(id) {
  return join(SESSIONS_DIR, `${id}.json`);
}

async function ensureStore() {
  await fsp.mkdir(SESSIONS_DIR, { recursive: true });
  if (!existsSync(INDEX_PATH)) {
    await fsp.writeFile(INDEX_PATH, JSON.stringify({ sessions: [] }, null, 2));
  }
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

async function readIndex() {
  await ensureStore();
  const raw = await fsp.readFile(INDEX_PATH, 'utf8').catch(() => '');
  const parsed = safeJsonParse(raw, { sessions: [] });
  return Array.isArray(parsed?.sessions) ? parsed : { sessions: [] };
}

async function writeIndex(index) {
  await ensureStore();
  await fsp.writeFile(INDEX_PATH, JSON.stringify({ sessions: index.sessions || [] }, null, 2));
}

function summarize(text = '', max = 160) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

function buildSearchText(session) {
  const parts = [session.title || '', session.agent || ''];
  for (const msg of session.messages || []) {
    parts.push(msg.text || '');
  }
  return parts.join('\n').toLowerCase();
}

function sessionMeta(session) {
  const last = Array.isArray(session.messages) && session.messages.length ? session.messages[session.messages.length - 1] : null;
  return {
    id: session.id,
    agent: session.agent,
    title: session.title || '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
    lastMessagePreview: summarize(last?.text || ''),
    metadata: session.metadata || {},
  };
}

export async function createApiSession({ agent, title = '', metadata = {} } = {}) {
  await ensureStore();
  const id = `ccs_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
  const now = nowIso();
  const session = {
    id,
    agent: String(agent || '').trim(),
    title: String(title || '').trim(),
    metadata: metadata && typeof metadata === 'object' ? metadata : {},
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await fsp.writeFile(sessionPath(id), JSON.stringify(session, null, 2));
  const index = await readIndex();
  index.sessions.unshift(sessionMeta(session));
  await writeIndex(index);
  return session;
}

export async function getApiSession(id) {
  await ensureStore();
  if (!id) return null;
  const path = sessionPath(String(id));
  if (!existsSync(path)) return null;
  const raw = await fsp.readFile(path, 'utf8').catch(() => '');
  const parsed = safeJsonParse(raw, null);
  if (!parsed || typeof parsed !== 'object') return null;
  if (!Array.isArray(parsed.messages)) parsed.messages = [];
  return parsed;
}

export async function saveApiSession(session) {
  await ensureStore();
  const next = { ...session, updatedAt: nowIso() };
  await fsp.writeFile(sessionPath(next.id), JSON.stringify(next, null, 2));
  const index = await readIndex();
  const meta = sessionMeta(next);
  const existingIdx = index.sessions.findIndex((item) => item.id === next.id);
  if (existingIdx === -1) index.sessions.unshift(meta);
  else index.sessions[existingIdx] = meta;
  index.sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  await writeIndex(index);
  return next;
}

export async function appendApiSessionMessage(id, { role, text, meta = {} } = {}) {
  const session = await getApiSession(id);
  if (!session) return null;
  const message = {
    id: `msg_${randomUUID().replace(/-/g, '').slice(0, 18)}`,
    role: role === 'assistant' ? 'assistant' : 'user',
    text: String(text || ''),
    timestamp: nowIso(),
    meta: meta && typeof meta === 'object' ? meta : {},
  };
  session.messages.push(message);
  const saved = await saveApiSession(session);
  return { session: saved, message };
}

export async function listApiSessions({ agent = '', limit = 20 } = {}) {
  const index = await readIndex();
  let items = [...index.sessions];
  if (agent) items = items.filter((item) => item.agent === agent);
  return items.slice(0, Math.max(1, Number(limit) || 20));
}

function buildSnippet(session, query) {
  const q = String(query || '').toLowerCase();
  for (const msg of session.messages || []) {
    const text = String(msg.text || '');
    const lower = text.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx !== -1) {
      const start = Math.max(0, idx - 60);
      const end = Math.min(text.length, idx + q.length + 100);
      return summarize(text.slice(start, end), 220);
    }
  }
  return summarize(session.title || '', 220);
}

export async function searchApiSessions(query, { agent = '', limit = 20 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const items = await listApiSessions({ agent, limit: 1000 });
  const results = [];
  for (const meta of items) {
    const session = await getApiSession(meta.id);
    if (!session) continue;
    if (agent && session.agent !== agent) continue;
    const haystack = buildSearchText(session);
    if (!haystack.includes(q)) continue;
    results.push({
      sessionId: session.id,
      agent: session.agent,
      title: session.title || '',
      updatedAt: session.updatedAt,
      messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
      snippet: buildSnippet(session, q),
    });
    if (results.length >= Math.max(1, Number(limit) || 20)) break;
  }
  return results;
}

export function getApiSessionMeta(session) {
  return sessionMeta(session);
}
