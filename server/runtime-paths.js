import 'dotenv/config';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const MODULE_ROOT = dirname(fileURLToPath(import.meta.url));
const configuredProjectRoot = String(process.env.COMMANDCENTER_ROOT || '').trim();
export const PROJECT_ROOT = resolve(configuredProjectRoot || dirname(MODULE_ROOT));
export const USER_HOME = String(process.env.USERPROFILE || process.env.HOME || homedir()).trim();

const configuredDataDir = String(process.env.COMMANDCENTER_DATA_DIR || '').trim();
export const DATA_DIR = resolve(PROJECT_ROOT, configuredDataDir || 'data');

export function dataPath(...segments) {
  return join(DATA_DIR, ...segments);
}

export function projectPath(...segments) {
  return join(PROJECT_ROOT, ...segments);
}
