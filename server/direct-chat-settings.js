import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'direct-chat-settings.json');

export const DIRECT_CHAT_DEFAULTS = {
  relayEnabled: false,
  relayUrl: '',
  relayShowDeviceLabels: true,
};

export function normalizeDirectChatSettings(input = {}) {
  const settings = input && typeof input === 'object' ? input : {};
  return {
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
  return normalizeDirectChatSettings(settings);
}
