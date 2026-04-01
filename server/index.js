import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { execFile, exec } from 'node:child_process';
import os from 'node:os';
import multer from 'multer';
import config from './config.js';
import OpenClawBridge from './openclaw-bridge.js';
import { transcribe, speak, listElevenLabsVoices } from './voice.js';
import { loadAgentRoster } from './agents.js';
import { loadVoiceSettings, saveVoiceSettings, maskApiKey } from './settings.js';
import { loadWakeSettings, saveWakeSettings, maskAccessKey } from './wake-settings.js';
import { transcribeWakeAudio, warmWakeTranscriber } from './wake-transcriber.js';
import { detectWakeKeyword, warmWakeKeywordDetector } from './wake-keyword-detector.js';
import { startSessionMonitor } from './session-monitor.js';
import { loadGeminiRuntimeConfig } from './gemini-config.js';
import { createLiveTask, getLiveTask, listLiveTasks, looksComplexRequest, runLiveTask } from './live-tasks.js';
import { createCallSession, endCallSession, getCallSession, listCallSessions, updateCallSession } from './call-session-store.js';
import { GeminiLiveSession } from './gemini-live.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const roster = loadAgentRoster();
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

function sanitizeName(name = '') {
  return String(name || 'file')
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 120) || 'file';
}

async function ensureChatLibrary() {
  await fsp.mkdir(chatFilesDir, { recursive: true });
  if (!existsSync(chatManifestPath)) {
    await fsp.writeFile(chatManifestPath, JSON.stringify({ items: [] }, null, 2));
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
app.use(basePath || '/', express.static(join(__dirname, '..', 'public')));

const liveGeminiSessions = new Map();
const liveGeminiWatchdogs = new Map();
app.use(`${basePath}/wakewords`, express.static(join(__dirname, '..', 'public', 'wakewords')));
if (basePath) {
  app.get(basePath, (req, res) => res.redirect(basePath + '/'));
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

app.get(`${basePath}/api/status`, (req, res) => {
  res.json({
    uptime: process.uptime(),
    bridge: bridge.getStatus(),
    clients: wss.clients.size,
    voiceEnabled: true,
    agents: roster.agents,
    primaryAgentId: roster.primaryAgentId,
  });
});

app.get(`${basePath}/api/agents`, (req, res) => {
  res.json({
    agents: roster.agents,
    primaryAgentId: roster.primaryAgentId,
  });
});

app.get(`${basePath}/api/settings/voice`, async (req, res) => {
  const settings = await loadVoiceSettings();
  res.json({
    ok: true,
    settings: {
      hasApiKey: !!settings.elevenlabsApiKey,
      apiKeyMasked: maskApiKey(settings.elevenlabsApiKey),
      defaultVoiceId: settings.defaultVoiceId,
      agentVoices: settings.agentVoices || {},
    },
  });
});

app.post(`${basePath}/api/settings/voice`, async (req, res) => {
  try {
    const existing = await loadVoiceSettings();
    const body = req.body || {};
    const next = {
      elevenlabsApiKey: body.elevenlabsApiKey ? String(body.elevenlabsApiKey).trim() : existing.elevenlabsApiKey,
      defaultVoiceId: String(body.defaultVoiceId || '').trim(),
      agentVoices: body.agentVoices || {},
    };
    const saved = await saveVoiceSettings(next);
    res.json({
      ok: true,
      settings: {
        hasApiKey: !!saved.elevenlabsApiKey,
        apiKeyMasked: maskApiKey(saved.elevenlabsApiKey),
        defaultVoiceId: saved.defaultVoiceId,
        agentVoices: saved.agentVoices,
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
    builder: ['kairo', 'cairo', 'kyro'],
    qa: ['mina', 'meena'],
    researcher: ['lyra', 'lira'],
    comms: ['niko', 'nico', 'neeko'],
    'emotional-support-1': ['pip', 'pipp'],
    'emotional-support-2': ['mochi', 'mochie'],
  };

  return roster.agents.map((agent) => {
    const aliases = new Set([
      agent.label,
      agent.id,
      agent.name?.split('/')[0]?.trim(),
      ...(extraAliases[agent.id] || []),
    ].filter(Boolean).map((v) => normalizeWakeText(v)));
    return { agentId: agent.id, label: agent.label, aliases: Array.from(aliases).filter(Boolean) };
  });
}

function detectWakeAgent(text = '') {
  const normalized = normalizeWakeText(text);
  if (!normalized) return null;

  let best = null;
  for (const agent of buildWakeAliases()) {
    for (const alias of agent.aliases) {
      const index = normalized.indexOf(alias);
      if (index === -1) continue;
      if (!best || index < best.index || (index === best.index && alias.length > best.alias.length)) {
        const before = normalized.slice(0, index).trim();
        const after = normalized.slice(index + alias.length).trim();
        const remainder = [before, after].filter(Boolean).join(' ').trim();
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

    const speaker = agent || roster.primaryAgentId || 'main';
    console.log(`[voice] Speaking as ${speaker}: "${text.slice(0, 80)}..."`);
    const audio = await speak(text, speaker);

    res.set('Content-Type', audio.contentType);
    res.set('Content-Length', audio.buffer.length);
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
      agent: String(req.body?.agent || roster.primaryAgentId || 'orchestrator'),
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
      agent: String(agent || roster.primaryAgentId || 'orchestrator'),
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
        agent: String(agent || roster.primaryAgentId || 'orchestrator'),
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

app.post(`${basePath}/api/chat/direct`, async (req, res) => {
  try {
    const { text, agent, fileIds = [] } = req.body || {};
    const target = agent || roster.primaryAgentId || 'main';
    if (!text) return res.status(400).json({ error: 'No text provided' });

    const attachedFiles = await resolveChatFiles(fileIds);
    const finalMessage = `${String(text).trim()}${buildAttachmentContext(attachedFiles)}`;

    console.log(`[chat] Direct message to ${target}: "${finalMessage.slice(0, 120)}..."`);

    broadcast({
      type: 'agent:thinking',
      data: {
        agent: target,
        status: 'Processing...',
        source: 'direct-chat',
        chat: true,
        fileIds: attachedFiles.map((file) => file.id),
      },
    });

    const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
    const thinkingLevel = (target === roster.primaryAgentId || target === 'main') ? 'low' : 'off';

    execFile(openclawBin, [
      'agent', '--agent', target,
      '--thinking', thinkingLevel,
      '--message', finalMessage,
    ], {
      timeout: 90000,
      env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
    }, (err, stdout, stderr) => {
      if (err) {
        console.error(`[chat] Error from ${target}:`, err.message);
        broadcast({
          type: 'agent:error',
          data: { agent: target, message: err.message, source: 'direct-chat', chat: true },
        });
        return;
      }

      const response = stdout.trim();
      console.log(`[chat] Response from ${target}: "${response.slice(0, 80)}..."`);

      broadcast({
        type: 'agent:responding',
        data: { agent: target, message: response, source: 'direct-chat', chat: true },
      });
    });

    res.json({ ok: true, agent: target, text, fileIds: attachedFiles.map((file) => file.id) });
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

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}

export { broadcast, wss };

const bridge = new OpenClawBridge();
const stopSessionMonitor = startSessionMonitor({ broadcast, roster });

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
