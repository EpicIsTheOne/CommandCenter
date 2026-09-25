import { promises as fsp } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonStore, updateJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';
import { randomUUID } from 'node:crypto';

const DATA_PATH = dataPath('roleplay-groups.json');

async function ensureStore() {
  await fsp.mkdir(dirname(DATA_PATH), { recursive: true });
}

async function readStore() {
  await ensureStore();
  const parsed = await readJsonStore(DATA_PATH, { defaultValue: { groups: [] } });
  return { groups: Array.isArray(parsed.groups) ? parsed.groups : [] };
}

async function writeStore(store) {
  await ensureStore();
  await writeJsonStore(DATA_PATH, { groups: Array.isArray(store.groups) ? store.groups : [] });
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
  await updateJsonStore(DATA_PATH, { defaultValue: { groups: [] } }, async (store) => ({
    groups: [group, ...(Array.isArray(store.groups) ? store.groups : [])],
  }));
  return group;
}

export async function appendRoleplayGroupMessages(id = '', messages = []) {
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
  let updated = null;
  await updateJsonStore(DATA_PATH, { defaultValue: { groups: [] } }, async (store) => {
    const groups = Array.isArray(store.groups) ? [...store.groups] : [];
    const index = groups.findIndex((group) => group.id === id);
    if (index === -1) return { groups };
    groups[index] = {
      ...groups[index],
      messages: [...(groups[index].messages || []), ...clean].slice(-300),
      updatedAt: now,
    };
    updated = groups[index];
    return { groups };
  });
  return updated;
}

export async function saveRoleplayGroup(group = {}) {
  let updated = null;
  await updateJsonStore(DATA_PATH, { defaultValue: { groups: [] } }, async (store) => {
    const groups = Array.isArray(store.groups) ? [...store.groups] : [];
    const index = groups.findIndex((item) => item.id === group.id);
    if (index === -1) return { groups };
    const next = { ...groups[index], ...group, updatedAt: new Date().toISOString() };
    groups[index] = next;
    updated = next;
    return { groups };
  });
  return updated;
}

export async function deleteRoleplayGroup(id = '') {
  let removed = false;
  await updateJsonStore(DATA_PATH, { defaultValue: { groups: [] } }, async (store) => {
    const groups = Array.isArray(store.groups) ? store.groups : [];
    const next = groups.filter((group) => group.id !== id);
    removed = next.length !== groups.length;
    return { groups: next };
  });
  return removed;
}
