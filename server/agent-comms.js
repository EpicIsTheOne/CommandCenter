import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const STORE_FILE = join(DATA_DIR, 'agent-comms.json');
const STORE_VERSION = 1;
const MAX_MESSAGES = 800;
const MAX_TEXT_CHARS = 1500;
const ALLOWED_SCOPE_TYPES = new Set(['global', 'chat', 'task', 'call']);
const ALLOWED_TYPES = new Set(['note', 'context', 'handoff', 'warning', 'reply', 'status']);

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value = '', max = MAX_TEXT_CHARS) {
  return String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\t \f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .slice(0, max);
}

function cleanShort(value = '', max = 120) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeScopeType(value = '') {
  const scopeType = cleanShort(value || 'global', 24).toLowerCase();
  return ALLOWED_SCOPE_TYPES.has(scopeType) ? scopeType : 'global';
}

function normalizeType(value = '') {
  const type = cleanShort(value || 'note', 24).toLowerCase();
  return ALLOWED_TYPES.has(type) ? type : 'note';
}

function normalizeMeta(meta = {}) {
  const input = meta && typeof meta === 'object' ? meta : {};
  return {
    priority: ['low', 'normal', 'high'].includes(String(input.priority || '').toLowerCase()) ? String(input.priority).toLowerCase() : 'normal',
    sessionId: cleanShort(input.sessionId || '', 120),
    taskId: cleanShort(input.taskId || '', 120),
    callSessionId: cleanShort(input.callSessionId || '', 120),
  };
}

export function normalizeAgentComm(input = {}) {
  const scopeType = normalizeScopeType(input.scopeType || input.scope || 'global');
  const text = cleanText(input.text || input.message || '', MAX_TEXT_CHARS);
  const scopeId = scopeType === 'global' ? '' : cleanShort(input.scopeId || '', 160);
  const readBy = Array.isArray(input.readBy)
    ? Array.from(new Set(input.readBy.map((value) => cleanShort(value, 80)).filter(Boolean))).slice(0, 32)
    : [];

  return {
    id: cleanShort(input.id || `ac_${randomUUID()}`, 96),
    fromAgent: cleanShort(input.fromAgent || '', 80),
    fromLabel: cleanShort(input.fromLabel || '', 80),
    fromRuntime: cleanShort(input.fromRuntime || '', 40),
    toAgent: cleanShort(input.toAgent || '', 80),
    toLabel: cleanShort(input.toLabel || '', 80),
    toRuntime: cleanShort(input.toRuntime || '', 40),
    type: normalizeType(input.type || 'note'),
    text,
    scopeType,
    scopeId,
    threadId: cleanShort(input.threadId || '', 120),
    replyToId: cleanShort(input.replyToId || '', 120),
    source: cleanShort(input.source || 'manual-ui', 48),
    createdAt: cleanShort(input.createdAt || nowIso(), 64),
    updatedAt: cleanShort(input.updatedAt || input.createdAt || nowIso(), 64),
    readBy,
    meta: normalizeMeta(input.meta),
  };
}

function normalizeStore(input = {}) {
  const messages = Array.isArray(input.messages)
    ? input.messages.map(normalizeAgentComm).filter((message) => message.text && message.fromAgent && message.toAgent)
    : [];
  return {
    version: STORE_VERSION,
    messages: messages.slice(-MAX_MESSAGES),
  };
}

export async function loadAgentComms() {
  try {
    if (!existsSync(STORE_FILE)) return { version: STORE_VERSION, messages: [] };
    const raw = await readFile(STORE_FILE, 'utf8');
    return normalizeStore(JSON.parse(raw));
  } catch {
    return { version: STORE_VERSION, messages: [] };
  }
}

export async function saveAgentComms(store = {}) {
  const normalized = normalizeStore(store);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STORE_FILE, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 });
  return normalized;
}

export async function createAgentComm(input = {}) {
  const message = normalizeAgentComm(input);
  const store = await loadAgentComms();
  const next = await saveAgentComms({ ...store, messages: [...store.messages, message] });
  const created = next.messages.find((entry) => entry.id === message.id) || message;
  return { ok: true, message: created, store: next };
}

export async function getAgentComm(id = '') {
  const targetId = cleanShort(id || '', 96);
  if (!targetId) return null;
  const store = await loadAgentComms();
  return store.messages.find((message) => message.id === targetId) || null;
}

export async function listAgentComms(filters = {}) {
  const store = await loadAgentComms();
  const fromAgent = cleanShort(filters.fromAgent || '', 80);
  const toAgent = cleanShort(filters.toAgent || '', 80);
  const scopeType = cleanShort(filters.scopeType || '', 24).toLowerCase();
  const scopeId = cleanShort(filters.scopeId || '', 160);
  const threadId = cleanShort(filters.threadId || '', 120);
  const unreadFor = cleanShort(filters.unreadFor || '', 80);
  const limit = Math.max(1, Math.min(200, Number(filters.limit || 100) || 100));
  const messages = store.messages.filter((message) => {
    if (fromAgent && message.fromAgent !== fromAgent) return false;
    if (toAgent && message.toAgent !== toAgent) return false;
    if (scopeType && message.scopeType !== scopeType) return false;
    if (scopeId && message.scopeId !== scopeId) return false;
    if (threadId && message.threadId !== threadId) return false;
    if (unreadFor && Array.isArray(message.readBy) && message.readBy.includes(unreadFor)) return false;
    return true;
  });
  return messages.slice(-limit);
}

export async function markAgentCommsRead({ ids = [], agentId = '' } = {}) {
  const targetIds = Array.from(new Set((Array.isArray(ids) ? ids : []).map((id) => cleanShort(id, 96)).filter(Boolean)));
  const targetAgent = cleanShort(agentId || '', 80);
  if (!targetIds.length || !targetAgent) return { ok: true, updated: 0, ids: [] };
  const store = await loadAgentComms();
  let updated = 0;
  const messages = store.messages.map((message) => {
    if (!targetIds.includes(message.id)) return message;
    const readBy = Array.isArray(message.readBy) ? [...message.readBy] : [];
    if (!readBy.includes(targetAgent)) {
      readBy.push(targetAgent);
      updated += 1;
    }
    return normalizeAgentComm({ ...message, readBy, updatedAt: nowIso() });
  });
  await saveAgentComms({ ...store, messages });
  return { ok: true, updated, ids: targetIds };
}

export function buildAgentCommPromptBlock(message = {}) {
  const normalized = normalizeAgentComm(message);
  const scopeText = normalized.scopeType === 'global'
    ? 'global'
    : `${normalized.scopeType} / ${normalized.scopeId || '(missing-scope-id)'}`;
  return [
    '[Agent Backchannel]',
    `From: ${normalized.fromLabel || normalized.fromAgent || 'Unknown'}`,
    `From Agent ID: ${normalized.fromAgent || 'unknown'}`,
    `Runtime: ${normalized.fromRuntime || 'unknown'}`,
    `Type: ${normalized.type || 'note'}`,
    `Scope: ${scopeText}`,
    '',
    normalized.text || '',
  ].join('\n').trim();
}

export async function listAgentCommThread(threadId = '', rootId = '', limit = 40) {
  const targetThread = cleanShort(threadId || rootId || '', 120);
  const targetRoot = cleanShort(rootId || threadId || '', 96);
  if (!targetThread && !targetRoot) return [];
  const safeLimit = Math.max(1, Math.min(80, Number(limit || 40) || 40));
  const store = await loadAgentComms();
  return store.messages.filter((message) => {
    if (targetRoot && message.id === targetRoot) return true;
    if (targetRoot && message.replyToId === targetRoot) return true;
    if (targetThread && message.threadId === targetThread) return true;
    return false;
  }).slice(-safeLimit);
}

export async function listScopedAgentComms({ agentId = '', scopeType = '', scopeId = '', limit = 6, unreadOnly = true } = {}) {
  const targetAgent = cleanShort(agentId || '', 80);
  if (!targetAgent) return [];
  const normalizedScopeType = normalizeScopeType(scopeType || 'global');
  const normalizedScopeId = normalizedScopeType === 'global' ? '' : cleanShort(scopeId || '', 160);
  const safeLimit = Math.max(1, Math.min(40, Number(limit || 6) || 6));
  const store = await loadAgentComms();
  return store.messages.filter((message) => {
    if (message.toAgent !== targetAgent) return false;
    if (unreadOnly && Array.isArray(message.readBy) && message.readBy.includes(targetAgent)) return false;
    if (message.scopeType === 'global') return true;
    return message.scopeType === normalizedScopeType && message.scopeId === normalizedScopeId;
  }).slice(-safeLimit);
}

export function buildAgentCommContext(messages = []) {
  const scopedMessages = Array.isArray(messages) ? messages : [];
  if (!scopedMessages.length) return '';
  return scopedMessages.map((message) => buildAgentCommPromptBlock(message)).join('\n\n');
}

export async function buildScopedAgentCommContext({ agentId = '', scopeType = '', scopeId = '', limit = 6, unreadOnly = true } = {}) {
  const messages = await listScopedAgentComms({ agentId, scopeType, scopeId, limit, unreadOnly });
  return buildAgentCommContext(messages);
}

export { ALLOWED_SCOPE_TYPES, ALLOWED_TYPES, STORE_FILE as AGENT_COMMS_STORE_FILE };
