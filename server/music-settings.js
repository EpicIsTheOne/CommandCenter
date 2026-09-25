import { mkdir } from 'node:fs/promises';
import { readJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const DATA_DIR = dataPath();
const MUSIC_DIR = dataPath('music');
const SETTINGS_FILE = dataPath('music-settings.json');

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
    return { ...DEFAULT_MUSIC_SETTINGS, ...normalize(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULT_MUSIC_SETTINGS })) };
  } catch { return { ...DEFAULT_MUSIC_SETTINGS }; }
}

export async function saveMusicSettings(input) {
  const settings = normalize(input);
  await ensureMusicStorage();
  await writeJsonStore(SETTINGS_FILE, settings);
  return settings;
}

export function getMusicDir() {
  return MUSIC_DIR;
}
