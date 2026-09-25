import { mkdir } from 'node:fs/promises';
import { readJsonStore, writeJsonStore } from './json-store.js';
import { dataPath } from './runtime-paths.js';

const DATA_DIR = dataPath();
const BRANDING_DIR = dataPath('branding');
const SETTINGS_FILE = dataPath('branding-settings.json');

const DEFAULTS = {
  title: 'OpenClaw Command Center',
  subtitle: 'Mission Control',
  logoUrl: '',
  faviconUrl: '',
};

function normalize(input = {}) {
  return {
    title: String(input.title || DEFAULTS.title).trim().slice(0, 80),
    subtitle: String(input.subtitle || DEFAULTS.subtitle).trim().slice(0, 140),
    logoUrl: String(input.logoUrl || '').trim(),
    faviconUrl: String(input.faviconUrl || '').trim(),
  };
}

export async function ensureBrandingStorage() { await mkdir(BRANDING_DIR, { recursive: true }); }
export function getBrandingDir() { return BRANDING_DIR; }
export async function loadBrandingSettings() {
  try {
    await ensureBrandingStorage();
    return { ...DEFAULTS, ...normalize(await readJsonStore(SETTINGS_FILE, { defaultValue: DEFAULTS })) };
  } catch { return { ...DEFAULTS }; }
}
export async function saveBrandingSettings(input) {
  const settings = normalize(input);
  await ensureBrandingStorage();
  await writeJsonStore(SETTINGS_FILE, settings);
  return settings;
}
