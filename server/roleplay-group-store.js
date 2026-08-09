import { promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const DATA_PATH = join(process.cwd(), 'data', 'roleplay-groups.json');

async function ensureStore() {
  await fsp.mkdir(dirname(DATA_PATH), { recursive: true });
  try { await fsp.access(DATA_PATH); }
  catch { await fsp.writeFile(DATA_PATH, JSON.stringify({ groups: [] }, null, 2)); }
}

async function readStore() {
  await ensureStore();
  try {
    const parsed = JSON.parse(await fsp.readFile(DATA_PATH, 'utf8'));
    return { groups: Array.isArray(parsed.groups) ? parsed.groups : [] };
  } catch {
    return { groups: [] };
  }
}

async function writeStore(store) {
  await ensureStore();
  await fsp.writeFile(DATA_PATH, JSON.stringify({ groups: Array.isArray(store.groups) ? store.groups : [] }, null, 2));
}

export async function listRoleplayGroups({ limit = 50 } = {}) {
  const store = await readStore();
  return store.groups
    .slice()
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
    .slice(0, Math.max(1, Math.min(200, Number(limit || 50) || 50)))
    .map((group) => ({ ...group, messages: undefined, messageCount: Array.isArray(group.messages) ? group.messages.length : 0, lastMessagePreview: String(group.messages?.at?.(-1)?.text || '').slice(0, 140) }));
}

export async function getRoleplayGroup(id = '') {
  const store = await readStore();
  return store.groups.find((group) => group.id === id) || null;
}

export async function createRoleplayGroup({ name = '', scenario = '', agents = [], userCharacter = '', systemCharacter = false, model = '', roleplayProvider = null } = {}) {
  const now = new Date().toISOString();
  const cleanAgents = (Array.isArray(agents) ? agents : []).map((agent) => ({
    id: String(agent.id || '').trim(),
    label: String(agent.label || agent.id || '').trim(),
    color: String(agent.color || '').trim(),
  })).filter((agent) => agent.id);
  const group = {
    id: `rpg_${randomUUID()}`,
    name: String(name || '').trim().slice(0, 80) || 'Roleplay Group Chat',
    scenario: String(scenario || '').trim().slice(0, 2000),
    agents: cleanAgents,
    userCharacter: String(userCharacter || '').trim().slice(0, 80),
    systemCharacter: systemCharacter === true,
    model: String(model || '').trim().slice(0, 160),
    roleplayProvider: roleplayProvider && typeof roleplayProvider === 'object' ? roleplayProvider : null,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const store = await readStore();
  store.groups.unshift(group);
  await writeStore(store);
  return group;
}

export async function appendRoleplayGroupMessages(id = '', messages = []) {
  const store = await readStore();
  const idx = store.groups.findIndex((group) => group.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const clean = (Array.isArray(messages) ? messages : [messages]).map((message) => ({
    id: message.id || `rpgm_${randomUUID()}`,
    speakerId: String(message.speakerId || '').trim(),
    speakerLabel: String(message.speakerLabel || message.speakerId || '').trim(),
    role: String(message.role || 'agent').trim(),
    text: String(message.text || '').trim(),
    model: String(message.model || '').trim(),
    createdAt: message.createdAt || now,
  })).filter((message) => message.speakerId && message.text);
  store.groups[idx].messages = [...(store.groups[idx].messages || []), ...clean].slice(-300);
  store.groups[idx].updatedAt = now;
  await writeStore(store);
  return store.groups[idx];
}

export async function saveRoleplayGroup(group = {}) {
  const store = await readStore();
  const idx = store.groups.findIndex((item) => item.id === group.id);
  if (idx === -1) return null;
  const next = {
    ...store.groups[idx],
    ...group,
    updatedAt: new Date().toISOString(),
  };
  store.groups[idx] = next;
  await writeStore(store);
  return next;
}

export async function deleteRoleplayGroup(id = '') {
  const store = await readStore();
  const idx = store.groups.findIndex((group) => group.id === id);
  if (idx === -1) return false;
  store.groups.splice(idx, 1);
  await writeStore(store);
  return true;
}
