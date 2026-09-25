import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import config from './config.js';
import { readJsonStore, updateJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const AUTH_FILE = dataPath('ui-auth.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_SESSIONS = 1000;
const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/i;

function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored = '') {
  const [salt, hex] = String(stored || '').split(':');
  if (!salt || !hex) return false;
  const test = scryptSync(String(password), salt, 64);
  const target = Buffer.from(hex, 'hex');
  return target.length === test.length && timingSafeEqual(target, test);
}

export async function loadUiAuthConfig() {
  const parsed = await readJsonStore(AUTH_FILE, {
    defaultValue: { version: 1, passwordHash: '' },
  });
  const passwordHash = String(parsed?.passwordHash || '');
  return {
    passwordHash,
    enabled: !!passwordHash,
  };
}

export async function setUiPassword(password, { onlyIfUnset = false } = {}) {
  const passwordHash = hashPassword(password);
  if (onlyIfUnset) {
    await updateJsonStore(AUTH_FILE, { defaultValue: { version: 1, passwordHash: '' } }, async (current) => {
      if (String(current?.passwordHash || '')) {
        const error = new Error('Password already set');
        error.code = 'PASSWORD_ALREADY_SET';
        throw error;
      }
      return { version: 1, passwordHash };
    });
  } else {
    await writeJsonStore(AUTH_FILE, {
      version: 1,
      passwordHash,
    });
  }
  await writeJsonStore(dataPath('ui-sessions.json'), { version: 1, sessions: {} });
  return { enabled: true };
}

export async function createSession({ allowUnconfigured = false } = {}) {
  const auth = await loadUiAuthConfig();
  if (!auth.enabled && (!allowUnconfigured || !config.relayOnlyMode)) throw new Error('UI authentication is not configured.');
  const token = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  await updateJsonStore(dataPath('ui-sessions.json'), { defaultValue: { version: 1, sessions: {} } }, async (store) => {
    const sessions = await readSessions();
    sessions[token] = expiresAt;
    return { version: 1, sessions: pruneSessionEntries(sessions) };
  });
  return { token, expiresAt };
}

export async function isValidSession(token) {
  const candidate = String(token || '');
  if (!SESSION_TOKEN_PATTERN.test(candidate)) return false;
  const auth = await loadUiAuthConfig();
  if (!auth.enabled && !config.relayOnlyMode) return false;
  const sessions = await readSessions();
  return !!sessions[candidate];
}

export async function revokeSession(token) {
  await updateJsonStore(dataPath('ui-sessions.json'), { defaultValue: { version: 1, sessions: {} } }, async () => {
    const sessions = await readSessions();
    delete sessions[String(token || '')];
    return { version: 1, sessions };
  });
}

export function checkPassword(password, passwordHash) {
  return verifyPassword(password, passwordHash);
}

async function readSessions() {
  const store = await readJsonStore(dataPath('ui-sessions.json'), { defaultValue: { version: 1, sessions: {} } });
  const now = Date.now();
  return pruneSessionEntries(store?.sessions || {}, now);
}

function pruneSessionEntries(sessions, now = Date.now()) {
  return Object.fromEntries(Object.entries(sessions || {})
    .map(([token, expiresAt]) => [token, Number(expiresAt || 0)])
    .filter(([, expiresAt]) => expiresAt > now)
    .slice(-MAX_SESSIONS));
}
