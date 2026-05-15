import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const BRANDING_DIR = join(DATA_DIR, 'branding');
const SETTINGS_FILE = join(DATA_DIR, 'branding-settings.json');

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
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULTS };
    return { ...DEFAULTS, ...normalize(JSON.parse(await readFile(SETTINGS_FILE, 'utf8'))) };
  } catch {
    return { ...DEFAULTS };
  }
}
export async function saveBrandingSettings(input) {
  const settings = normalize(input);
  await ensureBrandingStorage();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}
