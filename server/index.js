import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
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
import { transcribe, speak, listElevenLabsVoices, searchFishAudioVoices, previewFishAudioVoice, resolveAgentVoice } from './voice.js';
import { loadAgentRoster, searchAgents } from './agents.js';
import { loadVoiceSettings, saveVoiceSettings, maskApiKey, maskSessionCookie } from './settings.js';
import { ensureCompanionRegistry, importCodexPetPackageFromDir, loadCompanionRegistry, loadCompanionSettings, resolveAgentVisual, saveCompanionSettings } from './companions.js';
import { ensureMusicStorage, getMusicDir, loadMusicSettings, saveMusicSettings } from './music-settings.js';
import { ensureIntroStorage, getIntroDir, loadIntroSettings, saveIntroSettings } from './intro-settings.js';
import { BUILT_IN_THEMES, DEFAULT_THEME_ID, DEFAULT_WORKSPACE_ID, ensureAppearanceStorage, getAppearanceBackgroundDir, loadAppearanceSettings, saveAppearanceSettings } from './appearance-settings.js';
import { ensureBrandingStorage, getBrandingDir, loadBrandingSettings, saveBrandingSettings } from './branding-settings.js';
import { ALLOWED_WIDGET_IDS, loadLayoutSettings, saveLayoutSettings } from './layout-settings.js';
import { loadWakeSettings, saveWakeSettings, maskAccessKey } from './wake-settings.js';
import { transcribeWakeAudio, warmWakeTranscriber } from './wake-transcriber.js';
import { detectWakeKeyword, warmWakeKeywordDetector } from './wake-keyword-detector.js';
import { startSessionMonitor } from './session-monitor.js';
import { loadGeminiRuntimeConfig } from './gemini-config.js';
import { createLiveTask, getLiveTask, listLiveTasks, looksComplexRequest, runLiveTask } from './live-tasks.js';
import { createCallSession, endCallSession, getCallSession, listCallSessions, updateCallSession } from './call-session-store.js';
import { GeminiLiveSession } from './gemini-live.js';
import { requireApiAuth } from './api-auth.js';
import { runApiChatTurn } from './api-chat-runner.js';
import { appendApiSessionMessage, createApiSession, getApiSession, getApiSessionMeta, listApiSessions, searchApiSessions } from './api-session-store.js';

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
if (useHttps) {
  server = createHttpsServer({
    cert: readFileSync(certPath),
    key: readFileSync(keyPath),
  }, app);
} else {
  server = createHttpServer(app);
}
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const chatLibraryDir = join(__dirname, '..', 'data', 'chat-library');
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
    await fsp.writeFile(chatManifestPath, JSON.stringify({ items: [] }, null, 2));
  }
  if (!existsSync(chatHistoryPath)) {
    await fsp.writeFile(chatHistoryPath, JSON.stringify({ agents: {} }, null, 2));
  }
}

async function readChatManifest() {
  await ensureChatLibrary();
  try {
    const raw = await fsp.readFile(chatManifestPath, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.items) ? parsed : { items: [] };
  } catch {
    return { items: [] };
  }
}

async function writeChatManifest(manifest) {
  await ensureChatLibrary();
  await fsp.writeFile(chatManifestPath, JSON.stringify({ items: manifest.items || [] }, null, 2));
}

async function readChatHistoryStore() {
  await ensureChatLibrary();
  try {
    const raw = await fsp.readFile(chatHistoryPath, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && parsed.agents && typeof parsed.agents === 'object'
      ? parsed
      : { agents: {} };
  } catch {
    return { agents: {} };
  }
}

async function writeChatHistoryStore(store) {
  await ensureChatLibrary();
  await fsp.writeFile(chatHistoryPath, JSON.stringify({ agents: store.agents || {} }, null, 2));
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
  const store = await readChatHistoryStore();
  if (!Array.isArray(store.agents[agentId])) store.agents[agentId] = [];
  store.agents[agentId].push(sanitizeChatMessage(message));
  if (store.agents[agentId].length > MAX_CHAT_HISTORY_MESSAGES) {
    store.agents[agentId] = store.agents[agentId].slice(-MAX_CHAT_HISTORY_MESSAGES);
  }
  await writeChatHistoryStore(store);
  return store.agents[agentId];
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

function buildAttachmentContext(files = []) {
  if (!files.length) return '';
  const lines = files.map((file) => {
    if (file.kind === 'link') {
      return `- ${file.name} [link]: ${file.sourceUrl}${file.notes ? ` | notes: ${file.notes}` : ''}`;
    }
    return `- ${file.originalName || file.name}: local path ${file.path} | mime ${file.mimeType} | download ${basePath}/api/chat/files/${file.id}/download`;
  });
  return `\n\nAttached files and reusable references:\n${lines.join('\n')}\nUse these files if relevant to the request.`;
}

app.use(express.json());
app.use(`${basePath}/media/music`, express.static(getMusicDir()));
app.use(`${basePath}/media/intros`, express.static(getIntroDir()));
app.use(`${basePath}/media/appearance/backgrounds`, express.static(getAppearanceBackgroundDir()));
app.use(`${basePath}/media/branding`, express.static(getBrandingDir()));
app.use(basePath || '/', express.static(join(__dirname, '..', 'public')));
app.use(`${basePath}/api/v1`, requireApiAuth);
await ensureCompanionRegistry();
await ensureMusicStorage();
await ensureIntroStorage();
await ensureAppearanceStorage();
await ensureBrandingStorage();

const liveGeminiSessions = new Map();
const liveGeminiWatchdogs = new Map();
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
  const fellBackToDemo = !configuredDemo && bridgeStatus.mode === 'demo';
  const liveConnected = !configuredDemo && bridgeStatus.mode === 'live' && bridgeStatus.connected;

  if (configuredDemo) {
    issues.push({ level: 'info', code: 'DEMO_MODE_ENABLED', message: 'CommandCenter is running in demo mode. Agent activity may be simulated.' });
  } else if (fellBackToDemo) {
    issues.push({ level: 'warn', code: 'FALLBACK_TO_DEMO', message: `Live gateway connection failed, so CommandCenter fell back to demo mode${bridgeStatus.lastFallbackReason ? ` (${bridgeStatus.lastFallbackReason})` : ''}.` });
  }

  if (!configuredDemo && !bridgeStatus.gatewayTokenConfigured) {
    issues.push({ level: 'warn', code: 'GATEWAY_TOKEN_MISSING', message: 'No gateway token is configured for live OpenClaw mode.' });
  }

  if (bridgeStatus.lastAuthError) {
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
      mode: configuredDemo ? 'demo' : fellBackToDemo ? 'demo-fallback' : liveConnected ? 'live' : 'connecting',
      modeLabel: configuredDemo ? 'Demo mode' : fellBackToDemo ? 'Demo fallback' : liveConnected ? 'Live OpenClaw' : 'Connecting to OpenClaw',
      demoMode: configuredDemo,
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

app.post(`${basePath}/api/v1/files/upload`, upload.array('files', 10), async (req, res) => {
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
      await fsp.writeFile(savedPath, file.buffer);
      const item = {
        id,
        kind: 'file',
        name: safeOriginal,
        originalName: file.originalname || safeOriginal,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size || file.buffer?.length || 0,
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

app.post(`${basePath}/api/companions/import-zip`, upload.single('package'), async (req, res) => {
  try {
    const file = req.file;
    if (!file?.buffer?.length) {
      return res.status(400).json({ ok: false, error: 'No zip package uploaded', code: 'BAD_REQUEST' });
    }
    const agentId = String(req.body?.agentId || '').trim();
    const tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'cc-pet-import-'));
    const zipPath = join(tempDir, 'package.zip');
    await fsp.writeFile(zipPath, file.buffer);
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-o', zipPath, '-d', tempDir], (err) => err ? reject(err) : resolve());
    });
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
  }
});

app.post(`${basePath}/api/companions/import-folder`, upload.array('files', 500), async (req, res) => {
  try {
    const files = Array.isArray(req.files) ? req.files : [];
    if (!files.length) {
      return res.status(400).json({ ok: false, error: 'No folder files uploaded', code: 'BAD_REQUEST' });
    }
    const uploadedPaths = files.map((file) => String(file.originalname || '').replace(/\\/g, '/')).filter(Boolean);
    console.log('[companions] import-folder upload received', { count: uploadedPaths.length, first: uploadedPaths[0], paths: uploadedPaths.slice(0, 20) });
    const agentId = String(req.body?.agentId || '').trim();
    const tempDir = await fsp.mkdtemp(join(os.tmpdir(), 'cc-pet-folder-import-'));
    for (const file of files) {
      const relativePath = String(file.originalname || '').replace(/\\/g, '/').replace(/^\/+/, '');
      if (!relativePath || relativePath.includes('..')) continue;
      const destPath = join(tempDir, relativePath);
      await fsp.mkdir(dirname(destPath), { recursive: true });
      await fsp.writeFile(destPath, file.buffer);
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
  }
});

app.get(`${basePath}/api/companions/imports/:slug/*`, async (req, res) => {
  const slug = basename(String(req.params.slug || ''));
  const file = String(req.params[0] || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!file || file.includes('..')) return res.status(400).json({ ok: false, error: 'Invalid import asset path', code: 'BAD_REQUEST' });
  const fullPath = join(__dirname, '..', 'data', 'companions', 'imports', slug, file);
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
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: 'No background image uploaded', code: 'BAD_REQUEST' });
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
    await fsp.writeFile(fullPath, req.file.buffer);
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
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: 'No logo uploaded', code: 'BAD_REQUEST' });
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.svg'].includes(ext)) return res.status(400).json({ ok: false, error: 'Unsupported logo format', code: 'BAD_REQUEST' });
    const name = `logo-${Date.now()}${ext}`;
    await fsp.writeFile(join(getBrandingDir(), name), req.file.buffer);
    const saved = await saveBrandingSettings({ ...(await loadBrandingSettings()), logoUrl: `${basePath}/media/branding/${encodeURIComponent(name)}` });
    res.json({ ok: true, settings: saved });
  } catch (err) { res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' }); }
});

app.post(`${basePath}/api/settings/branding/favicon`, upload.single('favicon'), async (req, res) => {
  try {
    if (!req.file?.buffer?.length) return res.status(400).json({ ok: false, error: 'No favicon uploaded', code: 'BAD_REQUEST' });
    const ext = extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.ico', '.png', '.svg'].includes(ext)) return res.status(400).json({ ok: false, error: 'Unsupported favicon format', code: 'BAD_REQUEST' });
    const name = `favicon-${Date.now()}${ext}`;
    await fsp.writeFile(join(getBrandingDir(), name), req.file.buffer);
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
    if (!req.file?.buffer?.length) {
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
    await fsp.writeFile(fullPath, req.file.buffer);
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
    if (!req.file?.buffer?.length) {
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
    await fsp.writeFile(fullPath, req.file.buffer);
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
    const next = {
      provider: body.provider || existing.provider || 'elevenlabs',
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
      elevenlabsAgentVoices: body.elevenlabsAgentVoices || existing.elevenlabsAgentVoices || {},
      fishAgentVoices: body.fishAgentVoices || existing.fishAgentVoices || {},
      agentVoices: String(body.provider || existing.provider || '').trim() === 'fish'
        ? (body.fishAgentVoices || existing.fishAgentVoices || {})
        : (body.elevenlabsAgentVoices || existing.elevenlabsAgentVoices || {}),
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

  if (bridgeStatus.lastAuthError) {
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
    await fs.writeFile(join(targetDir, safeName), req.file.buffer);

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
    const text = await transcribe(req.file.buffer, req.file.originalname || 'audio.webm');
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

    const keywordMatch = await detectWakeKeyword(req.file.buffer, req.file.originalname || 'wake.webm').catch(() => null);
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

    const text = await transcribeWakeAudio(req.file.buffer, req.file.originalname || 'wake.webm');
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

app.post(`${basePath}/api/chat/files/upload`, upload.array('files', 10), async (req, res) => {
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
      await fsp.writeFile(savedPath, file.buffer);
      const item = {
        id,
        kind: 'file',
        name: safeOriginal,
        originalName: file.originalname || safeOriginal,
        mimeType: file.mimetype || 'application/octet-stream',
        size: file.size || file.buffer?.length || 0,
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
      transport: 'websocket-proxy-pending',
    },
  });
});

app.get(`${basePath}/api/call/sessions`, async (req, res) => {
  res.json({ ok: true, sessions: listCallSessions() });
});

app.get(`${basePath}/api/call/:id`, async (req, res) => {
  const session = getCallSession(String(req.params.id || ''));
  if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
  res.json({ ok: true, session });
});

app.post(`${basePath}/api/call/start`, async (req, res) => {
  try {
    const runtime = await loadGeminiRuntimeConfig();
    if (!runtime.hasApiKey) {
      return res.status(400).json({ ok: false, error: 'Gemini API key is not configured in Mission Control' });
    }
    const session = createCallSession({
      agent: String(req.body?.agent || getRoster().primaryAgentId || 'orchestrator'),
      mode: 'gemini-live',
    });

    const gemini = new GeminiLiveSession({
      apiKey: runtime.apiKey,
      model: runtime.model,
      responseModalities: runtime.responseModalities,
      onEvent: (event) => {
        const current = getCallSession(session.id);
        updateCallSession(session.id, {
          geminiEventCount: Number(current?.geminiEventCount || 0) + 1,
          currentTurnGeminiEventCount: Number(current?.currentTurnGeminiEventCount || 0) + 1,
          lastGeminiEventAt: new Date().toISOString(),
        });
        clearLiveWatchdog(session.id);
        if (event.type === 'setupComplete') {
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: 'Gemini live setup complete' } });
          return;
        }
        if (event.type === 'input.transcript') {
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini heard input: ${String(event.data?.text || '').slice(0, 120)}` } });
          return;
        }
        if (event.type === 'output.transcript') {
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini output transcript: ${String(event.data?.text || '').slice(0, 120)}` } });
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
              if (name !== 'handoff_to_openclaw') {
                functionResponses.push({ name, id, response: { error: `Unsupported tool: ${name}` } });
                continue;
              }
              const prompt = String(args.prompt || '').trim();
              const title = String(args.title || prompt.slice(0, 80) || 'OpenClaw task').trim();
              const summary = String(args.summary || "I'm working on that through OpenClaw.").trim();
              const agent = String(args.agent || session.agent || 'orchestrator').trim();
              if (!prompt) {
                functionResponses.push({ name, id, response: { error: 'Missing prompt for handoff_to_openclaw' } });
                continue;
              }
              const task = await createLiveTask({ title, summary, prompt, agent });
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
            broadcast({ type: 'call:error', data: { sessionId: session.id, message: error.message || 'Tool handoff failed' } });
          });
          return;
        }
        if (event.type === 'response.text') {
          const text = String(event.data?.text || '').trim();
          if (!text) return;
          updateCallSession(session.id, { lastAssistantText: text, state: event.data?.done ? 'speaking' : 'thinking' });
          broadcast({ type: 'call:response.text', data: { sessionId: session.id, text, done: !!event.data?.done } });
          return;
        }
        if (event.type === 'response.audio') {
          const pcm16Base64 = String(event.data?.pcm16Base64 || '');
          const mimeType = String(event.data?.mimeType || 'audio/pcm;rate=24000');
          updateCallSession(session.id, { state: 'speaking' });
          broadcast({
            type: 'call:response.audio',
            data: {
              sessionId: session.id,
              pcm16Base64,
              mimeType,
              done: !!event.data?.done,
            },
          });
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini audio chunk ${pcm16Base64.length}b ${mimeType}` } });
          return;
        }
        if (event.type === 'closed') {
          clearLiveWatchdog(session.id);
          broadcast({ type: 'call:debug', data: { sessionId: session.id, message: `Gemini live closed code=${event.data?.code ?? ''} reason=${event.data?.reason || ''}` } });
          const ended = endCallSession(session.id, 'ended');
          if (ended) broadcast({ type: 'call:session.ended', data: ended });
          liveGeminiSessions.delete(session.id);
        }
      },
      onError: (error) => {
        broadcast({ type: 'call:error', data: { sessionId: session.id, message: error.message || 'Gemini live error' } });
      },
    });

    await gemini.connect();
    liveGeminiSessions.set(session.id, gemini);

    const ready = updateCallSession(session.id, { state: 'ready' }) || session;
    broadcast({ type: 'call:session.started', data: ready });
    res.json({ ok: true, session: ready, runtime: { model: runtime.model, thinkingLevel: runtime.thinkingLevel } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/call/:id/end`, async (req, res) => {
  const sessionId = String(req.params.id || '');
  clearLiveWatchdog(sessionId);
  const live = liveGeminiSessions.get(sessionId);
  if (live) {
    live.close();
    liveGeminiSessions.delete(sessionId);
  }
  const session = endCallSession(sessionId, 'ended');
  if (!session) return res.status(404).json({ ok: false, error: 'Call session not found' });
  broadcast({ type: 'call:session.ended', data: session });
  res.json({ ok: true, session });
});

app.post(`${basePath}/api/call/:id/audio`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
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

app.post(`${basePath}/api/call/:id/screen`, async (req, res) => {
  try {
    const sessionId = String(req.params.id || '');
    const live = liveGeminiSessions.get(sessionId);
    if (!live) return res.status(404).json({ ok: false, error: 'Live Gemini session not found' });
    const jpegBase64 = String(req.body?.jpegBase64 || '').trim();
    const mimeType = String(req.body?.mimeType || 'image/jpeg').trim();
    if (!jpegBase64) return res.status(400).json({ ok: false, error: 'Missing jpegBase64' });
    live.sendVideoFrame({ imageBase64: jpegBase64, mimeType });
    broadcast({ type: 'call:debug', data: { sessionId, message: `Screen frame uplink ${jpegBase64.length}b ${mimeType}` } });
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
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
      broadcast({ type: 'call:transcript.final', data: { sessionId, text, state: updated?.state || 'thinking' } });

      if (looksComplexRequest(text)) {
        const task = await createLiveTask({
          title: text.slice(0, 80) || 'Background task',
          summary: "I'm working on that in the background.",
          prompt: text,
          agent: session.agent,
        });
        broadcast({ type: 'live_task:update', data: task });
        runLiveTask(task, { broadcast, roster });
        const spoken = "I'm working on that in the background.";
        const after = updateCallSession(sessionId, { lastAssistantText: spoken, state: 'speaking' });
        broadcast({ type: 'call:response.text', data: { sessionId, text: spoken, taskId: task.id, state: after?.state || 'speaking' } });
        return res.json({ ok: true, route: 'openclaw-task', taskId: task.id, spoken, session: after });
      }

      const live = liveGeminiSessions.get(sessionId);
      if (!live) {
        const spoken = 'Gemini live session is not connected yet. Please restart the call.';
        const after = updateCallSession(sessionId, { lastAssistantText: spoken, state: 'speaking' });
        broadcast({ type: 'call:response.text', data: { sessionId, text: spoken, state: after?.state || 'speaking' } });
        return res.json({ ok: false, route: 'gemini-live-missing', spoken, session: after });
      }

      live.sendTextTurn(text);
      const after = updateCallSession(sessionId, { state: 'thinking' });
      return res.json({ ok: true, route: 'gemini-live', session: after });
    }

    if (eventType === 'assistant.playback_finished') {
      clearLiveWatchdog(sessionId);
      const updated = updateCallSession(sessionId, { state: 'ready', currentTurnAudioChunks: 0 });
      broadcast({ type: 'call:session.state', data: { sessionId, state: updated?.state || 'ready' } });
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

app.get(`${basePath}/api/v1/sessions`, async (req, res) => {
  try {
    const agent = String(req.query?.agent || '').trim();
    const limit = Number(req.query?.limit || 20);
    const sessions = await listApiSessions({ agent, limit });
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.get(`${basePath}/api/v1/sessions/search`, async (req, res) => {
  try {
    const q = String(req.query?.q || '').trim();
    if (!q) return res.status(400).json({ ok: false, error: 'Missing query', code: 'BAD_REQUEST' });
    const agent = String(req.query?.agent || '').trim();
    const limit = Number(req.query?.limit || 20);
    const results = await searchApiSessions(q, { agent, limit });
    res.json({ ok: true, query: q, results });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message, code: 'INTERNAL_ERROR' });
  }
});

app.post(`${basePath}/api/v1/sessions`, async (req, res) => {
  try {
    const agent = String(req.body?.agent || '').trim();
    const title = String(req.body?.title || '').trim();
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    if (!agent) return res.status(400).json({ ok: false, error: 'agent is required', code: 'BAD_REQUEST' });
    const exists = roster.agents.some((item) => item.id === agent);
    if (!exists) return res.status(404).json({ ok: false, error: 'Agent not found', code: 'AGENT_NOT_FOUND' });
    const session = await createApiSession({ agent, title, metadata });
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

    const attachedFiles = await resolveChatFiles(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = buildAttachmentContext(attachedFiles);

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text, meta: { files: attachmentPayload } });
    session = userAppend.session;

    const result = await runApiChatTurn({ session, latestMessage: text, attachmentContext });
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
      sessionId: session.id,
      agent: session.agent,
      message: userAppend.message,
      response: assistantAppend.message,
      files: attachmentPayload,
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

    const attachedFiles = await resolveChatFiles(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = buildAttachmentContext(attachedFiles);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text, meta: { files: attachmentPayload } });
    session = userAppend.session;
    sendEvent('accepted', { sessionId: session.id, messageId: userAppend.message.id, agent: session.agent, files: attachmentPayload });

    const result = await runApiChatTurn({
      session,
      latestMessage: text,
      attachmentContext,
      onEvent: (event) => sendEvent(event.type, event.data || {}),
    });
    const assistantMeta = { files: [] };
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
    sendEvent('done', { ok: true, sessionId: session.id, responseId: assistantAppend.message.id, audio: !!audioEvent });
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

    const attachedFiles = await resolveChatFiles(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = buildAttachmentContext(attachedFiles);

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text: message, meta: { files: attachmentPayload } });
    session = userAppend.session;
    const result = await runApiChatTurn({ session, latestMessage: message, attachmentContext });
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
    const limit = Number(req.query?.limit || 20);
    const sessions = await listApiSessions({ agent, limit });
    res.json({ ok: true, sessions });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post(`${basePath}/api/chat/sessions`, async (req, res) => {
  try {
    const agent = String(req.body?.agent || '').trim();
    const title = String(req.body?.title || '').trim();
    const metadata = req.body?.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {};
    if (!agent) return res.status(400).json({ ok: false, error: 'agent is required' });
    const exists = roster.agents.some((item) => item.id === agent);
    if (!exists) return res.status(404).json({ ok: false, error: 'Agent not found' });
    const session = await createApiSession({ agent, title, metadata });
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

app.post(`${basePath}/api/chat/direct`, async (req, res) => {
  try {
    const incomingText = req.body?.message ?? req.body?.text;
    const userText = String(incomingText || '').trim();
    const requestedAgent = String(req.body?.agent || '').trim();
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
      session = await createApiSession({ agent: target, title, metadata: req.body?.metadata || {} });
    }

    const attachedFiles = await resolveChatFiles(fileIds);
    const attachmentPayload = apiAttachmentPayload(attachedFiles.map(toChatFileRecord));
    const attachmentContext = buildAttachmentContext(attachedFiles);

    const userAppend = await appendApiSessionMessage(session.id, { role: 'user', text: userText, meta: { files: attachmentPayload } });
    session = userAppend.session;

    broadcast({
      type: 'agent:thinking',
      data: {
        agent: session.agent,
        status: 'Processing...',
        source: 'direct-chat',
        chat: true,
        sessionId: session.id,
        fileIds: attachedFiles.map((file) => file.id),
      },
    });

    const result = await runApiChatTurn({ session, latestMessage: userText, attachmentContext });
    const assistantMeta = { files: [] };
    const assistantAppend = await appendApiSessionMessage(session.id, { role: 'assistant', text: result.text, meta: assistantMeta });

    broadcast({
      type: 'agent:responding',
      data: { agent: session.agent, message: result.text, source: 'direct-chat', chat: true, sessionId: session.id },
    });

    res.json({
      ok: true,
      session: getApiSessionMeta(assistantAppend.session),
      agent: session.agent,
      text: userText,
      fileIds: attachedFiles.map((file) => file.id),
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

const wss = new WebSocketServer({ server, path: `${basePath || ''}/ws` || '/ws' });

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

app.get(`${basePath}/api/session-monitor/debug`, (req, res) => {
  res.json({ ok: true, agents: typeof stopSessionMonitor.getDebugState === 'function' ? stopSessionMonitor.getDebugState() : [] });
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

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[server] Command Center listening on :${config.port}${basePath || ''}`);
  console.log(`[server] Protocol: ${useHttps ? 'https' : 'http'}`);
  warmWakeTranscriber().then(() => {
    console.log('[wake] Warm transcriber ready');
  }).catch((err) => {
    console.error('[wake] Failed to warm transcriber:', err.message);
  });

  warmWakeKeywordDetector().then(() => {
    console.log('[wake] Keyword detector ready');
  }).catch((err) => {
    console.error('[wake] Failed to warm keyword detector:', err.message);
  });

  try {
    bridge.start();
  } catch (err) {
    console.error('[bridge] Failed to start:', err.message);
  }
});
