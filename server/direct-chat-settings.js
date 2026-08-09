import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'direct-chat-settings.json');
export const DEFAULT_PAWAN_ROLEPLAY_MODEL = 'pkrd/cosmosrp-2.1';

export const DIRECT_CHAT_DEFAULTS = {
  randomBackchannelMaxTurns: 8,
  manualBackchannelMaxTurns: 24,
  naturalBackchannelStop: true,
  roleplayAutoSpeak: true,
  roleplayDefaultModel: 'z-ai/glm-5',
  pawanApiKey: '',
  roleplayCustomBaseUrl: '',
  roleplayCustomModel: '',
  roleplayCustomApiKey: '',
  relayEnabled: false,
  relayUrl: '',
  relayShowDeviceLabels: true,
};

function resolveRoleplayDefaultModel(model = '', hasPawanKey = false) {
  const trimmed = String(model || '').trim().slice(0, 120);
  if (trimmed) {
    if (hasPawanKey && trimmed === DIRECT_CHAT_DEFAULTS.roleplayDefaultModel) return DEFAULT_PAWAN_ROLEPLAY_MODEL;
    return trimmed;
  }
  return hasPawanKey ? DEFAULT_PAWAN_ROLEPLAY_MODEL : DIRECT_CHAT_DEFAULTS.roleplayDefaultModel;
}

function clampInt(value, min, max, fallback) {
  const next = Number(value);
  if (!Number.isFinite(next)) return fallback;
  return Math.max(min, Math.min(max, Math.round(next)));
}

export function normalizeDirectChatSettings(input = {}) {
  const settings = input && typeof input === 'object' ? input : {};
  const pawanApiKey = String(settings.pawanApiKey || '').trim().slice(0, 300);
  return {
    randomBackchannelMaxTurns: clampInt(settings.randomBackchannelMaxTurns, 2, 20, DIRECT_CHAT_DEFAULTS.randomBackchannelMaxTurns),
    manualBackchannelMaxTurns: clampInt(settings.manualBackchannelMaxTurns, 2, 40, DIRECT_CHAT_DEFAULTS.manualBackchannelMaxTurns),
    naturalBackchannelStop: settings.naturalBackchannelStop !== false,
    roleplayAutoSpeak: settings.roleplayAutoSpeak !== false,
    roleplayDefaultModel: resolveRoleplayDefaultModel(settings.roleplayDefaultModel, !!pawanApiKey),
    pawanApiKey,
    roleplayCustomBaseUrl: String(settings.roleplayCustomBaseUrl || '').trim().slice(0, 300),
    roleplayCustomModel: String(settings.roleplayCustomModel || '').trim().slice(0, 160),
    roleplayCustomApiKey: String(settings.roleplayCustomApiKey || '').trim().slice(0, 300),
    relayEnabled: settings.relayEnabled === true,
    relayUrl: String(settings.relayUrl || '').trim().slice(0, 500),
    relayShowDeviceLabels: settings.relayShowDeviceLabels !== false,
  };
}

export async function loadDirectChatSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DIRECT_CHAT_DEFAULTS };
    return normalizeDirectChatSettings({ ...DIRECT_CHAT_DEFAULTS, ...JSON.parse(await readFile(SETTINGS_FILE, 'utf8')) });
  } catch {
    return { ...DIRECT_CHAT_DEFAULTS };
  }
}

export async function saveDirectChatSettings(input = {}) {
  const existing = await loadDirectChatSettings();
  const settings = normalizeDirectChatSettings({ ...existing, ...(input || {}) });
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function publicDirectChatSettings(settings = {}) {
  const normalized = normalizeDirectChatSettings(settings);
  return {
    ...normalized,
    hasPawanApiKey: !!normalized.pawanApiKey,
    pawanApiKey: '',
    hasRoleplayCustomApiKey: !!normalized.roleplayCustomApiKey,
    roleplayCustomApiKey: '',
  };
}
