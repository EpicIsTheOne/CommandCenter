import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { readJsonStore, writeJsonStore } from './json-store.js';

const ROOT = process.cwd();
const DATA_DIR = String(process.env.COMMANDCENTER_DATA_DIR || '').trim() || join(ROOT, 'data');
const AUTH_FILE = join(DATA_DIR, 'ui-auth.json');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 days

const sessions = new Map();

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
  try {
    const parsed = await readJsonStore(AUTH_FILE, { defaultValue: { passwordHash: '' } });
    return {
      passwordHash: String(parsed.passwordHash || ''),
      enabled: !!parsed.passwordHash,
    };
  } catch (err) {
    console.error('[auth] Could not load UI auth configuration:', err.message);
    throw err;
  }
}

export async function setUiPassword(password) {
  const passwordHash = hashPassword(password);
  await writeJsonStore(AUTH_FILE, { passwordHash }, { mode: 0o600, backup: true });
  revokeAllSessions();
  return { enabled: true };
}

export function createSessionToken() {
  return randomBytes(32).toString('hex');
}

export function createSession(token) {
  sessions.set(token, Date.now() + SESSION_TTL_MS);
}

export function isValidSession(token) {
  const exp = sessions.get(String(token || ''));
  if (!exp) return false;
  if (Date.now() > exp) {
    sessions.delete(String(token || ''));
    return false;
  }
  return true;
}

export function revokeSession(token) {
  sessions.delete(String(token || ''));
}

export function revokeAllSessions() {
  sessions.clear();
}

export function pruneExpiredSessions(now = Date.now()) {
  let pruned = 0;
  for (const [token, expiresAt] of sessions) {
    if (now > expiresAt) {
      sessions.delete(token);
      pruned += 1;
    }
  }
  return pruned;
}

const pruneTimer = setInterval(() => pruneExpiredSessions(), 15 * 60_000);
pruneTimer.unref?.();

export function checkPassword(password, passwordHash) {
  return verifyPassword(password, passwordHash);
}
