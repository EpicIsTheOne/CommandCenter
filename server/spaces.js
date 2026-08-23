// Spaces: first-class working environments that group projects, agents,
// harnesses, machines, tasks, and notes. Persisted via the shared JSON store
// (atomic writes + last-known-good backup). Schema-versioned for migrations.
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readJsonStore, writeJsonStore } from './json-store.js';

export const SPACES_SCHEMA_VERSION = 1;

const MAX_SPACES = 64;
const MAX_ID_LEN = 120;
const MAX_NAME_LEN = 80;
const MAX_TEXT_LEN = 600;
const MAX_ARRAY = 200;

function nowIso() {
  return new Date().toISOString();
}

function cleanId(value = '', prefix = '') {
  const raw = String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '');
  return raw.slice(0, MAX_ID_LEN);
}

function cleanText(value = '', max = MAX_TEXT_LEN) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function cleanRefList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanId(typeof item === 'string' ? item : item?.id))
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, MAX_ARRAY);
}

function normalizeMemberRefs(value) {
  // Members can be strings or {id, label} records; stored normalized as ids
  // plus a labelHints map so UIs can render names before resolving entities.
  const ids = [];
  const labelHints = {};
  const push = (entry) => {
    if (typeof entry === 'string') {
      const id = cleanId(entry);
      if (id && !ids.includes(id)) ids.push(id);
      return;
    }
    if (entry && typeof entry === 'object') {
      const id = cleanId(entry.id || entry.agent || entry.name);
      if (!id) return;
      if (!ids.includes(id)) ids.push(id);
      const label = cleanText(entry.label || entry.name || entry.title, MAX_NAME_LEN);
      if (label && !labelHints[id]) labelHints[id] = label;
    }
  };
  if (Array.isArray(value)) value.forEach(push);
  else if (value && typeof value === 'object') Object.values(value).forEach(push);
  return { ids: ids.slice(0, MAX_ARRAY), labelHints };
}

// Accepts the stored {ids, labelHints} shape and converts it back into the
// refs list normalizeMemberRefs understands (id strings + {id, label}).
function storedMembersToRefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  if (!Array.isArray(value.ids) && !value.labelHints) return value;
  const refs = (Array.isArray(value.ids) ? value.ids : []).slice();
  const hints = value.labelHints && typeof value.labelHints === 'object' ? value.labelHints : {};
  for (const [id, label] of Object.entries(hints)) refs.push({ id, label });
  return refs;
}

const MEMBER_KIND_INPUT_KEYS = {
  projects: ['projectIds'],
  agents: ['agentIds'],
  harnesses: ['harnessIds'],
  machines: ['machineIds'],
  tasks: ['taskIds'],
  terminals: ['terminalIds'],
  services: ['serviceIds'],
  artifacts: ['artifactIds'],
};

function memberRefsFor(input, existing, kind) {
  const stored = input?.members?.[kind];
  if (stored !== undefined) return storedMembersToRefs(stored);
  if (input?.[kind] !== undefined) return input[kind];
  for (const altKey of MEMBER_KIND_INPUT_KEYS[kind]) {
    if (input?.[altKey] !== undefined) return input[altKey];
  }
  return storedMembersToRefs(existing?.members?.[kind]);
}

export function normalizeSpace(input = {}, existing = null) {
  const now = nowIso();
  const members = {};
  for (const kind of Object.keys(MEMBER_KIND_INPUT_KEYS)) {
    members[kind] = normalizeMemberRefs(memberRefsFor(input, existing, kind));
  }
  return {
    id: cleanId(input.id || existing?.id) || `space-${randomUUID().slice(0, 8)}`,
    name: cleanText(input.name ?? existing?.name, MAX_NAME_LEN) || 'Untitled Space',
    summary: cleanText(input.summary ?? existing?.summary),
    icon: cleanText(input.icon ?? existing?.icon, 16),
    accent: /^#[0-9a-fA-F]{6}$/.test(String(input.accent ?? existing?.accent ?? '')) ? String(input.accent ?? existing?.accent ?? '') : '',
    mode: ['grid', 'flow'].includes(input.mode) ? input.mode : (existing?.mode || 'grid'),
    members,
    settings: {
      defaultHarness: cleanId(input.settings?.defaultHarness ?? existing?.settings?.defaultHarness),
      defaultMachine: cleanId(input.settings?.defaultMachine ?? existing?.settings?.defaultMachine),
      autoAttachNewTasks: Boolean(input.settings?.autoAttachNewTasks ?? existing?.settings?.autoAttachNewTasks ?? true),
      ...(input.settings && typeof input.settings === 'object' ? { extra: Object.fromEntries(Object.entries(input.settings).filter(([key]) => !['defaultHarness', 'defaultMachine', 'autoAttachNewTasks'].includes(key)).slice(0, 32)) } : {}),
    },
    archived: Boolean(input.archived ?? existing?.archived ?? false),
    createdAt: existing?.createdAt || safeIso(input.createdAt) || now,
    updatedAt: now,
  };
}

function safeIso(value, fallback = '') {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

export class SpacesStore {
  constructor({ dataDir = process.env.COMMANDCENTER_CONTROL_DATA_DIR || process.env.COMMANDCENTER_DATA_DIR || join(process.cwd(), 'data'), fileName = 'spaces.v1.json' } = {}) {
    this.dataDir = dataDir;
    this.filePath = join(this.dataDir, fileName);
    this._cache = null;
  }

  async _loadRaw() {
    const defaultValue = { schemaVersion: SPACES_SCHEMA_VERSION, spaces: [] };
    let doc = await readJsonStore(this.filePath, { defaultValue });
    if (!doc || typeof doc !== 'object' || !Array.isArray(doc.spaces)) doc = defaultValue;
    if (Number(doc.schemaVersion || 0) < SPACES_SCHEMA_VERSION) {
      doc = migrateSpacesDoc(doc);
      // Persist the schema upgrade once so subsequent boots skip migration.
      await writeJsonStore(this.filePath, doc);
    }
    this._cache = doc;
    return doc;
  }

  async _persist(doc) {
    doc.schemaVersion = SPACES_SCHEMA_VERSION;
    await writeJsonStore(this.filePath, doc);
    this._cache = doc;
    return doc;
  }

  async list({ includeArchived = false } = {}) {
    const doc = this._cache || await this._loadRaw();
    this._cache = doc;
    return doc.spaces
      .filter((space) => includeArchived || !space.archived)
      .map((space) => structuredClone(space));
  }

  async get(id = '') {
    const key = cleanId(id);
    if (!key) return null;
    const doc = this._cache || await this._loadRaw();
    this._cache = doc;
    const space = doc.spaces.find((entry) => entry.id === key);
    return space ? structuredClone(space) : null;
  }

  async create(input = {}) {
    const doc = this._cache || await this._loadRaw();
    const space = normalizeSpace({ ...input, id: input.id || `space-${randomUUID().slice(0, 8)}` });
    if (!space.name || space.name === 'Untitled Space') {
      if (!input.name) space.name = `Space ${doc.spaces.length + 1}`;
    }
    if (doc.spaces.some((entry) => entry.id === space.id)) {
      const error = new Error(`Space id already exists: ${space.id}`);
      error.code = 'SPACE_EXISTS';
      throw error;
    }
    if (doc.spaces.length >= MAX_SPACES) {
      const error = new Error(`Space limit reached (${MAX_SPACES}). Archive or delete a Space first.`);
      error.code = 'SPACE_LIMIT';
      throw error;
    }
    doc.spaces.push(space);
    await this._persist(doc);
    return structuredClone(space);
  }

  async update(id, patch = {}) {
    const doc = this._cache || await this._loadRaw();
    const key = cleanId(id);
    const index = doc.spaces.findIndex((entry) => entry.id === key);
    if (index === -1) return null;
    const merged = normalizeSpace({
      ...doc.spaces[index],
      ...patch,
      id: key,
      createdAt: doc.spaces[index].createdAt,
      settings: { ...doc.spaces[index].settings, ...(patch.settings || {}) },
    }, doc.spaces[index]);
    doc.spaces[index] = merged;
    await this._persist(doc);
    return structuredClone(merged);
  }

  async delete(id) {
    const doc = this._cache || await this._loadRaw();
    const key = cleanId(id);
    const index = doc.spaces.findIndex((entry) => entry.id === key);
    if (index === -1) return false;
    doc.spaces.splice(index, 1);
    await this._persist(doc);
    return true;
  }

  async attach(kind, spaceId, refs) {
    const allowed = ['projects', 'agents', 'harnesses', 'machines', 'tasks', 'terminals', 'services', 'artifacts'];
    if (!allowed.includes(kind)) {
      const error = new Error(`Unknown member kind: ${kind}`);
      error.code = 'SPACE_BAD_KIND';
      throw error;
    }
    const space = await this.get(spaceId);
    if (!space) return null;
    const { ids, labelHints } = normalizeMemberRefs(refs);
    const current = new Set(space.members[kind].ids);
    for (const id of ids) current.add(id);
    const patch = { members: { ...space.members, [kind]: { ids: Array.from(current).slice(0, MAX_ARRAY), labelHints: { ...space.members[kind].labelHints, ...labelHints } } } };
    return this.update(spaceId, patch);
  }

  async detach(kind, spaceId, refs) {
    const space = await this.get(spaceId);
    if (!space) return null;
    const removals = new Set(cleanRefList(refs));
    const nextIds = space.members[kind].ids.filter((id) => !removals.has(id));
    const labelHints = Object.fromEntries(Object.entries(space.members[kind].labelHints).filter(([id]) => !removals.has(id)));
    return this.update(spaceId, { members: { ...space.members, [kind]: { ids: nextIds, labelHints } } });
  }

  async ensureDefaultSpace(name = 'Command Center') {
    const spaces = await this.list();
    if (spaces.length) return spaces[0];
    return this.create({ name, summary: 'Default operating environment created automatically on first launch.' });
  }
}

export function migrateSpacesDoc(doc) {
  // v0 -> v1: legacy docs lacked schemaVersion/member normalization.
  const source = doc && typeof doc === 'object' ? doc : {};
  const legacySpaces = Array.isArray(source.spaces) ? source.spaces : [];
  return {
    schemaVersion: SPACES_SCHEMA_VERSION,
    migratedAt: nowIso(),
    spaces: legacySpaces.slice(0, MAX_SPACES).map((space) => normalizeSpace(space)),
  };
}

let singleton = null;

export function getSpacesStore(options = {}) {
  if (!singleton || options.forceNew) singleton = new SpacesStore(options);
  return singleton;
}

export function resetSpacesStoreForTests() {
  singleton = null;
}
