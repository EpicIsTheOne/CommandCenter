import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'wake-settings.json');

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
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...normalize(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveWakeSettings(input) {
  const settings = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function maskAccessKey(key) {
  const value = String(key || '').trim();
  if (!value) return '';
  if (value.length <= 8) return '••••••••';
  return `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
