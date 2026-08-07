import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import multer from 'multer';
import config from './config.js';
import OpenClawBridge from './openclaw-bridge.js';
import { transcribe, speak, streamSpeak, streamFishAudioText, listElevenLabsVoices, searchFishAudioVoices, previewFishAudioVoice, resolveAgentVoice } from './voice.js';
import { loadAgentRoster, searchAgents, detectAgentSources } from './agents.js';
import { loadVoiceSettings, saveVoiceSettings, maskApiKey, maskSessionCookie } from './settings.js';
import { ensureCompanionRegistry, importCodexPetPackageFromDir, loadCompanionRegistry, loadCompanionSettings, resolveAgentVisual, saveCompanionSettings } from './companions.js';
import { ensureMusicStorage, getMusicDir, loadMusicSettings, saveMusicSettings } from './music-settings.js';
import { ensureIntroStorage, getIntroDir, loadIntroSettings, saveIntroSettings } from './intro-settings.js';
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, DEFAULT_WORKSPACE_ID, ensureAppearanceStorage, getAppearanceBackgroundDir, loadAppearanceSettings, saveAppearanceSettings } from './appearance-settings.js';
import { ensureBrandingStorage, getBrandingDir, loadBrandingSettings, saveBrandingSettings } from './branding-settings.js';
import { ALLOWED_WIDGET_IDS, loadLayoutSettings, saveLayoutSettings } from './layout-settings.js';
import { loadWorkspaceRooms, saveWorkspaceRooms } from './workspace-rooms.js';
import { loadWakeSettings, saveWakeSettings, maskAccessKey } from './wake-settings.js';
import { transcribeWakeAudio, warmWakeTranscriber } from './wake-transcriber.js';
import { detectWakeKeyword, warmWakeKeywordDetector } from './wake-keyword-detector.js';
import { startSessionMonitor } from './session-monitor.js';
import { startHermesSessionMonitor } from './hermes-session-monitor.js';
import { FAIRY_CALL_MODE_OPTIONS, GEMINI_LIVE_VOICE_OPTIONS, loadGeminiRuntimeConfig, loadGeminiSettings, saveGeminiSettings, normalizeCallMode } from './gemini-config.js';
import { createLiveTask, getLiveTask, listLiveTasks, looksComplexRequest, pruneLiveTasks, runLiveTask } from './live-tasks.js';
import { createCallSession, endCallSession, getCallSession, listCallSessions, updateCallSession } from './call-session-store.js';
import { cleanupFairyRecordingIndex, getFairyRecording, getFairyRecordingPath, listFairyRecordings, saveFairyRecording } from './fairy-recordings.js';
import { GeminiLiveSession, FAIRY_LIVE_VOICE_NAME, buildFairyLiveSystemPrompt } from './gemini-live.js';
import { addFairyMemoryEntry, buildFairyMemoryContext, loadFairyMemory, removeFairyMemoryEntry, selectRelevantFairyMemory, updateFairyMemoryEntry } from './fairy-memory.js';
import { requireApiAuth } from './api-auth.js';
import { registerGracefulShutdown } from './shutdown.js';
import { createAuthRouter } from './routes/auth.js';
import { runApiChatTurn } from './api-chat-runner.js';
import relayAgentSource from './relay-agent-source.js';
import { runRoleplayChatTurn } from './roleplay-chat-runner.js';
import { appendApiSessionMessage, createApiSession, getApiSession, getApiSessionMeta, listApiSessions, saveApiSession, searchApiSessions } from './api-session-store.js';
import { loadUiAuthConfig, setUiPassword, checkPassword, createSessionToken, createSession, isValidSession, revokeSession } from './ui-auth.js';
import { loadUpdateSettings, saveUpdateSettings } from './update-settings.js';
import { loadDirectChatSettings, publicDirectChatSettings, saveDirectChatSettings } from './direct-chat-settings.js';
import { applyUpdate, finalizePostRestartUpdateState, getUpdatePayload, startAutoUpdateScheduler } from './updater.js';
import { buildAttachmentBundle } from './attachment-bundle.js';
import { authorizeWebSocketRequest, createRateLimiter, isVerifiedLoopback, securityHeaders, validReikaEmbedToken } from './request-security.js';
import { getPlatformCapabilities } from './platform-capabilities.js';
import { readJsonStore, updateJsonStore, writeJsonStore } from './json-store.js';
import { parseCookies } from './cookie-helpers.js';
import { enforceUploadBudget, uploadedFiles } from './upload-policy.js';

function apiAttachmentPayload(files = []) {
  return files.map((file) => ({
    id: String(file.id || ''),
    kind: file.kind === 'link' ? 'link' : 'file',
    name: String(file.name || file.originalName || 'file'),
    originalName: String(file.originalName || file.name || 'file'),
    mimeType: String(file.mimeType || 'application/octet-stream'),
    sourceUrl: String(file.sourceUrl || ''),
    downloadUrl: String(file.downloadUrl || ''),
    path: String(file.path || ''),
    notes: String(file.notes || ''),
  }));
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const getRoster = () => loadAgentRoster();
const roster = getRoster();
const basePath = config.basePath || '';

const certPath = join(__dirname, 'cert.pem');
const keyPath = join(__dirname, 'key.pem');
const useHttps = existsSync(certPath) && existsSync(keyPath);
let server;
let localApiServer = null;
if (useHttps) {
  const tlsOptions = {
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  };
  server = createHttpsServer(tlsOptions, app);
  if (config.localApiEnabled) localApiServer = createHttpsServer(tlsOptions, app);
} else {
  server = createHttpServer(app);
  if (config.localApiEnabled) localApiServer = createHttpServer(app);
}
const commandCenterDataDir = String(process.env.COMMANDCENTER_DATA_DIR || '').trim() || join(process.cwd(), 'data');
const uploadTmpDir = join(commandCenterDataDir, '.tmp-uploads');
mkdirSync(uploadTmpDir, { recursive: true, mode: 0o700 });
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadTmpDir),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${randomUUID()}.upload`),
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 100, fields: 50 },
});
const chatLibraryDir = join(commandCenterDataDir, 'chat-library');
const chatFilesDir = join(chatLibraryDir, 'files');
const chatManifestPath = join(chatLibraryDir, 'manifest.json');
const chatHistoryPath = join(chatLibraryDir, 'history.json');
const MAX_CHAT_HISTORY_MESSAGES = 120;

function sanitizeName(name = '') {
  return String(name || 'file')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'file';
}

function isAllowedMusicExt(ext = '') {
  return ['.mp3', '.wav', '.ogg', '.m4a', '.aac', '.flac', '.webm'].includes(String(ext || '').toLowerCase());
}

function isAllowedIntroExt(ext = '') {
  return ['.mp4', '.webm', '.mov', '.m4v'].includes(String(ext || '').toLowerCase());
}

function isAllowedBackgroundExt(ext = '') {
  return ['.png', '.jpg', '.jpeg', '.webp'].includes(String(ext || '').toLowerCase());
}

async function validateExtractedTree(root, { maxFiles = 1000, maxBytes = 250 * 1024 * 1024 } = {}) {
  let files = 0;
  let bytes = 0;
  async function walk(dir) {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const info = await fsp.lstat(path);
      if (info.isSymbolicLink()) throw new Error('ZIP packages may not contain symbolic links');
      if (info.isDirectory()) await walk(path);
      else if (info.isFile()) {
        files += 1;
        bytes += info.size;
        if (files > maxFiles || bytes > maxBytes) throw new Error('ZIP expanded file count or byte limit exceeded');
      }
    }
  }
  await walk(root);
  return { files, bytes };
}

async function listMusicTracks() {
  await ensureMusicStorage();
  const musicDir = getMusicDir();
  const entries = await fsp.readdir(musicDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const ext = extname(entry.name || '').toLowerCase();
      const id = basename(entry.name, ext);
      return {
        id,
        filename: entry.name,
        name: id.replace(/[-_]+/g, ' ').trim() || id,
        ext,
        url: `${basePath}/media/music/${encodeURIComponent(entry.name)}`,
      };
    })
    .filter((track) => isAllowedMusicExt(track.ext))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listIntroVideos() {
  await ensureIntroStorage();
  const introDir = getIntroDir();
  const entries = await fsp.readdir(introDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const ext = extname(entry.name || '').toLowerCase();
      const id = basename(entry.name, ext);
      return {
        id,
        filename: entry.name,
        name: id.replace(/[-_]+/g, ' ').trim() || id,
        ext,
        url: `${basePath}/media/intros/${encodeURIComponent(entry.name)}`,
      };
    })
    .filter((intro) => isAllowedIntroExt(intro.ext))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function listWorkspaceBackgrounds() {
  await ensureAppearanceStorage();
  const dir = getAppearanceBackgroundDir();
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const builtIn = [{ id: DEFAULT_WORKSPACE_ID, filename: 'room-background.png', name: 'Default Office', ext: '.png', url: `${basePath}/assets/office-art/room-background.png`, builtIn: true }];
  const uploaded = entries
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const ext = extname(entry.name || '').toLowerCase();
      const id = basename(entry.name, ext);
      return {
        id,
        filename: entry.name,
        name: id.replace(/[-_]+/g, ' ').trim() || id,
        ext,
        url: `${basePath}/media/appearance/backgrounds/${encodeURIComponent(entry.name)}`,
        builtIn: false,
      };
    })
    .filter((bg) => isAllowedBackgroundExt(bg.ext));
  return [...builtIn, ...uploaded].sort((a, b) => (a.builtIn === b.builtIn ? a.name.localeCompare(b.name) : a.builtIn ? -1 : 1));
}

async function ensureChatLibrary() {
  await fsp.mkdir(chatFilesDir, { recursive: true });
  if (!existsSync(chatManifestPath)) {
    await writeJsonStore(chatManifestPath, { items: [] });
  }
  if (!existsSync(chatHistoryPath)) {
    await writeJsonStore(chatHistoryPath, { agents: {} });
  }
}

async function readChatManifest() {
  await ensureChatLibrary();
  try {
    const parsed = await readJsonStore(chatManifestPath, { defaultValue: { items: [] } });
    return Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch (err) {
    console.error('[chat-library] Manifest error:', err.message);
    throw err;
  }
}

async function writeChatManifest(manifest) {
  await ensureChatLibrary();
  await writeJsonStore(chatManifestPath, { items: manifest.items || [] });
}

async function readChatHistoryStore() {
  await ensureChatLibrary();
  try {
    const parsed = await readJsonStore(chatHistoryPath, { defaultValue: { agents: {} } });
    return parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object'
      ? parsed
      : { agents: {} };
  } catch (err) {
    console.error('[chat-library] History error:', err.message);
    throw err;
  }
}

async function writeChatHistoryStore(store) {
  await ensureChatLibrary();
  await writeJsonStore(chatHistoryPath, { agents: store.agents || {} });
}

function sanitizeChatMessage(message = {}) {
  return {
    id: String(message.id || randomUUID()),
    role: message.role === 'user' ? 'user' : 'agent',
    kind: String(message.kind || 'text'),
    text: String(message.text || ''),
    timestamp: Number(message.timestamp || Date.now()),
    files: Array.isArray(message.files)
      ? message.files.map((file) => ({
          id: String(file.id || ''),
          name: String(file.name || file.originalName || 'file'),
          originalName: String(file.originalName || file.name || 'file'),
          mimeType: String(file.mimeType || 'application/octet-stream'),
          kind: file.kind === 'link' ? 'link' : 'file',
          sourceUrl: String(file.sourceUrl || ''),
          downloadUrl: String(file.downloadUrl || ''),
        }))
      : [],
  };
}

async function getChatHistory(agentId) {
  const store = await readChatHistoryStore();
  const history = Array.isArray(store.agents?.[agentId]) ? store.agents[agentId] : [];
  return history.map(sanitizeChatMessage).slice(-MAX_CHAT_HISTORY_MESSAGES);
}

async function appendChatHistory(agentId, message) {
  let history = [];
  await updateJsonStore(chatHistoryPath, { defaultValue: { agents: {} } }, (store) => {
    const agents = { ...(store.agents || {}) };
    history = [...(Array.isArray(agents[agentId]) ? agents[agentId] : []), sanitizeChatMessage(message)].slice(-MAX_CHAT_HISTORY_MESSAGES);
    agents[agentId] = history;
    return { agents };
  });
  return history;
}

function buildConversationContext(history = []) {
  if (!Array.isArray(history) || !history.length) return '';
  const lines = history
    .slice(-MAX_CHAT_HISTORY_MESSAGES)
    .map((entry) => {
      const role = entry.role === 'user' ? 'User' : 'Assistant';
      const text = String(entry.text || '').trim();
      const attachments = Array.isArray(entry.files) && entry.files.length
        ? ` [files: ${entry.files.map((file) => file.name || file.originalName || 'file').join(', ')}]`
        : '';
      return `${role}: ${text || '(no text)'}${attachments}`;
    });
  return `Previous direct chat conversation with this user:\n${lines.join('\n')}\n\nReply naturally, using the conversation above as context.`;
}

function toChatFileRecord(item) {
  return {
    id: item.id,
    kind: item.kind || 'file',
    name: item.name,
    originalName: item.originalName || item.name,
    mimeType: item.mimeType || 'application/octet-stream',
    size: item.size || 0,
    createdAt: item.createdAt,
    sourceUrl: item.sourceUrl || '',
    notes: item.notes || '',
    ext: item.ext || '',
    downloadUrl: item.kind === 'link' ? item.sourceUrl : `${basePath}/api/chat/files/${item.id}/download`,
    path: item.path || '',
  };
}

async function resolveChatFiles(ids = []) {
  const manifest = await readChatManifest();
  const wanted = new Set((Array.isArray(ids) ? ids : []).map((id) => String(id)));
  return manifest.items.filter((item) => wanted.has(String(item.id)));
}

async function resolveAttachmentBundle(fileIds = []) {
  const files = await resolveChatFiles(fileIds);
  const bundle = await buildAttachmentBundle(files, { libraryDir: chatLibraryDir, requestedIds: fileIds });
  return { files, bundle };
}

app.disable('x-powered-by');
app.use(securityHeaders);
app.use(express.json({ limit: '1mb' }));

async function uploadedBuffer(file) {
  if (file?.buffer) return file.buffer;
  if (!file?.path) return Buffer.alloc(0);
  return fsp.readFile(file.path);
}

app.use((req, res, next) => {
  const cleanup = () => {
    const files = uploadedFiles(req);
    for (const file of files) if (file?.path) fsp.unlink(file.path).catch(() => {});
  };
  res.once('finish', cleanup);
  res.once('close', cleanup);
  req.once('aborted', cleanup);
  next();
});

async function requireUiAuthPage(req, res, next) {
  const auth = await loadUiAuthConfig();
  if (!auth.enabled) return next();
  const token = parseCookies(req).cc_auth;
  if (isValidSession(token)) return next();
  const wantsHtml = String(req.headers.accept || '').includes('text/html');
  if (wantsHtml) return res.redirect(`${basePath || '/'}?auth=required`);
  return res.status(401).json({ ok: false, error: 'Unauthorized' });
}

function maskCommandCenterApiKey(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.length <= 8) return `${raw.slice(0, 2)}•••${raw.slice(-1)}`;
  return `${raw.slice(0, 6)}••••${raw.slice(-6)}`;
}

function generateCommandCenterApiKey() {
  return `cc_${randomUUID().replace(/-/g, '')}_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

async function setEnvKeyInDotenv(key, value) {
  const envPath = join(__dirname, '..', '.env');
  let raw = '';
  try { raw = await fsp.readFile(envPath, 'utf8'); } catch {}
  const lines = String(raw || '').split(/\r?\n/);
  let found = false;
  const out = lines.map((line) => {
    if (line.startsWith(`${key}=`)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) out.push(`${key}=${value}`);
  const normalized = out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n?$/, '\n');
  await fsp.writeFile(envPath, normalized, 'utf8');
}

// Auth + operator-setup routes live in server/routes/auth.js (extracted from
// the monolith). The UI API policy MUST be registered BEFORE the auth router so
// it runs for every matched request (the router's handlers respond without
// calling next(), so a policy mounted after it would be bypassed).
const { router: authRouter, uiApiPolicy } = createAuthRouter({ basePath });
app.use(uiApiPolicy);
app.use(authRouter);


app.get(`${basePath}/api/settings/api-key`, async (_req, res) => {
  const current = String(config.apiKey || '').trim();
  return res.json({
    ok: true,
    hasApiKey: !!current,
    apiKeyMasked: maskCommandCenterApiKey(current),
    basePath,
    v1BaseUrl: `${basePath}/api/v1`,
  });
});

app.post(`${basePath}/api/settings/api-key/rotate`, async (_req, res) => {
  try {
    const nextKey = generateCommandCenterApiKey();
    await setEnvKeyInDotenv('COMMANDCENTER_API_KEY', nextKey);
    config.apiKey = nextKey;
    return res.json({ ok: true, apiKey: nextKey, apiKeyMasked: maskCommandCenterApiKey(nextKey), rotated: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not rotate API key' });
  }
});

app.get(`${basePath}/api/settings/api-key/reveal`, async (_req, res) => {
  const current = String(config.apiKey || '').trim();
  return res.json({ ok: true, hasApiKey: !!current, apiKey: current });
});

app.get(`${basePath}/api/settings/update`, async (req, res) => {
  try {
    const refresh = String(req.query?.refresh || '1').trim() !== '0';
    return res.json(await getUpdatePayload({ refresh }));
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not load update status', code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/update`, async (req, res) => {
  try {
    const existing = await loadUpdateSettings();
    const saved = await saveUpdateSettings({
      ...existing,
      autoUpdateEnabled: req.body?.autoUpdateEnabled !== false,
      checkIntervalHours: req.body?.checkIntervalHours !== undefined ? req.body.checkIntervalHours : existing.checkIntervalHours,
    });
    return res.json({ ok: true, settings: saved });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not save update settings', code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/update/apply`, async (req, res) => {
  try {
    const confirm = req.body?.confirm === true;
    if (!confirm) {
      return res.status(400).json({ ok: false, error: 'Confirmation required before applying update', code: 'CONFIRM_REQUIRED' });
    }
    const result = await applyUpdate({ requestedBy: 'manual' });
    if (!result.ok) {
      return res.status(409).json({ ok: false, error: result?.state?.message || result.reason || 'Could not apply update', code: 'UPDATE_BLOCKED', details: result });
    }
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not apply update', code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/settings/agents`, async (_req, res) => {
  return res.json({ ok: true, ...(buildAgentSettingsPayload()) });
});

app.get(`${basePath}/api/settings/direct-chat`, async (_req, res) => {
  try {
    const settings = await loadDirectChatSettings();
    return res.json({ ok: true, settings: publicDirectChatSettings(settings) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not load direct chat settings' });
  }
});

app.post(`${basePath}/api/settings/direct-chat`, async (req, res) => {
  try {
    const settings = await saveDirectChatSettings({
      relayEnabled: req.body?.relayEnabled,
      relayUrl: req.body?.relayUrl,
      relayShowDeviceLabels: req.body?.relayShowDeviceLabels,
    });
    await relayAgentSource.configure(settings);
    return res.json({ ok: true, settings: publicDirectChatSettings(settings) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not save direct chat settings' });
  }
});

app.post(`${basePath}/api/settings/agents/detect`, async (req, res) => {
  try {
    const source = String(req.body?.source || '').trim().toLowerCase();
    if (!['openclaw', 'hermes'].includes(source)) {
      return res.status(400).json({ ok: false, error: 'source must be openclaw or hermes' });
    }
    if (source === 'openclaw') {
      await setEnvKeyInDotenv('OPENCLAW_AGENT_SOURCE_ENABLED', 'true');
    }
    if (source === 'hermes') {
      await setEnvKeyInDotenv('HERMES_BRIDGE_ENABLED', 'true');
      const detected = detectAgentSources();
      const first = detected.hermes.agents[0] || null;
      if (first) {
        await setEnvKeyInDotenv('HERMES_AGENT_ID', String(first.id || 'hermes'));
        await setEnvKeyInDotenv('HERMES_AGENT_LABEL', String(first.label || first.name || 'Hermes'));
        await setEnvKeyInDotenv('HERMES_AGENT_NAME', String(first.name || first.label || 'Hermes'));
      }
    }
    return res.json({ ok: true, source, ...(buildAgentSettingsPayload()) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not detect agents' });
  }
});
app.use(`${basePath}/media/music`, express.static(getMusicDir()));
app.use(`${basePath}/media/intros`, express.static(getIntroDir()));
app.use(`${basePath}/media/appearance/backgrounds`, express.static(getAppearanceBackgroundDir()));
app.use(`${basePath}/media/branding`, express.static(getBrandingDir()));
app.use(`${basePath}/docs`, requireUiAuthPage);
app.use(basePath || '/', express.static(join(__dirname, '..', 'public')));
app.use(`${basePath}/api/v1`, requireApiAuth);
await ensureCompanionRegistry();
await ensureMusicStorage();
await ensureIntroStorage();
await ensureAppearanceStorage();
await ensureBrandingStorage();

const liveGeminiSessions = new Map();
const liveGeminiWatchdogs = new Map();
const liveScreenChangePrompts = new Map();
const announcedLiveTaskResults = new Set();
const agentActivity = new Map();

const SAFE_SETTINGS_SECTIONS = {
  gemini: `${basePath}/api/settings/gemini`,
  appearance: `${basePath}/api/settings/appearance`,
  branding: `${basePath}/api/settings/branding`,
  layout: `${basePath}/api/settings/layout`,
  companions: `${basePath}/api/settings/companions`,
  intro: `${basePath}/api/settings/intro`,
  music: `${basePath}/api/settings/music`,
  wake: `${basePath}/api/settings/wake`,
  voice: `${basePath}/api/settings/voice`,
  workspace_rooms: `${basePath}/api/workspace/rooms`,
};
const SETTINGS_SECRET_KEY_RE = /(api[_-]?key|password|passwd|token|secret|cookie|session|credential|accesskey)/i;

function sanitizeSettingsPatch(value) {
  if (Array.isArray(value)) return value.map((item) => sanitizeSettingsPatch(item));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (SETTINGS_SECRET_KEY_RE.test(String(key || ''))) continue;
    if (/file|upload|buffer|base64|binary/i.test(String(key || ''))) continue;
    out[key] = sanitizeSettingsPatch(raw);
  }
  return out;
}

function resolveSettingsSection(section = '') {
  const key = String(section || '').trim().toLowerCase().replace(/[\s/-]+/g, '_');
  return { key, path: SAFE_SETTINGS_SECTIONS[key] || '' };
}

async function fetchLocalSettings(req, method, path, body = null) {
  const init = {
    method,
    headers: { cookie: req.headers.cookie || '' },
  };
  if (body !== null) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const upstream = await fetch(`${req.protocol}://${req.get('host')}${path}`, init);
  let data = null;
  try { data = await upstream.json(); } catch { data = { ok: false, error: `Upstream ${method} ${path} did not return JSON` }; }
  return { status: upstream.status, data };
}

function buildAgentSettingsPayload() {
  const roster = getRoster();
  const detected = detectAgentSources();
  const bySource = {
    openclaw: roster.agents.filter((agent) => agent.source === 'openclaw' || agent.bridge === 'openclaw'),
    hermes: roster.agents.filter((agent) => agent.source === 'hermes' || agent.bridge === 'hermes'),
    relay: roster.agents.filter((agent) => agent.source === 'relay' || agent.bridge === 'relay'),
  };
  return {
    roster,
    sources: {
      openclaw: {
        ...detected.openclaw,
        activeAgents: bySource.openclaw,
        showDetectButton: bySource.openclaw.length === 0,
      },
      hermes: {
        ...detected.hermes,
        activeAgents: bySource.hermes,
        showDetectButton: bySource.hermes.length === 0,
      },
      relay: {
        ...detected.relay,
        activeAgents: bySource.relay,
        showDetectButton: false,
      },
    },
    actions: {
      showDetectOpenClaw: bySource.openclaw.length === 0,
      showDetectHermes: bySource.hermes.length === 0,
      showDetectRelay: false,
    },
  };
}

function mergeAgentTransportMetadata(agentId = '', metadata = {}) {
  const relayMeta = relayAgentSource.buildSessionMetadata(agentId);
  return {
    ...(metadata && typeof metadata === 'object' ? metadata : {}),
    ...relayMeta,
  };
}

async function maybePersistHermesSession(session, result) {
  const hermesSessionId = String(result?.hermesSessionId || '').trim();
  const hermesProfile = String(result?.hermesProfile || '').trim();
  const relayProviderSessionId = String(result?.relayProviderSessionId || '').trim();
  const relayRemoteSessionId = String(result?.relayRemoteSessionId || '').trim();
  if (!session?.id || (!hermesSessionId && !hermesProfile && !relayProviderSessionId && !relayRemoteSessionId)) return session;
  if (
    String(session?.metadata?.hermesSessionId || '').trim() === hermesSessionId
    && String(session?.metadata?.hermesProfile || '').trim() === hermesProfile
    && String(session?.metadata?.relayProviderSessionId || '').trim() === relayProviderSessionId
    && String(session?.metadata?.relayRemoteSessionId || '').trim() === relayRemoteSessionId
  ) return session;
  return await saveApiSession({
    ...session,
    metadata: {
      ...(session.metadata || {}),
      ...(hermesSessionId ? { hermesSessionId } : {}),
      ...(hermesProfile ? { hermesProfile } : {}),
      ...(relayProviderSessionId ? { relayProviderSessionId } : {}),
      ...(relayRemoteSessionId ? { relayRemoteSessionId } : {}),
    },
  });
}

async function runImageLookupTask({ query, agent, session }) {
  const chosenAgent = chooseIdleAgent(agent || session?.agent || '', getRoster());
  const prompt = [
    'Find a publicly reachable web image for the requested topic.',
    'Return ONLY strict JSON: {"title":"...","imageUrl":"https://...","sourceUrl":"https://...","why":"..."}',
    'Rules:',
    '- Pick one image only.',
    '- imageUrl must be a direct image URL when possible.',
    '- sourceUrl must be the page the image came from or a relevant canonical source.',
    '- No markdown. No commentary outside JSON.',
    '- Prefer stable, hotlinkable, safe-for-work images.',
    `Query: ${query}`,
  ].join('\n');
  return await new Promise((resolve) => {
    execFile(process.env.OPENCLAW_BIN || 'openclaw', [
      'agent', '--agent', chosenAgent, '--thinking', 'low', '--message', prompt,
    ], {
      timeout: 8 * 60 * 1000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 3 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return resolve({ ok: false, agent: chosenAgent, error: String(stderr || err.message || 'Image lookup failed').slice(0, 600) });
      const raw = String(stdout || '').trim();
      const match = raw.match(/\{[\s\S]*\}$/);
      try {
        const parsed = JSON.parse(match ? match[0] : raw);
        const imageUrl = String(parsed?.imageUrl || '').trim();
        const sourceUrl = String(parsed?.sourceUrl || '').trim();
        if (!/^https?:\/\//i.test(imageUrl)) return resolve({ ok: false, agent: chosenAgent, error: 'Agent did not return a valid imageUrl' });
        resolve({
          ok: true,
          agent: chosenAgent,
          title: String(parsed?.title || query).trim().slice(0, 160),
          imageUrl,
          sourceUrl,
          why: String(parsed?.why || '').trim().slice(0, 280),
        });
      } catch {
        resolve({ ok: false, agent: chosenAgent, error: 'Agent returned invalid JSON for image lookup' });
      }
    });
  });
}
app.use(`${basePath}/wakewords`, express.static(join(__dirname, '..', 'public', 'wakewords')));
if (basePath) {
  app.get(basePath, (req, res) => res.redirect(basePath + '/'));
  app.get(`${basePath}/docs`, (req, res) => res.redirect(`${basePath}/docs/`));
}

function clearLiveWatchdog(sessionId) {
  const existing = liveGeminiWatchdogs.get(sessionId);
  if (existing) {
    clearTimeout(existing);
    liveGeminiWatchdogs.delete(sessionId);
  }
}

function setCallSessionState(sessionId, state, patch = {}, { broadcastState = true } = {}) {
  const updated = updateCallSession(sessionId, { ...patch, state });
  if (updated && broadcastState) {
    broadcast({ type: 'call:session.state', data: { sessionId, state: updated.state, session: updated } });
  }
  return updated;
}

function broadcastCallHandoff(type, sessionId, payload = {}) {
  broadcast({ type, data: { sessionId, ...payload } });
}

function stripAnsi(value = '') {
  return String(value || '').replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function compactForSpeech(value = '', maxChars = 1800) {
  return stripAnsi(value)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, '').slice(0, 900))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxChars);
}

function findSessionForLiveTask(taskId = '') {
  if (!taskId) return null;
  return listCallSessions().find((session) => session.active && session.persona === 'fairy' && session.handoffTaskId === taskId) || null;
}

function inferTaskDomain(text = '') {
  const input = String(text || '').toLowerCase();
  if (/(ui|ux|frontend|front end|css|layout|button|mobile|responsive|animation|design)/.test(input)) return 'ui';
  if (/(backend|server|api|database|db|infra|deploy|auth|socket|websocket|route)/.test(input)) return 'backend';
  if (/(test|qa|repro|verify|validation|regression)/.test(input)) return 'qa';
  if (/(research|investigate|why|compare|analyze|analysis|web search)/.test(input)) return 'research';
  if (/(docs|readme|copy|write|wording|documentation)/.test(input)) return 'docs';
  return 'general';
}

function getAgentRuntimeInfo(agentId = '', roster) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const agent = agents.find((item) => item.id === agentId) || {};
  const runtime = agent.source === 'hermes' || agent.bridge === 'hermes' ? 'hermes' : 'openclaw';
  const label = compactForSpeech(agent.label || agent.name || agent.id || agentId || (runtime === 'hermes' ? 'Hermes' : 'OpenClaw'), 80);
  return { agent, runtime, label };
}

function describeAgentChoice(agentId = '', roster) {
  const { agent, runtime, label } = getAgentRuntimeInfo(agentId, roster);
  const domain = inferTaskDomain(`${agent.id || ''} ${agent.label || ''} ${agent.name || ''}`);
  if (domain === 'ui') return { label, runtime, reason: 'UI issue. Routing the visual specialist.' };
  if (domain === 'backend') return { label, runtime, reason: 'Backend job. Routing the systems brain.' };
  if (domain === 'qa') return { label, runtime, reason: 'Validation problem. Routing QA.' };
  if (domain === 'research') return { label, runtime, reason: 'Research task. Routing the investigator.' };
  if (domain === 'docs') return { label, runtime, reason: 'Docs work. Routing the writer.' };
  return { label, runtime, reason: runtime === 'hermes' ? 'That needs Nyxie. Routing it through Hermes.' : 'That needs Astra. Routing it through OpenClaw.' };
}

function buildHandoffSpokenSummary(text = '', agentId = '', roster) {
  const { label, reason } = describeAgentChoice(agentId, roster);
  const domain = inferTaskDomain(text);
  if (domain === 'ui') return `${reason} ${label} gets this one.`;
  if (domain === 'backend') return `${reason} ${label} gets it.`;
  if (domain === 'qa') return `${reason} ${label} can verify it.`;
  if (domain === 'research') return `${reason} ${label} can dig.`;
  if (domain === 'docs') return `${reason} ${label} can tighten it up.`;
  return reason;
}

function appendCallTranscriptEntry(sessionId, role, text, meta = {}) {
  const cleanRole = String(role || '').trim();
  const cleanText = String(text || '').trim();
  if (!sessionId || !cleanRole || !cleanText) return getCallSession(sessionId);
  const current = getCallSession(sessionId);
  if (!current) return null;
  const now = new Date().toISOString();
  const entries = Array.isArray(current.transcriptEntries) ? current.transcriptEntries.slice(-79) : [];
  const last = entries[entries.length - 1];
  if (last && last.role === cleanRole && last.text === cleanText) return current;
  if (last && last.role === cleanRole) {
    const gapMs = Math.abs(Date.now() - Date.parse(last.at || 0));
    if (gapMs <= 4000 && String(meta.source || '') === String(last.source || '')) {
      last.text = `${String(last.text || '').trim()} ${cleanText}`.replace(/\s+/g, ' ').trim();
      last.at = now;
      entries[entries.length - 1] = last;
      return updateCallSession(sessionId, { transcriptEntries: entries.slice(-80) });
    }
  }
  entries.push({ role: cleanRole, text: cleanText, at: now, ...meta });
  return updateCallSession(sessionId, { transcriptEntries: entries.slice(-80) });
}

function noteAgentActivity(agentId = '', state = 'active') {
  const id = String(agentId || '').trim();
  if (!id) return;
  agentActivity.set(id, { state, at: Date.now() });
}

function chooseIdleAgent(preferred = '', roster = getRoster()) {
  const agents = Array.isArray(roster?.agents) ? roster.agents.filter((agent) => agent?.id) : [];
  if (!agents.length) return String(preferred || roster?.primaryAgentId || 'orchestrator').trim();
  const preferredId = String(preferred || '').trim();
  const ordered = agents
    .map((agent) => {
      const activity = agentActivity.get(agent.id) || null;
      const state = String(activity?.state || 'idle');
      const at = Number(activity?.at || 0);
      const busyPenalty = ['thinking', 'responding', 'tool_use', 'working'].includes(state) ? 10_000_000_000 : 0;
      const preferredPenalty = preferredId && agent.id === preferredId ? 1_000_000_000 : 0;
      const primaryPenalty = agent.id === String(roster?.primaryAgentId || '') ? 100_000_000 : 0;
      return { id: agent.id, score: busyPenalty + preferredPenalty + primaryPenalty + at };
    })
    .sort((a, b) => a.score - b.score);
  return ordered[0]?.id || preferredId || String(roster?.primaryAgentId || 'orchestrator').trim();
}

async function maybeQueueFairyMemoryUpdate(session = null) {
  if (!session || !session.id || String(session.persona || '') !== 'fairy') return;
  const existingStatus = String(session.memoryUpdate?.status || '').trim();
  if (['queued', 'running', 'completed'].includes(existingStatus)) return;
  const transcriptEntries = Array.isArray(session.transcriptEntries) ? session.transcriptEntries : [];
  if (!transcriptEntries.length) return;
  const latestUserText = [...transcriptEntries].reverse().find((entry) => entry?.role === 'user')?.text || session.lastTranscript || '';
  const scope = String(session.agent || 'general').trim().toLowerCase() || 'general';
  const roster = getRoster();
  const agent = chooseIdleAgent(session.agent, roster);
  const transcriptBlock = transcriptEntries.slice(-16).map((entry) => `${entry.role.toUpperCase()}: ${String(entry.text || '').replace(/\s+/g, ' ').trim()}`).join('\n');
  const prompt = [
    'You are extracting durable memory for future Fairy live calls in Command Center.',
    'Return ONLY strict JSON with this shape: {"entries":[{"text":"...","tags":["..."],"scope":"general|ui|backend|research|<agent>","pinned":false}]}.',
    'Rules:',
    '- Save only durable, future-useful memory: operator preferences, recurring project context, stable settings choices, follow-up intent, or enduring facts.',
    '- Do NOT save ephemeral chatter, secrets, API keys, passwords, tokens, cookies, or credentials.',
    '- Keep each text concise and specific.',
    '- Return 0 to 3 entries max.',
    `Preferred scope for this call: ${scope}`,
    '',
    'Recent Fairy call transcript:',
    transcriptBlock,
    latestUserText ? `\nLatest user emphasis: ${latestUserText}` : '',
  ].filter(Boolean).join('\n');

  updateCallSession(session.id, { memoryUpdate: { status: 'queued', agent, startedAt: new Date().toISOString(), saved: 0 } });
  broadcast({ type: 'call:memory.update', data: { sessionId: session.id, status: 'queued', agent } });

  execFile(process.env.OPENCLAW_BIN || 'openclaw', [
    'agent', '--agent', agent, '--thinking', 'low', '--message', prompt,
  ], {
    timeout: 8 * 60 * 1000,
    env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
    maxBuffer: 3 * 1024 * 1024,
  }, async (err, stdout, stderr) => {
    if (err) {
      const message = String(stderr || err.message || 'Memory update task failed').slice(0, 500);
      updateCallSession(session.id, { memoryUpdate: { status: 'failed', agent, error: message, finishedAt: new Date().toISOString(), saved: 0 } });
      broadcast({ type: 'call:memory.update', data: { sessionId: session.id, status: 'failed', agent, error: message } });
      return;
    }
    const raw = String(stdout || '').trim();
    const match = raw.match(/\{[\s\S]*\}$/);
    let parsed = null;
    try { parsed = JSON.parse(match ? match[0] : raw); } catch {}
    const items = Array.isArray(parsed?.entries) ? parsed.entries.slice(0, 3) : [];
    const saved = [];
    for (const item of items) {
      const text = String(item?.text || '').trim();
      if (!text) continue;
      if (/(api[_ -]?key|password|passwd|token|secret|cookie|credential)/i.test(text)) continue;
      try {
        const result = await addFairyMemoryEntry({
          text,
          tags: Array.isArray(item?.tags) ? item.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 8) : ['post-call'],
          scope: String(item?.scope || scope).trim().toLowerCase() || scope,
          pinned: item?.pinned === true,
          source: `post-call:${agent}`,
        });
        saved.push(result.entry);
      } catch {}
    }
    updateCallSession(session.id, { memoryUpdate: { status: 'completed', agent, finishedAt: new Date().toISOString(), saved: saved.length, entries: saved.map((entry) => entry.id) } });
    broadcast({ type: 'call:memory.update', data: { sessionId: session.id, status: 'completed', agent, saved: saved.length, entries: saved } });
  });
}

function maybeAnnounceLiveTaskProgress(msg) {
  if (msg?.type !== 'live_task:update') return;
  const task = msg.data || {};
  const taskId = String(task.id || '').trim();
  const status = String(task.status || '').trim();
  if (!taskId || status !== 'working') return;
  const session = findSessionForLiveTask(taskId);
  if (!session) return;
  const updated = updateCallSession(session.id, {
    handoffTaskId: taskId,
    handoffTitle: task.title || session.handoffTitle || '',
    lastTaskSummary: task.summary || (String(task.runtime || '').trim() === 'hermes' ? 'Hermes is working on it.' : 'OpenClaw is working on it.'),
  });
  broadcastCallDebugState(session.id);
  broadcast({
    type: 'call:handoff.progress',
    data: {
      sessionId: session.id,
      taskId,
      status,
      summary: task.summary || (String(task.runtime || '').trim() === 'hermes' ? 'Hermes is working on it.' : 'OpenClaw is working on it.'),
      title: task.title || session.handoffTitle || 'Background task',
      session: updated || session,
    },
  });
}

function sanitizeFrameMeta(value = {}) {
  const input = value && typeof value === 'object' ? value : {};
  const cleanString = (v, max = 160) => String(v || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
  const cleanNumber = (v) => Number.isFinite(Number(v)) ? Number(v) : 0;
  return {
    source: cleanString(input.source, 24),
    reason: cleanString(input.reason, 48),
    frameId: cleanNumber(input.frameId),
    capturedAt: cleanString(input.capturedAt, 40),
    stable: input.stable === true,
    videoWidth: cleanNumber(input.videoWidth),
    videoHeight: cleanNumber(input.videoHeight),
    displaySurface: cleanString(input.displaySurface, 40),
    logicalSurface: typeof input.logicalSurface === 'boolean' ? input.logicalSurface : null,
    cursor: cleanString(input.cursor, 40),
    trackLabel: cleanString(input.trackLabel, 120),
    avgDiff: cleanNumber(input.avgDiff),
    changedRatio: cleanNumber(input.changedRatio),
  };
}

function describeFrameMeta(meta = {}) {
  const bits = [];
  if (meta.source) bits.push(`source=${meta.source}`);
  if (meta.reason) bits.push(`reason=${meta.reason}`);
  if (meta.frameId) bits.push(`frame=${meta.frameId}`);
  if (meta.displaySurface) bits.push(`surface=${meta.displaySurface}`);
  if (meta.stable) bits.push('stable');
  if (meta.videoWidth && meta.videoHeight) bits.push(`${meta.videoWidth}x${meta.videoHeight}`);
  return bits.join(' ');
}

function summarizeVisualMemory(visualMemory = {}) {
  const recent = Array.isArray(visualMemory?.recent) ? visualMemory.recent.slice(0, 6) : [];
  return {
    current: visualMemory?.current || null,
    recent,
    lastStableScreenFrameAt: visualMemory?.lastStableScreenFrameAt || null,
    lastStableScreenFrameMeta: visualMemory?.lastStableScreenFrameMeta || null,
    lastChangeAt: visualMemory?.lastChangeAt || null,
    lastChangeSummary: visualMemory?.lastChangeSummary || '',
  };
}

const LIVE_INTENT_OVERRIDES = new Set(['', 'normal', 'just_watch', 'quiet', 'guide_me', 'operator_now', 'narrate']);

function normalizeLiveIntentOverride(value = '') {
  const normalized = String(value || '').trim().toLowerCase().replace(/[\s-]+/g, '_');
  if (!normalized || normalized === 'normal' || normalized === 'none' || normalized === 'clear' || normalized === 'reset') return '';
  return LIVE_INTENT_OVERRIDES.has(normalized) ? normalized : '';
}

function describeLiveIntentOverride(intent = '') {
  const value = normalizeLiveIntentOverride(intent);
  if (value === 'just_watch') return 'Just watch: stay especially quiet unless something clearly important happens.';
  if (value === 'quiet') return 'Quiet: still helpful, but less chatty and more defer-heavy.';
  if (value === 'guide_me') return 'Guide Me: be more proactive and step-by-step right now.';
  if (value === 'operator_now') return 'Operator Now: bias harder toward routing and execution-ready summaries.';
  if (value === 'narrate') return 'Narrate: allow more observational commentary for demos, streams, or active walkthroughs.';
  return 'Normal: follow the selected call mode with no temporary override.';
}

function applyLiveIntentOverride(policy = {}, intent = '') {
  const value = normalizeLiveIntentOverride(intent);
  const base = { ...policy, liveIntentOverride: value };
  if (!value) return base;
  if (value === 'just_watch') {
    return {
      ...base,
      interruptStrictness: 'high',
      proactivity: 'low',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: true,
      screenChangeDebounceMs: Math.max(Number(base.screenChangeDebounceMs || 0), 6000),
      modeDecision: `${base.modeDecision}+intent:just_watch`,
      modeReason: 'Live override is set to Just Watch, so Fairy should stay especially quiet unless something clearly important happens.',
    };
  }
  if (value === 'quiet') {
    return {
      ...base,
      proactivity: base.proactivity === 'high' ? 'medium' : base.proactivity === 'medium' ? 'medium-low' : 'low',
      responseStyle: base.responseStyle === 'directive' ? 'brief-directive' : base.responseStyle === 'guided' ? 'guided-brief' : 'quiet-brief',
      deferNonCriticalCommentary: true,
      screenChangeDebounceMs: Math.max(Number(base.screenChangeDebounceMs || 0), 4200),
      modeDecision: `${base.modeDecision}+intent:quiet`,
      modeReason: 'Live override is set to Quiet, so Fairy should be less chatty and more selective about unsolicited commentary.',
    };
  }
  if (value === 'guide_me') {
    return {
      ...base,
      responseStyle: 'guided',
      interruptStrictness: 'normal',
      proactivity: 'high',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: false,
      screenChangeDebounceMs: Math.min(Number(base.screenChangeDebounceMs || 3500), 2400),
      modeDecision: `${base.modeDecision}+intent:guide_me`,
      modeReason: 'Live override is set to Guide Me, so Fairy should be more proactive and step-by-step right now.',
    };
  }
  if (value === 'operator_now') {
    return {
      ...base,
      handoffPolicy: 'aggressive',
      responseStyle: 'directive',
      interruptStrictness: 'normal',
      proactivity: 'high',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: false,
      screenChangeDebounceMs: Math.min(Number(base.screenChangeDebounceMs || 3500), 2600),
      modeDecision: `${base.modeDecision}+intent:operator_now`,
      modeReason: 'Live override is set to Operator Now, so Fairy should bias harder toward routing and execution-ready summaries.',
    };
  }
  if (value === 'narrate') {
    return {
      ...base,
      responseStyle: base.responseStyle === 'short' ? 'short-narrate' : 'narrative-brief',
      interruptStrictness: 'normal',
      proactivity: 'high',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: false,
      screenChangeDebounceMs: Math.min(Number(base.screenChangeDebounceMs || 3500), 2200),
      modeDecision: `${base.modeDecision}+intent:narrate`,
      modeReason: 'Live override is set to Narrate, so Fairy can describe meaningful visible changes more freely for the moment.',
    };
  }
  return base;
}

function buildEffectiveCallPolicy(callMode = 'universal', intensityLevel = 'low', liveIntentOverride = '') {
  return applyLiveIntentOverride(buildCallModePolicy(callMode, intensityLevel), liveIntentOverride);
}

function buildLiveIntentSystemEvent(callMode = 'universal', liveIntentOverride = '') {
  const intent = normalizeLiveIntentOverride(liveIntentOverride);
  if (!intent) return `SYSTEM EVENT FOR LIVE CALL:
Live intent override cleared. Return to the normal behavior for the current call mode.`;
  const mode = normalizeCallMode(callMode || 'universal');
  return [
    'SYSTEM EVENT FOR LIVE CALL:',
    `Active call mode: ${mode}.`,
    `Active live intent override: ${intent}.`,
    describeLiveIntentOverride(intent),
    'Apply this override immediately on top of the current call mode until it is changed or cleared.',
  ].join('\n');
}

function buildCallModePolicy(callMode = 'universal', intensityLevel = 'low') {
  const mode = normalizeCallMode(callMode || 'universal');
  if (mode === 'gaming') {
    const isHigh = intensityLevel === 'high';
    const isMedium = intensityLevel === 'medium';
    return {
      handoffPolicy: 'conservative',
      responseStyle: 'short',
      interruptStrictness: 'high',
      proactivity: isHigh ? 'low' : isMedium ? 'medium-low' : 'medium',
      suppressScreenCommentary: isHigh,
      deferNonCriticalCommentary: isHigh || isMedium,
      screenChangeDebounceMs: isHigh ? 5200 : isMedium ? 4200 : 3200,
      modeDecision: isHigh
        ? 'gaming:high-intensity-suppress-noncritical'
        : isMedium
          ? 'gaming:medium-intensity-defer-fyi'
          : 'gaming:normal-copilot',
      modeReason: isHigh
        ? 'Rapid screen motion suggests active gameplay; suppressing non-critical chatter.'
        : isMedium
          ? 'Moderate gameplay activity detected; defer FYI commentary until a calmer gap.'
          : 'Gaming mode favors short copilot-style commentary.',
    };
  }
  if (mode === 'observe') {
    return {
      handoffPolicy: 'normal',
      responseStyle: 'minimal',
      interruptStrictness: 'high',
      proactivity: 'low',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: true,
      screenChangeDebounceMs: 5200,
      modeDecision: 'observe:quiet-monitoring',
      modeReason: 'Observe mode stays quiet unless something clearly useful changes.',
    };
  }
  if (mode === 'guide') {
    return {
      handoffPolicy: 'normal',
      responseStyle: 'guided',
      interruptStrictness: 'normal',
      proactivity: 'high',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: false,
      screenChangeDebounceMs: 2400,
      modeDecision: 'guide:step-by-step',
      modeReason: 'Guide mode is more proactive and step-oriented.',
    };
  }
  if (mode === 'operator') {
    return {
      handoffPolicy: 'aggressive',
      responseStyle: 'directive',
      interruptStrictness: 'normal',
      proactivity: 'high',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: false,
      screenChangeDebounceMs: 2600,
      modeDecision: 'operator:action-biased',
      modeReason: 'Operator mode favors routing real work quickly and speaking in action-biased summaries.',
    };
  }
  if (mode === 'record') {
    const isHigh = intensityLevel === 'high';
    const isMedium = intensityLevel === 'medium';
    return {
      handoffPolicy: 'normal',
      responseStyle: 'concise-review',
      interruptStrictness: 'high',
      proactivity: isHigh ? 'low' : 'medium-low',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: true,
      screenChangeDebounceMs: isHigh ? 5600 : isMedium ? 4600 : 4000,
      modeDecision: isHigh
        ? 'record:hold-for-cleaner-transition'
        : isMedium
          ? 'record:defer-noncritical'
          : 'record:review-friendly',
      modeReason: isHigh
        ? 'Record mode is holding commentary during busy visual churn to keep output cleaner for later review.'
        : isMedium
          ? 'Record mode is deferring non-critical commentary until the visual state settles.'
          : 'Record mode favors concise, review-friendly commentary.',
    };
  }
  if (mode === 'assist') {
    const isHigh = intensityLevel === 'high';
    return {
      handoffPolicy: 'normal',
      responseStyle: 'helpful-brief',
      interruptStrictness: isHigh ? 'high' : 'normal',
      proactivity: isHigh ? 'medium-low' : 'medium',
      suppressScreenCommentary: false,
      deferNonCriticalCommentary: isHigh,
      screenChangeDebounceMs: isHigh ? 3600 : 3000,
      modeDecision: isHigh ? 'assist:back-off-during-busy-state' : 'assist:balanced-help',
      modeReason: isHigh
        ? 'Assist mode is easing back during a busy moment to avoid piling on.'
        : 'Assist mode keeps Fairy helpful, brief, and supportive without overdriving.',
    };
  }
  return {
    handoffPolicy: 'normal',
    responseStyle: 'normal',
    interruptStrictness: 'normal',
    proactivity: 'medium',
    suppressScreenCommentary: false,
    deferNonCriticalCommentary: false,
    screenChangeDebounceMs: 3500,
    modeDecision: `${mode}:baseline`,
    modeReason: 'Universal mode keeps normal Fairy behavior enabled.',
  };
}

function inferGamingIntensity(payload = {}, session = {}) {
  const avgDiff = Number(payload.avgDiff || session?.lastScreenChange?.avgDiff || 0);
  const changedRatio = Number(payload.changedRatio || session?.lastScreenChange?.changedRatio || 0);
  if (avgDiff >= 24 || changedRatio >= 0.34) return 'high';
  if (avgDiff >= 14 || changedRatio >= 0.18) return 'medium';
  return 'low';
}

function classifyScreenChangeCallout(payload = {}, frameMeta = {}, session = {}) {
  const avgDiff = Number(payload.avgDiff || 0);
  const changedRatio = Number(payload.changedRatio || 0);
  const reason = String(frameMeta.reason || '').toLowerCase();
  const label = String(frameMeta.trackLabel || '').toLowerCase();
  const visualSummary = String(session?.visualMemory?.current?.summary || '').toLowerCase();
  const intense = session.callMode === 'gaming' ? inferGamingIntensity(payload, session) : 'low';
  const hay = `${reason} ${label} ${visualSummary}`;

  const has = (re) => re.test(hay);
  const menuLike = has(/inventory|menu|pause|settings|loadout|quest|journal|craft|store|shop|vendor|talent|skill|character|party|backpack|arsenal|equipment/);
  const mapLike = has(/map|world map|minimap|objective|quest path|waypoint|marker|fast travel|region/);
  const scoreboardLike = has(/scoreboard|score board|leaderboard|round over|victory|defeat|match results|placement|rank up|ranked/);
  const respawnLike = has(/respawn|spectat|eliminat|you died|death|knocked|revive|wipe|game over/);
  const hudLike = has(/hud|crosshair|ammo|health|shield|mana|stamina|cooldown|ability|ultimate|objective timer/);
  const combatLike = has(/combat|fight|battle|gunfire|explosion|firefight|boss|enemy|wave|damage/) || (intense === 'high' && !menuLike && !mapLike && !scoreboardLike && !respawnLike);
  const transitionLike = /screen-change/.test(reason) && (avgDiff >= 24 || changedRatio >= 0.34);

  if (respawnLike || scoreboardLike) {
    return { tier: '1', kind: 'critical', summary: respawnLike ? 'death/respawn or spectator-state transition' : 'scoreboard or round-result transition', semantic: respawnLike ? 'respawn' : 'scoreboard' };
  }
  if (transitionLike && !menuLike && !mapLike && !hudLike) {
    return { tier: '1', kind: 'critical', summary: 'major gameplay/state transition', semantic: 'transition' };
  }
  if (mapLike || menuLike) {
    return { tier: '2', kind: 'important', summary: mapLike ? 'map/objective navigation state change' : 'menu or inventory state change', semantic: mapLike ? 'map' : 'menu' };
  }
  if (combatLike && intense === 'high') {
    return { tier: '3', kind: 'fyi', summary: 'high-motion combat churn without a clear semantic UI shift', semantic: 'combat' };
  }
  if (hudLike) {
    return { tier: intense === 'high' ? '3' : '2', kind: intense === 'high' ? 'fyi' : 'important', summary: 'HUD or status-state update', semantic: 'hud' };
  }
  if (avgDiff >= 18 || changedRatio >= 0.22) {
    return { tier: '2', kind: 'important', summary: 'notable visual state change', semantic: 'state' };
  }
  return { tier: '3', kind: 'fyi', summary: 'minor visual update', semantic: 'minor' };
}

function buildCallDebugState(session = {}) {
  return {
    sessionId: session.id || '',
    lastScreenFrameAt: session.lastScreenFrameAt || null,
    lastScreenFrameMeta: session.lastScreenFrameMeta || null,
    lastCameraFrameAt: session.lastCameraFrameAt || null,
    lastCameraFrameMeta: session.lastCameraFrameMeta || null,
    lastScreenChange: session.lastScreenChange || null,
    lastGeminiHint: session.lastGeminiHint || '',
    lastGeminiHintAt: session.lastGeminiHintAt || null,
    lastVisualAssumption: session.lastVisualAssumption || '',
    lastVisualConfidence: session.lastVisualConfidence || '',
    callMode: session.callMode || 'universal',
    liveIntentOverride: normalizeLiveIntentOverride(session.liveIntentOverride || ''),
    liveIntentStatus: describeLiveIntentOverride(session.liveIntentOverride || ''),
    modeDecision: session.modeDecision || '',
    modeReason: session.modeReason || '',
    intensityLevel: session.intensityLevel || 'low',
    lastCalloutTier: session.lastCalloutTier || '',
    speechSuppressedReason: session.speechSuppressedReason || '',
    handoffPolicy: session.handoffPolicy || '',
    proactivity: session.proactivity || '',
    responseStyle: session.responseStyle || '',
    lastRoutingDecision: session.lastRoutingDecision || '',
    lastTaskSummary: session.lastTaskSummary || '',
    visualMemory: summarizeVisualMemory(session.visualMemory || {}),
  };
}

function broadcastCallDebugState(sessionId) {
  const session = getCallSession(sessionId);
  if (!session) return;
  broadcast({
    type: 'call:debug.state',
    data: {
      sessionId,
      debug: buildCallDebugState(session),
    },
  });
}

function pushVisualMemoryEntry(sessionId, entry = {}, patch = {}) {
  const session = getCallSession(sessionId);
  if (!session) return null;
  const existing = session.visualMemory || {};
  const recent = [
    {
      observedAt: new Date().toISOString(),
      summary: '',
      confidence: '',
      ...entry,
    },
    ...(Array.isArray(existing.recent) ? existing.recent : []),
  ].slice(0, 8);
  const visualMemory = {
    current: entry.current || existing.current || null,
    recent,
    lastStableScreenFrameAt: existing.lastStableScreenFrameAt || null,
    lastStableScreenFrameMeta: existing.lastStableScreenFrameMeta || null,
    lastChangeAt: existing.lastChangeAt || null,
    lastChangeSummary: existing.lastChangeSummary || '',
    ...patch,
  };
  return updateCallSession(sessionId, { visualMemory });
}

function describeVisualSurface(meta = {}) {
  const bits = [];
  if (meta.displaySurface) bits.push(meta.displaySurface);
  if (meta.videoWidth && meta.videoHeight) bits.push(`${meta.videoWidth}x${meta.videoHeight}`);
  if (meta.trackLabel) bits.push(meta.trackLabel.slice(0, 80));
  return bits.join(' · ');
}

function inferVisualConfidence(meta = {}, session = {}, { duringTransition = false } = {}) {
  if (!meta || !meta.stable) return 'low';
  if (duringTransition) return 'medium';
  const lastChange = session?.lastScreenChange || null;
  if (lastChange?.at) {
    const ageMs = Date.now() - new Date(lastChange.at).getTime();
    if (Number.isFinite(ageMs) && ageMs < 4500) return 'medium';
  }
  return 'high';
}

function buildStableVisualSnapshot(meta = {}, session = {}) {
  const previous = session?.visualMemory?.current || null;
  const confidence = inferVisualConfidence(meta, session);
  const surfaceText = describeVisualSurface(meta);
  let summary = 'Stable screen frame received.';
  if (surfaceText) summary = `Stable ${surfaceText} frame received.`;
  if (previous?.summary && previous.summary === summary) {
    summary = `${summary} Visual context appears consistent with the previous stable state.`;
  }
  return {
    source: 'screen',
    observedAt: new Date().toISOString(),
    confidence,
    pageGuess: '',
    appGuess: '',
    routeGuess: '',
    visibleTexts: [],
    uiState: {
      loading: false,
      modalOpen: false,
      errorVisible: false,
      blocked: false,
      transitional: false,
    },
    importantElements: [],
    summary,
    surface: meta.displaySurface || '',
    trackLabel: meta.trackLabel || '',
    frameId: meta.frameId || 0,
  };
}

function summarizeStableVisualDelta(previousMeta = {}, nextMeta = {}, session = {}) {
  if (!previousMeta || !previousMeta.frameId) {
    return {
      summary: 'First stable visual state captured for this screen-sharing run.',
      assumption: 'Fairy now has a stable screen frame and can start rebuilding current visual awareness carefully.',
      confidence: inferVisualConfidence(nextMeta, session),
    };
  }
  const changes = [];
  if ((previousMeta.trackLabel || '') && (nextMeta.trackLabel || '') && previousMeta.trackLabel !== nextMeta.trackLabel) {
    changes.push('capture target label changed');
  }
  if ((previousMeta.displaySurface || '') && (nextMeta.displaySurface || '') && previousMeta.displaySurface !== nextMeta.displaySurface) {
    changes.push(`surface changed from ${previousMeta.displaySurface} to ${nextMeta.displaySurface}`);
  }
  if (previousMeta.videoWidth !== nextMeta.videoWidth || previousMeta.videoHeight !== nextMeta.videoHeight) {
    changes.push(`frame size changed from ${previousMeta.videoWidth || 0}x${previousMeta.videoHeight || 0} to ${nextMeta.videoWidth || 0}x${nextMeta.videoHeight || 0}`);
  }
  if ((nextMeta.reason || '').includes('screen-change')) {
    changes.push('a meaningful screen transition finished and stabilized');
  }
  if (!changes.length) changes.push('visual context appears consistent with the previous stable frame');
  const confidence = inferVisualConfidence(nextMeta, session, { duringTransition: /change/i.test(nextMeta.reason || '') });
  return {
    summary: changes.join('; '),
    assumption: changes.some((item) => /changed|transition/.test(item))
      ? 'Visual context likely changed; Fairy should favor the newest stable frame and avoid stale page assumptions.'
      : 'Visual context appears stable enough to keep current assumptions unless visible text contradicts them.',
    confidence,
  };
}

function flushDeferredScreenCommentary(sessionId, reason = 'calm-gap') {
  const pending = liveScreenChangePrompts.get(sessionId) || {};
  if (!pending.pendingPayload) return false;
  const session = getCallSession(sessionId);
  if (!session || !session.active || !session.screenShareActive) return false;
  const live = liveGeminiSessions.get(sessionId);
  if (!live) return false;
  const payload = pending.pendingPayload;
  const intensityLevel = session.callMode === 'gaming' ? inferGamingIntensity(payload, session) : (session.intensityLevel || 'low');
  const modePolicy = buildEffectiveCallPolicy(session.callMode || 'universal', intensityLevel, session.liveIntentOverride || '');
  if (session.callMode === 'gaming' && !session.liveIntentOverride && intensityLevel !== 'low') return false;
  liveScreenChangePrompts.set(sessionId, { ...pending, pendingPayload: null, lastFlushAt: Date.now(), flushReason: reason });
  updateCallSession(sessionId, {
    intensityLevel,
    speechSuppressedReason: '',
    modeDecision: session.callMode === 'gaming' && !session.liveIntentOverride ? 'gaming:calm-gap-release' : (modePolicy.modeDecision || session.modeDecision || ''),
    modeReason: session.callMode === 'gaming' && !session.liveIntentOverride ? 'Queued FYI commentary was released after intensity dropped.' : (modePolicy.modeReason || session.modeReason || ''),
  });
  broadcast({ type: 'call:debug', data: { sessionId, message: `Releasing deferred screen commentary after ${reason}.` } });
  maybePromptScreenChange(sessionId, { ...payload, forceFlush: true, releaseReason: reason });
  return true;
}

function maybePromptScreenChange(sessionId, payload = {}) {
  const session = getCallSession(sessionId);
  if (!session || !session.active || !session.screenShareActive) return;
  const live = liveGeminiSessions.get(sessionId);
  if (!live) return;
  const now = Date.now();
  const existingPrompt = liveScreenChangePrompts.get(sessionId) || {};
  const forceFlush = payload.forceFlush === true;
  const releaseReason = String(payload.releaseReason || '').trim();
  const avgDiff = Number(payload.avgDiff || 0);
  const changedRatio = Number(payload.changedRatio || 0);
  const frameMeta = sanitizeFrameMeta(payload.frameMeta || session.lastScreenFrameMeta || {});
  const intensityLevel = session.callMode === 'gaming' ? inferGamingIntensity(payload, session) : (session.intensityLevel || 'low');
  const modePolicy = buildEffectiveCallPolicy(session.callMode || 'universal', intensityLevel, session.liveIntentOverride || '');
  const callout = classifyScreenChangeCallout(payload, frameMeta, session);
  const effectivePayload = existingPrompt.pendingPayload && intensityLevel === 'low'
    ? {
        ...existingPrompt.pendingPayload,
        avgDiff: Math.max(Number(existingPrompt.pendingPayload.avgDiff || 0), avgDiff),
        changedRatio: Math.max(Number(existingPrompt.pendingPayload.changedRatio || 0), changedRatio),
        frameMeta,
      }
    : payload;

  updateCallSession(sessionId, {
    intensityLevel,
    handoffPolicy: modePolicy.handoffPolicy,
    proactivity: modePolicy.proactivity,
    responseStyle: modePolicy.responseStyle,
    modeDecision: modePolicy.modeDecision,
    modeReason: modePolicy.modeReason,
    speechSuppressedReason: modePolicy.suppressScreenCommentary ? 'combat' : modePolicy.deferNonCriticalCommentary && (callout.tier === '3' || ((session.callMode === 'record' || session.callMode === 'observe') && callout.tier !== '1')) ? 'cooldown' : '',
    lastCalloutTier: callout.tier,
  });

  if (!forceFlush && existingPrompt.lastAt && now - existingPrompt.lastAt < modePolicy.screenChangeDebounceMs) {
    liveScreenChangePrompts.set(sessionId, { ...existingPrompt, pendingPayload: effectivePayload, lastSkippedAt: now, lastTier: callout.tier });
    broadcastCallDebugState(sessionId);
    return;
  }

  if (!forceFlush && modePolicy.suppressScreenCommentary && callout.tier !== '1') {
    liveScreenChangePrompts.set(sessionId, { ...existingPrompt, pendingPayload: effectivePayload, lastSkippedAt: now, lastTier: callout.tier });
    broadcast({ type: 'call:debug', data: { sessionId, message: `Gaming mode suppressed ${callout.semantic || callout.kind} screen commentary at intensity=${intensityLevel} (${avgDiff}/${changedRatio}).` } });
    broadcastCallDebugState(sessionId);
    return;
  }

  if (!forceFlush && modePolicy.deferNonCriticalCommentary && (callout.tier === '3' || ((session.callMode === 'record' || session.callMode === 'observe') && callout.tier !== '1'))) {
    liveScreenChangePrompts.set(sessionId, { ...existingPrompt, pendingPayload: effectivePayload, lastSkippedAt: now, lastTier: callout.tier });
    broadcast({ type: 'call:debug', data: { sessionId, message: `Gaming mode deferred ${callout.semantic || 'fyi'} commentary until a calmer gap (${avgDiff}/${changedRatio}).` } });
    broadcastCallDebugState(sessionId);
    return;
  }

  const promptAvgDiff = Number(effectivePayload.avgDiff || avgDiff || 0);
  const promptChangedRatio = Number(effectivePayload.changedRatio || changedRatio || 0);
  const metaLine = describeFrameMeta(frameMeta);
  const currentVisual = session.visualMemory?.current || null;
  const previousVisual = Array.isArray(session.visualMemory?.recent) ? session.visualMemory.recent[0] : null;
  const overrideLine = session.liveIntentOverride ? `Live intent override: ${session.liveIntentOverride}; ${describeLiveIntentOverride(session.liveIntentOverride)}` : '';
  const modeLine = session.callMode === 'gaming'
    ? `Gaming callout policy: tier ${callout.tier} (${callout.kind}); intensity=${intensityLevel}; use short copilot phrasing${releaseReason ? `; this was deferred until a calm gap after ${releaseReason}` : ''}.`
    : session.callMode === 'record'
      ? `Record callout policy: tier ${callout.tier} (${callout.kind}); intensity=${intensityLevel}; prefer concise review-friendly notes, not live narration${releaseReason ? `; this was deferred until the state settled after ${releaseReason}` : ''}.`
      : session.callMode === 'assist'
        ? `Assist callout policy: tier ${callout.tier} (${callout.kind}); intensity=${intensityLevel}; be helpful and brief, and avoid piling on during busy moments${releaseReason ? `; this was deferred until a better moment after ${releaseReason}` : ''}.`
        : '';
  const prompt = [
    'SYSTEM EVENT FOR LIVE CALL:',
    'The shared screen changed noticeably after a stabilized post-change frame was uploaded.',
    `Current call state: ${String(session.state || 'unknown')}`,
    `Change strength: avgDiff=${promptAvgDiff || 0}, changedRatio=${promptChangedRatio || 0}`,
    `Callout tier: ${callout.tier} (${callout.kind})`,
    `Semantic class: ${callout.semantic || 'general'}`,
    `Change interpretation: ${callout.summary}`,
    metaLine ? `Newest frame metadata: ${metaLine}` : '',
    currentVisual?.summary ? `Current visual memory: ${currentVisual.summary}` : '',
    previousVisual?.summary ? `Recent prior visual summary: ${previousVisual.summary}` : '',
    modeLine,
    overrideLine,
    'Use the newest stable screen frame as visual context. Prefer the newest stable state over older assumptions. Do not identify a website, app, tab, or route unless visible text/UI clearly supports it. If the frame looks blank, partially loaded, or transitional, say it appears to still be loading instead of guessing.',
    callout.tier === '1'
      ? 'If this looks critical or obvious, comment immediately in one short game-copilot line. Prefer fragments like "Respawn screen." or "Objective changed."'
      : callout.tier === '2'
        ? 'If this is useful and user-visible, comment briefly now in one short copilot line. Avoid explanation unless Epic asks.'
        : session.callMode === 'record'
          ? 'Only comment if it creates a useful review note. Keep it short, neutral, and recap-friendly. Otherwise stay quiet.'
          : session.callMode === 'assist'
            ? 'Only comment if it helps Epic in the moment. Keep it brief and practical. Otherwise stay quiet.'
            : 'Only comment if there is a genuinely useful short FYI. One brief line max. Otherwise stay quiet.',
  ].filter(Boolean).join('\n');

  updateCallSession(sessionId, {
    lastGeminiHint: prompt,
    lastGeminiHintAt: new Date().toISOString(),
    lastVisualAssumption: 'Recent major screen change; favor the newest stable frame and avoid stale app/page guesses until visible UI confirms them.',
    lastVisualConfidence: frameMeta?.stable ? 'medium' : 'low',
    speechSuppressedReason: '',
    lastCalloutTier: callout.tier,
    modeDecision: releaseReason ? 'gaming:calm-gap-release' : modePolicy.modeDecision,
    modeReason: releaseReason ? `Released deferred ${callout.kind} commentary after ${releaseReason}.` : modePolicy.modeReason,
    visualMemory: {
      ...(session.visualMemory || {}),
      lastChangeAt: new Date().toISOString(),
      lastChangeSummary: `${callout.semantic || 'general'} · ${callout.summary} (${promptAvgDiff || 0}/${promptChangedRatio || 0}).`,
    },
  });
  broadcast({ type: 'call:debug', data: { sessionId, message: `Prompting Fairy with screen change tier=${callout.tier} (${promptAvgDiff}/${promptChangedRatio}) while state=${session.state || 'unknown'}.` } });
  broadcastCallDebugState(sessionId);
  try {
    liveScreenChangePrompts.set(sessionId, { lastAt: Date.now(), pendingPayload: null, lastTier: callout.tier });
    live.sendTextTurn(prompt);
  } catch (err) {
    broadcast({ type: 'call:error', data: { sessionId, message: err.message || 'Could not send screen-change hint to Gemini' } });
  }
}

function broadcastRecordingCommand(sessionId, action, extra = {}) {
  broadcast({ type: 'call:recording.command', data: { sessionId, action, ...extra } });
  broadcast({ type: 'call:debug', data: { sessionId, message: `Recording command sent: ${action}` } });
}

function maybeAnnounceLiveTaskResult(msg) {
  if (msg?.type !== 'live_task:update') return;
  const task = msg.data || {};
  const taskId = String(task.id || '').trim();
  const status = String(task.status || '').trim();
  if (!taskId || !['completed', 'failed', 'needs_input'].includes(status)) return;
  const announcementKey = `${taskId}:${status}`;
  if (announcedLiveTaskResults.has(announcementKey)) return;

  const session = findSessionForLiveTask(taskId);
  if (!session) return;
  const live = liveGeminiSessions.get(session.id);
  if (!live) return;
  announcedLiveTaskResults.add(announcementKey);
  if (announcedLiveTaskResults.size > 200) {
    const oldest = announcedLiveTaskResults.values().next().value;
    if (oldest) announcedLiveTaskResults.delete(oldest);
  }

  const runtime = String(task.runtime || '').trim() === 'hermes' ? 'hermes' : 'openclaw';
  const runtimeLabel = runtime === 'hermes' ? 'Hermes' : 'OpenClaw';
  const title = compactForSpeech(task.title || session.handoffTitle || `${runtimeLabel} task`, 180);
  const agent = compactForSpeech(task.agent || session.agent || runtimeLabel, 80);
  const summary = compactForSpeech(task.summary || '', 700);
  const result = compactForSpeech(task.result || task.error || '', 1800);
  const statusLine = status === 'completed'
    ? `The ${runtimeLabel} agent finished successfully.`
    : status === 'needs_input'
      ? `The ${runtimeLabel} agent needs more input from Epic.`
      : `The ${runtimeLabel} agent failed.`;
  const prompt = [
    'SYSTEM EVENT FOR LIVE CALL:',
    statusLine,
    `Agent: ${agent}`,
    `Task: ${title}`,
    summary ? `Summary: ${summary}` : '',
    result ? `Result/detail: ${result}` : '',
    'Now tell Epic about this result out loud in your Fairy voice. Keep it concise, useful, and do not claim you personally did the backend work. Mention if Epic needs to answer or act next.',
  ].filter(Boolean).join('\n');

  const updated = setCallSessionState(session.id, 'thinking', {
    handoffTaskId: taskId,
    handoffTitle: title,
    lastTaskSummary: summary || result || statusLine,
  }, { broadcastState: false });
  broadcastCallDebugState(session.id);
  broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Prompting Fairy to announce live task ${taskId} (${status}).` } });
  broadcast({ type: 'call:session.state', data: { sessionId: session.id, state: updated?.state || 'thinking', session: updated || session } });
  try {
    live.sendTextTurn(prompt);
  } catch (err) {
    broadcast({ type: 'call:error', data: { sessionId: session.id, message: err.message || 'Failed to prompt Fairy with task result' } });
  }
}

function armLiveWatchdog(sessionId, text, { broadcast }) {
  clearLiveWatchdog(sessionId);
  const timer = setTimeout(() => {
    const session = getCallSession(sessionId);
    if (!session || !session.active) return;
    if ((session.currentTurnGeminiEventCount || 0) > 0) return;
    const hint = session.partialTranscript || session.lastTranscript || text || 'Hello?';
    broadcast({
      type: 'call:debug',
      data: {
        sessionId,
        message: `No Gemini response for current turn after ${session.currentTurnAudioChunks || 0} audio chunks (${session.uplinkAudioChunks || 0} total). Falling back to text turn. Last heard: ${String(hint).slice(0, 120)}`,
      },
    });
    const live = liveGeminiSessions.get(sessionId);
    if (live && hint) {
      try {
        live.sendTextTurn(hint);
        broadcast({ type: 'call:debug', data: { sessionId, message: 'Sent forced text fallback turn to Gemini.' } });
      } catch (err) {
        broadcast({ type: 'call:error', data: { sessionId, message: err.message || 'Forced text fallback failed' } });
      }
    }
  }, 4000);
  liveGeminiWatchdogs.set(sessionId, timer);
}

app.get(`${basePath}/api/status`, async (req, res) => {
  const bridgeStatus = bridge.getStatus();
  const voiceSettings = await loadVoiceSettings();
  const issues = [];
  const configuredDemo = !!bridgeStatus.configuredDemo;
  const relayOnlyMode = !!bridgeStatus.relayOnlyMode;
  const fellBackToDemo = !configuredDemo && !relayOnlyMode && bridgeStatus.mode === 'demo';
  const liveConnected = !configuredDemo && !relayOnlyMode && bridgeStatus.mode === 'live' && bridgeStatus.connected;

  if (relayOnlyMode) {
    issues.push({ level: 'info', code: 'RELAY_ONLY_MODE_ENABLED', message: 'CommandCenter is running in relay-only mode. Local OpenClaw gateway connectivity is intentionally disabled.' });
  } else if (configuredDemo) {
    issues.push({ level: 'info', code: 'DEMO_MODE_ENABLED', message: 'CommandCenter is running in demo mode. Agent activity may be simulated.' });
  } else if (fellBackToDemo) {
    issues.push({ level: 'warn', code: 'FALLBACK_TO_DEMO', message: `Live gateway connection failed, so CommandCenter fell back to demo mode${bridgeStatus.lastFallbackReason ? ` (${bridgeStatus.lastFallbackReason})` : ''}.` });
  }

  if (!configuredDemo && !relayOnlyMode && !bridgeStatus.gatewayTokenConfigured) {
    issues.push({ level: 'warn', code: 'GATEWAY_TOKEN_MISSING', message: 'No gateway token is configured for live OpenClaw mode.' });
  }

  if (!relayOnlyMode && bridgeStatus.lastAuthError) {
    issues.push({ level: 'error', code: 'GATEWAY_AUTH_FAILED', message: `Gateway authentication failed: ${bridgeStatus.lastAuthError}` });
  }

  if (!voiceSettings.sttApiBase && voiceSettings.sttMode === 'api') {
    issues.push({ level: 'warn', code: 'STT_API_BASE_MISSING', message: 'AIChat STT API mode is selected, but no STT API base URL is configured.' });
  }

  res.json({
    uptime: process.uptime(),
    bridge: bridgeStatus,
    clients: wss.clients.size,
    voiceEnabled: true,
    agents: roster.agents,
    primaryAgentId: roster.primaryAgentId,
    setup: {
      mode: relayOnlyMode ? 'relay-only' : configuredDemo ? 'demo' : fellBackToDemo ? 'demo-fallback' : liveConnected ? 'live' : 'connecting',
      modeLabel: relayOnlyMode ? 'Relay-only mode' : configuredDemo ? 'Demo mode' : fellBackToDemo ? 'Demo fallback' : liveConnected ? 'Live OpenClaw' : 'Connecting to OpenClaw',
      demoMode: configuredDemo,
      relayOnlyMode,
      requestedMode: bridgeStatus.requestedMode,
      actualMode: bridgeStatus.mode,
      gatewayConnected: bridgeStatus.connected,
      gatewayTokenConfigured: bridgeStatus.gatewayTokenConfigured,
      gatewayTokenSource: bridgeStatus.gatewayTokenSource,
      sttMode: voiceSettings.sttMode || 'api',
      sttProvider: voiceSettings.sttApiProvider || 'fish',
      ttsProvider: voiceSettings.provider || 'elevenlabs',
      issues,
    },
  });
});

app.get(`${basePath}/api/agents`, async (req, res) => {
  const roster = getRoster();
  const companionSettings = await loadCompanionSettings();
  const companionRegistry = await loadCompanionRegistry(basePath);
  res.json({
    agents: roster.agents.map((agent) => ({
      ...agent,
      visual: resolveAgentVisual(agent.id, companionSettings, companionRegistry),
    })),
    primaryAgentId: roster.primaryAgentId,
  });
});

app.get(`${basePath}/api/v1/agents`, async (req, res) => {
  const roster = getRoster();
  const companionSettings = await loadCompanionSettings();
  const companionRegistry = await loadCompanionRegistry(basePath);
  res.json({
    ok: true,
    agents: roster.agents.map((agent) => ({
      ...agent,
      visual: resolveAgentVisual(agent.id, companionSettings, companionRegistry),
    })),
    primaryAgentId: roster.primaryAgentId,
  });
});

app.get(`${basePath}/api/v1/agents/search`, (req, res) => {
  const roster = getRoster();
  const q = String(req.query?.q || '').trim();
  const limit = Number(req.query?.limit || 10);
  res.json({
    ok: true,
    query: q,
    results: searchAgents(q, roster, limit),
  });
});

app.get(`${basePath}/api/v1/files`, async (req, res) => {
  try {
    const manifest = await readChatManifest();
    const items = [...manifest.items].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).map(toChatFileRecord);
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/files/upload`, upload.array('files', 10), enforceUploadBudget({ maxFiles: 10, maxBytes: 25 * 1024 * 1024 }), async (req, res) => {
  try {
    await ensureChatLibrary();
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ ok: false, error: 'No files uploaded', code: 'BAD_REQUEST' });

    const manifest = await readChatManifest();
    const created = [];

    for (const file of files) {
      const id = randomUUID();
      const ext = extname(file.originalname || '') || '';
      const safeOriginal = sanitizeName(file.originalname || `upload${ext}`);
      const savedName = `${id}${ext}`;
      const savedPath = join(chatFilesDir, savedName);
      await fsp.writeFile(savedPath, await uploadedBuffer(file));
      const item = {
        id,
        kind: 'file',
        name: safeOriginal,
        originalName: file.originalname || safeOriginal,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size || 0,
        createdAt: Date.now(),
        path: savedPath,
        ext,
      };
      manifest.items.push(item);
      created.push(toChatFileRecord(item));
    }

    await writeChatManifest(manifest);
    res.json({ ok: true, items: created });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/files/link`, async (req, res) => {
  try {
    const sourceUrl = String(req.body?.url || '').trim();
    const name = String(req.body?.name || '').trim() || sourceUrl;
    const notes = String(req.body?.notes || '').trim();
    if (!sourceUrl) return res.status(400).json({ ok: false, error: 'url is required', code: 'BAD_REQUEST' });

    const manifest = await readChatManifest();
    const item = {
      id: randomUUID(),
      kind: 'link',
      name: name.slice(0, 180),
      originalName: name.slice(0, 180),
      mimeType: 'text/uri-list',
      size: 0,
      createdAt: Date.now(),
      sourceUrl,
      notes,
      path: '',
      ext: '',
    };
    manifest.items.push(item);
    await writeChatManifest(manifest);
    res.json({ ok: true, item: toChatFileRecord(item) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/files/:id/download`, async (req, res) => {
  try {
    const manifest = await readChatManifest();
    const item = manifest.items.find((entry) => String(entry.id) === String(req.params.id));
    if (!item) return res.status(404).json({ ok: false, error: 'File not found', code: 'FILE_NOT_FOUND' });
    if (item.kind === 'link') return res.redirect(item.sourceUrl);
    if (!item.path || !existsSync(item.path)) return res.status(404).json({ ok: false, error: 'Stored file missing', code: 'FILE_NOT_FOUND' });
    res.download(item.path, item.originalName || item.name || 'download');
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/settings/gemini`, async (req, res) => {
  const settings = await loadGeminiSettings();
  const runtime = await loadGeminiRuntimeConfig();
  res.json({
    ok: true,
    settings: {
      hasApiKey: !!runtime.hasApiKey,
      apiKeyMasked: maskApiKey(settings.apiKey || runtime.apiKey || ''),
      model: settings.model || runtime.model,
      responseModalities: settings.responseModalities || runtime.responseModalities || ['AUDIO'],
      thinkingLevel: settings.thinkingLevel || runtime.thinkingLevel || 'minimal',
      voiceName: settings.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
      liveVoiceName: settings.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
      speechOutputMode: settings.speechOutputMode || runtime.speechOutputMode || 'gemini',
      fishVoiceId: settings.fishVoiceId || runtime.fishVoiceId || '',
      personaName: settings.personaName || runtime.personaName || 'Fairy',
      operatorName: settings.operatorName || runtime.operatorName || 'Epic',
      personalityPrompt: settings.personalityPrompt || runtime.personalityPrompt || '',
      memoryEnabled: settings.memoryEnabled ?? runtime.memoryEnabled ?? true,
      memoryNotes: settings.memoryNotes || runtime.memoryNotes || '',
      callMode: settings.callMode || runtime.callMode || 'universal',
      liveIntentOverride: '',
      availableCallModes: FAIRY_CALL_MODE_OPTIONS,
      availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
      source: runtime.source || 'command-center-local',
      usingEnvKey: String(runtime.source || '').startsWith('env:'),
    },
  });
});

app.post(`${basePath}/api/settings/gemini`, async (req, res) => {
  try {
    const existing = await loadGeminiSettings();
    const body = req.body || {};
    const next = {
      apiKey: body.apiKey ? String(body.apiKey).trim() : existing.apiKey,
      model: body.model !== undefined ? String(body.model || '').trim() : existing.model,
      responseModalities: body.responseModalities !== undefined ? body.responseModalities : existing.responseModalities,
      thinkingLevel: body.thinkingLevel !== undefined ? String(body.thinkingLevel || '').trim() : existing.thinkingLevel,
      voiceName: body.voiceName !== undefined ? String(body.voiceName || '').trim() : existing.voiceName,
      speechOutputMode: body.speechOutputMode !== undefined ? String(body.speechOutputMode || '').trim() : existing.speechOutputMode,
      fishVoiceId: body.fishVoiceId !== undefined ? String(body.fishVoiceId || '').trim() : existing.fishVoiceId,
      personaName: body.personaName !== undefined ? String(body.personaName || '').trim() : existing.personaName,
      operatorName: body.operatorName !== undefined ? String(body.operatorName || '').trim() : existing.operatorName,
      personalityPrompt: body.personalityPrompt !== undefined ? String(body.personalityPrompt || '') : existing.personalityPrompt,
      memoryEnabled: body.memoryEnabled !== undefined ? body.memoryEnabled !== false : existing.memoryEnabled,
      memoryNotes: body.memoryNotes !== undefined ? String(body.memoryNotes || '') : existing.memoryNotes,
      callMode: body.callMode !== undefined ? String(body.callMode || '').trim() : existing.callMode,
    };
    const saved = await saveGeminiSettings(next);
    const runtime = await loadGeminiRuntimeConfig();
    res.json({
      ok: true,
      settings: {
        hasApiKey: !!runtime.hasApiKey,
        apiKeyMasked: maskApiKey(saved.apiKey || runtime.apiKey || ''),
        model: saved.model,
        responseModalities: saved.responseModalities,
        thinkingLevel: saved.thinkingLevel,
        voiceName: saved.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
        liveVoiceName: saved.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
        speechOutputMode: saved.speechOutputMode || runtime.speechOutputMode || 'gemini',
        fishVoiceId: saved.fishVoiceId || runtime.fishVoiceId || '',
        personaName: saved.personaName || runtime.personaName || 'Fairy',
        operatorName: saved.operatorName || runtime.operatorName || 'Epic',
        personalityPrompt: saved.personalityPrompt || runtime.personalityPrompt || '',
        memoryEnabled: saved.memoryEnabled ?? runtime.memoryEnabled ?? true,
        memoryNotes: saved.memoryNotes || runtime.memoryNotes || '',
        callMode: saved.callMode || runtime.callMode || 'universal',
        availableCallModes: FAIRY_CALL_MODE_OPTIONS,
        availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
        source: runtime.source || 'command-center-local',
        usingEnvKey: String(runtime.source || '').startsWith('env:'),
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/settings/voice`, async (req, res) => {
  const settings = await loadVoiceSettings();
  res.json({
    ok: true,
    settings: {
      provider: settings.provider || 'elevenlabs',
      hasApiKey: !!settings.elevenlabsApiKey,
      apiKeyMasked: maskApiKey(settings.elevenlabsApiKey),
      defaultVoiceId: settings.defaultVoiceId,
      fishAudioApiBase: settings.fishAudioApiBase,
      fishVoiceId: settings.fishVoiceId,
      hasFishSessionCookie: !!settings.fishSessionCookie,
      fishSessionCookieMasked: maskSessionCookie(settings.fishSessionCookie),
      fishFormat: settings.fishFormat,
      fishIncludeAsteriskNarration: settings.fishIncludeAsteriskNarration === true,
      fishPlaybackMode: settings.fishPlaybackMode || 'auto',
      fishAutoStreamMinChars: settings.fishAutoStreamMinChars || 260,
      sttMode: settings.sttMode || 'api',
      sttApiBase: settings.sttApiBase || 'https://your-domain.example/aichat',
      sttApiProvider: settings.sttApiProvider || 'fish',
      sttLanguage: settings.sttLanguage || 'en',
      hasSttFishApiKey: !!settings.sttFishApiKey,
      sttFishApiKeyMasked: maskApiKey(settings.sttFishApiKey),
      sttFishUsesServerKey: true,
      hasSttOpenAiApiKey: !!settings.sttOpenAiApiKey,
      sttOpenAiApiKeyMasked: maskApiKey(settings.sttOpenAiApiKey),
      hasSttElevenlabsApiKey: !!settings.sttElevenlabsApiKey,
      sttElevenlabsApiKeyMasked: maskApiKey(settings.sttElevenlabsApiKey),
      agentVoices: settings.agentVoices || {},
      elevenlabsAgentVoices: settings.elevenlabsAgentVoices || {},
      fishAgentVoices: settings.fishAgentVoices || {},
    },
  });
});

app.get(`${basePath}/api/settings/companions`, async (req, res) => {
  const settings = await loadCompanionSettings();
  const registry = await loadCompanionRegistry(basePath);
  res.json({
    ok: true,
    settings,
    items: registry,
    resolved: Object.fromEntries(
      roster.agents.map((agent) => [agent.id, resolveAgentVisual(agent.id, settings, registry)]),
    ),
  });
});

app.post(`${basePath}/api/settings/companions`, async (req, res) => {
  try {
    const existing = await loadCompanionSettings();
    const registry = await loadCompanionRegistry(basePath);
    const body = req.body || {};

    if (body.agentVisuals && typeof body.agentVisuals === 'object' && !Array.isArray(body.agentVisuals)) {
      const nextAgentVisuals = { ...(existing.agentVisuals || {}) };
      for (const [agentIdRaw, config] of Object.entries(body.agentVisuals || {})) {
        const agentId = String(agentIdRaw || '').trim();
        const mode = String(config?.mode || 'default').trim().toLowerCase() === 'companion' ? 'companion' : 'default';
        const companionId = String(config?.companionId || '').trim();
        const scaleRaw = Number(config?.scale);
        const scale = Number.isFinite(scaleRaw) ? Math.min(2, Math.max(0.45, scaleRaw)) : 1;
        if (!agentId || !roster.agents.find((agent) => agent.id === agentId)) {
          return res.status(400).json({ ok: false, error: `Unknown agent: ${agentId}`, code: 'UNKNOWN_AGENT' });
        }
        if (mode === 'companion' && !registry.find((item) => item.id === companionId)) {
          return res.status(400).json({ ok: false, error: `Unknown companion package for ${agentId}`, code: 'UNKNOWN_COMPANION' });
        }
        nextAgentVisuals[agentId] = {
          mode,
          companionId: mode === 'companion' ? companionId : '',
          scale,
        };
      }
      const saved = await saveCompanionSettings({
        ...existing,
        agentVisuals: nextAgentVisuals,
      });
      return res.json({
        ok: true,
        settings: saved,
        resolved: Object.fromEntries(
          roster.agents.map((agent) => [agent.id, resolveAgentVisual(agent.id, saved, registry)]),
        ),
      });
    }

    const agentId = String(body.agentId || '').trim();
    const mode = String(body.mode || 'default').trim().toLowerCase() === 'companion' ? 'companion' : 'default';
    const companionId = String(body.companionId || '').trim();
    const scaleRaw = Number(body.scale);
    const scale = Number.isFinite(scaleRaw) ? Math.min(2, Math.max(0.45, scaleRaw)) : 1;
    if (!agentId || !roster.agents.find((agent) => agent.id === agentId)) {
      return res.status(400).json({ ok: false, error: 'Unknown agent', code: 'UNKNOWN_AGENT' });
    }
    if (mode === 'companion' && !registry.find((item) => item.id === companionId)) {
      return res.status(400).json({ ok: false, error: 'Unknown companion package', code: 'UNKNOWN_COMPANION' });
    }
    const saved = await saveCompanionSettings({
      ...existing,
      agentVisuals: {
        ...(existing.agentVisuals || {}),
        [agentId]: {
          mode,
          companionId: mode === 'companion' ? companionId : '',
          scale,
        },
      },
    });
    res.json({
      ok: true,
      settings: saved,
      saved: saved.agentVisuals?.[agentId] || { mode: 'default', companionId: '' },
      resolved: resolveAgentVisual(agentId, saved, registry),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/companions`, async (req, res) => {
  const items = await loadCompanionRegistry(basePath);
  res.json({ ok: true, items });
});

app.post(`${basePath}/api/companions/import`, async (req, res) => {
  try {
    const sourceDir = String(req.body?.sourceDir || '').trim();
    const imported = await importCodexPetPackageFromDir(sourceDir, basePath);
    const items = await loadCompanionRegistry(basePath);
    res.json({ ok: true, item: imported.item, items });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'IMPORT_FAILED' });
  }
});

app.post(`${basePath}/api/companions/import-zip`, upload.single('package'), enforceUploadBudget({ maxFiles: 1, maxBytes: 25 * 1024 * 1024 }), async (req, res) => {
  let tempDir = '';
  try {
    const file = req.file;
    if (!file?.size) {
      return res.status(400).json({ ok: false, error: 'No zip package uploaded', code: 'BAD_REQUEST' });
    }
    const agentId = String(req.body?.agentId || '').trim();
    const zipBuffer = await uploadedBuffer(file);
    if (!(zipBuffer[0] === 0x50 && zipBuffer[1] === 0x4b)) throw new Error('Uploaded package is not a ZIP file');
    tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'cc-pet-import-'));
    const zipPath = join(tempDir, 'package.zip');
    await fsp.writeFile(zipPath, zipBuffer);
    const entries = await new Promise((resolve, reject) => {
      execFile('unzip', ['-Z1', zipPath], { maxBuffer: 1024 * 1024 }, (err, stdout) => err ? reject(err) : resolve(String(stdout || '').split(/\r?\n/).filter(Boolean)));
    });
    if (entries.length > 1000 || entries.some((name) => /(^|[\\/])\.\.([\\/]|$)/.test(name) || /^[\\/]/.test(name) || /^[A-Za-z]:/.test(name))) {
      throw new Error('Unsafe or excessive ZIP contents');
    }
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', zipPath, '-d', tempDir], (err) => err ? reject(err) : resolve());
    });
    await validateExtractedTree(tempDir);
    const imported = await importCodexPetPackageFromDir(tempDir, basePath);
    const items = await loadCompanionRegistry(basePath);
    let assigned = null;
    if (agentId && roster.agents.find((agent) => agent.id === agentId)) {
      const existing = await loadCompanionSettings();
      const saved = await saveCompanionSettings({
        ...existing,
        agentVisuals: {
          ...(existing.agentVisuals || {}),
          [agentId]: { mode: 'companion', companionId: imported.item.id, scale: 1 },
        },
      });
      assigned = resolveAgentVisual(agentId, saved, items);
    }
    res.json({ ok: true, item: imported.item, items, assigned });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'IMPORT_FAILED' });
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.post(`${basePath}/api/companions/import-folder`, upload.array('files', 100), enforceUploadBudget({ maxFiles: 100, maxBytes: 100 * 1024 * 1024 }), async (req, res) => {
  let tempDir = '';
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'No folder files uploaded', code: 'BAD_REQUEST' });
    }
    const uploadedPaths = files.map((file) => String(file.originalname || '').replace(/\\/g, '/')).filter(Boolean);
    console.log('[companions] import-folder upload received', { count: uploadedPaths.length, first: uploadedPaths[0], paths: uploadedPaths.slice(0, 20) });
    const agentId = String(req.body?.agentId || '').trim();
    tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'cc-pet-folder-import-'));
    for (const file of files) {
      const relativePath = String(file.originalname || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relativePath || relativePath.includes('..')) continue;
      const destPath = join(tempDir, relativePath);
      await fsp.mkdir(dirname(destPath), { recursive: true });
      await fsp.writeFile(destPath, await uploadedBuffer(file));
    }
    const imported = await importCodexPetPackageFromDir(tempDir, basePath);
    const items = await loadCompanionRegistry(basePath);
    let assigned = null;
    if (agentId && roster.agents.find((agent) => agent.id === agentId)) {
      const existing = await loadCompanionSettings();
      const saved = await saveCompanionSettings({
        ...existing,
        agentVisuals: {
          ...(existing.agentVisuals || {}),
          [agentId]: { mode: 'companion', companionId: imported.item.id, scale: 1 },
        },
      });
      assigned = resolveAgentVisual(agentId, saved, items);
    }
    res.json({ ok: true, item: imported.item, items, assigned });
  } catch (err) {
    console.error('[companions] import-folder failed:', err?.message || err);
    res.status(400).json({ ok: false, error: err.message, code: 'IMPORT_FAILED' });
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
});

app.get(`${basePath}/api/companions/imports/:slug/*`, async (req, res) => {
  const slug = basename(String(req.params.slug || ''));
  const file = String(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!file || file.includes('..')) return res.status(400).json({ ok: false, error: 'Invalid import asset path', code: 'BAD_REQUEST' });
  const fullPath = join(commandCenterDataDir, 'companions', 'imports', slug, file);
  if (!existsSync(fullPath)) return res.status(404).json({ ok: false, error: 'Imported companion asset not found', code: 'NOT_FOUND' });
  res.sendFile(fullPath);
});

app.get(`${basePath}/api/companions/:id`, async (req, res) => {
  const items = await loadCompanionRegistry(basePath);
  const item = items.find((entry) => String(entry.id) === String(req.params.id));
  if (!item) return res.status(404).json({ ok: false, error: 'Companion not found', code: 'COMPANION_NOT_FOUND' });
  res.json({ ok: true, item });
});


app.get(`${basePath}/api/settings/appearance`, async (req, res) => {
  try {
    const settings = await loadAppearanceSettings();
    const backgrounds = await listWorkspaceBackgrounds();
    const customThemes = Array.isArray(settings.customThemes) ? settings.customThemes : [];
    const themes = [...BUILT_IN_THEMES, ...customThemes];
    const themeId = themes.find((theme) => theme.id === settings.themeId) ? settings.themeId : DEFAULT_THEME_ID;
    const workspaceBackgroundId = backgrounds.find((bg) => bg.id === settings.workspaceBackgroundId) ? settings.workspaceBackgroundId : DEFAULT_WORKSPACE_ID;
    res.json({ ok: true, settings: { ...settings, themeId, workspaceBackgroundId }, themes, backgrounds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/appearance`, async (req, res) => {
  try {
    const existing = await loadAppearanceSettings();
    const backgrounds = await listWorkspaceBackgrounds();
    const customThemes = Array.isArray(existing.customThemes) ? existing.customThemes : [];
    const themes = [...BUILT_IN_THEMES, ...customThemes];
    const themeId = String(req.body?.themeId || existing.themeId || DEFAULT_THEME_ID).trim();
    const workspaceBackgroundId = String(req.body?.workspaceBackgroundId || existing.workspaceBackgroundId || DEFAULT_WORKSPACE_ID).trim();
    const saved = await saveAppearanceSettings({
      ...existing,
      ...req.body,
      themeId: themes.find((theme) => theme.id === themeId) ? themeId : DEFAULT_THEME_ID,
      workspaceBackgroundId: backgrounds.find((bg) => bg.id === workspaceBackgroundId) ? workspaceBackgroundId : DEFAULT_WORKSPACE_ID,
    });
    res.json({ ok: true, settings: saved, themes, backgrounds });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/appearance/theme`, async (req, res) => {
  try {
    const existing = await loadAppearanceSettings();
    const theme = req.body?.theme;
    if (!theme || typeof theme !== 'object') return res.status(400).json({ ok: false, error: 'Missing theme', code: 'BAD_REQUEST' });
    const nextCustomThemes = [...(existing.customThemes || []).filter((item) => item.id !== String(theme.id || '').trim()), {
      id: String(theme.id || '').trim() || `custom-theme-${Date.now()}`,
      name: String(theme.name || 'Custom Theme').trim(),
      builtIn: false,
      colors: theme.colors || {},
    }];
    const saved = await saveAppearanceSettings({ ...existing, themeId: String(theme.id || '').trim(), customThemes: nextCustomThemes });
    res.json({ ok: true, settings: saved, themes: [...BUILT_IN_THEMES, ...(saved.customThemes || [])] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/appearance/background`, upload.single('background'), async (req, res) => {
  try {
    if (!req.file?.size) return res.status(400).json({ ok: false, error: 'No background image uploaded', code: 'BAD_REQUEST' });
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!isAllowedBackgroundExt(ext)) return res.status(400).json({ ok: false, error: 'Unsupported background format', code: 'BAD_REQUEST' });
    const dir = getAppearanceBackgroundDir();
    const base = sanitizeName(basename(String(req.file.originalname || 'workspace'), ext)) || 'workspace';
    let fileName = `${base}${ext}`;
    let fullPath = join(dir, fileName);
    let counter = 2;
    while (existsSync(fullPath)) {
      fileName = `${base}-${counter}${ext}`;
      fullPath = join(dir, fileName);
      counter += 1;
    }
    await fsp.writeFile(fullPath, await uploadedBuffer(req.file));
    const backgrounds = await listWorkspaceBackgrounds();
    const uploaded = backgrounds.find((bg) => bg.filename === fileName) || null;
    const saved = await saveAppearanceSettings({ ...(await loadAppearanceSettings()), workspaceBackgroundId: uploaded?.id || DEFAULT_WORKSPACE_ID });
    res.json({ ok: true, background: uploaded, backgrounds, settings: saved, themes: [...BUILT_IN_THEMES, ...((await loadAppearanceSettings()).customThemes || [])] });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/settings/branding`, async (req, res) => {
  try {
    res.json({ ok: true, settings: await loadBrandingSettings() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/branding`, async (req, res) => {
  try {
    const existing = await loadBrandingSettings();
    const saved = await saveBrandingSettings({ ...existing, ...req.body });
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/branding/logo`, upload.single('logo'), async (req, res) => {
  try {
    if (!req.file?.size) return res.status(400).json({ ok: false, error: 'No logo uploaded', code: 'BAD_REQUEST' });
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) return res.status(400).json({ ok: false, error: 'Unsupported logo format', code: 'BAD_REQUEST' });
    const name = `logo-${Date.now()}${ext}`;
    await fsp.writeFile(join(getBrandingDir(), name), await uploadedBuffer(req.file));
    const saved = await saveBrandingSettings({ ...(await loadBrandingSettings()), logoUrl: `${basePath}/media/branding/${encodeURIComponent(name)}` });
    res.json({ ok: true, settings: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' }); }
});

app.post(`${basePath}/api/settings/branding/favicon`, upload.single('favicon'), async (req, res) => {
  try {
    if (!req.file?.size) return res.status(400).json({ ok: false, error: 'No favicon uploaded', code: 'BAD_REQUEST' });
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.ico', '.png', '.svg'].includes(ext)) return res.status(400).json({ ok: false, error: 'Unsupported favicon format', code: 'BAD_REQUEST' });
    const name = `favicon-${Date.now()}${ext}`;
    await fsp.writeFile(join(getBrandingDir(), name), await uploadedBuffer(req.file));
    const saved = await saveBrandingSettings({ ...(await loadBrandingSettings()), faviconUrl: `${basePath}/media/branding/${encodeURIComponent(name)}` });
    res.json({ ok: true, settings: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' }); }
});

app.get(`${basePath}/api/settings/layout`, async (req, res) => {
  try { res.json({ ok: true, settings: await loadLayoutSettings() }); }
  catch (err) { res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' }); }
});

app.post(`${basePath}/api/settings/layout`, async (req, res) => {
  try {
    const body = req.body || {};
    const invalidIds = [
      ...((Array.isArray(body.widgetOrder) ? body.widgetOrder : []).filter((id) => !ALLOWED_WIDGET_IDS.includes(String(id || '').trim()))),
      ...((Array.isArray(body.hiddenWidgets) ? body.hiddenWidgets : []).filter((id) => !ALLOWED_WIDGET_IDS.includes(String(id || '').trim()))),
      ...Object.keys(body.collapsedWidgets || {}).filter((id) => !ALLOWED_WIDGET_IDS.includes(String(id || '').trim())),
    ];
    if (invalidIds.length) {
      return res.status(400).json({ ok: false, error: `Unknown widget id(s): ${[...new Set(invalidIds)].join(', ')}`, code: 'BAD_REQUEST' });
    }
    const existing = await loadLayoutSettings();
    const saved = await saveLayoutSettings({ ...existing, ...body });
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/workspace/rooms`, async (req, res) => {
  try {
    const settings = await loadWorkspaceRooms(getRoster());
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/workspace/rooms`, async (req, res) => {
  try {
    const settings = await saveWorkspaceRooms(req.body || {}, getRoster());
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message, code: 'BAD_REQUEST' });
  }
});

app.get(`${basePath}/api/settings/intro`, async (req, res) => {
  try {
    const settings = await loadIntroSettings();
    const intros = await listIntroVideos();
    let selectedIntroId = String(settings.selectedIntroId || '').trim();
    if (selectedIntroId && !intros.find((intro) => intro.id === selectedIntroId)) selectedIntroId = '';
    if (!selectedIntroId && intros[0]?.id) selectedIntroId = intros[0].id;
    res.json({ ok: true, settings: { ...settings, selectedIntroId } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/intro`, async (req, res) => {
  try {
    const existing = await loadIntroSettings();
    const intros = await listIntroVideos();
    const requestedIntroId = String(req.body?.selectedIntroId || '').trim();
    const safeIntroId = !requestedIntroId || intros.find((intro) => intro.id === requestedIntroId) ? requestedIntroId : '';
    const saved = await saveIntroSettings({
      ...existing,
      enabled: req.body?.enabled === true,
      volume: req.body?.volume,
      selectedIntroId: safeIntroId,
    });
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/intro/videos`, async (req, res) => {
  try {
    const intros = await listIntroVideos();
    res.json({ ok: true, intros });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/intro/upload`, upload.single('intro'), async (req, res) => {
  try {
    if (!req.file?.size) {
      return res.status(400).json({ ok: false, error: 'No intro video uploaded', code: 'BAD_REQUEST' });
    }
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!isAllowedIntroExt(ext)) {
      return res.status(400).json({ ok: false, error: 'Unsupported intro video format', code: 'BAD_REQUEST' });
    }
    const introDir = getIntroDir();
    const base = sanitizeName(basename(String(req.file.originalname || 'intro'), ext)) || 'intro';
    let fileName = `${base}${ext}`;
    let fullPath = join(introDir, fileName);
    let counter = 2;
    while (existsSync(fullPath)) {
      fileName = `${base}-${counter}${ext}`;
      fullPath = join(introDir, fileName);
      counter += 1;
    }
    await fsp.writeFile(fullPath, await uploadedBuffer(req.file));
    const intros = await listIntroVideos();
    const uploaded = intros.find((intro) => intro.filename === fileName) || null;
    const saved = await saveIntroSettings({ ...(await loadIntroSettings()), selectedIntroId: uploaded?.id || '' });
    res.json({ ok: true, intro: uploaded, intros, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/settings/music`, async (req, res) => {
  try {
    const settings = await loadMusicSettings();
    const tracks = await listMusicTracks();
    let selectedTrackId = String(settings.selectedTrackId || '').trim();
    if (selectedTrackId && !tracks.find((track) => track.id === selectedTrackId)) selectedTrackId = '';
    if (!selectedTrackId && tracks[0]?.id) selectedTrackId = tracks[0].id;
    res.json({ ok: true, settings: { ...settings, selectedTrackId } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/music`, async (req, res) => {
  try {
    const existing = await loadMusicSettings();
    const tracks = await listMusicTracks();
    const requestedTrackId = String(req.body?.selectedTrackId || '').trim();
    const safeTrackId = !requestedTrackId || tracks.find((track) => track.id === requestedTrackId) ? requestedTrackId : '';
    const saved = await saveMusicSettings({
      ...existing,
      enabled: req.body?.enabled === true,
      volume: req.body?.volume,
      speechDuckLevel: req.body?.speechDuckLevel,
      fairyCallDuckLevel: req.body?.fairyCallDuckLevel,
      playbackScope: req.body?.playbackScope,
      selectedTrackId: safeTrackId,
    });
    res.json({ ok: true, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/music/tracks`, async (req, res) => {
  try {
    const tracks = await listMusicTracks();
    res.json({ ok: true, tracks });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/music/upload`, upload.single('track'), async (req, res) => {
  try {
    if (!req.file?.size) {
      return res.status(400).json({ ok: false, error: 'No audio file uploaded', code: 'BAD_REQUEST' });
    }
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!isAllowedMusicExt(ext)) {
      return res.status(400).json({ ok: false, error: 'Unsupported audio format', code: 'BAD_REQUEST' });
    }
    const musicDir = getMusicDir();
    const base = sanitizeName(basename(String(req.file.originalname || 'track'), ext)) || 'track';
    let fileName = `${base}${ext}`;
    let fullPath = join(musicDir, fileName);
    let counter = 2;
    while (existsSync(fullPath)) {
      fileName = `${base}-${counter}${ext}`;
      fullPath = join(musicDir, fileName);
      counter += 1;
    }
    await fsp.writeFile(fullPath, await uploadedBuffer(req.file));
    const tracks = await listMusicTracks();
    const uploaded = tracks.find((track) => track.filename === fileName) || null;
    const saved = await saveMusicSettings({ ...(await loadMusicSettings()), selectedTrackId: uploaded?.id || '' });
    res.json({ ok: true, track: uploaded, tracks, settings: saved });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/voice`, async (req, res) => {
  try {
    const settings = await loadVoiceSettings();
    const agent = String(req.query?.agent || '').trim();
    const resolved = agent ? await resolveAgentVoice(settings, agent) : null;
    res.json({
      ok: true,
      settings: {
        provider: settings.provider || 'elevenlabs',
        defaultVoiceId: settings.defaultVoiceId,
        fishVoiceId: settings.fishVoiceId,
        agentVoices: settings.agentVoices || {},
        elevenlabsAgentVoices: settings.elevenlabsAgentVoices || {},
        fishAgentVoices: settings.fishAgentVoices || {},
      },
      resolved: agent ? { agent, ...resolved } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/voice/options`, async (req, res) => {
  try {
    const settings = await loadVoiceSettings();
    const provider = String(req.query?.provider || settings.provider || 'elevenlabs').trim().toLowerCase() === 'fish' ? 'fish' : 'elevenlabs';
    if (provider === 'fish') {
      const q = String(req.query?.q || '').trim();
      if (!q) {
        return res.status(400).json({ ok: false, error: 'q is required for fish voice search', code: 'BAD_REQUEST' });
      }
      const result = await searchFishAudioVoices(q, settings, {
        limit: req.query?.limit || 8,
        pageSize: req.query?.pageSize || 12,
      });
      return res.json({ ok: true, provider, query: q, items: result.items || [], bestMatch: result.bestMatch || null });
    }

    const voices = await listElevenLabsVoices(settings.elevenlabsApiKey);
    return res.json({ ok: true, provider, items: voices });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/voice`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const provider = String(req.body?.provider || existing.provider || 'elevenlabs').trim().toLowerCase() === 'fish' ? 'fish' : 'elevenlabs';
    const elevenlabsAgentVoices = { ...(existing.elevenlabsAgentVoices || {}), ...(req.body?.elevenlabsAgentVoices || {}) };
    const fishAgentVoices = { ...(existing.fishAgentVoices || {}), ...(req.body?.fishAgentVoices || {}) };
    const agent = String(req.body?.agent || '').trim();
    const voiceId = String(req.body?.voiceId || '').trim();
    if (agent && voiceId) {
      if (provider === 'fish') fishAgentVoices[agent] = voiceId;
      else elevenlabsAgentVoices[agent] = voiceId;
    }
    const saved = await saveVoiceSettings({
      ...existing,
      provider,
      defaultVoiceId: req.body?.defaultVoiceId !== undefined ? String(req.body.defaultVoiceId || '').trim() : existing.defaultVoiceId,
      fishVoiceId: req.body?.fishVoiceId !== undefined ? String(req.body.fishVoiceId || '').trim() : existing.fishVoiceId,
      elevenlabsAgentVoices,
      fishAgentVoices,
      agentVoices: provider === 'fish' ? fishAgentVoices : elevenlabsAgentVoices,
    });
    const resolved = agent ? await resolveAgentVoice(saved, agent) : null;
    res.json({
      ok: true,
      settings: {
        provider: saved.provider,
        defaultVoiceId: saved.defaultVoiceId,
        fishVoiceId: saved.fishVoiceId,
        agentVoices: saved.agentVoices,
        elevenlabsAgentVoices: saved.elevenlabsAgentVoices || {},
        fishAgentVoices: saved.fishAgentVoices || {},
      },
      resolved: agent ? { agent, ...resolved } : null,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/settings/voice`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const body = req.body || {};
    const provider = String(body.provider || existing.provider || 'elevenlabs').trim() === 'fish' ? 'fish' : 'elevenlabs';
    const bodyElevenlabsAgentVoices = body.elevenlabsAgentVoices && typeof body.elevenlabsAgentVoices === 'object' && !Array.isArray(body.elevenlabsAgentVoices)
      ? body.elevenlabsAgentVoices
      : null;
    const bodyFishAgentVoices = body.fishAgentVoices && typeof body.fishAgentVoices === 'object' && !Array.isArray(body.fishAgentVoices)
      ? body.fishAgentVoices
      : null;
    const elevenlabsAgentVoices = provider === 'elevenlabs'
      ? (bodyElevenlabsAgentVoices || existing.elevenlabsAgentVoices || {})
      : (existing.elevenlabsAgentVoices || {});
    const fishAgentVoices = provider === 'fish'
      ? (bodyFishAgentVoices || existing.fishAgentVoices || {})
      : (existing.fishAgentVoices || {});

    const next = {
      provider,
      elevenlabsApiKey: body.elevenlabsApiKey ? String(body.elevenlabsApiKey).trim() : existing.elevenlabsApiKey,
      defaultVoiceId: body.defaultVoiceId !== undefined ? String(body.defaultVoiceId || '').trim() : (existing.defaultVoiceId || ''),
      fishAudioApiBase: String(body.fishAudioApiBase || existing.fishAudioApiBase || 'https://your-domain.example/aichat').trim(),
      fishVoiceId: body.fishVoiceId !== undefined ? String(body.fishVoiceId || '').trim() : (existing.fishVoiceId || ''),
      fishSessionCookie: body.fishSessionCookie ? String(body.fishSessionCookie).trim() : existing.fishSessionCookie,
      fishFormat: String(body.fishFormat || existing.fishFormat || 'mp3').trim(),
      fishIncludeAsteriskNarration: body.fishIncludeAsteriskNarration === true,
      fishPlaybackMode: String(body.fishPlaybackMode || existing.fishPlaybackMode || 'auto').trim(),
      fishAutoStreamMinChars: body.fishAutoStreamMinChars ?? existing.fishAutoStreamMinChars ?? 260,
      sttMode: body.sttMode || existing.sttMode || 'api',
      sttApiBase: String(body.sttApiBase || existing.sttApiBase || 'https://your-domain.example/aichat').trim(),
      sttApiProvider: body.sttApiProvider || existing.sttApiProvider || 'fish',
      sttLanguage: body.sttLanguage !== undefined ? String(body.sttLanguage || '').trim() : (existing.sttLanguage || 'en'),
      sttFishApiKey: body.sttFishApiKey ? String(body.sttFishApiKey).trim() : existing.sttFishApiKey,
      sttOpenAiApiKey: body.sttOpenAiApiKey ? String(body.sttOpenAiApiKey).trim() : existing.sttOpenAiApiKey,
      sttElevenlabsApiKey: body.sttElevenlabsApiKey ? String(body.sttElevenlabsApiKey).trim() : existing.sttElevenlabsApiKey,
      elevenlabsAgentVoices,
      fishAgentVoices,
      agentVoices: provider === 'fish' ? fishAgentVoices : elevenlabsAgentVoices,
    };
    const saved = await saveVoiceSettings(next);
    res.json({
      ok: true,
      settings: {
        provider: saved.provider || 'elevenlabs',
        hasApiKey: !!saved.elevenlabsApiKey,
        apiKeyMasked: maskApiKey(saved.elevenlabsApiKey),
        defaultVoiceId: saved.defaultVoiceId,
        fishAudioApiBase: saved.fishAudioApiBase,
        fishVoiceId: saved.fishVoiceId,
        hasFishSessionCookie: !!saved.fishSessionCookie,
        fishSessionCookieMasked: maskSessionCookie(saved.fishSessionCookie),
        fishFormat: saved.fishFormat,
        fishIncludeAsteriskNarration: saved.fishIncludeAsteriskNarration === true,
        fishPlaybackMode: saved.fishPlaybackMode || 'auto',
        fishAutoStreamMinChars: saved.fishAutoStreamMinChars || 260,
        sttMode: saved.sttMode || 'api',
        sttApiBase: saved.sttApiBase || 'https://your-domain.example/aichat',
        sttApiProvider: saved.sttApiProvider || 'fish',
        sttLanguage: saved.sttLanguage || 'en',
        hasSttFishApiKey: !!saved.sttFishApiKey,
        sttFishApiKeyMasked: maskApiKey(saved.sttFishApiKey),
        sttFishUsesServerKey: true,
        hasSttOpenAiApiKey: !!saved.sttOpenAiApiKey,
        sttOpenAiApiKeyMasked: maskApiKey(saved.sttOpenAiApiKey),
        hasSttElevenlabsApiKey: !!saved.sttElevenlabsApiKey,
        sttElevenlabsApiKeyMasked: maskApiKey(saved.sttElevenlabsApiKey),
        agentVoices: saved.agentVoices,
        elevenlabsAgentVoices: saved.elevenlabsAgentVoices || {},
        fishAgentVoices: saved.fishAgentVoices || {},
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/settings/voice/voices`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const apiKey = String(req.body?.elevenlabsApiKey || existing.elevenlabsApiKey || '').trim();
    if (!apiKey) return res.status(400).json({ error: 'No ElevenLabs API key configured' });
    const voices = await listElevenLabsVoices(apiKey);
    res.json({ ok: true, voices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/setup/test`, async (req, res) => {
  const bridgeStatus = bridge.getStatus();
  const settings = await loadVoiceSettings();
  const checks = [];

  checks.push({
    key: 'gateway-mode',
    ok: bridgeStatus.configuredDemo ? true : bridgeStatus.mode === 'live',
    level: bridgeStatus.configuredDemo ? 'info' : (bridgeStatus.mode === 'live' ? 'ok' : 'warn'),
    message: bridgeStatus.configuredDemo
      ? 'CommandCenter is intentionally running in demo mode.'
      : bridgeStatus.mode === 'live'
        ? 'Live OpenClaw gateway connection is active.'
        : bridgeStatus.mode === 'demo'
          ? `Live OpenClaw failed and CommandCenter fell back to demo mode${bridgeStatus.lastFallbackReason ? ` (${bridgeStatus.lastFallbackReason})` : ''}.`
          : 'Live OpenClaw gateway is not connected right now.',
  });

  if (!bridgeStatus.configuredDemo) {
    checks.push({
      key: 'gateway-token',
      ok: !!bridgeStatus.gatewayTokenConfigured,
      level: bridgeStatus.gatewayTokenConfigured ? 'ok' : 'warn',
      message: bridgeStatus.gatewayTokenConfigured
        ? `Gateway token is configured (${bridgeStatus.gatewayTokenSource || 'unknown source'}).`
        : 'Gateway token is missing for live mode.',
    });
  }

  if (!relayOnlyMode && bridgeStatus.lastAuthError) {
    checks.push({
      key: 'gateway-auth',
      ok: false,
      level: 'error',
      message: `Gateway authentication failed: ${bridgeStatus.lastAuthError}`,
    });
  }

  if ((settings.sttMode || 'api') === 'local') {
    checks.push({
      key: 'stt',
      ok: true,
      level: 'ok',
      message: 'STT is set to local Whisper on this server.',
    });
  } else {
    const provider = String(settings.sttApiProvider || 'fish');
    const base = String(settings.sttApiBase || '').trim();
    const hasProviderKey = provider === 'fish'
      ? true
      : provider === 'openai'
        ? !!settings.sttOpenAiApiKey
        : !!settings.sttElevenlabsApiKey;
    checks.push({
      key: 'stt-api-base',
      ok: !!base,
      level: base ? 'ok' : 'warn',
      message: base ? `STT API base is set to ${base}.` : 'STT API base URL is missing.',
    });
    checks.push({
      key: 'stt-provider',
      ok: hasProviderKey || provider === 'fish',
      level: hasProviderKey || provider === 'fish' ? 'ok' : 'warn',
      message: provider === 'fish'
        ? 'STT is set to AIChat API → Fish Audio.'
        : hasProviderKey
          ? `STT is set to AIChat API → ${provider}.`
          : `${provider} STT is selected but its API key is missing.`,
    });
  }

  if ((settings.provider || 'elevenlabs') === 'fish') {
    checks.push({
      key: 'tts',
      ok: !!String(settings.fishAudioApiBase || '').trim() && !!String(settings.fishVoiceId || '').trim(),
      level: (!!String(settings.fishAudioApiBase || '').trim() && !!String(settings.fishVoiceId || '').trim()) ? 'ok' : 'warn',
      message: (!!String(settings.fishAudioApiBase || '').trim() && !!String(settings.fishVoiceId || '').trim())
        ? 'Fish Audio TTS looks configured.'
        : 'Fish Audio TTS is selected but the API base or voice ID is missing.',
    });
  } else {
    checks.push({
      key: 'tts',
      ok: !!String(settings.elevenlabsApiKey || '').trim(),
      level: !!String(settings.elevenlabsApiKey || '').trim() ? 'ok' : 'warn',
      message: !!String(settings.elevenlabsApiKey || '').trim()
        ? 'ElevenLabs TTS looks configured.'
        : 'ElevenLabs TTS is selected but no API key is saved. CommandCenter will fall back to espeak-ng.',
    });
  }

  const hasError = checks.some((check) => check.level === 'error');
  const hasWarn = checks.some((check) => check.level === 'warn');
  res.json({
    ok: !hasError,
    summary: hasError ? 'Setup test found blocking problems.' : hasWarn ? 'Setup test found a few things to fix.' : 'Setup test passed.',
    tone: hasError ? 'error' : hasWarn ? 'warn' : 'ok',
    checks,
  });
});

app.post(`${basePath}/api/settings/voice/fish/preview`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const body = req.body || {};
    const voiceId = String(body.voiceId || body.fishVoiceId || body.referenceId || '').trim();
    if (!voiceId) return res.status(400).json({ error: 'No Fish voice ID provided' });
    const settings = {
      ...existing,
      fishAudioApiBase: String(body.fishAudioApiBase || existing.fishAudioApiBase || 'https://your-domain.example/aichat').trim(),
      fishSessionCookie: body.fishSessionCookie ? String(body.fishSessionCookie).trim() : existing.fishSessionCookie,
      fishFormat: String(body.fishFormat || existing.fishFormat || 'mp3').trim(),
      fishIncludeAsteriskNarration: body.fishIncludeAsteriskNarration === true,
    };
    const audio = await previewFishAudioVoice({
      text: String(body.text || 'Hey, this is a Fish Audio voice preview from Command Center.'),
      voiceId,
      settings,
    });
    res.set('Content-Type', audio.contentType);
    res.set('Content-Length', audio.buffer.length);
    res.send(audio.buffer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/settings/voice/fish/search`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const body = req.body || {};
    const query = String(body.q || body.query || body.title || '').trim();
    if (!query) return res.json({ query: '', items: [], bestMatch: null });
    const settings = {
      ...existing,
      fishAudioApiBase: String(body.fishAudioApiBase || existing.fishAudioApiBase || 'https://your-domain.example/aichat').trim(),
      fishSessionCookie: body.fishSessionCookie ? String(body.fishSessionCookie).trim() : existing.fishSessionCookie,
    };
    const result = await searchFishAudioVoices(query, settings, {
      limit: body.limit || 8,
      pageSize: body.pageSize || 12,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message, items: [], bestMatch: null });
  }
});

app.get(`${basePath}/api/settings/wake`, async (req, res) => {
  const settings = await loadWakeSettings();
  res.json({
    ok: true,
    settings: {
      hasAccessKey: !!settings.porcupineAccessKey,
      accessKeyMasked: maskAccessKey(settings.porcupineAccessKey),
      wakeWords: settings.wakeWords || {},
      modelPath: `${basePath}/vendor/picovoice/porcupine_params.pv`,
    },
  });
});

app.post(`${basePath}/api/settings/wake`, async (req, res) => {
  try {
    const existing = await loadWakeSettings();
    const body = req.body || {};
    const next = {
      porcupineAccessKey: body.porcupineAccessKey ? String(body.porcupineAccessKey).trim() : existing.porcupineAccessKey,
      wakeWords: body.wakeWords || existing.wakeWords || {},
    };
    const saved = await saveWakeSettings(next);
    res.json({
      ok: true,
      settings: {
        hasAccessKey: !!saved.porcupineAccessKey,
        accessKeyMasked: maskAccessKey(saved.porcupineAccessKey),
        wakeWords: saved.wakeWords,
        modelPath: `${basePath}/vendor/picovoice/porcupine_params.pv`,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${basePath}/api/settings/wake/runtime`, async (req, res) => {
  const settings = await loadWakeSettings();
  res.json({
    ok: true,
    accessKey: settings.porcupineAccessKey,
    wakeWords: settings.wakeWords || {},
    modelPath: `${basePath}/vendor/picovoice/porcupine_params.pv`,
  });
});

app.post(`${basePath}/api/settings/wake/keyword`, upload.single('keyword'), async (req, res) => {
  try {
    const agentId = String(req.body?.agentId || '').trim();
    const label = String(req.body?.label || agentId || '').trim();
    const sensitivity = Number(req.body?.sensitivity || 0.6);
    if (!agentId) return res.status(400).json({ error: 'agentId is required' });
    if (!req.file) return res.status(400).json({ error: 'keyword file is required' });
    if (!req.file.originalname.toLowerCase().endsWith('.ppn')) return res.status(400).json({ error: 'keyword file must be a .ppn file' });

    const safeName = `${agentId.replace(/[^a-z0-9_-]/gi, '_')}.ppn`;
    const fs = await import('node:fs/promises');
    const targetDir = join(__dirname, '..', 'public', 'wakewords');
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(join(targetDir, safeName), await uploadedBuffer(req.file));

    const existing = await loadWakeSettings();
    const saved = await saveWakeSettings({
      porcupineAccessKey: existing.porcupineAccessKey,
      wakeWords: {
        ...existing.wakeWords,
        [agentId]: {
          label: label || agentId,
          publicPath: `${basePath}/wakewords/${safeName}`,
          builtIn: existing.wakeWords?.[agentId]?.builtIn || '',
          sensitivity,
        },
      },
    });

    res.json({ ok: true, wakeWords: saved.wakeWords });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${basePath}/api/health`, (req, res) => {
  const cpus = os.cpus();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const memPct = Math.round(((totalMem - freeMem) / totalMem) * 100);
  const loadAvg = os.loadavg()[0];
  const cpuPct = Math.min(100, Math.round((loadAvg / cpus.length) * 100));

  exec("df / --output=pcent | tail -1 | tr -d ' %'; echo; cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null || echo 0", (err, stdout) => {
    const lines = (stdout || '').trim().split('\n');
    const diskPct = parseInt(lines[0]) || 0;
    const tempC = Math.round((parseInt(lines[1]) || 0) / 1000);
    res.json({ cpu_pct: cpuPct, mem_pct: memPct, disk_pct: diskPct, temp_c: tempC, uptime: Math.floor(os.uptime()) });
  });
});

let weatherCache = { data: null, ts: 0 };
app.get(`${basePath}/api/weather`, async (req, res) => {
  const now = Date.now();
  if (weatherCache.data && now - weatherCache.ts < 600000) {
    return res.json(weatherCache.data);
  }
  try {
    const resp = await fetch(`https://wttr.in/${encodeURIComponent(config.weatherLocation)}?format=j1`);
    const json = await resp.json();
    const cur = json.current_condition?.[0] || {};
    const data = {
      temp_c: parseInt(cur.temp_C) || 0,
      feels_like: parseInt(cur.FeelsLikeC) || 0,
      desc: cur.weatherDesc?.[0]?.value || 'Unknown',
      code: parseInt(cur.weatherCode) || 0,
      humidity: parseInt(cur.humidity) || 0,
      wind_kph: parseInt(cur.windspeedKmph) || 0,
      location: config.weatherLocation.split(',')[0],
    };
    weatherCache = { data, ts: now };
    res.json(data);
  } catch (err) {
    console.error('[weather] Error:', err.message);
    res.json(weatherCache.data || { temp_c: 0, desc: 'Unavailable', code: 0 });
  }
});

function runOpenClawWebSearch(query, { agentId } = {}) {
  return new Promise((resolve, reject) => {
    const roster = getRoster();
    const requested = String(agentId || roster.primaryAgentId || 'orchestrator').trim();
    const target = roster.agents.some((item) => item.id === requested)
      ? requested
      : String(roster.primaryAgentId || 'orchestrator').trim();
    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
    const prompt = [
      'Use the web_search tool if it is available in this OpenClaw install.',
      'Search the web for the query below and return a concise factual result for Fairy to speak.',
      'Include the most relevant findings in plain language.',
      'If useful, include 2-5 source domains or URLs inline.',
      'If web search is unavailable, say that clearly instead of pretending you searched.',
      `Query: ${String(query || '').trim()}`,
    ].join('\n');

    execFile(openclawBin, [
      'agent', '--agent', target,
      '--thinking', 'off',
      '--message', prompt,
    ], {
      timeout: 90000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
      maxBuffer: 2 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(String(stderr || err.message || 'Web search failed').trim()));
        return;
      }
      resolve(String(stdout || '').trim());
    });
  });
}


function summarizeWebSearchResult(result = '') {
  const text = String(result || '').trim();
  const urls = Array.from(new Set((text.match(/https?:\/\/[^\s)]+/g) || []).slice(0, 4)));
  const domains = Array.from(new Set(urls.map((url) => {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
  }).filter(Boolean))).slice(0, 4);
  const cleaned = text.replace(/https?:\/\/[^\s)]+/g, '').replace(/\s+/g, ' ').trim();
  return {
    preview: cleaned.slice(0, 260),
    urls,
    domains,
  };
}

function sendToAgent(agentId, message) {
  const cleanMessage = String(message || '').trim();
  if (!cleanMessage) {
    console.log('[agent] Skipping empty message');
    return;
  }

  const roster = getRoster();
  const target = agentId || roster.primaryAgentId || 'main';
  console.log(`[agent] Sending to ${target}: "${cleanMessage.slice(0, 80)}..."`);

  broadcast({
    type: 'agent:thinking',
    data: { agent: target, status: 'Processing...' },
  });

  const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
  const thinkingLevel = (target === roster.primaryAgentId || target === 'main') ? 'low' : 'off';
  execFile(openclawBin, [
    'agent', '--agent', target,
    '--thinking', thinkingLevel,
    '--message', cleanMessage,
  ], {
    timeout: 90000,
    env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
  }, (err, stdout, stderr) => {
    if (err) {
      console.error(`[agent] Error from ${target}:`, err.message);
      broadcast({
        type: 'agent:error',
        data: { agent: target, message: err.message },
      });
      return;
    }

    const response = stdout.trim();
    console.log(`[agent] Response from ${target}: "${response.slice(0, 80)}..."`);

    broadcast({
      type: 'agent:responding',
      data: { agent: target, message: response },
    });
  });
}

app.post(`${basePath}/api/voice/transcribe`, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No audio file provided' });
    }

    const roster = getRoster();
    const targetAgent = req.body?.targetAgent || roster.primaryAgentId || 'main';
    console.log(`[voice] Transcribing ${req.file.size} bytes for agent: ${targetAgent}`);
    const text = await transcribe(await uploadedBuffer(req.file), req.file.originalname || 'audio.webm');
    console.log(`[voice] Transcribed: "${text}"`);

    if (!String(text || '').trim()) {
      return res.json({ text: '', agent: targetAgent, ignored: 'empty-transcription' });
    }

    broadcast({
      type: 'voice:transcription',
      data: { text, agent: targetAgent, timestamp: Date.now() },
    });

    sendToAgent(targetAgent, text);

    res.json({ text, agent: targetAgent });
  } catch (err) {
    console.error('[voice] Transcription error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function normalizeWakeText(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildWakeAliases() {
  const extraAliases = {
    orchestrator: ['astra', 'astrah'],
    builder: ['miyabi', 'miyabby', 'miyaby'],
    qa: ['mina', 'meena'],
    ui: ['jane doe', 'jane', 'janedoe'],
    researcher: ['lyra', 'lira'],
    comms: ['niko', 'nico', 'neeko'],
    'emotional-support-1': ['pip', 'pipp'],
    'emotional-support-2': ['mochi', 'mochie'],
  };

  return roster.agents.map((agent) => {
    const aliases = new Set([
      agent.label,
      agent.id,
      agent.name?.split('/')?.[0]?.trim(),
      ...(extraAliases[agent.id] || []),
    ].filter(Boolean).map((value) => normalizeWakeText(value)));
    return { agentId: agent.id, label: agent.label, aliases: Array.from(aliases).filter(Boolean) };
  });
}

function escapeRegex(value = '') {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function detectWakeAgent(text = '') {
  const normalized = normalizeWakeText(text);
  if (!normalized) return null;

  let best = null;
  for (const agent of buildWakeAliases()) {
    for (const alias of agent.aliases) {
      if (!alias) continue;
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`, 'i');
      const match = pattern.exec(normalized);
      if (!match) continue;
      const index = match.index;
      const before = normalized.slice(0, index).trim();
      const after = normalized.slice(index + alias.length).trim();
      const remainder = [before, after].filter(Boolean).join(' ').trim();
      if (!best || index < best.index || (index === best.index && alias.length > best.alias.length)) {
        best = { ...agent, alias, index, remainder };
      }
    }
  }
  return best;
}

app.get(`${basePath}/api/wake/config`, async (req, res) => {
  res.json({
    ok: true,
    agents: buildWakeAliases(),
  });
});

app.post(`${basePath}/api/wake/detect`, upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No audio file provided' });

    const audioBuffer = await uploadedBuffer(req.file);
    const keywordMatch = await detectWakeKeyword(audioBuffer, req.file.originalname || 'wake.webm').catch(() => null);
    if (keywordMatch?.agentId && String(keywordMatch.alias || '').length > 3) {
      const agent = buildWakeAliases().find((a) => a.agentId === keywordMatch.agentId);
      return res.json({
        ok: true,
        text: keywordMatch.alias,
        match: {
          ...agent,
          alias: keywordMatch.alias,
          remainder: '',
        },
      });
    }

    const text = await transcribeWakeAudio(audioBuffer, req.file.originalname || 'wake.webm');
    const match = detectWakeAgent(text);
    res.json({ ok: true, text, match });
  } catch (err) {
    console.error('[wake] Detection error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/browser/send`, async (req, res) => {
  try {
    const { text, agent } = req.body || {};
    const roster = getRoster();
    const target = agent || roster.primaryAgentId || 'main';
    if (!text) return res.status(400).json({ error: 'No text provided' });

    broadcast({
      type: 'voice:transcription',
      data: { text, agent: target, timestamp: Date.now() },
    });
    sendToAgent(target, text);
    res.json({ ok: true, agent: target, text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${basePath}/api/chat/files`, async (req, res) => {
  try {
    const manifest = await readChatManifest();
    const items = [...manifest.items].sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0)).map(toChatFileRecord);
    res.json({ ok: true, items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/chat/files/upload`, upload.array('files', 10), enforceUploadBudget({ maxFiles: 10, maxBytes: 25 * 1024 * 1024 }), async (req, res) => {
  try {
    await ensureChatLibrary();
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) return res.status(400).json({ error: 'No files uploaded' });

    const manifest = await readChatManifest();
    const created = [];

    for (const file of files) {
      const id = randomUUID();
      const ext = extname(file.originalname || '') || '';
      const safeOriginal = sanitizeName(file.originalname || `upload${ext}`);
      const savedName = `${id}${ext}`;
      const savedPath = join(chatFilesDir, savedName);
      await fsp.writeFile(savedPath, await uploadedBuffer(file));
      const item = {
        id,
        kind: 'file',
        name: safeOriginal,
        originalName: file.originalname || safeOriginal,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size || 0,
        createdAt: Date.now(),
        path: savedPath,
        ext,
      };
      manifest.items.push(item);
      created.push(toChatFileRecord(item));
    }

    await writeChatManifest(manifest);
    res.json({ ok: true, items: created });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/chat/files/link`, async (req, res) => {
  try {
    const sourceUrl = String(req.body?.url || '').trim();
    const name = String(req.body?.name || '').trim() || sourceUrl;
    const notes = String(req.body?.notes || '').trim();
    if (!sourceUrl) return res.status(400).json({ error: 'url is required' });

    const manifest = await readChatManifest();
    const item = {
      id: randomUUID(),
      kind: 'link',
      name: name.slice(0, 180),
      originalName: name.slice(0, 180),
      mimeType: 'text/uri-list',
      size: 0,
      createdAt: Date.now(),
      sourceUrl,
      notes,
      path: '',
      ext: '',
    };
    manifest.items.push(item);
    await writeChatManifest(manifest);
    res.json({ ok: true, item: toChatFileRecord(item) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${basePath}/api/chat/files/:id/download`, async (req, res) => {
  try {
    const manifest = await readChatManifest();
    const item = manifest.items.find((entry) => String(entry.id) === String(req.params.id));
    if (!item) return res.status(404).json({ error: 'File not found' });
    if (item.kind === 'link') return res.redirect(item.sourceUrl);
    if (!item.path || !existsSync(item.path)) return res.status(404).json({ error: 'Stored file missing' });
    res.download(item.path, item.originalName || item.name || 'download');
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete(`${basePath}/api/chat/files/:id`, async (req, res) => {
  try {
    const manifest = await readChatManifest();
    const index = manifest.items.findIndex((entry) => String(entry.id) === String(req.params.id));
    if (index === -1) return res.status(404).json({ error: 'File not found' });
    const [item] = manifest.items.splice(index, 1);
    await writeChatManifest(manifest);
    if (item.kind !== 'link' && item.path && existsSync(item.path)) {
      await fsp.unlink(item.path).catch(() => {});
    }
    res.json({ ok: true, id: item.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post(`${basePath}/api/voice/speak`, async (req, res) => {
  try {
    const { text, agent } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'No text provided' });
    }

    const roster = getRoster();
    const speaker = agent || roster.primaryAgentId || 'main';
    console.log(`[voice] Speaking as ${speaker}: "${text.slice(0, 80)}..."`);
    const streamed = await streamSpeak(text, speaker, res);
    if (streamed) return;

    const audio = await speak(text, speaker);

    res.set('Content-Type', audio.contentType);
    res.set('Content-Length', audio.buffer.length);
    res.set('X-TTS-Mode', audio.mode || 'full');
    res.send(audio.buffer);
  } catch (err) {
    console.error('[voice] TTS error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Direct Chat API - send message directly to an agent without voice
app.get(`${basePath}/api/live/config`, async (req, res) => {
  const config = await loadGeminiRuntimeConfig();
  res.json({
    ok: true,
    config: {
      hasApiKey: config.hasApiKey,
      model: config.model,
      responseModalities: config.responseModalities,
      thinkingLevel: config.thinkingLevel,
      voiceName: config.voiceName || FAIRY_LIVE_VOICE_NAME,
      liveVoiceName: config.voiceName || FAIRY_LIVE_VOICE_NAME,
      speechOutputMode: config.speechOutputMode || 'gemini',
      fishVoiceId: config.fishVoiceId || '',
      personaName: config.personaName || 'Fairy',
      operatorName: config.operatorName || 'Epic',
      personalityPrompt: config.personalityPrompt || '',
      memoryEnabled: config.memoryEnabled ?? true,
      memoryNotes: config.memoryNotes || '',
      callMode: config.callMode || 'universal',
      availableCallModes: FAIRY_CALL_MODE_OPTIONS,
      availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
      source: config.source,
      transport: 'server-websocket',
    },
  });
});

app.get(`${basePath}/api/fairy/memory`, async (req, res) => {
  const store = await loadFairyMemory();
  const scope = String(req.query?.scope || 'all').trim().toLowerCase();
  const query = String(req.query?.q || '').trim();
  let entries = Array.isArray(store.entries) ? [...store.entries] : [];
  if (scope && scope !== 'all') entries = entries.filter((entry) => String(entry.scope || 'general') === scope);
  if (query) {
    const lowered = query.toLowerCase();
    entries = selectRelevantFairyMemory({ store: { entries }, query, scope: scope === 'all' ? 'general' : scope, limit: 40 }).filter((entry) => {
      const hay = `${String(entry.text || '').toLowerCase()} ${(entry.tags || []).join(' ').toLowerCase()} ${String(entry.scope || '')}`;
      return hay.includes(lowered) || query.split(/\s+/).some((part) => part && hay.includes(part.toLowerCase()));
    });
  }
  entries.sort((a, b) => (b.pinned === true) - (a.pinned === true) || Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  res.json({ ok: true, entries, count: entries.length });
});

app.delete(`${basePath}/api/fairy/memory/:id`, async (req, res) => {
  const result = await removeFairyMemoryEntry(String(req.params.id || ''));
  if (!result.ok) return res.status(404).json({ ok: false, error: 'Memory entry not found' });
  res.json({ ok: true, count: result.store.entries.length });
});

app.post(`${basePath}/api/fairy/memory/:id`, async (req, res) => {
  const patch = {
    text: req.body?.text,
    tags: req.body?.tags,
    scope: req.body?.scope,
    pinned: req.body?.pinned,
  };
  const result = await updateFairyMemoryEntry(String(req.params.id || ''), patch);
  if (!result.ok) return res.status(404).json({ ok: false, error: 'Memory entry not found' });
  res.json({ ok: true, entry: result.entry, count: result.store.entries.length });
});

app.get(`${basePath}/api/call/sessions`, async (req, res) => {
  res.json({ ok: true, sessions: listCallSessions() });
});

app.get(`${basePath}/api/call/:id`, async (req, res) => {
  const session = getCallSession(String(req.params.id || ''));
  if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
  res.json({ ok: true, session });
});

app.post(`${basePath}/api/call/:id/fairy-speak`, async (req, res) => {
  try {
    const session = getCallSession(String(req.params.id || ''));
    if (!session || String(session.persona || '') !== 'fairy') {
      return res.status(404).json({ ok: false, error: 'Fairy call session not found' });
    }
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'No text provided' });

    const geminiSettings = await loadGeminiSettings();
    if (String(geminiSettings.speechOutputMode || 'gemini') !== 'fish') {
      return res.status(400).json({ ok: false, error: 'Fairy Fish voice mode is not enabled' });
    }
    const fishVoiceId = String(geminiSettings.fishVoiceId || '').trim();
    if (!fishVoiceId) {
      return res.status(400).json({ ok: false, error: 'No Fairy Fish voice ID configured' });
    }

    const voiceSettings = await loadVoiceSettings();
    const mergedVoiceSettings = {
      ...voiceSettings,
      provider: 'fish',
    };
    await streamFishAudioText(text, mergedVoiceSettings, res, { voiceId: fishVoiceId, agentId: session.agent || 'main' });
  } catch (err) {
    console.error('[fairy] Fish speech error:', err.message);
    res.status(500).json({ ok: false, error: err.message || 'Fairy Fish speech failed' });
  }
});

app.get(`${basePath}/api/fairy/recordings`, async (req, res) => {
  try {
    const recordings = await cleanupFairyRecordingIndex();
    res.json({
      ok: true,
      recordings: recordings.map((item) => ({
        ...item,
        downloadUrl: `${basePath}/api/fairy/recordings/${encodeURIComponent(item.id)}/download`,
      })),
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Could not list Fairy recordings' });
  }
});

app.get(`${basePath}/api/fairy/recordings/:id/download`, async (req, res) => {
  try {
    const record = await getFairyRecording(String(req.params.id || ''));
    if (!record) return res.status(404).json({ ok: false, error: 'Recording not found' });
    res.download(getFairyRecordingPath(record), record.filename || 'fairy-recording.webm');
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Could not download Fairy recording' });
  }
});

app.post(`${basePath}/api/call/:id/recording`, upload.single('video'), async (req, res) => {
  try {
    const sessionId = String(req.params.id || '').trim();
    if (!sessionId) return res.status(400).json({ ok: false, error: 'Missing session id' });
    if (!req.file?.size) return res.status(400).json({ ok: false, error: 'Missing recording video' });
    const record = await saveFairyRecording({
      buffer: await uploadedBuffer(req.file),
      mimeType: String(req.body?.mimeType || req.file.mimetype || 'video/webm').trim(),
      sessionId,
      startedAt: String(req.body?.startedAt || '').trim(),
      endedAt: String(req.body?.endedAt || '').trim(),
      durationMs: Number(req.body?.durationMs || 0),
      includeMic: String(req.body?.includeMic || 'false') === 'true',
      includeFairy: String(req.body?.includeFairy || 'false') === 'true',
      notes: String(req.body?.notes || '').trim(),
      source: 'fairy-live',
    });
    updateCallSession(sessionId, { recordingActive: false, lastRecordingId: record.id });
    broadcast({ type: 'call:recording.saved', data: { sessionId, record: { ...record, downloadUrl: `${basePath}/api/fairy/recordings/${encodeURIComponent(record.id)}/download` } } });
    res.json({ ok: true, record: { ...record, downloadUrl: `${basePath}/api/fairy/recordings/${encodeURIComponent(record.id)}/download` } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message || 'Could not save Fairy recording' });
  }
});

app.post(`${basePath}/api/call/start`, async (req, res) => {
  try {
    const runtime = await loadGeminiRuntimeConfig();
    if (!runtime.hasApiKey) {
      return res.status(400).json({ ok: false, error: 'Gemini API key is not configured in Command Center settings' });
    }
    const currentRoster = getRoster();
    const requestedAgent = String(req.body?.agent || currentRoster.primaryAgentId || 'orchestrator').trim();
    const sessionAgent = currentRoster.agents.some((agent) => agent.id === requestedAgent)
      ? requestedAgent
      : String(currentRoster.primaryAgentId || 'orchestrator').trim();
    const activeCallMode = normalizeCallMode(runtime.callMode || 'universal');
    const initialModePolicy = buildEffectiveCallPolicy(activeCallMode, 'low', '');
    const session = createCallSession({
      agent: sessionAgent,
      mode: 'gemini-live',
      persona: 'fairy',
      callMode: activeCallMode,
    });
    updateCallSession(session.id, {
      callMode: activeCallMode,
      intensityLevel: 'low',
      handoffPolicy: initialModePolicy.handoffPolicy,
      proactivity: initialModePolicy.proactivity,
      responseStyle: initialModePolicy.responseStyle,
      modeDecision: initialModePolicy.modeDecision,
      modeReason: initialModePolicy.modeReason,
      speechSuppressedReason: '',
    });

    const memoryStore = runtime.memoryEnabled ? await loadFairyMemory() : { entries: [] };
    const memoryContext = buildFairyMemoryContext({
      enabled: runtime.memoryEnabled !== false,
      memoryNotes: runtime.memoryNotes || '',
      store: memoryStore,
      scope: sessionAgent || 'general',
      limit: 10,
    });

    const liveResponseModalities = Array.isArray(runtime.responseModalities) && runtime.responseModalities.length
      ? runtime.responseModalities
      : ['AUDIO'];
    const gemini = new GeminiLiveSession({
      apiKey: runtime.apiKey,
      model: runtime.model,
      responseModalities: liveResponseModalities,
      voiceName: runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
      systemPrompt: buildFairyLiveSystemPrompt({
        roster: currentRoster,
        personaName: runtime.personaName || 'Fairy',
        operatorName: runtime.operatorName || 'Epic',
        personalityPrompt: runtime.personalityPrompt || '',
        memoryContext,
        callMode: activeCallMode,
        liveIntentOverride: '',
      }),
      onEvent: (event) => {
        const current = getCallSession(session.id);
        updateCallSession(session.id, {
          geminiEventCount: Number(current?.geminiEventCount || 0) + 1,
          currentTurnGeminiEventCount: Number(current?.currentTurnGeminiEventCount || 0) + 1,
          lastGeminiEventAt: new Date().toISOString(),
        });
        clearLiveWatchdog(session.id);
        if (event.type === 'setupComplete') {
          setCallSessionState(session.id, 'ready');
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: 'Fairy live setup complete' } });
          return;
        }
        if (event.type === 'input.transcript') {
          const text = String(event.data?.text || '').trim();
          const updated = updateCallSession(session.id, { partialTranscript: text, state: 'listening' });
          broadcast({ type: 'call:transcript.partial', data: { sessionId: session.id, text, state: updated?.state || 'listening' } });
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini heard input: ${text.slice(0, 120)}` } });
          return;
        }
        if (event.type === 'output.transcript') {
          const text = String(event.data?.text || '').trim();
          const updated = text
            ? setCallSessionState(session.id, 'speaking', { lastAssistantText: text })
            : getCallSession(session.id);
          if (text) appendCallTranscriptEntry(session.id, 'assistant', text, { source: 'output.transcript' });
          if (text) broadcast({ type: 'call:response.text', data: { sessionId: session.id, text, done: false, state: updated?.state || 'speaking' } });
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini output transcript: ${text.slice(0, 120)}` } });
          return;
        }
        if (event.type === 'tool.call') {
          const functionCalls = Array.isArray(event.data?.functionCalls) ? event.data.functionCalls : [];
          if (!functionCalls.length) return;
          (async () => {
            const functionResponses = [];
            for (const fc of functionCalls) {
              const name = String(fc?.name || '').trim();
              const id = String(fc?.id || '').trim();
              const args = fc?.args && typeof fc.args === 'object' ? fc.args : {};
              if (name === 'update_live_memory') {
                const text = String(args.text || '').trim();
                const tags = Array.isArray(args.tags) ? args.tags.map((tag) => String(tag || '').trim()).filter(Boolean).slice(0, 8) : [];
                const scope = String(args.scope || session.agent || 'general').trim().toLowerCase() || 'general';
                const pinned = args.pinned === true;
                if (runtime.memoryEnabled === false) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'Live memory is disabled in Command Center settings' } });
                  continue;
                }
                if (!text) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'Missing text for update_live_memory' } });
                  continue;
                }
                if (/(api[_ -]?key|password|passwd|token|secret|cookie|credential)/i.test(text)) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'Refusing to store likely secret material in live memory' } });
                  continue;
                }
                const savedMemory = await addFairyMemoryEntry({ text, tags, scope, pinned, source: 'gemini-live' });
                broadcast({
                  type: 'call:memory.saved',
                  data: {
                    sessionId: session.id,
                    ok: true,
                    entry: savedMemory.entry,
                    count: savedMemory.store.entries.length,
                  },
                });
                functionResponses.push({
                  name,
                  id,
                  response: {
                    ok: true,
                    memoryId: savedMemory.entry.id,
                    count: savedMemory.store.entries.length,
                  },
                });
                continue;
              }
              if (name === 'update_command_center_settings') {
                const requestedSection = String(args.section || 'gemini').trim().toLowerCase();
                if (requestedSection && requestedSection !== 'gemini') {
                  const { key, path } = resolveSettingsSection(requestedSection);
                  if (!path) {
                    functionResponses.push({ name, id, response: { ok: false, error: 'Unsupported settings section' } });
                    continue;
                  }
                  const patch = sanitizeSettingsPatch(args.patch && typeof args.patch === 'object' ? args.patch : {});
                  const result = await fetchLocalSettings(req, 'POST', path, patch);
                  const changedKeys = Object.keys(patch || {});
                  broadcast({ type: 'call:settings.updated', data: { sessionId: session.id, section: key, changedKeys, settings: result.data?.settings || result.data || {} } });
                  functionResponses.push({ name, id, response: { ok: result.status < 400, section: key, changedKeys, settings: result.data?.settings || result.data || {}, error: result.status >= 400 ? result.data?.error || 'Settings update failed' : undefined } });
                  continue;
                }
                const existing = await loadGeminiSettings();
                const next = {
                  apiKey: existing.apiKey,
                  model: args.model !== undefined ? String(args.model || '').trim() : existing.model,
                  responseModalities: args.responseModalities !== undefined ? args.responseModalities : existing.responseModalities,
                  thinkingLevel: args.thinkingLevel !== undefined ? String(args.thinkingLevel || '').trim() : existing.thinkingLevel,
                  voiceName: args.voiceName !== undefined ? String(args.voiceName || '').trim() : existing.voiceName,
                  speechOutputMode: args.speechOutputMode !== undefined ? String(args.speechOutputMode || '').trim() : existing.speechOutputMode,
                  fishVoiceId: args.fishVoiceId !== undefined ? String(args.fishVoiceId || '').trim() : existing.fishVoiceId,
                  personaName: args.personaName !== undefined ? String(args.personaName || '').trim() : existing.personaName,
                  operatorName: args.operatorName !== undefined ? String(args.operatorName || '').trim() : existing.operatorName,
                  personalityPrompt: args.personalityPrompt !== undefined ? String(args.personalityPrompt || '') : existing.personalityPrompt,
                  memoryEnabled: args.memoryEnabled !== undefined ? args.memoryEnabled !== false : existing.memoryEnabled,
                  memoryNotes: args.memoryNotes !== undefined ? String(args.memoryNotes || '') : existing.memoryNotes,
                  callMode: args.callMode !== undefined ? String(args.callMode || '').trim() : existing.callMode,
                };
                const saved = await saveGeminiSettings(next);
                const runtimeNow = await loadGeminiRuntimeConfig();
                const changedKeys = ['model','responseModalities','thinkingLevel','voiceName','speechOutputMode','fishVoiceId','personaName','operatorName','personalityPrompt','memoryEnabled','memoryNotes','callMode']
                  .filter((key) => args[key] !== undefined);
                const settings = {
                  model: saved.model || runtimeNow.model,
                  responseModalities: saved.responseModalities || runtimeNow.responseModalities || ['AUDIO'],
                  thinkingLevel: saved.thinkingLevel || runtimeNow.thinkingLevel || 'minimal',
                  voiceName: saved.voiceName || runtimeNow.voiceName || FAIRY_LIVE_VOICE_NAME,
                  speechOutputMode: saved.speechOutputMode || runtimeNow.speechOutputMode || 'gemini',
                  fishVoiceId: saved.fishVoiceId || runtimeNow.fishVoiceId || '',
                  personaName: saved.personaName || runtimeNow.personaName || 'Fairy',
                  operatorName: saved.operatorName || runtimeNow.operatorName || 'Epic',
                  memoryEnabled: saved.memoryEnabled ?? runtimeNow.memoryEnabled ?? true,
                  memoryNotes: saved.memoryNotes || runtimeNow.memoryNotes || '',
                  callMode: saved.callMode || runtimeNow.callMode || 'universal',
                };
                broadcast({ type: 'call:settings.updated', data: { sessionId: session.id, section: 'gemini', changedKeys, settings } });
                functionResponses.push({ name, id, response: { ok: true, section: 'gemini', changedKeys, settings } });
                continue;
              }
              if (name === 'request_image_for_display') {
                const query = String(args.query || '').trim();
                if (!query) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'Missing query for request_image_for_display' } });
                  continue;
                }
                const preferredAgent = String(args.agent || '').trim();
                const title = String(args.title || query).trim().slice(0, 160);
                const chosenAgent = chooseIdleAgent(preferredAgent || session.agent, roster);
                broadcast({ type: 'call:image.search.started', data: { sessionId: session.id, query, agent: chosenAgent, title } });
                functionResponses.push({ name, id, response: { ok: true, started: true, pending: true, agent: chosenAgent, message: 'Image lookup started. Tell Epic you are pulling something up.' } });
                (async () => {
                  const result = await runImageLookupTask({ query, agent: chosenAgent, session });
                  if (!result.ok) {
                    broadcast({ type: 'call:image.search.result', data: { sessionId: session.id, ok: false, query, agent: chosenAgent, error: result.error || 'Image lookup failed' } });
                    const live = liveGeminiSessions.get(session.id);
                    if (live) {
                      try { live.sendTextTurn(`SYSTEM EVENT FOR LIVE CALL:
Image lookup failed for query: ${query}
Error: ${result.error || 'Image lookup failed'}
Tell Epic plainly that the image pull failed.`); } catch {}
                    }
                    return;
                  }
                  const imageData = { sessionId: session.id, ok: true, query, agent: result.agent || chosenAgent, title: result.title || title, imageUrl: result.imageUrl, sourceUrl: result.sourceUrl || '', why: result.why || '', copyText: result.imageUrl };
                  updateCallSession(session.id, { imageDisplay: { ...imageData, shownAt: new Date().toISOString() } });
                  broadcast({ type: 'call:image.display', data: imageData });
                  const live = liveGeminiSessions.get(session.id);
                  if (live) {
                    try { live.sendTextTurn(`SYSTEM EVENT FOR LIVE CALL:
Image lookup complete for query: ${query}
Title: ${result.title || title}
Image URL: ${result.imageUrl}
Source URL: ${result.sourceUrl || ''}
Why: ${result.why || ''}
Tell Epic briefly that you put the image on screen and that he can copy the link.`); } catch {}
                  }
                })().catch((error) => {
                  broadcast({ type: 'call:image.search.result', data: { sessionId: session.id, ok: false, query, agent: chosenAgent, error: error.message || 'Image lookup failed' } });
                });
                continue;
              }
              if (name === 'search_web') {
                const query = String(args.query || '').trim();
                if (!query) {
                  functionResponses.push({ name, id, response: { error: 'Missing query for search_web' } });
                  continue;
                }
                broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Fairy requested web search: ${query.slice(0, 120)}` } });
                broadcast({ type: 'call:web_search.started', data: { sessionId: session.id, query } });
                functionResponses.push({
                  name,
                  id,
                  response: {
                    ok: true,
                    query,
                    started: true,
                    pending: true,
                    message: 'Web search started in the background. Acknowledge it briefly, keep listening, and tell Epic you will report back with results.',
                  },
                });
                (async () => {
                  try {
                    const result = await runOpenClawWebSearch(query, { agentId: roster.primaryAgentId || session.agent || 'orchestrator' });
                    const summary = summarizeWebSearchResult(result);
                    broadcast({
                      type: 'call:web_search.result',
                      data: {
                        sessionId: session.id,
                        query,
                        ok: true,
                        preview: summary.preview,
                        urls: summary.urls,
                        domains: summary.domains,
                      },
                    });
                    const live = liveGeminiSessions.get(session.id);
                    if (live) {
                      try {
                        live.sendTextTurn([
                          'SYSTEM EVENT FOR LIVE CALL:',
                          `Background web search complete for query: ${query}`,
                          summary.preview ? `Preview: ${summary.preview}` : '',
                          summary.domains?.length ? `Sources: ${summary.domains.join(', ')}` : '',
                          summary.urls?.length ? `URLs: ${summary.urls.slice(0, 3).join(' | ')}` : '',
                          'Now tell Epic the web result briefly. Make it clear you checked the web, summarize the useful part, and keep the conversation moving.',
                        ].filter(Boolean).join('\n'));
                      } catch (err) {
                        broadcast({ type: 'call:error', data: { sessionId: session.id, message: err.message || 'Could not relay web search result to Fairy' } });
                      }
                    }
                  } catch (error) {
                    broadcast({
                      type: 'call:web_search.result',
                      data: {
                        sessionId: session.id,
                        query,
                        ok: false,
                        error: error.message || 'Web search failed',
                      },
                    });
                    const live = liveGeminiSessions.get(session.id);
                    if (live) {
                      try {
                        live.sendTextTurn([
                          'SYSTEM EVENT FOR LIVE CALL:',
                          `Background web search failed for query: ${query}`,
                          `Error: ${error.message || 'Web search failed'}`,
                          'Tell Epic plainly that the web check failed, then continue the conversation without pretending you verified anything.',
                        ].join('\n'));
                      } catch (err) {
                        broadcast({ type: 'call:error', data: { sessionId: session.id, message: err.message || 'Could not relay web search failure to Fairy' } });
                      }
                    }
                  }
                })();
                continue;
              }
              if (name === 'start_screen_recording') {
                const liveSession = getCallSession(session.id);
                if (!liveSession?.screenShareActive) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'Screen sharing is not active, so there is nothing to record yet.' } });
                  continue;
                }
                if (liveSession?.recordingActive) {
                  functionResponses.push({ name, id, response: { ok: true, alreadyRecording: true, message: 'Screen recording is already running.' } });
                  continue;
                }
                const notes = String(args.notes || '').trim().slice(0, 240);
                updateCallSession(session.id, { recordingActive: true, recordingStartedAt: new Date().toISOString() });
                broadcastRecordingCommand(session.id, 'start', { notes });
                functionResponses.push({ name, id, response: { ok: true, started: true, message: 'Recording started. Tell Epic you are capturing it now.' } });
                continue;
              }
              if (name === 'stop_screen_recording') {
                const liveSession = getCallSession(session.id);
                if (!liveSession?.recordingActive) {
                  functionResponses.push({ name, id, response: { ok: false, error: 'No Fairy screen recording is currently active.' } });
                  continue;
                }
                const reason = String(args.reason || '').trim().slice(0, 200);
                broadcastRecordingCommand(session.id, 'stop', { reason, requestedBy: 'fairy-tool' });
                functionResponses.push({ name, id, response: { ok: true, stopping: true, message: 'Stopping and saving the recording now.' } });
                continue;
              }
              if (name === 'end_live_call') {
                broadcast({ type: 'call:end.requested', data: { sessionId: session.id, reason: String(args.reason || '').trim().slice(0, 200), source: 'fairy-tool' } });
                functionResponses.push({ name, id, response: { ok: true, ending: true, message: 'Ending the live call now.' } });
                setTimeout(() => {
                  const currentLive = liveGeminiSessions.get(session.id);
                  if (currentLive) {
                    try { currentLive.sendTextTurn('SYSTEM EVENT FOR LIVE CALL:\nWrap up in one short sentence, then end the call.'); } catch {}
                  }
                  broadcastRecordingCommand(session.id, 'prepare-end', { source: 'fairy-tool' });
                }, 50);
                continue;
              }
              if (name !== 'handoff_to_openclaw' && name !== 'handoff_to_agent') {
                functionResponses.push({ name, id, response: { error: `Unsupported tool: ${name}` } });
                continue;
              }
              const prompt = String(args.prompt || '').trim();
              const title = String(args.title || prompt.slice(0, 80) || 'Agent task').trim();
              const requestedAgent = String(args.agent || session.agent || 'orchestrator').trim();
              const agent = roster.agents.some((item) => item.id === requestedAgent)
                ? requestedAgent
                : String(roster.primaryAgentId || session.agent || 'orchestrator').trim();
              const selectedAgent = roster.agents.find((item) => item.id === agent) || null;
              const runtime = selectedAgent?.source === 'hermes' || selectedAgent?.bridge === 'hermes' ? 'hermes' : 'openclaw';
              const summary = String(args.summary || buildHandoffSpokenSummary(prompt, agent, roster)).trim();
              if (!prompt) {
                functionResponses.push({ name, id, response: { error: 'Missing prompt for handoff_to_agent' } });
                continue;
              }
              const handoffStarted = setCallSessionState(session.id, 'handing_off', {
                handoffTitle: title,
                handoffTaskId: '',
              });
              broadcastCallHandoff('call:handoff.started', session.id, { title, summary, agent, runtime, session: handoffStarted });
              const task = await createLiveTask({ title, summary, prompt, agent, runtime });
              const handoffLinked = setCallSessionState(session.id, 'task_running', {
                handoffTaskId: task.id,
                handoffTitle: title,
              });
              broadcastCallHandoff('call:handoff.task_created', session.id, { taskId: task.id, task, session: handoffLinked });
              broadcast({ type: 'live_task:update', data: task });
              runLiveTask(task, { broadcast, roster });
              functionResponses.push({
                name,
                id,
                response: {
                  ok: true,
                  taskId: task.id,
                  status: task.status,
                  summary: task.summary,
                },
              });
            }
            if (functionResponses.length) {
              gemini.sendToolResponse(functionResponses);
              broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini used live tool handoff (${functionResponses.length} call(s))` } });
            }
          })().catch((error) => {
            const failed = setCallSessionState(session.id, 'error', { lastAssistantText: error.message || 'Tool handoff failed' });
            broadcastCallHandoff('call:handoff.failed', session.id, { message: error.message || 'Tool handoff failed', session: failed });
            broadcast({ type: 'call:error', data: { sessionId: session.id, message: error.message || 'Tool handoff failed' } });
          });
          return;
        }
        if (event.type === 'response.text') {
          const text = String(event.data?.text || '').trim();
          if (!text) return;
          const updated = setCallSessionState(session.id, event.data?.done ? 'speaking' : 'thinking', { lastAssistantText: text });
          appendCallTranscriptEntry(session.id, 'assistant', text, { source: 'response.text', done: !!event.data?.done });
          broadcast({ type: 'call:response.text', data: { sessionId: session.id, text, done: !!event.data?.done, state: updated?.state || (event.data?.done ? 'speaking' : 'thinking') } });
          return;
        }
        if (event.type === 'response.audio') {
          const pcm16Base64 = String(event.data?.pcm16Base64 || '');
          const mimeType = String(event.data?.mimeType || 'audio/pcm;rate=24000');
          const updated = setCallSessionState(session.id, 'speaking');
          const finalText = event.data?.done ? String(getCallSession(session.id)?.lastAssistantText || '').trim() : '';
          broadcast({
            type: 'call:response.audio',
            data: {
              sessionId: session.id,
              pcm16Base64,
              mimeType,
              done: !!event.data?.done,
              text: finalText,
              state: updated?.state || 'speaking',
            },
          });
          if (event.data?.done && finalText) {
            broadcast({
              type: 'call:response.text',
              data: {
                sessionId: session.id,
                text: finalText,
                done: true,
                state: updated?.state || 'speaking',
                source: 'response.audio.final',
              },
            });
          }
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini audio chunk ${pcm16Base64.length}b ${mimeType}` } });
          return;
        }
        if (event.type === 'closed') {
          clearLiveWatchdog(session.id);
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini live closed code=${event.data?.code ?? ''} reason=${event.data?.reason || ''}` } });
          const ended = endCallSession(session.id, 'ended');
          if (ended) {
            broadcast({ type: 'call:session.ended', data: ended });
            maybeQueueFairyMemoryUpdate(ended).catch(() => {});
          }
          liveGeminiSessions.delete(session.id);
          liveScreenChangePrompts.delete(session.id);
        }
      },
      onError: (error) => {
        setCallSessionState(session.id, 'error', { lastAssistantText: error.message || 'Gemini live error' });
        broadcast({ type: 'call:error', data: { sessionId: session.id, message: error.message || 'Gemini live error' } });
      },
    });

    await gemini.connect();
    liveGeminiSessions.set(session.id, gemini);

    const ready = setCallSessionState(session.id, 'ready', {}, { broadcastState: false }) || session;
    broadcast({ type: 'call:session.started', data: ready });
    broadcastCallDebugState(session.id);
    res.json({ ok: true, session: ready, runtime: { model: runtime.model, thinkingLevel: runtime.thinkingLevel } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/call/:id/mode`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '').trim();
    const session = getCallSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
    const callMode = normalizeCallMode(req.body?.callMode || session.callMode || 'universal');
    const intensityLevel = String(session.intensityLevel || 'low').trim() || 'low';
    const policy = buildEffectiveCallPolicy(callMode, intensityLevel, session.liveIntentOverride || '');
    const updated = updateCallSession(sessionId, {
      callMode,
      liveIntentOverride: normalizeLiveIntentOverride(session.liveIntentOverride || ''),
      handoffPolicy: policy.handoffPolicy,
      proactivity: policy.proactivity,
      responseStyle: policy.responseStyle,
      modeDecision: policy.modeDecision,
      modeReason: policy.modeReason,
      speechSuppressedReason: policy.suppressScreenCommentary ? 'combat' : '',
    });
    broadcast({ type: 'call:mode.updated', data: { sessionId, callMode, liveIntentOverride: normalizeLiveIntentOverride(updated?.liveIntentOverride || ''), session: updated } });
    broadcastCallDebugState(sessionId);
    return res.json({ ok: true, session: updated, callMode });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not update call mode' });
  }
});

app.post(`${basePath}/api/call/:id/end`, async (req, res) => {
  const sessionId = String(req.params.id || '');
  clearLiveWatchdog(sessionId);
  const live = liveGeminiSessions.get(sessionId);
  if (live) {
    live.close();
    liveGeminiSessions.delete(sessionId);
    liveScreenChangePrompts.delete(sessionId);
  }
  const session = endCallSession(sessionId, 'ended');
  if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
  broadcast({ type: 'call:session.ended', data: session });
  maybeQueueFairyMemoryUpdate(session).catch(() => {});
  res.json({ ok: true, session });
});

app.post(`${basePath}/api/call/:id/audio`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) {
      const session = getCallSession(sessionId);
      if (session?.state === 'ended') return res.json({ ok: true, ignored: true, ended: true });
      return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    }
    const pcm16Base64 = String(req.body?.pcm16Base64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'audio/pcm;rate=16000').trim();
    if (!pcm16Base64) return res.status(400).json({ ok: false, error: 'Missing pcm16Base64' });
    live.sendAudioChunk({ pcm16Base64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, {
      state: 'listening',
      uplinkAudioChunks: Number(current?.uplinkAudioChunks || 0) + 1,
      currentTurnAudioChunks: Number(current?.currentTurnAudioChunks || 0) + 1,
      lastAudioAt: new Date().toISOString(),
    });
    const count = Number(updated?.uplinkAudioChunks || 0)
    const turnCount = Number(updated?.currentTurnAudioChunks || 0)
    if (count <= 3 || count % 25 === 0) {
      broadcast({ type: 'call:debug', data: { sessionId, message: `Audio chunk uplink #${count} total / #${turnCount} this turn ${pcm16Base64.length}b ${mimeType}` } });
    }
    if (turnCount === 50 || turnCount === 100 || turnCount === 200) {
      armLiveWatchdog(sessionId, updated?.lastTranscript || updated?.partialTranscript || 'Hello?', { broadcast });
    }
    res.json({ ok: true, state: updated?.state || 'listening' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/call/:id/intent`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '').trim();
    const session = getCallSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
    const liveIntentOverride = normalizeLiveIntentOverride(req.body?.intentOverride || req.body?.liveIntentOverride || '');
    const intensityLevel = session.callMode === 'gaming' ? (session.intensityLevel || 'low') : 'low';
    const policy = buildEffectiveCallPolicy(session.callMode || 'universal', intensityLevel, liveIntentOverride);
    const updated = updateCallSession(sessionId, {
      liveIntentOverride,
      liveIntentSetAt: new Date().toISOString(),
      handoffPolicy: policy.handoffPolicy,
      proactivity: policy.proactivity,
      responseStyle: policy.responseStyle,
      modeDecision: policy.modeDecision,
      modeReason: policy.modeReason,
      speechSuppressedReason: '',
    });
    broadcast({ type: 'call:intent.updated', data: { sessionId, liveIntentOverride, session: updated } });
    broadcastCallDebugState(sessionId);
    const live = liveGeminiSessions.get(sessionId);
    if (live) {
      try {
        live.sendTextTurn(buildLiveIntentSystemEvent(session.callMode || 'universal', liveIntentOverride));
      } catch (err) {
        broadcast({ type: 'call:error', data: { sessionId, message: err.message || 'Could not apply live intent override' } });
      }
    }
    return res.json({ ok: true, session: updated, liveIntentOverride, liveIntentStatus: describeLiveIntentOverride(liveIntentOverride) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not update live intent override' });
  }
});

app.post(`${basePath}/api/call/:id/screen`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const jpegBase64 = String(req.body?.jpegBase64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();
    const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || req.body?.meta || {});
    if (!jpegBase64) return res.status(400).json({ ok: false, error: 'Missing jpegBase64' });
    live.sendVideoFrame({ imageBase64: jpegBase64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, {
      screenShareActive: true,
      lastScreenFrameAt: new Date().toISOString(),
      lastScreenFrameMeta: frameMeta,
      screenFrameCount: Number(current?.screenFrameCount || 0) + 1,
    });
    if (!current?.screenShareActive) {
      broadcast({ type: 'call:screen.enabled', data: { sessionId, session: updated } });
    }
    const previousStableMeta = current?.visualMemory?.lastStableScreenFrameMeta || null;
    const nextVisualMemory = {
      ...(updated?.visualMemory || current?.visualMemory || {}),
      ...(frameMeta.stable ? (() => {
        const delta = summarizeStableVisualDelta(previousStableMeta || {}, frameMeta, current || updated || {});
        const snapshot = buildStableVisualSnapshot(frameMeta, current || updated || {});
        snapshot.summary = delta.summary;
        snapshot.confidence = delta.confidence;
        return {
          lastStableScreenFrameAt: updated?.lastScreenFrameAt || new Date().toISOString(),
          lastStableScreenFrameMeta: frameMeta,
          current: snapshot,
          lastChangeSummary: delta.summary,
        };
      })() : {}),
    };
    const afterVisual = updateCallSession(sessionId, {
      visualMemory: nextVisualMemory,
      ...(frameMeta.stable ? {
        lastVisualAssumption: summarizeStableVisualDelta(previousStableMeta || {}, frameMeta, current || updated || {}).assumption,
        lastVisualConfidence: summarizeStableVisualDelta(previousStableMeta || {}, frameMeta, current || updated || {}).confidence,
      } : {}),
    });
    if (frameMeta.stable) {
      const delta = summarizeStableVisualDelta(previousStableMeta || {}, frameMeta, current || updated || {});
      pushVisualMemoryEntry(sessionId, {
        reason: frameMeta.reason || 'stable-frame',
        summary: delta.summary,
        confidence: delta.confidence,
        current: nextVisualMemory.current,
      }, {
        current: nextVisualMemory.current,
        lastStableScreenFrameAt: nextVisualMemory.lastStableScreenFrameAt,
        lastStableScreenFrameMeta: nextVisualMemory.lastStableScreenFrameMeta,
        lastChangeSummary: delta.summary,
      });
    }
    const metaText = describeFrameMeta(frameMeta);
    broadcast({ type: 'call:debug', data: { sessionId, message: `Screen frame uplink #${updated?.screenFrameCount || 1} ${jpegBase64.length}b ${mimeType}${metaText ? ` ${metaText}` : ''}` } });
    broadcastCallDebugState(sessionId);
    return res.json({ ok: true, frameMeta });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/call/:id/camera`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const jpegBase64 = String(req.body?.jpegBase64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();
    const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || req.body?.meta || {});
    if (!jpegBase64) return res.status(400).json({ ok: false, error: 'Missing jpegBase64' });
    live.sendVideoFrame({ imageBase64: jpegBase64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, {
      cameraShareActive: true,
      lastCameraFrameAt: new Date().toISOString(),
      lastCameraFrameMeta: frameMeta,
      cameraFrameCount: Number(current?.cameraFrameCount || 0) + 1,
    });
    if (!current?.cameraShareActive) {
      broadcast({ type: 'call:camera.enabled', data: { sessionId, session: updated } });
    }
    const metaText = describeFrameMeta(frameMeta);
    broadcast({ type: 'call:debug', data: { sessionId, message: `Camera frame uplink #${updated?.cameraFrameCount || 1} ${jpegBase64.length}b ${mimeType}${metaText ? ` ${metaText}` : ''}` } });
    broadcastCallDebugState(sessionId);
    return res.json({ ok: true, frameMeta });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not send camera frame' });
  }
});

app.post(`${basePath}/api/call/:id/event`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const session = getCallSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
    const eventType = String(req.body?.type || '').trim();
    const text = String(req.body?.text || '').trim();

    if (eventType === 'transcript.partial') {
      liveScreenChangePrompts.set(sessionId, { lastAt: 0, pendingPayload: null, lastTier: '', lastSkippedAt: 0 });
      const updated = updateCallSession(sessionId, { partialTranscript: text, state: 'listening' });
      broadcast({ type: 'call:transcript.partial', data: { sessionId, text, state: updated?.state || 'listening' } });
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'transcript.final') {
      clearLiveWatchdog(sessionId);
      const updated = updateCallSession(sessionId, {
        lastTranscript: text,
        partialTranscript: '',
        state: 'thinking',
        currentTurnGeminiEventCount: 0,
        currentTurnAudioChunks: 0,
      });
      appendCallTranscriptEntry(sessionId, 'user', text, { source: 'transcript.final' });
      broadcast({ type: 'call:transcript.final', data: { sessionId, text, state: updated?.state || 'thinking' } });

      if (looksComplexRequest(text)) {
        const title = text.slice(0, 80) || 'Background task';
        const summary = buildHandoffSpokenSummary(text, session.agent, roster);
        const started = setCallSessionState(sessionId, 'handing_off', {
          handoffTitle: title,
          handoffTaskId: '',
          lastRoutingDecision: 'complex-request-handoff',
          lastTaskSummary: summary,
        });
        broadcastCallHandoff('call:handoff.started', sessionId, { title, summary, agent: session.agent, session: started });
        const task = await createLiveTask({
          title,
          summary,
          prompt: text,
          agent: session.agent,
        });
        const linked = setCallSessionState(sessionId, 'task_running', {
          handoffTitle: title,
          handoffTaskId: task.id,
          lastRoutingDecision: 'complex-request-handoff',
          lastTaskSummary: summary,
        });
        broadcastCallDebugState(sessionId);
        broadcastCallHandoff('call:handoff.task_created', sessionId, { taskId: task.id, task, session: linked });
        broadcast({ type: 'live_task:update', data: task });
        runLiveTask(task, { broadcast, roster });
        const spoken = summary;
        const after = updateCallSession(sessionId, { lastAssistantText: spoken, state: 'speaking' });
        appendCallTranscriptEntry(sessionId, 'assistant', spoken, { source: 'openclaw-task', taskId: task.id });
        broadcast({ type: 'call:response.text', data: { sessionId, text: spoken, taskId: task.id, state: after?.state || 'speaking' } });
        return res.json({ ok: true, route: 'openclaw-task', taskId: task.id, spoken, session: after });
      }

      const live = liveGeminiSessions.get(sessionId);
      if (!live) {
        const spoken = 'Gemini live session is not connected yet. Please restart the call.';
        const after = updateCallSession(sessionId, { lastAssistantText: spoken, state: 'speaking' });
        appendCallTranscriptEntry(sessionId, 'assistant', spoken, { source: 'gemini-live-missing' });
        broadcast({ type: 'call:response.text', data: { sessionId, text: spoken, state: after?.state || 'speaking' } });
        return res.json({ ok: false, route: 'gemini-live-missing', spoken, session: after });
      }

      const runtime = await loadGeminiRuntimeConfig();
      const turnMemoryStore = runtime.memoryEnabled !== false ? await loadFairyMemory() : { entries: [] };
      const relevantMemory = buildFairyMemoryContext({
        enabled: runtime.memoryEnabled !== false,
        memoryNotes: runtime.memoryNotes || '',
        store: turnMemoryStore,
        query: text,
        scope: session.agent || 'general',
        limit: 6,
      });
      const enrichedText = relevantMemory
        ? `[Local memory context — do not quote verbatim unless useful]
${relevantMemory}

[Operator request]
${text}`
        : text;
      live.sendTextTurn(enrichedText);
      const after = updateCallSession(sessionId, { state: 'thinking' });
      return res.json({ ok: true, route: 'gemini-live', session: after });
    }

    if (eventType === 'assistant.playback_finished') {
      clearLiveWatchdog(sessionId);
      const updated = updateCallSession(sessionId, { state: 'ready', currentTurnAudioChunks: 0 });
      broadcast({ type: 'call:session.state', data: { sessionId, state: updated?.state || 'ready' } });
      flushDeferredScreenCommentary(sessionId, 'assistant-finished');
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'assistant.interrupted') {
      clearLiveWatchdog(sessionId);
      const reason = String(req.body?.reason || 'user_speaking').trim() || 'user_speaking';
      const updated = updateCallSession(sessionId, {
        state: 'listening',
        currentTurnAudioChunks: 0,
        partialTranscript: '',
        lastRoutingDecision: `interrupted:${reason}`,
      });
      broadcast({ type: 'call:assistant.interrupted', data: { sessionId, reason, state: updated?.state || 'listening' } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'recording.started') {
      const updated = updateCallSession(sessionId, {
        recordingActive: true,
        recordingStartedAt: String(req.body?.startedAt || new Date().toISOString()).trim(),
      });
      broadcast({ type: 'call:recording.started', data: { sessionId, session: updated } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'recording.stopped') {
      const updated = updateCallSession(sessionId, {
        recordingActive: false,
      });
      broadcast({ type: 'call:recording.stopped', data: { sessionId, session: updated, reason: String(req.body?.reason || '').trim() } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'screen.started') {
      const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || {});
      const updated = updateCallSession(sessionId, {
        screenShareActive: true,
        lastScreenFrameMeta: frameMeta,
        lastGeminiHintAt: new Date().toISOString(),
        lastVisualAssumption: 'Screen share started; building fresh visual state from stable frames.',
        lastVisualConfidence: 'low',
        visualMemory: {
          ...(session.visualMemory || {}),
          current: null,
          recent: [],
          lastChangeAt: null,
          lastChangeSummary: 'Screen share started.',
        },
      });
      const live = liveGeminiSessions.get(sessionId);
      if (live) {
        try {
          const metaText = describeFrameMeta(frameMeta);
          const prompt = `Screen sharing is now active${metaText ? ` (${metaText})` : ''}. Use incoming stable screen frames as visual context. Prioritize meaningful changes: errors, warnings, redirects, enabled actions, blocked flows, modals, completed loads, auth failures, and obvious next steps. Do not narrate every frame. Do not identify a website, app, tab, or route unless visible text/UI clearly supports it; if the frame is blank or transitional, say it appears to still be loading. If Epic asks for changes or actions, hand off to OpenClaw.`;
          updateCallSession(sessionId, { lastGeminiHint: prompt, lastGeminiHintAt: new Date().toISOString() });
          live.sendTextTurn(prompt);
        } catch (err) {
          broadcast({ type: 'call:error', data: { sessionId, message: err.message || 'Could not send screen context to Gemini' } });
        }
      }
      broadcast({ type: 'call:screen.enabled', data: { sessionId, session: updated } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'screen.changed') {
      const avgDiff = Number(req.body?.avgDiff || 0);
      const changedRatio = Number(req.body?.changedRatio || 0);
      const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || {});
      const updated = updateCallSession(sessionId, {
        lastScreenFrameMeta: frameMeta || session.lastScreenFrameMeta,
        lastScreenChange: { avgDiff, changedRatio, at: new Date().toISOString(), frameMeta },
        lastVisualAssumption: 'A major screen transition just happened; older page assumptions may now be stale until the next stable frame confirms the new state.',
        lastVisualConfidence: 'low',
        visualMemory: {
          ...(session.visualMemory || {}),
          current: session.visualMemory?.current ? {
            ...session.visualMemory.current,
            confidence: 'low',
            uiState: {
              ...(session.visualMemory.current.uiState || {}),
              transitional: true,
              loading: true,
            },
            summary: 'Recent major screen change detected; waiting for the next stable frame before trusting old assumptions.',
          } : null,
          lastChangeAt: new Date().toISOString(),
          lastChangeSummary: `Screen changed (${avgDiff}/${changedRatio}).`,
        },
      });
      pushVisualMemoryEntry(sessionId, {
        reason: 'screen-change-stable',
        summary: `Screen changed (${avgDiff}/${changedRatio}).`,
        confidence: frameMeta?.stable ? 'medium' : 'low',
      });
      broadcast({ type: 'call:screen.changed', data: { sessionId, avgDiff, changedRatio, frameMeta } });
      const queueState = liveScreenChangePrompts.get(sessionId) || {};
      if ((session.callMode === 'gaming' || updated?.callMode === 'gaming') && queueState.pendingPayload) {
        const newIntensity = inferGamingIntensity({ avgDiff, changedRatio }, updated || session);
        if (newIntensity === 'low') {
          flushDeferredScreenCommentary(sessionId, 'screen-settled');
        } else {
          maybePromptScreenChange(sessionId, { avgDiff, changedRatio, frameMeta });
        }
      } else {
        maybePromptScreenChange(sessionId, { avgDiff, changedRatio, frameMeta });
      }
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated || getCallSession(sessionId) });
    }

    if (eventType === 'screen.stopped') {
      liveScreenChangePrompts.delete(sessionId);
      const updated = updateCallSession(sessionId, {
        screenShareActive: false,
        lastVisualAssumption: 'Screen sharing stopped; no current screen visibility.',
        lastVisualConfidence: 'none',
        visualMemory: {
          ...(session.visualMemory || {}),
          current: null,
          lastChangeSummary: 'Screen sharing stopped.',
        },
      });
      const live = liveGeminiSessions.get(sessionId);
      if (live) {
        try {
          live.sendTextTurn('Screen sharing stopped. Do not claim current visual awareness unless new screen frames arrive.');
        } catch {}
      }
      broadcast({ type: 'call:screen.disabled', data: { sessionId, session: updated } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'camera.started') {
      const updated = updateCallSession(sessionId, {
        cameraShareActive: true,
        lastVisualAssumption: 'Camera sharing active; use camera frames for current visual answers.',
      });
      const live = liveGeminiSessions.get(sessionId);
      if (live) {
        try {
          const prompt = 'Camera sharing is now active. Use incoming camera frames as visual context for what Epic is showing you. If Epic asks what you can see, answer from the camera frames. If he asks for actions, hand off to OpenClaw.';
          updateCallSession(sessionId, { lastGeminiHint: prompt, lastGeminiHintAt: new Date().toISOString() });
          live.sendTextTurn(prompt);
        } catch (err) {
          broadcast({ type: 'call:error', data: { sessionId, message: err.message || 'Could not send camera context to Gemini' } });
        }
      }
      broadcast({ type: 'call:camera.enabled', data: { sessionId, session: updated } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    if (eventType === 'camera.stopped') {
      const updated = updateCallSession(sessionId, {
        cameraShareActive: false,
        lastVisualAssumption: 'Camera sharing stopped; no current camera visibility.',
      });
      const live = liveGeminiSessions.get(sessionId);
      if (live) {
        try {
          live.sendTextTurn('Camera sharing stopped. Do not claim current camera visibility unless new camera frames arrive.');
        } catch {}
      }
      broadcast({ type: 'call:camera.disabled', data: { sessionId, session: updated } });
      broadcastCallDebugState(sessionId);
      return res.json({ ok: true, session: updated });
    }

    return res.status(400).json({ ok: false, error: 'Unsupported call event type' });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(`${basePath}/api/live/tasks`, async (req, res) => {
  const tasks = await listLiveTasks();
  res.json({ ok: true, tasks });
});

app.get(`${basePath}/api/live/tasks/:id`, async (req, res) => {
  const task = await getLiveTask(String(req.params.id || ''));
  if (!task) return res.status(404).json({ ok: false, error: 'Task not found' });
  res.json({ ok: true, task });
});

app.post(`${basePath}/api/live/tasks/prune`, async (req, res) => {
  const pruned = await pruneLiveTasks();
  res.json({ ok: true, pruned });
});

app.post(`${basePath}/api/live/tasks`, async (req, res) => {
  try {
    const { text, title, agent } = req.body || {};
    const prompt = String(text || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'No text provided' });
    const task = await createLiveTask({
      title: String(title || prompt.slice(0, 80) || 'Background task'),
      summary: 'Queued',
      prompt,
      agent: String(agent || getRoster().primaryAgentId || 'orchestrator'),
    });
    broadcast({ type: 'live_task:update', data: task });
    runLiveTask(task, { broadcast, roster });
    res.json({ ok: true, task_id: task.id, status: task.status, task });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/live/route`, async (req, res) => {
  try {
    const { text, agent } = req.body || {};
    const prompt = String(text || '').trim();
    if (!prompt) return res.status(400).json({ ok: false, error: 'No text provided' });

    if (looksComplexRequest(prompt)) {
      const task = await createLiveTask({
        title: prompt.slice(0, 80) || 'Background task',
        summary: "I'm working on that in the background.",
        prompt,
        agent: String(agent || getRoster().primaryAgentId || 'orchestrator'),
      });
      broadcast({ type: 'live_task:update', data: task });
      runLiveTask(task, { broadcast, roster });
      return res.json({
        ok: true,
        route: 'openclaw-task',
        task_id: task.id,
        status: task.status,
        spoken: "I'm working on that in the background.",
      });
    }

    return res.json({
      ok: true,
      route: 'gemini-live',
      spoken: null,
      task_id: null,
      status: 'direct',
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(`${basePath}/api/memory/search`, async (req, res) => {
  res.json({ ok: true, results: [], available: false, reason: 'memory-provider-unavailable-or-not-yet-wired' });
});

app.get(`${basePath}/api/v1/settings/:section`, async (req, res) => {
  try {
    const { key, path } = resolveSettingsSection(req.params.section || '');
    if (!path) return res.status(404).json({ ok: false, error: 'Unsupported settings section' });
    const result = await fetchLocalSettings(req, 'GET', path);
    return res.status(result.status).json({ ok: true, section: key, ...(result.data || {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not read settings section' });
  }
});

app.post(`${basePath}/api/v1/settings/:section`, async (req, res) => {
  try {
    const { key, path } = resolveSettingsSection(req.params.section || '');
    if (!path) return res.status(404).json({ ok: false, error: 'Unsupported settings section' });
    const patch = sanitizeSettingsPatch(req.body || {});
    const result = await fetchLocalSettings(req, 'POST', path, patch);
    return res.status(result.status).json({ ok: true, section: key, ...(result.data || {}) });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not save settings section' });
  }
});

app.get(`${basePath}/api/v1/fairy/config`, async (req, res) => {
  const config = await loadGeminiRuntimeConfig();
  res.json({
    ok: true,
    fairy: {
      hasApiKey: config.hasApiKey,
      model: config.model,
      responseModalities: config.responseModalities,
      thinkingLevel: config.thinkingLevel,
      voiceName: config.voiceName || FAIRY_LIVE_VOICE_NAME,
      speechOutputMode: config.speechOutputMode || 'gemini',
      fishVoiceId: config.fishVoiceId || '',
      personaName: config.personaName || 'Fairy',
      operatorName: config.operatorName || 'Epic',
      personalityPrompt: config.personalityPrompt || '',
      memoryEnabled: config.memoryEnabled ?? true,
      memoryNotes: config.memoryNotes || '',
      callMode: config.callMode || 'universal',
      availableCallModes: FAIRY_CALL_MODE_OPTIONS,
      availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
      source: config.source,
      transport: 'server-websocket',
    },
  });
});

app.get(`${basePath}/api/v1/fairy/settings`, async (req, res) => {
  const settings = await loadGeminiSettings();
  const runtime = await loadGeminiRuntimeConfig();
  res.json({
    ok: true,
    settings: {
      hasApiKey: !!runtime.hasApiKey,
      apiKeyMasked: maskApiKey(settings.apiKey || runtime.apiKey || ''),
      model: settings.model || runtime.model,
      responseModalities: settings.responseModalities || runtime.responseModalities || ['AUDIO'],
      thinkingLevel: settings.thinkingLevel || runtime.thinkingLevel || 'minimal',
      voiceName: settings.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
      speechOutputMode: settings.speechOutputMode || runtime.speechOutputMode || 'gemini',
      fishVoiceId: settings.fishVoiceId || runtime.fishVoiceId || '',
      personaName: settings.personaName || runtime.personaName || 'Fairy',
      operatorName: settings.operatorName || runtime.operatorName || 'Epic',
      personalityPrompt: settings.personalityPrompt || runtime.personalityPrompt || '',
      memoryEnabled: settings.memoryEnabled ?? runtime.memoryEnabled ?? true,
      memoryNotes: settings.memoryNotes || runtime.memoryNotes || '',
      callMode: settings.callMode || runtime.callMode || 'universal',
      availableCallModes: FAIRY_CALL_MODE_OPTIONS,
      availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
      source: runtime.source || 'command-center-local',
    },
  });
});

app.post(`${basePath}/api/v1/fairy/settings`, async (req, res) => {
  try {
    const existing = await loadGeminiSettings();
    const body = req.body || {};
    const next = {
      apiKey: existing.apiKey,
      model: body.model !== undefined ? String(body.model || '').trim() : existing.model,
      responseModalities: body.responseModalities !== undefined ? body.responseModalities : existing.responseModalities,
      thinkingLevel: body.thinkingLevel !== undefined ? String(body.thinkingLevel || '').trim() : existing.thinkingLevel,
      voiceName: body.voiceName !== undefined ? String(body.voiceName || '').trim() : existing.voiceName,
      speechOutputMode: body.speechOutputMode !== undefined ? String(body.speechOutputMode || '').trim() : existing.speechOutputMode,
      fishVoiceId: body.fishVoiceId !== undefined ? String(body.fishVoiceId || '').trim() : existing.fishVoiceId,
      personaName: body.personaName !== undefined ? String(body.personaName || '').trim() : existing.personaName,
      operatorName: body.operatorName !== undefined ? String(body.operatorName || '').trim() : existing.operatorName,
      personalityPrompt: body.personalityPrompt !== undefined ? String(body.personalityPrompt || '') : existing.personalityPrompt,
      memoryEnabled: body.memoryEnabled !== undefined ? body.memoryEnabled !== false : existing.memoryEnabled,
      memoryNotes: body.memoryNotes !== undefined ? String(body.memoryNotes || '') : existing.memoryNotes,
      callMode: body.callMode !== undefined ? String(body.callMode || '').trim() : existing.callMode,
    };
    const saved = await saveGeminiSettings(next);
    const runtime = await loadGeminiRuntimeConfig();
    res.json({
      ok: true,
      settings: {
        hasApiKey: !!runtime.hasApiKey,
        apiKeyMasked: maskApiKey(saved.apiKey || runtime.apiKey || ''),
        model: saved.model || runtime.model,
        responseModalities: saved.responseModalities || runtime.responseModalities || ['AUDIO'],
        thinkingLevel: saved.thinkingLevel || runtime.thinkingLevel || 'minimal',
        voiceName: saved.voiceName || runtime.voiceName || FAIRY_LIVE_VOICE_NAME,
        speechOutputMode: saved.speechOutputMode || runtime.speechOutputMode || 'gemini',
        fishVoiceId: saved.fishVoiceId || runtime.fishVoiceId || '',
        personaName: saved.personaName || runtime.personaName || 'Fairy',
        operatorName: saved.operatorName || runtime.operatorName || 'Epic',
        personalityPrompt: saved.personalityPrompt || runtime.personalityPrompt || '',
        memoryEnabled: saved.memoryEnabled ?? runtime.memoryEnabled ?? true,
        memoryNotes: saved.memoryNotes || runtime.memoryNotes || '',
        callMode: saved.callMode || runtime.callMode || 'universal',
        availableCallModes: FAIRY_CALL_MODE_OPTIONS,
        availableVoiceNames: GEMINI_LIVE_VOICE_OPTIONS,
        source: runtime.source || 'command-center-local',
      },
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/fairy/memory`, async (req, res) => {
  const store = await loadFairyMemory();
  const scope = String(req.query?.scope || 'all').trim().toLowerCase();
  const query = String(req.query?.q || '').trim();
  let entries = Array.isArray(store.entries) ? [...store.entries] : [];
  if (scope && scope !== 'all') entries = entries.filter((entry) => String(entry.scope || 'general') === scope);
  if (query) {
    entries = selectRelevantFairyMemory({ store: { entries }, query, scope: scope === 'all' ? 'general' : scope, limit: 40 });
  }
  entries.sort((a, b) => (b.pinned === true) - (a.pinned === true) || Date.parse(b.updatedAt || b.createdAt || 0) - Date.parse(a.updatedAt || a.createdAt || 0));
  res.json({ ok: true, entries, count: entries.length });
});

app.get(`${basePath}/api/v1/fairy/sessions`, async (req, res) => {
  const sessions = listCallSessions().filter((session) => String(session?.persona || '') === 'fairy');
  res.json({ ok: true, sessions });
});

app.get(`${basePath}/api/v1/fairy/sessions/:id`, async (req, res) => {
  const session = getCallSession(String(req.params.id || ''));
  if (!session || String(session.persona || '') !== 'fairy') {
    return res.status(404).json({ ok: false, error: 'Fairy session not found' });
  }
  res.json({ ok: true, session });
});

app.post(`${basePath}/api/v1/fairy/calls/start`, async (req, res) => {
  try {
    const upstream = await fetch(`${req.protocol}://${req.get('host')}${basePath}/api/call/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: req.headers.cookie || '' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not start Fairy live session' });
  }
});

app.post(`${basePath}/api/v1/fairy/calls/:id/end`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const upstream = await fetch(`${req.protocol}://${req.get('host')}${basePath}/api/call/${encodeURIComponent(sessionId)}/end`, {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: req.headers.cookie || '' }, body: JSON.stringify({}),
    });
    const data = await upstream.json();
    return res.status(upstream.status).json(data);
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not end call' });
  }
});

app.post(`${basePath}/api/v1/fairy/calls/:id/text`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const session = getCallSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
    const text = String(req.body?.text || req.body?.message || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'text is required' });
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    live.sendTextTurn(text);
    const updated = updateCallSession(sessionId, { state: 'thinking', lastTranscript: text, partialTranscript: '' });
    appendCallTranscriptEntry(sessionId, 'user', text, { source: 'v1.text' });
    broadcast({ type: 'call:transcript.final', data: { sessionId, text, state: updated?.state || 'thinking' } });
    return res.json({ ok: true, route: 'gemini-live', session: updated });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not send text turn' });
  }
});

app.post(`${basePath}/api/v1/fairy/calls/:id/audio`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const pcm16Base64 = String(req.body?.pcm16Base64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'audio/pcm;rate=16000').trim();
    if (!pcm16Base64) return res.status(400).json({ ok: false, error: 'Missing pcm16Base64' });
    live.sendAudioChunk({ pcm16Base64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, { state: 'listening', uplinkAudioChunks: Number(current?.uplinkAudioChunks || 0) + 1, currentTurnAudioChunks: Number(current?.currentTurnAudioChunks || 0) + 1, lastAudioAt: new Date().toISOString() });
    return res.json({ ok: true, state: updated?.state || 'listening' });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not send audio chunk' });
  }
});

app.post(`${basePath}/api/v1/fairy/calls/:id/screen`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const jpegBase64 = String(req.body?.jpegBase64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();
    const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || req.body?.meta || {});
    if (!jpegBase64) return res.status(400).json({ ok: false, error: 'Missing jpegBase64' });
    live.sendVideoFrame({ imageBase64: jpegBase64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, {
      screenShareActive: true,
      lastScreenFrameAt: new Date().toISOString(),
      lastScreenFrameMeta: frameMeta,
      screenFrameCount: Number(current?.screenFrameCount || 0) + 1,
    });
    broadcast({ type: 'call:screen.enabled', data: { sessionId, session: updated } });
    return res.json({ ok: true, session: updated, frameMeta });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not send screen frame' });
  }
});

app.post(`${basePath}/api/v1/fairy/calls/:id/camera`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const jpegBase64 = String(req.body?.jpegBase64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();
    const frameMeta = sanitizeFrameMeta(req.body?.frameMeta || req.body?.meta || {});
    if (!jpegBase64) return res.status(400).json({ ok: false, error: 'Missing jpegBase64' });
    live.sendVideoFrame({ imageBase64: jpegBase64, mimeType });
    const current = getCallSession(sessionId);
    const updated = updateCallSession(sessionId, {
      cameraShareActive: true,
      lastCameraFrameAt: new Date().toISOString(),
      lastCameraFrameMeta: frameMeta,
      cameraFrameCount: Number(current?.cameraFrameCount || 0) + 1,
    });
    broadcast({ type: 'call:camera.enabled', data: { sessionId, session: updated } });
    return res.json({ ok: true, session: updated, frameMeta });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || 'Could not send camera frame' });
  }
});

app.get(`${basePath}/api/v1/sessions`, async (req, res) => {
  try {
    const agent = String(req.query?.agent || '').trim();
    const mode = String(req.query?.mode || '').trim();
    const limit = Number(req.query?.limit || 20);
    let sessions = await listApiSessions({ agent, limit: Math.max(limit, 100) });
    if (mode) sessions = sessions.filter((item) => String(item.mode || 'agent') === mode);
    res.json({ ok: true, sessions: sessions.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/sessions/search`, async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'Missing query', code: 'BAD_REQUEST' });
    const agent = String(req.query?.agent || '').trim();
    const mode = String(req.query?.mode || '').trim();
    const limit = Number(req.query?.limit || 20);
    let results = await searchApiSessions(q, { agent, limit: Math.max(limit, 100) });
    if (mode) results = results.filter((item) => String(item.mode || 'agent') === mode);
    res.json({ ok: true, query: q, results: results.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/sessions`, async (req, res) => {
  try {
    const agent = String(req.body?.agent || '').trim();
    const title = String(req.body?.title || '').trim();
    const mode = String(req.body?.mode || 'agent').trim() === 'roleplay' ? 'roleplay' : 'agent';
    const model = String(req.body?.model || '').trim();
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    if (!agent) return res.status(400).json({ ok: false, error: 'agent is required', code: 'BAD_REQUEST' });
    const exists = roster.agents.some((item) => item.id === agent);
    if (!exists) return res.status(404).json({ ok: false, error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    const session = await createApiSession({ agent, title, metadata, mode, model: mode === 'roleplay' ? model : '' });
    res.json({ ok: true, session: getApiSessionMeta(session) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/sessions/:id`, async (req, res) => {
  try {
    const session = await getApiSession(String(req.params.id || ''));
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    res.json({ ok: true, session: getApiSessionMeta(session) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/sessions/:id/messages`, async (req, res) => {
  try {
    const session = await getApiSession(String(req.params.id || ''));
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    const limit = Number(req.query?.limit || 0);
    const messages = limit > 0 ? session.messages.slice(-limit) : session.messages;
    res.json({ ok: true, sessionId: session.id, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/sessions/:id/messages`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const text = String(req.body?.message || '').trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    if (!text) return res.status(400).json({ ok: false, error: 'message is required', code: 'MESSAGE_REQUIRED' });
    let session = await getApiSession(sessionId);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found', code: 'SESSION_NOT_FOUND' });

    const { files: attachedFiles, bundle: attachmentBundle } = await resolveAttachmentBundle(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = attachmentBundle.context;

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text, meta: { files: attachmentPayload } });
    session = userAppend.session;

    const sessionMode = String(session.mode || 'agent') === 'roleplay' ? 'roleplay' : 'agent';
    const result = sessionMode === 'roleplay'
      ? await runRoleplayChatTurn({ session, latestMessage: text, attachmentContext, model: session.model || String(req.body?.model || '').trim() })
      : await runApiChatTurn({ session, latestMessage: text, attachmentContext, attachmentImages: attachmentBundle.images, attachmentStatuses: attachmentBundle.statuses });
    session = await maybePersistHermesSession(session, result);
    const assistantMeta = { files: [], mode: sessionMode, model: result.model || session.model || '' };
    let audioPayload = null;
    if (req.body?.audio === true) {
      const audio = await speak(result.text, session.agent);
      audioPayload = {
        contentType: audio.contentType,
        base64: audio.buffer.toString('base64'),
        provider: audio.provider || '',
        voiceId: audio.voiceId || '',
      };
      assistantMeta.audio = {
        contentType: audioPayload.contentType,
        provider: audioPayload.provider,
        voiceId: audioPayload.voiceId,
      };
    }
    const assistantAppend = await appendApiSessionMessage(session.id, { role: 'assistant', text: result.text, meta: assistantMeta });

    res.json({
      ok: true,
      sessionId: session.id,
      agent: session.agent,
      message: userAppend.message,
      response: assistantAppend.message,
      files: attachmentPayload,
      attachmentStatuses: result.attachmentStatuses || attachmentBundle.statuses,
      audio: audioPayload,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/sessions/:id/messages/stream`, async (req, res) => {
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  try {
    const sessionId = String(req.params.id || '');
    const text = String(req.body?.message || '').trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    if (!text) {
      res.status(400).json({ ok: false, error: 'message is required', code: 'MESSAGE_REQUIRED' });
      return;
    }
    let session = await getApiSession(sessionId);
    if (!session) {
      res.status(404).json({ ok: false, error: 'Session not found', code: 'SESSION_NOT_FOUND' });
      return;
    }

    const { files: attachedFiles, bundle: attachmentBundle } = await resolveAttachmentBundle(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = attachmentBundle.context;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text, meta: { files: attachmentPayload } });
    session = userAppend.session;
    sendEvent('accepted', { sessionId: session.id, messageId: userAppend.message.id, agent: session.agent, files: attachmentPayload });

    const sessionMode = String(session.mode || 'agent') === 'roleplay' ? 'roleplay' : 'agent';
    const result = sessionMode === 'roleplay'
      ? await runRoleplayChatTurn({
          session,
          latestMessage: text,
          attachmentContext,
          model: session.model || String(req.body?.model || '').trim(),
          attachmentImages: attachmentBundle.images,
          attachmentStatuses: attachmentBundle.statuses,
          onEvent: (event) => sendEvent(event.type, event.data || {}),
        })
      : await runApiChatTurn({
          session,
          latestMessage: text,
          attachmentContext,
          attachmentImages: attachmentBundle.images,
          attachmentStatuses: attachmentBundle.statuses,
          onEvent: (event) => sendEvent(event.type, event.data || {}),
        });
    session = await maybePersistHermesSession(session, result);
    const assistantMeta = { files: [], mode: sessionMode, model: result.model || session.model || '' };
    let audioEvent = null;
    if (req.body?.audio === true) {
      const audio = await speak(result.text, session.agent);
      audioEvent = {
        contentType: audio.contentType,
        base64: audio.buffer.toString('base64'),
        provider: audio.provider || '',
        voiceId: audio.voiceId || '',
      };
      assistantMeta.audio = {
        contentType: audioEvent.contentType,
        provider: audioEvent.provider,
        voiceId: audioEvent.voiceId,
      };
      sendEvent('audio', audioEvent);
    }
    const assistantAppend = await appendApiSessionMessage(session.id, { role: 'assistant', text: result.text, meta: assistantMeta });
    sendEvent('done', { ok: true, sessionId: session.id, responseId: assistantAppend.message.id, audio: !!audioEvent, attachmentStatuses: result.attachmentStatuses || attachmentBundle.statuses });
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
      return;
    }
    sendEvent('error', { ok: false, error: err.message, code: 'INTERNAL_ERROR' });
    res.end();
  }
});

app.post(`${basePath}/api/v1/chat`, async (req, res) => {
  try {
    const message = String(req.body?.message || '').trim();
    const existingSessionId = String(req.body?.sessionId || '').trim();
    const requestedAgent = String(req.body?.agent || '').trim();
    const title = String(req.body?.title || '').trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    if (!message) return res.status(400).json({ ok: false, error: 'message is required', code: 'MESSAGE_REQUIRED' });

    let session = null;
    if (existingSessionId) {
      session = await getApiSession(existingSessionId);
      if (!session) return res.status(404).json({ ok: false, error: 'Session not found', code: 'SESSION_NOT_FOUND' });
    } else {
      if (!requestedAgent) return res.status(400).json({ ok: false, error: 'agent is required when sessionId is missing', code: 'BAD_REQUEST' });
      const exists = roster.agents.some((item) => item.id === requestedAgent);
      if (!exists) return res.status(404).json({ ok: false, error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
      session = await createApiSession({ agent: requestedAgent, title, metadata: req.body?.metadata || {} });
    }

    const { files: attachedFiles, bundle: attachmentBundle } = await resolveAttachmentBundle(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = attachmentBundle.context;

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text: message, meta: { files: attachmentPayload } });
    session = userAppend.session;
    const result = await runApiChatTurn({ session, latestMessage: message, attachmentContext, attachmentImages: attachmentBundle.images, attachmentStatuses: attachmentBundle.statuses });
    session = await maybePersistHermesSession(session, result);
    const assistantMeta = { files: [] };
    let audioPayload = null;
    if (req.body?.audio === true) {
      const audio = await speak(result.text, session.agent);
      audioPayload = {
        contentType: audio.contentType,
        base64: audio.buffer.toString('base64'),
        provider: audio.provider || '',
        voiceId: audio.voiceId || '',
      };
      assistantMeta.audio = {
        contentType: audioPayload.contentType,
        provider: audioPayload.provider,
        voiceId: audioPayload.voiceId,
      };
    }
    const assistantAppend = await appendApiSessionMessage(session.id, { role: 'assistant', text: result.text, meta: assistantMeta });

    res.json({
      ok: true,
      session: getApiSessionMeta(assistantAppend.session),
      message: userAppend.message,
      response: assistantAppend.message,
      files: attachmentPayload,
      attachmentStatuses: result.attachmentStatuses || attachmentBundle.statuses,
      audio: audioPayload,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/chat/history/:agent`, async (req, res) => {
  try {
    const roster = getRoster();
    const agentId = String(req.params.agent || '').trim() || roster.primaryAgentId || 'main';
    const history = await getChatHistory(agentId);
    res.json({ ok: true, agent: agentId, messages: history });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get(`${basePath}/api/chat/sessions`, async (req, res) => {
  try {
    const agent = String(req.query?.agent || '').trim();
    const mode = String(req.query?.mode || '').trim();
    const limit = Math.max(1, Number(req.query?.limit || 20) || 20);
    let sessions = await listApiSessions({ agent, limit: Math.max(limit, 100) });
    if (mode) sessions = sessions.filter((item) => String(item.mode || 'agent') === mode);
    res.json({ ok: true, sessions: sessions.slice(0, limit) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/chat/sessions`, async (req, res) => {
  try {
    const agent = String(req.body?.agent || '').trim();
    const title = String(req.body?.title || '').trim();
    const requestedMode = String(req.body?.mode || 'agent').trim() === 'roleplay' ? 'roleplay' : 'agent';
    const mode = relayAgentSource.getAgent(agent) ? 'agent' : requestedMode;
    const model = String(req.body?.model || '').trim();
    const metadata = mergeAgentTransportMetadata(agent, req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {});
    const roleplayProvider = req.body?.roleplayProvider && typeof req.body.roleplayProvider === 'object' ? req.body.roleplayProvider : null;
    if (mode === 'roleplay' && roleplayProvider) metadata.roleplayProvider = roleplayProvider;
    if (!agent) return res.status(400).json({ ok: false, error: 'agent is required' });
    const currentRoster = getRoster();
    const exists = currentRoster.agents.some((item) => item.id === agent);
    if (!exists) return res.status(404).json({ ok: false, error: 'Agent not found' });
    const session = await createApiSession({ agent, title, metadata, mode, model: mode === 'roleplay' ? model : '' });
    res.json({ ok: true, session: getApiSessionMeta(session) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get(`${basePath}/api/chat/sessions/:id/messages`, async (req, res) => {
  try {
    const session = await getApiSession(String(req.params.id || ''));
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    const limit = Number(req.query?.limit || 0);
    const messages = limit > 0 ? session.messages.slice(-limit) : session.messages;
    res.json({ ok: true, sessionId: session.id, messages });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post([`${basePath}/api/chat/direct`, `${basePath}/api/v1/chat/direct`], async (req, res) => {
  try {
    const incomingText = req.body?.message ?? req.body?.text;
    const userText = String(incomingText || '').trim();
    const requestedAgent = String(req.body?.agent || '').trim();
    const requestedMode = String(req.body?.mode || 'agent').trim() === 'roleplay' ? 'roleplay' : 'agent';
    const requestedModel = String(req.body?.model || '').trim();
    const requestedRoleplayProvider = req.body?.roleplayProvider && typeof req.body.roleplayProvider === 'object' ? req.body.roleplayProvider : null;
    const existingSessionId = String(req.body?.sessionId || '').trim();
    const title = String(req.body?.title || '').trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    if (!userText) return res.status(400).json({ error: 'No text provided' });

    let session = null;
    if (existingSessionId) {
      session = await getApiSession(existingSessionId);
      if (!session) return res.status(404).json({ error: 'Session not found' });
    } else {
      const roster = getRoster();
      const target = requestedAgent || roster.primaryAgentId || 'main';
      const exists = roster.agents.some((item) => item.id === target);
      if (!exists) return res.status(404).json({ error: 'Agent not found' });
      const createdMode = relayAgentSource.getAgent(target) ? 'agent' : requestedMode;
      session = await createApiSession({
        agent: target,
        title,
        metadata: mergeAgentTransportMetadata(target, {
          ...(req.body?.metadata || {}),
          ...(createdMode === 'roleplay' && requestedRoleplayProvider ? { roleplayProvider: requestedRoleplayProvider } : {}),
        }),
        mode: createdMode,
        model: createdMode === 'roleplay' ? requestedModel : '',
      });
    }

    if (String(session.mode || 'agent') === 'roleplay' && (requestedModel || requestedRoleplayProvider)) {
      session = await saveApiSession({
        ...session,
        model: requestedModel || session.model,
        metadata: {
          ...(session.metadata || {}),
          ...(requestedRoleplayProvider ? { roleplayProvider: requestedRoleplayProvider } : {}),
        },
      });
    }

    const { files: attachedFiles, bundle: attachmentBundle } = await resolveAttachmentBundle(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = attachmentBundle.context;

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text: userText, meta: { files: attachmentPayload } });
    session = userAppend.session;
    const sessionMode = String(session.mode || 'agent') === 'roleplay' ? 'roleplay' : 'agent';
    const usesRelayTransport = session?.metadata?.chatTransport === 'relay';

    if (!usesRelayTransport) broadcast({
      type: 'agent:thinking',
      data: {
        agent: session.agent,
        status: sessionMode === 'roleplay' ? 'Roleplay mode...' : 'Processing...',
        source: 'direct-chat',
        chat: true,
        sessionId: session.id,
        fileIds: attachedFiles.map((file) => file.id),
        mode: sessionMode,
        model: session.model || '',
      },
    });

    const result = sessionMode === 'roleplay'
      ? await runRoleplayChatTurn({ session, latestMessage: userText, attachmentContext, model: session.model || requestedModel, roleplayProvider: requestedRoleplayProvider })
      : await runApiChatTurn({ session, latestMessage: userText, attachmentContext, attachmentImages: attachmentBundle.images, attachmentStatuses: attachmentBundle.statuses });
    session = await maybePersistHermesSession(session, result);
    const assistantMeta = { files: [], mode: sessionMode, model: result.model || session.model || '' };
    const assistantAppend = await appendApiSessionMessage(session.id, { role: 'assistant', text: result.text, meta: assistantMeta });

    if (!usesRelayTransport) broadcast({
      type: 'agent:responding',
      data: {
        agent: session.agent,
        message: result.text,
        source: 'direct-chat',
        chat: true,
        sessionId: session.id,
        mode: sessionMode,
        model: result.model || session.model || '',
      },
    });

    res.json({
      ok: true,
      session: getApiSessionMeta(assistantAppend.session),
      agent: session.agent,
      mode: sessionMode,
      model: result.model || session.model || '',
      text: userText,
      fileIds: attachedFiles.map((file) => file.id),
      attachmentStatuses: result.attachmentStatuses || attachmentBundle.statuses,
      message: userAppend.message,
      response: assistantAppend.message,
      agentMessage: {
        id: assistantAppend.message.id,
        role: 'agent',
        kind: 'text',
        text: assistantAppend.message.text,
        timestamp: assistantAppend.message.timestamp,
        files: [],
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

await relayAgentSource.configure(await loadDirectChatSettings().catch(() => ({})));

const wsPath = `${basePath || ''}/ws` || '/ws';
const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

server.on('upgrade', async (req, socket, head) => {
  try {
    const pathname = new URL(req.url || '/', `${useHttps ? 'https' : 'http'}://localhost`).pathname;
    if (pathname !== wsPath) {
      socket.destroy();
      return;
    }
    const authorization = authorizeWebSocketRequest(req, { validateSession: isValidSession });
    if (!authorization.ok) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } catch {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  console.log(`[ws] Client connected (total: ${wss.clients.size})`);

  ws.send(JSON.stringify({
    type: 'status',
    data: { ...bridge.getStatus(), voiceEnabled: true },
  }));

  ws.on('close', () => {
    console.log(`[ws] Client disconnected (total: ${wss.clients.size})`);
  });
});

const recentResponseBroadcasts = new Map();

function normalizeResponseForDedupe(text = '') {
  return String(text || '')
    .replace(/^\s*\[\[\s*reply_to[^\]]*\]\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function shouldSuppressBroadcast(msg) {
  if (msg?.type !== 'agent:responding' || !msg?.data?.message) return false;
  const agent = String(msg.data.agent || 'main');
  const normalized = normalizeResponseForDedupe(msg.data.message);
  if (!normalized) return false;
  const key = `${agent}::${normalized}`;
  const now = Date.now();
  for (const [entryKey, ts] of recentResponseBroadcasts) {
    if (now - ts > 30000) recentResponseBroadcasts.delete(entryKey);
  }
  const prior = recentResponseBroadcasts.get(key) || 0;
  if (now - prior < 30000) {
    console.log(`[broadcast] Suppressed duplicate agent response for ${agent}`);
    return true;
  }
  recentResponseBroadcasts.set(key, now);
  return false;
}

function broadcast(msg) {
  if (shouldSuppressBroadcast(msg)) return;
  const type = String(msg?.type || '');
  const agentId = String(msg?.data?.agent || '').trim();
  if (agentId && type.startsWith('agent:')) {
    if (type === 'agent:idle') noteAgentActivity(agentId, 'idle');
    else if (type === 'agent:thinking') noteAgentActivity(agentId, 'thinking');
    else if (type === 'agent:responding') noteAgentActivity(agentId, 'responding');
    else if (type === 'agent:tool_use') noteAgentActivity(agentId, 'tool_use');
    else noteAgentActivity(agentId, 'active');
  }
  maybeAnnounceLiveTaskProgress(msg);
  maybeAnnounceLiveTaskResult(msg);
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

export { broadcast, wss };

const bridge = new OpenClawBridge();
const stopSessionMonitor = startSessionMonitor({ broadcast, roster, emitResponses: true });
const stopHermesSessionMonitor = startHermesSessionMonitor({ broadcast });

// Graceful shutdown: Docker/systemd send SIGTERM; drain WS + HTTP before exit
// so live calls, WebSocket clients, and timers are not dropped mid-flight.
registerGracefulShutdown({ server, wss, localApiServer: config.localApiEnabled ? localApiServer : null, bridge });

app.get(`${basePath}/api/session-monitor/debug`, (req, res) => {
  res.json({ ok: true, agents: typeof stopSessionMonitor.getDebugState === 'function' ? stopSessionMonitor.getDebugState() : [] });
});

relayAgentSource.on('connected', (info) => {
  broadcast({ type: 'relay:connected', data: info });
  broadcast({ type: 'relay:roster_updated', data: { status: info } });
});

relayAgentSource.on('disconnected', (info) => {
  broadcast({ type: 'relay:disconnected', data: info });
  broadcast({ type: 'relay:roster_updated', data: { status: info } });
});

relayAgentSource.on('roster-updated', (info) => {
  broadcast({ type: 'relay:roster_updated', data: info });
});

relayAgentSource.on('event', (event) => {
  broadcast(event);
});

relayAgentSource.on('error', (error) => {
  console.warn('[relay] error:', error?.message || error);
});

bridge.on('connected', (info) => {
  console.log(`[bridge] Connected (${info.mode} mode)`);
  broadcast({ type: 'bridge:connected', data: info });
});

bridge.on('disconnected', () => {
  broadcast({ type: 'bridge:disconnected' });
});

bridge.on('event', (event) => {
  broadcast(event);
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: err.message, code: err.code || 'UPLOAD_ERROR' });
  }
  const accept = String(req.headers.accept || '');
  const wantsJson = req.path.startsWith(`${basePath}/api/`) || accept.includes('application/json');
  if (wantsJson) {
    return res.status(500).json({ ok: false, error: err.message || 'Internal Server Error', code: 'INTERNAL_ERROR' });
  }
  return next(err);
});

server.listen(config.port, config.host, () => {
  console.log(`[server] Command Center listening on ${config.host}:${config.port}${basePath || ''}`);
  console.log(`[server] Protocol: ${useHttps ? 'https' : 'http'}`);
  finalizePostRestartUpdateState().catch((err) => {
    console.error('[update] Failed to finalize post-restart update state:', err.message);
  });
  startAutoUpdateScheduler().then((info) => {
    console.log(`[update] Auto-update scheduler ready (${info.settings.autoUpdateEnabled ? 'enabled' : 'disabled'}, every ${Math.round((info.intervalMs || 0) / 3600000) || 0}h)`);
  }).catch((err) => {
    console.error('[update] Failed to start auto-update scheduler:', err.message);
  });
  loadWakeSettings().then((settings) => {
    const enabled = !!settings.porcupineAccessKey || Object.keys(settings.wakeWords || {}).length > 0;
    if (!enabled) {
      console.log('[wake] Optional wake workers disabled by configuration');
      return;
    }
    warmWakeTranscriber().then(() => console.log('[wake] Warm transcriber ready'))
      .catch((err) => console.warn('[wake] Transcriber unavailable:', err.message));
    warmWakeKeywordDetector().then(() => console.log('[wake] Keyword detector ready'))
      .catch((err) => console.warn('[wake] Keyword detector unavailable:', err.message));
  }).catch((err) => console.warn('[wake] Could not read wake settings:', err.message));

  try {
    bridge.start();
  } catch (err) {
    console.error('[bridge] Failed to start:', err.message);
  }
});

if (config.localApiEnabled && localApiServer) {
  localApiServer.listen(config.localApiPort, config.localApiHost, () => {
    console.log(`[server] Local API listener ready on ${config.localApiHost}:${config.localApiPort}${basePath || ''}/api/v1 (loopback-only, no bearer token required)`);
  });
}

// Periodic retention sweep so live-task history cannot grow without bound.
// Runs daily; the actual limits come from LIVE_TASK_RETENTION_DAYS /
// LIVE_TASK_MAX_COUNT (see server/live-tasks.js).
const retentionTimer = setInterval(() => {
  pruneLiveTasks().then((pruned) => {
    if (pruned > 0) console.log(`[retention] Pruned ${pruned} live task(s) past retention window.`);
  }).catch((err) => console.error('[retention] Live task prune failed:', err.message));
}, 24 * 60 * 60 * 1000);
if (typeof retentionTimer.unref === 'function') retentionTimer.unref();
