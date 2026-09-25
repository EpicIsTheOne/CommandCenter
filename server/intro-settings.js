import { mkdir } from 'node:fs/promises';
import { readJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const DATA_DIR = dataPath();
const INTRO_DIR = dataPath('intros');
const SETTINGS_FILE = dataPath('intro-settings.json');

export const DEFAULT_INTRO_SETTINGS = {
  enabled: true,
  volume: 0.55,
  selectedIntroId: 'zzz-intro',
};

function normalizeVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_INTRO_SETTINGS.volume;
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100));
}

function normalize(input = {}) {
  return {
    enabled: input.enabled !== false,
    volume: normalizeVolume(input.volume),
    selectedIntroId: String(input.selectedIntroId || '').trim(),
  };
}

export async function ensureIntroStorage() {
  await mkdir(INTRO_DIR, { recursive: true });
}

export async function loadIntroSettings() {
  try {
    await ensureIntroStorage();
    return { ...DEFAULT_INTRO_SETTINGS, ...normalize(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULT_INTRO_SETTINGS })) };
  } catch { return { ...DEFAULT_INTRO_SETTINGS }; }
}

export async function saveIntroSettings(input) {
  const settings = normalize(input);
  await ensureIntroStorage();
  await writeJsonStore(SETTINGS_FILE, settings);
  return settings;
}

export function getIntroDir() {
  return INTRO_DIR;
}
