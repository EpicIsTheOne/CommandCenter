import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
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
    if (!existsSync(AUTH_FILE)) return { passwordHash: '', enabled: false };
    const raw = await readFile(AUTH_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      passwordHash: String(parsed.passwordHash || ''),
      enabled: !!parsed.passwordHash,
    };
  } catch {
    return { passwordHash: '', enabled: false };
  }
}

export async function setUiPassword(password) {
  const passwordHash = hashPassword(password);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(AUTH_FILE, JSON.stringify({ passwordHash }, null, 2) + '\n', { mode: 0o600 });
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

export function checkPassword(password, passwordHash) {
  return verifyPassword(password, passwordHash);
}
