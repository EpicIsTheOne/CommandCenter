import { mkdir } from 'node:fs/promises';
import { readJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const DATA_DIR = dataPath();
const SETTINGS_FILE = dataPath('wake-settings.json');

const DEFAULT_SETTINGS = {
  porcupineAccessKey: '',
  wakeWords: {},
};

function normalize(input = {}) {
  return {
    porcupineAccessKey: String(input.porcupineAccessKey || '').trim(),
    wakeWords: Object.fromEntries(
      Object.entries(input.wakeWords || {}).map(([agentId, cfg]) => [
        String(agentId),
        {
          label: String(cfg?.label || agentId).trim(),
          publicPath: String(cfg?.publicPath || '').trim(),
          builtIn: String(cfg?.builtIn || '').trim(),
          sensitivity: Number.isFinite(Number(cfg?.sensitivity)) ? Number(cfg.sensitivity) : 0.6,
        },
      ]),
    ),
  };
}

export async function loadWakeSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...normalize(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULT_SETTINGS })) };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveWakeSettings(input) {
  const settings = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeJsonStore(SETTINGS_FILE, settings);
  return settings;
}

export function maskAccessKey(key) {
  const value = String(key || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
