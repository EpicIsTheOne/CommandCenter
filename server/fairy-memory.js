import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonStore, updateJsonStore, writeJsonStore } from './json-store.js';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const MEMORY_FILE = join(DATA_DIR, 'fairy-memory.json');
const MAX_ENTRIES = 160;
const MAX_ENTRY_CHARS = 1200;
const MAX_CONTEXT_CHARS = 6000;
const DEFAULT_SCOPE = 'general';

function cleanText(value = '', max = MAX_ENTRY_CHARS) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeScope(value = '') {
  const raw = cleanText(value || DEFAULT_SCOPE, 48).toLowerCase();
  return raw || DEFAULT_SCOPE;
}

function normalizeEntry(entry = {}) {
  const text = cleanText(entry.text || entry.note || '');
  if (!text) return null;
  const tags = Array.isArray(entry.tags)
    ? entry.tags.map((tag) => cleanText(tag, 48)).filter(Boolean).slice(0, 8)
    : [];
  return {
    id: cleanText(entry.id || randomUUID(), 96),
    text,
    tags,
    scope: normalizeScope(entry.scope || DEFAULT_SCOPE),
    pinned: entry.pinned === true,
    source: cleanText(entry.source || 'fairy-live', 80),
    createdAt: cleanText(entry.createdAt || new Date().toISOString(), 64),
    updatedAt: cleanText(entry.updatedAt || entry.createdAt || new Date().toISOString(), 64),
  };
}

function normalizeStore(input = {}) {
  const entries = Array.isArray(input.entries)
    ? input.entries.map(normalizeEntry).filter(Boolean)
    : [];
  return {
    version: 1,
    entries: entries.slice(-MAX_ENTRIES),
  };
}

function tokenize(value = '') {
  return Array.from(new Set(cleanText(value, 2000).toLowerCase().split(/[^a-z0-9]+/g).filter((token) => token.length >= 2))).slice(0, 64);
}

function scoreEntry(entry = {}, query = '', scope = DEFAULT_SCOPE) {
  let score = 0;
  const q = cleanText(query, 1000).toLowerCase();
  const queryTokens = tokenize(query);
  const hay = `${String(entry.text || '').toLowerCase()} ${Array.isArray(entry.tags) ? entry.tags.join(' ').toLowerCase() : ''} ${String(entry.scope || '')}`;
  if (entry.pinned) score += 3;
  if (scope && String(entry.scope || DEFAULT_SCOPE) === String(scope || DEFAULT_SCOPE)) score += 5;
  if (scope && String(entry.scope || DEFAULT_SCOPE) === 'general') score += 1;
  if (q && hay.includes(q)) score += 8;
  for (const token of queryTokens) {
    if (hay.includes(token)) score += 2;
  }
  const updatedAt = Date.parse(entry.updatedAt || entry.createdAt || Date.now());
  const ageDays = Math.max(0, (Date.now() - updatedAt) / 86400000);
  score += Math.max(0, 4 - Math.min(4, ageDays / 7));
  return score;
}

export async function loadFairyMemory() {
  return normalizeStore(await readJsonStore(MEMORY_FILE, { defaultValue: { version: 1, entries: [] } }));
}

export async function saveFairyMemory(store = {}) {
  const normalized = normalizeStore(store);
  await writeJsonStore(MEMORY_FILE, normalized, { mode: 0o600 });
  return normalized;
}

export async function addFairyMemoryEntry({ text, tags = [], scope = DEFAULT_SCOPE, pinned = false, source = 'fairy-live' } = {}) {
  const entry = normalizeEntry({ text, tags, scope, pinned, source });
  if (!entry) throw new Error('Missing memory text');
  const next = await updateJsonStore(MEMORY_FILE, { defaultValue: { version: 1, entries: [] }, normalize: normalizeStore }, (store) => ({ ...store, entries: [...store.entries, entry] }));
  return { entry, store: next };
}

export function selectRelevantFairyMemory({ store = {}, query = '', scope = DEFAULT_SCOPE, limit = 8 } = {}) {
  const entries = Array.isArray(store.entries) ? store.entries.filter((entry) => entry?.text) : [];
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query, scope) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || Date.parse(b.entry.updatedAt || b.entry.createdAt || 0) - Date.parse(a.entry.updatedAt || a.entry.createdAt || 0))
    .slice(0, Math.max(1, Math.min(24, limit)))
    .map((item) => item.entry);
}

export async function removeFairyMemoryEntry(id = '') {
  const target = cleanText(id, 96);
  let removed = false;
  const next = await updateJsonStore(MEMORY_FILE, { defaultValue: { version: 1, entries: [] }, normalize: normalizeStore }, (store) => {
    const entries = store.entries.filter((entry) => String(entry.id || '') !== target);
    removed = entries.length !== store.entries.length;
    return { ...store, entries };
  });
  return { ok: removed, store: next };
}

export async function updateFairyMemoryEntry(id = '', patch = {}) {
  const target = cleanText(id, 96);
  let found = false;
  const next = await updateJsonStore(MEMORY_FILE, { defaultValue: { version: 1, entries: [] }, normalize: normalizeStore }, (store) => ({ ...store, entries: store.entries.map((entry) => {
      if (String(entry.id || '') !== target) return entry;
      found = true;
      return normalizeEntry({ ...entry, ...patch, updatedAt: new Date().toISOString() });
    }).filter(Boolean) }));
  return { ok: found, store: next, entry: found ? next.entries.find((entry) => String(entry.id) === target) || null : null };
}

export function buildFairyMemoryContext({ enabled = true, memoryNotes = '', store = {}, query = '', scope = DEFAULT_SCOPE, limit = 8 } = {}) {
  if (!enabled) return '';
  const sections = [];
  const manual = String(memoryNotes || '').trim().slice(0, 3000);
  if (manual) {
    sections.push(`Operator-provided local memory:\n${manual}`);
  }

  const entries = selectRelevantFairyMemory({ store, query, scope, limit });
  if (entries.length) {
    const lines = entries.map((entry) => {
      const tags = Array.isArray(entry.tags) && entry.tags.length ? ` [${entry.tags.join(', ')}]` : '';
      const scopeLabel = entry.scope && entry.scope !== DEFAULT_SCOPE ? ` <${entry.scope}>` : '';
      const pinLabel = entry.pinned ? ' [pinned]' : '';
      const date = entry.createdAt ? String(entry.createdAt).slice(0, 10) : 'undated';
      return `- ${date}${scopeLabel}${pinLabel}${tags}: ${entry.text}`;
    }).join('\n');
    sections.push(`Relevant local memory:\n${lines}`);
  }

  if (!sections.length) return '';
  return sections.join('\n\n').slice(0, MAX_CONTEXT_CHARS).trim();
}
