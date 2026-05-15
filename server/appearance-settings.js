import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const APPEARANCE_DIR = join(DATA_DIR, 'appearance');
const BACKGROUND_DIR = join(APPEARANCE_DIR, 'backgrounds');
const SETTINGS_FILE = join(DATA_DIR, 'appearance-settings.json');

export const DEFAULT_THEME_ID = 'default-ember';
export const DEFAULT_WORKSPACE_ID = 'default-office';

export const BUILT_IN_THEMES = [
  {
    id: 'default-ember',
    name: 'Default Ember',
    builtIn: true,
    colors: {
      bgPrimary: '#0D1016', bgMascot: '#03050A', bgTerminal: '#03050A', bgOffice: '#05070D',
      borderColor: '#2D241C', textPrimary: '#D1C7B7', textDim: '#7A7267', green: '#88CC66',
      greenDim: '#558844', red: '#D25E5E', cyan: '#66B2CC', yellow: '#D1A550', purple: '#9A7ACC',
      amber: '#CC9933', amberGlow: 'rgba(204, 153, 51, 0.4)', glowIdle: '#66B2CC', glowListening: '#88CC66',
      glowThinking: '#D1A550', glowWorking: '#9A7ACC', glowHappy: '#88CC66', glowError: '#D25E5E',
      glowSleeping: '#4A5166', paneBg: 'rgba(20, 24, 32, 0.85)',
    },
  },
  {
    id: 'neon-noir',
    name: 'Neon Noir',
    builtIn: true,
    colors: {
      bgPrimary: '#090B14', bgMascot: '#050712', bgTerminal: '#050712', bgOffice: '#080B18',
      borderColor: '#2A1E4A', textPrimary: '#DDE6FF', textDim: '#7C83B6', green: '#57FF9A',
      greenDim: '#1DBB69', red: '#FF5E87', cyan: '#4DE6FF', yellow: '#FFCF5A', purple: '#B07BFF',
      amber: '#FF8A3D', amberGlow: 'rgba(255, 138, 61, 0.4)', glowIdle: '#4DE6FF', glowListening: '#57FF9A',
      glowThinking: '#FFCF5A', glowWorking: '#B07BFF', glowHappy: '#57FF9A', glowError: '#FF5E87',
      glowSleeping: '#49537A', paneBg: 'rgba(13, 16, 33, 0.82)',
    },
  },
  {
    id: 'forest-terminal',
    name: 'Forest Terminal',
    builtIn: true,
    colors: {
      bgPrimary: '#0B120F', bgMascot: '#07100C', bgTerminal: '#07100C', bgOffice: '#0B1510',
      borderColor: '#2B3A2B', textPrimary: '#D8E6D1', textDim: '#78907A', green: '#8EEA7A',
      greenDim: '#4C9E48', red: '#D76C6C', cyan: '#7CD7C2', yellow: '#C7D66B', purple: '#8E88D8',
      amber: '#B79A48', amberGlow: 'rgba(183, 154, 72, 0.35)', glowIdle: '#7CD7C2', glowListening: '#8EEA7A',
      glowThinking: '#C7D66B', glowWorking: '#8E88D8', glowHappy: '#8EEA7A', glowError: '#D76C6C',
      glowSleeping: '#4B5A50', paneBg: 'rgba(12, 21, 16, 0.84)',
    },
  },
];

const DEFAULT_SETTINGS = {
  workspaceBackgroundId: DEFAULT_WORKSPACE_ID,
  themeId: DEFAULT_THEME_ID,
  customThemes: [],
  panelOpacity: 0.85,
  blurStrength: 12,
  glowIntensity: 1,
  uiDensity: 'normal',
  borderStyle: 'sharp',
  fontPreset: 'modern',
};

function normalizeHex(value = '', fallback = '#000000') {
  const text = String(value || '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text : fallback;
}

function normalizeRgba(value = '', fallback = 'rgba(255, 255, 255, 0.1)') {
  const text = String(value || '').trim();
  return /^rgba?\(/i.test(text) ? text : fallback;
}

function normalizeTheme(theme = {}, index = 0) {
  const fallback = BUILT_IN_THEMES[0].colors;
  return {
    id: String(theme.id || `custom-theme-${index + 1}`).trim(),
    name: String(theme.name || `Custom Theme ${index + 1}`).trim(),
    builtIn: false,
    colors: {
      bgPrimary: normalizeHex(theme.colors?.bgPrimary, fallback.bgPrimary),
      bgMascot: normalizeHex(theme.colors?.bgMascot, fallback.bgMascot),
      bgTerminal: normalizeHex(theme.colors?.bgTerminal, fallback.bgTerminal),
      bgOffice: normalizeHex(theme.colors?.bgOffice, fallback.bgOffice),
      borderColor: normalizeHex(theme.colors?.borderColor, fallback.borderColor),
      textPrimary: normalizeHex(theme.colors?.textPrimary, fallback.textPrimary),
      textDim: normalizeHex(theme.colors?.textDim, fallback.textDim),
      green: normalizeHex(theme.colors?.green, fallback.green),
      greenDim: normalizeHex(theme.colors?.greenDim, fallback.greenDim),
      red: normalizeHex(theme.colors?.red, fallback.red),
      cyan: normalizeHex(theme.colors?.cyan, fallback.cyan),
      yellow: normalizeHex(theme.colors?.yellow, fallback.yellow),
      purple: normalizeHex(theme.colors?.purple, fallback.purple),
      amber: normalizeHex(theme.colors?.amber, fallback.amber),
      amberGlow: normalizeRgba(theme.colors?.amberGlow, fallback.amberGlow),
      glowIdle: normalizeHex(theme.colors?.glowIdle, fallback.glowIdle),
      glowListening: normalizeHex(theme.colors?.glowListening, fallback.glowListening),
      glowThinking: normalizeHex(theme.colors?.glowThinking, fallback.glowThinking),
      glowWorking: normalizeHex(theme.colors?.glowWorking, fallback.glowWorking),
      glowHappy: normalizeHex(theme.colors?.glowHappy, fallback.glowHappy),
      glowError: normalizeHex(theme.colors?.glowError, fallback.glowError),
      glowSleeping: normalizeHex(theme.colors?.glowSleeping, fallback.glowSleeping),
      paneBg: normalizeRgba(theme.colors?.paneBg, fallback.paneBg),
    },
  };
}

function clamp(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

function pick(value, allowed, fallback) {
  const text = String(value || '').trim();
  return allowed.includes(text) ? text : fallback;
}

function normalize(input = {}) {
  return {
    workspaceBackgroundId: String(input.workspaceBackgroundId || DEFAULT_SETTINGS.workspaceBackgroundId).trim(),
    themeId: String(input.themeId || DEFAULT_SETTINGS.themeId).trim(),
    customThemes: Array.isArray(input.customThemes) ? input.customThemes.map(normalizeTheme) : [],
    panelOpacity: clamp(input.panelOpacity, 0.3, 1, DEFAULT_SETTINGS.panelOpacity),
    blurStrength: clamp(input.blurStrength, 0, 24, DEFAULT_SETTINGS.blurStrength),
    glowIntensity: clamp(input.glowIntensity, 0, 2, DEFAULT_SETTINGS.glowIntensity),
    uiDensity: pick(input.uiDensity, ['compact', 'normal', 'spacious'], DEFAULT_SETTINGS.uiDensity),
    borderStyle: pick(input.borderStyle, ['sharp', 'rounded'], DEFAULT_SETTINGS.borderStyle),
    fontPreset: pick(input.fontPreset, ['terminal', 'modern', 'pixel', 'clean'], DEFAULT_SETTINGS.fontPreset),
  };
}

export async function ensureAppearanceStorage() {
  await mkdir(BACKGROUND_DIR, { recursive: true });
}

export async function loadAppearanceSettings() {
  try {
    await ensureAppearanceStorage();
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...normalize(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveAppearanceSettings(input) {
  const settings = normalize(input);
  await ensureAppearanceStorage();
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function getAppearanceBackgroundDir() {
  return BACKGROUND_DIR;
}
