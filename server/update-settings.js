import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonStore, writeJsonStore } from './json-store.js';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'update-settings.json');
const STATE_FILE = join(DATA_DIR, 'update-state.json');

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
  if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
  try {
    return normalizeSettings(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULT_SETTINGS }));
  } catch (err) {
    console.error('[update] Settings store error:', err.message);
    throw err;
  }
}

export async function saveUpdateSettings(input = {}) {
  const settings = normalizeSettings(input);
  await writeJsonStore(SETTINGS_FILE, settings, { mode: 0o600 });
  return settings;
}

export async function loadUpdateState() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    return normalizeState(await readJsonStore(STATE_FILE, { defaultValue: DEFAULT_STATE }));
  } catch (err) {
    console.error('[update] State store error:', err.message);
    throw err;
  }
}

export async function saveUpdateState(input = {}) {
  const state = normalizeState(input);
  await writeJsonStore(STATE_FILE, state, { mode: 0o600 });
  return state;
}

export { DEFAULT_SETTINGS, DEFAULT_STATE };
