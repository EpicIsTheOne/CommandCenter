import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile, copyFile } from 'node:fs/promises';
import { dirname, basename, join, extname } from 'node:path';

const DATA_DIR = join(process.cwd(), 'data', 'companions');
const COMPANIONS_DIR = join(DATA_DIR, 'library');
const IMPORTS_DIR = join(DATA_DIR, 'imports');
const REGISTRY_FILE = join(DATA_DIR, 'registry.json');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

const BUILT_IN_COMPANIONS = [
  // Generic placeholder pets were removed; the default roster is the curated
  // Codex pet set shipped in data/companions/imports/ and listed in
  // data/companions/registry.json (Anby, Jane-Doe, Jin-Woo, Makima, Miyabi,
  // Vivian, Xueying). Edit registry.json to customize the default companions.
];

const DEFAULT_SETTINGS = {
  agentVisuals: {},
};

function slugify(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'imported-pet';
}

function normalizeMode(mode = '') {
  return String(mode) === 'companion' ? 'companion' : 'default';
}

function normalizeScale(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 1;
  return Math.min(2.5, Math.max(0.5, Math.round(num * 100) / 100));
}

function hashPaletteSeed(value = '') {
  let hash = 0;
  for (const ch of String(value || 'pet')) hash = ((hash << 5) - hash) + ch.charCodeAt(0);
  return Math.abs(hash || 1);
}

function colorFromSeed(seed, sat = 72, light = 62) {
  return `hsl(${Math.abs(seed) % 360} ${sat}% ${light}%)`;
}

function detectCodexFrameCount(state = '', columns = 8, fallback = 1) {
  const explicit = petFrameCountFallbacks[state];
  return Math.max(1, Math.min(columns, Number(explicit || fallback || 1) || 1));
}

const petFrameCountFallbacks = {
  idle: 4,
  waiting: 4,
  thinking: 4,
  review: 4,
  tool: 6,
  responding: 6,
  waving: 6,
  jumping: 6,
  failed: 4,
  runningRight: 8,
  runningLeft: 8,
  walkingRight: 8,
  walkingLeft: 8,
  walkUp: 8,
  walkDown: 8,
  error: 4,
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueRows(rows = []) {
  const out = [];
  const seen = new Set();
  for (const raw of rows) {
    const row = Number(raw);
    if (!Number.isFinite(row) || row < 0 || seen.has(row)) continue;
    seen.add(row);
    out.push(row);
  }
  return out;
}

function inferCodexAnimationMap(pet = {}) {
  const manifestMap = pet.animations && typeof pet.animations === 'object' ? pet.animations : {};
  const alias = (...keys) => {
    const rows = [];
    for (const key of keys) {
      const value = manifestMap[key] ?? pet[key];
      if (value == null) continue;
      if (Array.isArray(value)) rows.push(...value);
      else rows.push(value);
    }
    return uniqueRows(rows);
  };

  const map = {
    idle: alias('idle', 'idleRow') || [0],
    thinking: alias('thinking', 'waiting', 'thinkingRow', 'waitingRow'),
    responding: alias('responding', 'tool', 'respondingRow', 'toolRow'),
    tool: alias('tool', 'responding', 'toolRow', 'respondingRow'),
    error: alias('error', 'failed', 'errorRow', 'failedRow'),
    waiting: alias('waiting', 'thinking', 'waitingRow', 'thinkingRow'),
    review: alias('review', 'reviewRow'),
    waving: alias('waving', 'wave', 'wavingRow', 'waveRow'),
    jumping: alias('jumping', 'jump', 'jumpingRow', 'jumpRow'),
    failed: alias('failed', 'error', 'failedRow', 'errorRow'),
    runningRight: alias('runningRight', 'runRight', 'walkRight', 'runningRow', 'runningRightRow', 'runRightRow', 'walkRightRow'),
    runningLeft: alias('runningLeft', 'runLeft', 'walkLeft', 'runningLeftRow', 'runLeftRow', 'walkLeftRow'),
    walkingRight: alias('walkingRight', 'walkRight', 'runningRight', 'walkRightRow', 'runningRightRow'),
    walkingLeft: alias('walkingLeft', 'walkLeft', 'runningLeft', 'walkLeftRow', 'runningLeftRow'),
    walkUp: alias('walkUp', 'up', 'walkUpRow', 'upRow'),
    walkDown: alias('walkDown', 'down', 'walkDownRow', 'downRow'),
  };

  if (!map.idle.length) map.idle = [0];
  if (!map.thinking.length) map.thinking = [6];
  if (!map.responding.length) map.responding = [3];
  if (!map.tool.length) map.tool = [7];
  if (!map.error.length) map.error = [5];
  if (!map.waiting.length) map.waiting = map.thinking.slice();
  if (!map.review.length) map.review = [8];
  if (!map.waving.length) map.waving = map.responding.slice();
  if (!map.jumping.length) map.jumping = [4];
  if (!map.failed.length) map.failed = map.error.slice();
  if (!map.runningRight.length) map.runningRight = [1];
  if (!map.runningLeft.length) map.runningLeft = [2];
  if (!map.walkingRight.length) map.walkingRight = map.runningRight.slice();
  if (!map.walkingLeft.length) map.walkingLeft = map.runningLeft.slice();
  if (!map.walkUp.length) map.walkUp = map.runningRight.slice();
  if (!map.walkDown.length) map.walkDown = map.runningRight.slice();

  const frameCounts = {};
  const manifestCounts = pet.frameCounts && typeof pet.frameCounts === 'object' ? pet.frameCounts : {};
  for (const [key, value] of Object.entries(manifestCounts)) {
    const count = Number(value);
    if (Number.isFinite(count) && count > 0) frameCounts[key] = Math.floor(count);
  }
  for (const key of Object.keys(petFrameCountFallbacks)) {
    if (!frameCounts[key]) frameCounts[key] = detectCodexFrameCount(key, Number(pet.columns || pet.cols || 8) || 8, petFrameCountFallbacks[key]);
  }
  map.frameCounts = frameCounts;
  return map;
}

function normalizeImportedSpritePath(value = '') {
  const raw = String(value || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return raw.replace(/^\/+/, '');
}

function getDeclaredSpriteRelativePath(pet = {}) {
  return normalizeImportedSpritePath(
    pet.spritesheetPath
    || pet.spriteSheetPath
    || pet.spritesheet
    || pet.spriteSheet
    || pet.image
    || 'spritesheet.webp'
  );
}

async function resolveSpriteFileForDir(dir, pet = {}) {
  const declared = getDeclaredSpriteRelativePath(pet);
  const declaredPath = join(dir, declared);
  if (existsSync(declaredPath)) {
    return { absolutePath: declaredPath, relativePath: declared };
  }
  const fallbackNames = ['spritesheet.webp', 'spritesheet.png', 'spritesheet.gif', 'spritesheet.jpg', 'spritesheet.jpeg'];
  for (const name of fallbackNames) {
    const absolutePath = join(dir, name);
    if (existsSync(absolutePath)) return { absolutePath, relativePath: name };
  }
  throw new Error(`Spritesheet not found in import directory (looked for ${declared})`);
}

async function resolveCodexImportRoot(sourceDir = '') {
  const dir = String(sourceDir || '').trim();
  if (!dir) throw new Error('sourceDir is required');
  const directPetPath = join(dir, 'pet.json');
  if (existsSync(directPetPath)) return dir;

  let entries = [];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new Error('Import directory not found');
  }
  const childDirs = entries.filter((entry) => entry.isDirectory());
  if (childDirs.length === 1) {
    const nestedDir = join(dir, childDirs[0].name);
    if (existsSync(join(nestedDir, 'pet.json'))) return nestedDir;
  }
  throw new Error('pet.json not found in import directory');
}

function convertImportedPetManifest(pet = {}, publicBase = '', spriteRelativePath = 'spritesheet.webp') {
  const slug = slugify(pet.id || pet.displayName || pet.name || 'imported-pet');
  const prefix = `${String(publicBase || '').replace(/\/+$/, '')}/api/companions/imports/${slug}`;
  const seed = hashPaletteSeed(slug);
  const columns = Number(pet.columns || pet.cols || 8) || 8;
  const rows = Number(pet.rows || 9) || 9;
  const spriteWidth = Number(pet.spriteWidth || pet.width || 1536) || 1536;
  const spriteHeight = Number(pet.spriteHeight || pet.height || 1872) || 1872;
  const animationMap = inferCodexAnimationMap(pet);
  const safeSpritePath = normalizeImportedSpritePath(spriteRelativePath || getDeclaredSpriteRelativePath(pet) || 'spritesheet.webp');
  return {
    id: `codex-${slug}`,
    name: String(pet.displayName || pet.name || pet.id || 'Imported Codex Pet').trim(),
    preview: '',
    palette: {
      primary: colorFromSeed(seed, 68, 66),
      secondary: colorFromSeed(seed + 57, 35, 18),
      accent: colorFromSeed(seed + 119, 88, 70),
    },
    states: ['idle', 'thinking', 'responding', 'tool', 'error'],
    animationStyle: 'codex-import',
    sourceType: 'codex-import',
    importedPet: {
      id: String(pet.id || slug),
      displayName: String(pet.displayName || pet.name || pet.id || 'Imported Codex Pet').trim(),
      description: String(pet.description || '').trim(),
      kind: String(pet.kind || 'creature').trim(),
      spritesheetPath: safeSpritePath,
      spritesheetUrl: `${prefix}/${safeSpritePath.split('/').map(encodeURIComponent).join('/')}`,
      manifestUrl: `${prefix}/pet.json`,
      rows,
      columns,
      spriteWidth,
      spriteHeight,
      frameWidth: Math.floor(spriteWidth / columns),
      frameHeight: Math.floor(spriteHeight / rows),
      animationMap,
      frameCounts: animationMap.frameCounts || {},
    },
  };
}

function sanitizeJsonText(raw = '') {
  return String(raw || '')
    .replace(/^\uFEFF/, '')
    .replace(/^\u0000+/, '')
    .trim();
}

function parsePetJson(raw = '', sourceLabel = 'pet.json') {
  const cleaned = sanitizeJsonText(raw);
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    const codes = Array.from(cleaned.slice(0, 8)).map((ch) => ch.charCodeAt(0));
    throw new Error(`Invalid ${sourceLabel}: ${err.message} (leading char codes: ${codes.join(', ')})`);
  }
}

async function loadImportedCompanions(publicBase = '') {
  if (!existsSync(IMPORTS_DIR)) return [];
  const dirs = await readdir(IMPORTS_DIR, { withFileTypes: true });
  const items = [];
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const petPath = join(IMPORTS_DIR, dir.name, 'pet.json');
    if (!existsSync(petPath)) continue;
    try {
      const pet = parsePetJson(await readFile(petPath, 'utf8'), petPath);
      const sprite = await resolveSpriteFileForDir(join(IMPORTS_DIR, dir.name), pet);
      items.push(convertImportedPetManifest(pet, publicBase, sprite.relativePath));
    } catch {}
  }
  return items;
}

export async function loadCompanionSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...normalizeSettings(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function normalizeSettings(input = {}) {
  const agentVisuals = {};
  for (const [agentId, config] of Object.entries(input?.agentVisuals || {})) {
    agentVisuals[String(agentId)] = {
      mode: normalizeMode(config?.mode),
      companionId: String(config?.companionId || '').trim(),
      scale: normalizeScale(config?.scale),
    };
  }
  return { agentVisuals };
}

export async function saveCompanionSettings(input = {}) {
  const settings = normalizeSettings(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export async function loadCompanionRegistry(publicBase = '') {
  let stored = [];
  try {
    if (existsSync(REGISTRY_FILE)) {
      const raw = await readFile(REGISTRY_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      stored = Array.isArray(parsed?.items) ? parsed.items : [];
    }
  } catch {}
  const imported = await loadImportedCompanions(publicBase);
  const merged = [...BUILT_IN_COMPANIONS, ...stored.filter((item) => item?.id && !BUILT_IN_COMPANIONS.find((builtIn) => builtIn.id === item.id)), ...imported];
  const deduped = [];
  const seen = new Set();
  for (const item of merged) {
    if (!item?.id || seen.has(item.id)) continue;
    seen.add(item.id);
    deduped.push(item);
  }
  return deduped;
}

export async function ensureCompanionRegistry() {
  await mkdir(COMPANIONS_DIR, { recursive: true });
  await mkdir(IMPORTS_DIR, { recursive: true });
  if (existsSync(REGISTRY_FILE)) return;
  await writeFile(REGISTRY_FILE, JSON.stringify({ items: BUILT_IN_COMPANIONS }, null, 2) + '\n');
}

export async function importCodexPetPackageFromDir(sourceDir = '', publicBase = '') {
  const dir = await resolveCodexImportRoot(sourceDir);
  const petPath = join(dir, 'pet.json');

  const pet = parsePetJson(await readFile(petPath, 'utf8'), petPath);
  const sprite = await resolveSpriteFileForDir(dir, pet);
  const slug = slugify(pet.id || pet.displayName || pet.name || basename(dir));
  const destDir = join(IMPORTS_DIR, slug);
  await mkdir(join(destDir, dirname(sprite.relativePath)), { recursive: true });
  await copyFile(petPath, join(destDir, 'pet.json'));
  await copyFile(sprite.absolutePath, join(destDir, sprite.relativePath));

  const converted = convertImportedPetManifest(pet, publicBase, sprite.relativePath);
  return { item: converted, path: destDir };
}

export function resolveAgentVisual(agentId = '', settings = {}, registry = []) {
  const config = settings?.agentVisuals?.[String(agentId)] || { mode: 'default', companionId: '' };
  const mode = normalizeMode(config.mode);
  const companionId = String(config.companionId || '').trim();
  const companion = registry.find((item) => String(item.id) === companionId) || null;
  const scale = normalizeScale(config.scale);
  if (mode !== 'companion' || !companion) {
    return { agentId: String(agentId), mode: 'default', companionId: '', scale, companion: null };
  }
  return { agentId: String(agentId), mode: 'companion', companionId, scale, companion };
}
