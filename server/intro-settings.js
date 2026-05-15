import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const INTRO_DIR = join(DATA_DIR, 'intros');
const SETTINGS_FILE = join(DATA_DIR, 'intro-settings.json');

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
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_INTRO_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_INTRO_SETTINGS, ...normalize(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_INTRO_SETTINGS };
  }
}

export async function saveIntroSettings(input) {
  const settings = normalize(input);
  await ensureIntroStorage();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function getIntroDir() {
  return INTRO_DIR;
}
