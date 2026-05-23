import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'update-settings.json');
const STATE_FILE = join(DATA_DIR, 'update-state.json');

const DEFAULT_SETTINGS = {
  autoUpdateEnabled: true,
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
    autoUpdateEnabled: input?.autoUpdateEnabled !== false,
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
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return normalizeSettings(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveUpdateSettings(input = {}) {
  await ensureDir();
  const settings = normalizeSettings(input);
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export async function loadUpdateState() {
  if (!existsSync(STATE_FILE)) return { ...DEFAULT_STATE };
  try {
    const raw = await readFile(STATE_FILE, 'utf8');
    return normalizeState(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export async function saveUpdateState(input = {}) {
  await ensureDir();
  const state = normalizeState(input);
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 });
  return state;
}

export { DEFAULT_SETTINGS, DEFAULT_STATE };
