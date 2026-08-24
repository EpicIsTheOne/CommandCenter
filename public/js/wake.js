const BASE = window.__BASE_PATH__ || '';

let state = 'off';
let recorder = null;
let streamRef = null;
let onWake = null;
let onStateChange = null;
let inFlight = false;
let cooldownUntil = 0;
let active = false;
let paused = false;

// On-device Porcupine spotting (zero round trip). Falls back to the legacy
// record→POST→whisper loop whenever Porcupine can't start.
const porcupineEngine = {
  mode: false,
  worker: null,
  keywordsMeta: [],
};

function setState(next, detail = '') {
  state = next;
  if (onStateChange) onStateChange(next, detail);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function bytesToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

async function fetchBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`);
  return bytesToBase64(await res.arrayBuffer());
}

function resolveBuiltInKeyword(name) {
  const keywords = window.PorcupineWeb?.BuiltInKeyword;
  if (!keywords) return null;
  const want = String(name || '').toLowerCase().replace(/[^a-z]/g, '');
  if (!want) return null;
  for (const key of Object.keys(keywords)) {
    if (key.toLowerCase() === want && key !== '__esModule') return keywords[key];
  }
  return null;
}

function triggerWake(agentId, payload = {}) {
  if (!active || paused || Date.now() < cooldownUntil) return;
  cooldownUntil = Date.now() + 3000;
  paused = true;
  setState('triggered', payload.label || agentId);
  if (onWake) onWake(agentId, payload);
}

function onPorcupineHit(index) {
  const agentId = porcupineEngine.keywordsMeta[Number(index)] || '';
  if (agentId) triggerWake(agentId, {});
}

async function startPorcupineEngine(runtime) {
  const factory = window.PorcupineWeb;
  const voiceProcessor = window.WebVoiceProcessor?.WebVoiceProcessor;
  if (!factory?.PorcupineWorker || !voiceProcessor) return false;
  const accessKey = String(runtime.accessKey || '').trim();
  if (!accessKey) return false;

  const keywordDefs = [];
  const meta = [];
  for (const [agentId, cfg] of Object.entries(runtime.wakeWords || {})) {
    const sensitivity = Math.min(0.99, Math.max(0.05, Number(cfg?.sensitivity || 0.6)));
    const builtin = resolveBuiltInKeyword(cfg?.builtIn);
    if (builtin !== null && builtin !== undefined) {
      keywordDefs.push({ builtin, sensitivity });
      meta.push(agentId);
      continue;
    }
    const ppnPath = String(cfg?.publicPath || '').trim();
    if (ppnPath) {
      try {
        const custom = await fetchBase64(ppnPath.startsWith('/') ? `${BASE}${ppnPath}` : ppnPath);
        keywordDefs.push({ custom, sensitivity });
        meta.push(agentId);
      } catch (_) {}
    }
  }
  if (!keywordDefs.length) return false;

  let modelArg;
  try {
    const modelBase64 = await fetchBase64(runtime.modelPath || `${BASE}/vendor/picovoice/porcupine_params.pv`);
    modelArg = modelBase64;
  } catch (_) {}

  try {
    const worker = await factory.PorcupineWorker.create(accessKey, keywordDefs, onPorcupineHit, modelArg);
    await voiceProcessor.start({ porcupine: worker });
    porcupineEngine.worker = worker;
    porcupineEngine.keywordsMeta = meta;
    porcupineEngine.mode = true;
    return true;
  } catch (err) {
    console.warn('[wake] Porcupine unavailable, using server detection:', err?.message || err);
    return false;
  }
}

async function stopPorcupineEngine() {
  if (!porcupineEngine.mode) return;
  porcupineEngine.mode = false;
  porcupineEngine.keywordsMeta = [];
  try { await window.WebVoiceProcessor?.WebVoiceProcessor?.stop(); } catch (_) {}
  try { await porcupineEngine.worker?.release?.(); } catch (_) {}
  porcupineEngine.worker = null;
}

async function detectBlob(blob) {
  if (!blob || blob.size < 2000) return;
  if (porcupineEngine.mode || inFlight || paused || Date.now() < cooldownUntil) return;
  inFlight = true;
  try {
    const form = new FormData();
    form.append('audio', blob, 'wake.webm');
    const data = await fetchJson(`${BASE}/api/wake/detect`, { method: 'POST', body: form });
    if (data.match) {
      triggerWake(data.match.agentId, { text: data.text || '', remainder: data.match.remainder || '' });
    }
  } finally {
    inFlight = false;
  }
}

function recordCycle() {
  if (!active || !streamRef) return;

  const chunks = [];
  try {
    recorder = new MediaRecorder(streamRef, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
    });
  } catch (err) {
    console.error('[wake] Failed to create recorder:', err);
    return;
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = async () => {
    recorder = null;
    if (!paused) {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      await detectBlob(blob);
    }
    if (active && !paused) {
      setTimeout(() => recordCycle(), 80);
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, 1200);
}

export function init(opts = {}) {
  onWake = opts.onWake || null;
  onStateChange = opts.onStateChange || null;
}

export function getState() {
  return state;
}

export function isActive() {
  return active;
}

export async function start() {
  if (active) return;
  paused = false;
  setState('arming');
  let onDevice = false;
  try {
    const runtime = await fetchJson(`${BASE}/api/settings/wake/runtime`);
    onDevice = await startPorcupineEngine(runtime);
  } catch (_) {}
  if (!onDevice) {
    streamRef = await navigator.mediaDevices.getUserMedia({ audio: true });
  }
  active = true;
  setState('armed', porcupineEngine.mode ? 'ARMED · ON-DEVICE' : '');
  if (!porcupineEngine.mode) {
    recordCycle();
  } else {
    console.log(`[wake] Porcupine spotting live (${porcupineEngine.keywordsMeta.length} keyword${porcupineEngine.keywordsMeta.length === 1 ? '' : 's'})`);
  }
}

export function resume() {
  if (!active) return;
  paused = false;
  cooldownUntil = Date.now() + 500;
  setState('armed');
  if (!porcupineEngine.mode) recordCycle();
}

export async function stop() {
  active = false;
  paused = false;
  await stopPorcupineEngine();
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
    recorder = null;
  }
  if (streamRef) {
    streamRef.getTracks().forEach((t) => t.stop());
    streamRef = null;
  }
  setState('off');
}
