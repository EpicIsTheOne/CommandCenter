import { mkdir } from 'node:fs/promises';
import { readJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const DATA_DIR = dataPath();
const SETTINGS_FILE = dataPath('update-settings.json');
const STATE_FILE = dataPath('update-state.json');

const DEFAULT_SETTINGS = {
  autoUpdateEnabled: false,
  checkIntervalHours: 6,
};

const DEFAULT_STATE = {
  status: 'idle',
  phase: '',
  message: '',
  lastCheckedAt: 0,
  lastUpdatedAt: 0,
  lastErrorAt: 0,
  localSha: '',
  targetSha: '',
  branch: '',
  commitsApplied: [],
  changedFiles: [],
};

async function ensureDir() {
  await mkdir(DATA_DIR, { recursive: true });
}

function normalizeSettings(input = {}) {
  const hoursRaw = Number(input?.checkIntervalHours);
  return {
    autoUpdateEnabled: input?.autoUpdateEnabled === true,
    checkIntervalHours: Number.isFinite(hoursRaw) ? Math.min(48, Math.max(1, Math.round(hoursRaw))) : DEFAULT_SETTINGS.checkIntervalHours,
  };
}

function normalizeState(input = {}) {
  return {
    status: String(input?.status || DEFAULT_STATE.status).trim() || DEFAULT_STATE.status,
    phase: String(input?.phase || DEFAULT_STATE.phase).trim(),
    message: String(input?.message || DEFAULT_STATE.message).trim(),
    lastCheckedAt: Number(input?.lastCheckedAt || 0) || 0,
    lastUpdatedAt: Number(input?.lastUpdatedAt || 0) || 0,
    lastErrorAt: Number(input?.lastErrorAt || 0) || 0,
    localSha: String(input?.localSha || '').trim(),
    targetSha: String(input?.targetSha || '').trim(),
    branch: String(input?.branch || '').trim(),
    commitsApplied: Array.isArray(input?.commitsApplied) ? input.commitsApplied.slice(0, 20) : [],
    changedFiles: Array.isArray(input?.changedFiles) ? input.changedFiles.slice(0, 100) : [],
  };
}

export async function loadUpdateSettings() {
  try { return normalizeSettings(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULT_SETTINGS })); }
  catch { return { ...DEFAULT_SETTINGS }; }
}

export async function saveUpdateSettings(input = {}) {
  await ensureDir();
  const settings = normalizeSettings(input);
  await writeJsonStore(SETTINGS_FILE, settings);
  return settings;
}

export async function loadUpdateState() {
  try { return normalizeState(await readJsonStore(STATE_FILE, { defaultValue: DEFAULT_STATE })); }
  catch { return { ...DEFAULT_STATE }; }
}

export async function saveUpdateState(input = {}) {
  await ensureDir();
  const state = normalizeState(input);
  await writeJsonStore(STATE_FILE, state);
  return state;
}

export { DEFAULT_SETTINGS, DEFAULT_STATE };
