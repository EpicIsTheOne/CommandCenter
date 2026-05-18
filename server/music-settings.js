import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const MUSIC_DIR = join(DATA_DIR, 'music');
const SETTINGS_FILE = join(DATA_DIR, 'music-settings.json');

export const DEFAULT_MUSIC_SETTINGS = {
  enabled: false,
  volume: 0.45,
  speechDuckLevel: 0.35,
  fairyCallDuckLevel: 0.22,
  playbackScope: 'tab',
  selectedTrackId: '',
};

function normalizeVolume(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_MUSIC_SETTINGS.volume;
  return Math.min(1, Math.max(0, Math.round(num * 100) / 100));
}

function normalizeScope(value = '') {
  return String(value || '').trim().toLowerCase() === 'always' ? 'always' : 'tab';
}

function normalize(input = {}) {
  return {
    enabled: input.enabled === true,
    volume: normalizeVolume(input.volume),
    speechDuckLevel: normalizeVolume(input.speechDuckLevel ?? DEFAULT_MUSIC_SETTINGS.speechDuckLevel),
    fairyCallDuckLevel: normalizeVolume(input.fairyCallDuckLevel ?? DEFAULT_MUSIC_SETTINGS.fairyCallDuckLevel),
    playbackScope: normalizeScope(input.playbackScope),
    selectedTrackId: String(input.selectedTrackId || '').trim(),
  };
}

export async function ensureMusicStorage() {
  await mkdir(MUSIC_DIR, { recursive: true });
}

export async function loadMusicSettings() {
  try {
    await ensureMusicStorage();
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_MUSIC_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_MUSIC_SETTINGS, ...normalize(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_MUSIC_SETTINGS };
  }
}

export async function saveMusicSettings(input) {
  const settings = normalize(input);
  await ensureMusicStorage();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function getMusicDir() {
  return MUSIC_DIR;
}
