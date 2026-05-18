const BASE = window.__BASE_PATH__ || '';
const INPUT_SAMPLE_RATE = 16000;
const AUDIO_CHUNK_SAMPLES = 3200; // 200ms at 16kHz
const VAD_HANGOVER_MS = 520;
const VAD_MIN_SPEECH_MS = 110;
const VAD_NOISE_LEARN_MS = 1400;
const VAD_MIN_RMS_START = 0.013;
const VAD_MIN_RMS_END = 0.007;
const VAD_MIN_PEAK_START = 0.045;
const VAD_INTERRUPT_RMS = 0.02;
const VAD_INTERRUPT_PEAK = 0.08;

const state = {
  sessionId: '',
  status: 'idle',
  model: '',
  hasApiKey: false,
  lastTaskId: '',
  tasks: new Map(),
  micActive: false,
  micMuted: false,
  micStream: null,
  micContext: null,
  micSource: null,
  micProcessor: null,
  vad: null,
  pcmQueue: [],
  audioPostChain: Promise.resolve(),
  playbackContext: null,
  playbackNextTime: 0,
  playbackSources: new Set(),
  playbackGeneration: 0,
  playbackActive: false,
  screenActive: false,
  screenStream: null,
  screenVideo: null,
  screenCanvas: null,
  screenTimer: null,
  screenPostChain: Promise.resolve(),
  screenChangeLastSample: null,
  screenChangeLastAt: 0,
  cameraActive: false,
  cameraStream: null,
  cameraVideo: null,
  cameraPreview: null,
  cameraCanvas: null,
  cameraTimer: null,
  cameraFacingMode: 'environment',
  lastEvent: 'none',
  lastError: '',
  overlayTimer: null,
  interrupting: false,
  lastInterruptAt: 0,
  personaName: 'Fairy',
  transcriptEntries: [],
  pendingAssistantText: '',
  imageCard: null,
  imageHideTimer: null,
};

const els = {};


function personaName() {
  return String(state.personaName || 'Fairy').trim() || 'Fairy';
}

function personaUpper() {
  return personaName().toUpperCase();
}

function callButtonLabel() {
  return `${personaUpper()} CALL`;
}

function livePanelLabel() {
  return `${personaUpper()} LIVE`;
}

function applyPersonaUi() {
  if (els.launch && !isSessionActive()) els.launch.textContent = callButtonLabel();
  const kicker = document.getElementById('fairy-live-kicker');
  if (kicker) kicker.textContent = livePanelLabel();
  if (els.panel) els.panel.setAttribute('aria-label', livePanelLabel());
  if (els.text) els.text.placeholder = `Test a ${personaName()} turn…`;
}

function emitLog(message, tone = 'info') {
  window.dispatchEvent(new CustomEvent('fairy-live-log', { detail: { message, tone } }));
}

function emitFairyCallAudioEvent(type, detail = {}) {
  window.dispatchEvent(new CustomEvent(type, { detail }));
}

function emitDirectChatSync(reason = 'update', extra = {}) {
  window.dispatchEvent(new CustomEvent('commandcenter:fairy-directchat-update', {
    detail: {
      reason,
      active: isSessionActive(),
      sessionId: state.sessionId,
      personaName: personaName(),
      status: state.status,
      transcriptCount: state.transcriptEntries.length,
      ...extra,
    },
  }));
}

function renderDiagnostics() {
  const html = `
    <div><strong>Key:</strong> ${state.hasApiKey ? 'configured' : 'missing'}</div>
    <div><strong>Session:</strong> ${state.sessionId ? state.sessionId.slice(0, 18) + '…' : 'none'}</div>
    <div><strong>Mic:</strong> ${state.micActive ? (state.micMuted ? 'muted' : 'live') : 'off'} · <strong>VAD:</strong> ${state.vad?.speaking ? 'speech' : 'idle'} · <strong>Screen:</strong> ${state.screenActive ? 'live' : 'off'} · <strong>Camera:</strong> ${state.cameraActive ? 'live' : 'off'}</div>
    ${state.micActive && state.vad ? `<div><strong>VAD level:</strong> rms ${state.vad.lastRms.toFixed(3)} · noise ${state.vad.noiseFloor.toFixed(3)} · peak ${state.vad.lastPeak.toFixed(3)}</div>` : ''}
    <div><strong>Last:</strong> ${escapeHtml(state.lastEvent || 'none')}</div>
    ${state.lastError ? `<div class="fairy-diag-error"><strong>Error:</strong> ${escapeHtml(state.lastError)}</div>` : ''}
  `;
  if (els.diagnostics) els.diagnostics.innerHTML = html;
}

function markEvent(label) {
  state.lastEvent = label;
  renderDiagnostics();
}

function markError(message) {
  state.lastError = String(message || 'Unknown error');
  markEvent('error');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  let body = null;
  try { body = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(body?.error || `Request failed (${res.status})`);
  return body || {};
}

function setHidden(el, hidden) {
  if (!el) return;
  el.classList.toggle('hidden', !!hidden);
}

async function copyTextValue(text) {
  const value = String(text || '').trim();
  if (!value) return false;
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch (_) {
    return false;
  }
}

function updateImageCardUi() {
  const active = !!(state.imageCard && state.imageCard.imageUrl);
  if (els.imageCard) setHidden(els.imageCard, !active);
  if (!active) return;
  if (els.imageCardImg) {
    els.imageCardImg.src = state.imageCard.imageUrl;
    els.imageCardImg.alt = state.imageCard.title || 'Fairy image';
  }
  if (els.imageCardTitle) els.imageCardTitle.textContent = String(state.imageCard.title || 'IMAGE').slice(0, 80).toUpperCase();
  if (els.imageCardOpen) els.imageCardOpen.href = state.imageCard.sourceUrl || state.imageCard.imageUrl || '#';
  if (els.imageCardCopy) els.imageCardCopy.disabled = !state.imageCard.imageUrl;
}

function dismissImageCard() {
  clearTimeout(state.imageHideTimer);
  state.imageHideTimer = null;
  state.imageCard = null;
  updateImageCardUi();
}

function showImageCard(card = {}, timeoutMs = 45000) {
  clearTimeout(state.imageHideTimer);
  state.imageCard = {
    title: String(card.title || card.query || 'Image').trim(),
    imageUrl: String(card.imageUrl || '').trim(),
    sourceUrl: String(card.sourceUrl || '').trim(),
    copyText: String(card.copyText || card.imageUrl || '').trim(),
    why: String(card.why || '').trim(),
  };
  updateImageCardUi();
  if (timeoutMs > 0) {
    state.imageHideTimer = setTimeout(() => {
      dismissImageCard();
    }, timeoutMs);
  }
}


function updateLaunchUi() {
  if (!els.launch) return;
  const active = isSessionActive();
  els.launch.textContent = active ? 'END CALL' : callButtonLabel();
  els.launch.classList.toggle('active', active);
}

function updateHeaderCallControls() {
  const active = isSessionActive();
  if (els.headerMic) {
    setHidden(els.headerMic, !active);
    els.headerMic.disabled = !state.sessionId;
    els.headerMic.textContent = state.micActive ? (state.micMuted ? 'MIC MUTED' : 'MIC LIVE') : 'MIC OFF';
    els.headerMic.classList.toggle('active', state.micActive && !state.micMuted);
    els.headerMic.classList.toggle('muted', state.micActive && state.micMuted);
  }
  if (els.headerScreen) {
    setHidden(els.headerScreen, !active);
    els.headerScreen.disabled = !state.sessionId;
    els.headerScreen.textContent = state.screenActive ? 'SCREEN LIVE' : 'SCREEN OFF';
    els.headerScreen.classList.toggle('active', state.screenActive);
  }
  if (els.headerCamera) {
    setHidden(els.headerCamera, !active);
    els.headerCamera.disabled = !state.sessionId;
    els.headerCamera.textContent = state.cameraActive ? 'CAM LIVE' : 'CAM OFF';
    els.headerCamera.classList.toggle('active', state.cameraActive);
  }
  if (els.headerCameraFacing) {
    setHidden(els.headerCameraFacing, !active);
    els.headerCameraFacing.disabled = !state.sessionId;
    els.headerCameraFacing.textContent = cameraFacingLabel();
    els.headerCameraFacing.classList.toggle('active', state.cameraActive);
  }
}

function cameraFacingLabel() {
  return state.cameraFacingMode === 'user' ? 'FRONT CAM' : 'BACK CAM';
}

function showOverlay(text = '', tone = 'info', persistMs = 7000) {
  if (!els.overlay) return;
  if (state.overlayTimer) clearTimeout(state.overlayTimer);
  const value = String(text || '').trim();
  if (!value) {
    els.overlay.innerHTML = '';
    setHidden(els.overlay, true);
    return;
  }
  els.overlay.className = `fairy-live-overlay tone-${tone}`.trim();
  els.overlay.innerHTML = value;
  setHidden(els.overlay, false);
  state.overlayTimer = setTimeout(() => {
    state.overlayTimer = null;
    els.overlay?.classList.add('hidden');
  }, persistMs);
}

function isSessionActive() {
  return !!state.sessionId && !['idle', 'ended', 'error'].includes(state.status);
}

export function isLiveCallActive() {
  return isSessionActive();
}

export function shouldSuppressAgentSpeech() {
  return isSessionActive();
}

export function getPersonaName() {
  return personaName();
}

export function getTranscriptMessages() {
  return state.transcriptEntries.map((entry) => ({ ...entry }));
}

export function getDirectChatAgent() {
  if (!isSessionActive()) return null;
  return {
    id: 'fairy-live',
    label: personaName(),
    name: personaName(),
    color: '#d8c4ff',
    isFairyLive: true,
    visual: { mode: 'default' },
  };
}

export function isDirectChatAgent(agentId = '') {
  return String(agentId || '').trim() === 'fairy-live';
}

export async function sendDirectChatMessage(text = '') {
  const value = String(text || '').trim();
  if (!value) return { ok: false, error: 'No text provided' };
  if (!state.sessionId) throw new Error(`Start ${personaName()} Live before sending text.`);
  appendTranscript('user', value, 'Epic');
  setStatus('thinking', `${personaName()} is deciding whether to answer or hand this to Astra…`);
  await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transcript.final', text: value }),
  });
  return { ok: true, sessionId: state.sessionId };
}

function updateMicUi() {
  if (els.mic) {
    els.mic.disabled = !state.sessionId;
    els.mic.textContent = state.micActive ? (state.micMuted ? 'MIC MUTED' : 'MIC LIVE') : 'START MIC';
    els.mic.classList.toggle('active', state.micActive && !state.micMuted);
    els.mic.classList.toggle('muted', state.micActive && state.micMuted);
  }
  if (els.audioStatus) {
    els.audioStatus.textContent = state.micActive
      ? (state.micMuted ? 'Mic captured but muted.' : `Mic streaming to ${personaName()}.`)
      : 'Mic off. Text test mode still works.';
  }
  updateHeaderCallControls();
  renderDiagnostics();
}

function updateScreenUi() {
  if (els.screen) {
    els.screen.disabled = !state.sessionId;
    els.screen.textContent = state.screenActive ? 'STOP SCREEN' : 'SHARE SCREEN';
    els.screen.classList.toggle('active', state.screenActive);
  }
  if (els.screenStatus) {
    els.screenStatus.textContent = state.screenActive
      ? `Screen frames streaming to ${personaName()}.`
      : 'Screen sharing off.';
  }
  updateHeaderCallControls();
  renderDiagnostics();
}

function updateCameraUi() {
  if (els.camera) {
    els.camera.disabled = !state.sessionId;
    els.camera.textContent = state.cameraActive ? 'STOP CAMERA' : 'START CAMERA';
    els.camera.classList.toggle('active', state.cameraActive);
  }
  if (els.cameraFacing) {
    els.cameraFacing.disabled = !state.sessionId;
    els.cameraFacing.textContent = cameraFacingLabel();
    els.cameraFacing.classList.toggle('active', state.cameraActive);
  }
  if (els.cameraStatus) {
    els.cameraStatus.textContent = state.cameraActive
      ? `Camera frames streaming to ${personaName()} (${state.cameraFacingMode === 'user' ? 'front camera' : 'back camera'}).`
      : `Camera off. Next source: ${state.cameraFacingMode === 'user' ? 'front camera' : 'back camera'}.`;
  }
  if (els.cameraPreviewWrap) setHidden(els.cameraPreviewWrap, !state.cameraActive);
  if (els.cameraPreviewLabel) els.cameraPreviewLabel.textContent = `${state.cameraFacingMode === 'user' ? 'FRONT' : 'BACK'} CAM`;
  updateImageCardUi();
  updateHeaderCallControls();
  renderDiagnostics();
}

function setStatus(status, message = '') {
  state.status = status || 'idle';
  if (els.state) {
    els.state.className = `fairy-live-state state-${state.status}`;
    els.state.textContent = state.status.replace(/_/g, ' ').toUpperCase();
  }
  if (els.status && message) els.status.textContent = message;
  if (els.start) els.start.disabled = ['connecting', 'ready', 'listening', 'thinking', 'speaking', 'handing_off', 'task_running'].includes(state.status);
  if (els.end) els.end.disabled = !state.sessionId || ['idle', 'ended'].includes(state.status);
  updateLaunchUi();
  updateHeaderCallControls();
  updateMicUi();
  updateScreenUi();
  emitDirectChatSync('status', { message });
  window.dispatchEvent(new CustomEvent('commandcenter:fairy-status', {
    detail: {
      sessionId: state.sessionId,
      active: isSessionActive(),
      status: state.status,
      message,
      personaName: personaName(),
      speaking: state.status === 'speaking',
      listening: state.status === 'listening',
      thinking: state.status === 'thinking' || state.status === 'handing_off' || state.status === 'task_running',
    },
  }));
}

function appendTranscript(role, text, meta = '') {
  if (!text) return;
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    role: String(role || 'system'),
    text: String(text || ''),
    meta: String(meta || role || ''),
    timestamp: Date.now(),
  };
  state.transcriptEntries.push(entry);
  if (state.transcriptEntries.length > 160) state.transcriptEntries.splice(0, state.transcriptEntries.length - 160);
  if (els.transcript) {
    const row = document.createElement('div');
    row.className = `fairy-live-line ${role}`;
    row.innerHTML = `
      <div class="fairy-live-line-meta">${escapeHtml(meta || role)}</div>
      <div class="fairy-live-line-text">${escapeHtml(text)}</div>
    `;
    els.transcript.appendChild(row);
    els.transcript.scrollTop = els.transcript.scrollHeight;
  }
  emitDirectChatSync('transcript', { entry });
}

function mergeAssistantChunk(currentText = '', nextChunk = '') {
  const current = String(currentText || '');
  const next = String(nextChunk || '');
  if (!next.trim()) return current;
  if (!current.trim()) return next;

  if (next.startsWith(current)) return next;
  if (current.startsWith(next) && current.length > next.length) return current;

  const maxOverlap = Math.min(current.length, next.length);
  for (let i = maxOverlap; i > 0; i -= 1) {
    if (current.slice(-i) === next.slice(0, i)) {
      return current + next.slice(i);
    }
  }

  const currentTrimmed = current.trimEnd();
  const nextTrimmed = next.trimStart();
  const glue = /[\s\n]$/.test(current) || /^[,.;:!?)}\]]/.test(nextTrimmed) ? '' : ' ';
  return `${currentTrimmed}${glue}${nextTrimmed}`;
}

function commitPendingAssistantText(reason = 'done') {
  const text = String(state.pendingAssistantText || '').trim();
  if (!text) return '';
  appendTranscript('fairy', text, personaName());
  state.pendingAssistantText = '';
  emitDirectChatSync('assistant-commit', { reason, text });
  return text;
}

function renderHandoff(text = '', tone = '') {
  if (!els.handoff) return;
  if (!text) {
    els.handoff.innerHTML = '';
    setHidden(els.handoff, true);
    return;
  }
  els.handoff.className = `fairy-live-handoff ${tone || ''}`.trim();
  els.handoff.innerHTML = text;
  setHidden(els.handoff, false);
}

function parseRate(mimeType = '', fallback = 24000) {
  const match = String(mimeType || '').match(/rate=(\d+)/i);
  const rate = match ? Number(match[1]) : fallback;
  return Number.isFinite(rate) && rate > 0 ? rate : fallback;
}

function int16ToBase64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  let binary = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(String(base64 || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

function resampleToInt16(input, sourceRate, targetRate = INPUT_SAMPLE_RATE) {
  if (!input?.length) return new Int16Array(0);
  if (sourceRate === targetRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return out;
  }

  const ratio = sourceRate / targetRate;
  const newLength = Math.max(1, Math.round(input.length / ratio));
  const out = new Int16Array(newLength);
  for (let i = 0; i < newLength; i += 1) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(input.length - 1, left + 1);
    const frac = pos - left;
    const sample = input[left] * (1 - frac) + input[right] * frac;
    const s = Math.max(-1, Math.min(1, sample));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function createVadState() {
  return {
    noiseFloor: 0.006,
    startedAt: Date.now(),
    speaking: false,
    speechMs: 0,
    silenceMs: 0,
    preroll: [],
    lastRms: 0,
    lastPeak: 0,
  };
}

function samplesDurationMs(samples) {
  return Math.round((Number(samples?.length || 0) / INPUT_SAMPLE_RATE) * 1000);
}

function measureSamples(samples) {
  if (!samples?.length) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const value = Math.abs(samples[i] / 0x7fff);
    sum += value * value;
    if (value > peak) peak = value;
  }
  return { rms: Math.sqrt(sum / samples.length), peak };
}

function rememberVadPreroll(vad, samples, durationMs) {
  // Kept as a no-op compatibility shim for older debug notes: mic upload is continuous now,
  // so pre-roll is unnecessary and local VAD must not gate Gemini Live input.
  void vad;
  void samples;
  void durationMs;
}

function enqueueRawPcmSamples(samples) {
  if (!samples?.length || state.micMuted || !state.sessionId) return;
  for (let i = 0; i < samples.length; i += 1) state.pcmQueue.push(samples[i]);
  while (state.pcmQueue.length >= AUDIO_CHUNK_SAMPLES) {
    const chunk = new Int16Array(state.pcmQueue.splice(0, AUDIO_CHUNK_SAMPLES));
    postAudioChunk(chunk);
  }
}

function observeVadSamples(samples) {
  if (!samples?.length || state.micMuted || !state.sessionId) return;
  const vad = state.vad || (state.vad = createVadState());
  const durationMs = samplesDurationMs(samples);
  const { rms, peak } = measureSamples(samples);
  vad.lastRms = rms;
  vad.lastPeak = peak;

  const learningNoise = !vad.speaking && (Date.now() - vad.startedAt) < VAD_NOISE_LEARN_MS;
  const endThreshold = Math.max(VAD_MIN_RMS_END, vad.noiseFloor * 2.0);
  const startThreshold = Math.max(VAD_MIN_RMS_START, vad.noiseFloor * 3.2);
  const speechCandidate = rms >= startThreshold || (rms >= endThreshold && peak >= VAD_MIN_PEAK_START);
  const continuingSpeech = rms >= endThreshold || peak >= VAD_MIN_PEAK_START;

  if (!vad.speaking && !speechCandidate) {
    if (learningNoise || rms < Math.max(VAD_MIN_RMS_START, vad.noiseFloor * 2.6)) {
      vad.noiseFloor = (vad.noiseFloor * 0.94) + (rms * 0.06);
    }
    rememberVadPreroll(vad, samples, durationMs);
    renderDiagnostics();
    return;
  }

  if (!vad.speaking && speechCandidate) {
    vad.speaking = true;
    vad.speechMs = 0;
    vad.silenceMs = 0;
    vad.preroll = [];
  }

  if (vad.speaking) {
    if (continuingSpeech) {
      vad.speechMs += durationMs;
      vad.silenceMs = 0;
    } else {
      vad.silenceMs += durationMs;
    }
    if (vad.silenceMs >= VAD_HANGOVER_MS && vad.speechMs >= VAD_MIN_SPEECH_MS) {
      vad.speaking = false;
      vad.speechMs = 0;
      vad.silenceMs = 0;
      vad.preroll = [];
    }
  }
  renderDiagnostics();
}

function shouldInterruptForSamples(samples) {
  if (!state.sessionId || !samples?.length) return false;
  if (!state.playbackActive) return false;
  if (!['speaking', 'thinking', 'handing_off', 'task_running'].includes(state.status)) return false;
  const now = Date.now();
  if (state.interrupting || (now - state.lastInterruptAt) < 900) return false;
  const { rms, peak } = measureSamples(samples);
  const floor = state.vad?.noiseFloor || 0.006;
  const rmsThreshold = Math.max(VAD_INTERRUPT_RMS, floor * 4.0);
  return rms >= rmsThreshold && peak >= VAD_INTERRUPT_PEAK;
}

function interruptFairy(reason = 'user_speaking') {
  if (!state.sessionId || state.interrupting) return;
  state.interrupting = true;
  state.lastInterruptAt = Date.now();
  stopPlayback();
  showOverlay('Interrupted.', 'tool', 1200);
  emitLog(`Fairy interrupted: ${reason}`, 'info');
  markEvent('interrupted');
  setStatus('listening', 'Go on. Fairy is listening.');
  fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'assistant.interrupted', reason }),
  }).catch(() => {}).finally(() => {
    setTimeout(() => {
      state.interrupting = false;
    }, 240);
  });
}

function queuePcmSamples(samples) {
  if (!samples?.length || state.micMuted || !state.sessionId) return;
  observeVadSamples(samples);
  if (shouldInterruptForSamples(samples)) interruptFairy('user_speaking');
  // Gemini Live needs continuous mic input to do its own endpointing reliably.
  // Local VAD is for diagnostics/barge-in only; do not gate Fairy's ears shut.
  enqueueRawPcmSamples(samples);
}

function flushPcmQueue() {
  if (!state.pcmQueue.length || !state.sessionId) return;
  const chunk = new Int16Array(state.pcmQueue.splice(0, state.pcmQueue.length));
  postAudioChunk(chunk);
}

function postAudioChunk(samples) {
  if (!state.sessionId || !samples?.length) return;
  const sessionId = state.sessionId;
  const pcm16Base64 = int16ToBase64(samples);
  state.audioPostChain = state.audioPostChain
    .catch(() => {})
    .then(() => fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/audio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pcm16Base64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` }),
    }))
    .catch((err) => {
      if (state.sessionId === sessionId) {
        setStatus('error', err.message || 'Mic audio upload failed');
        stopMic().catch(() => {});
      }
    });
}

async function ensurePlaybackContext() {
  if (!state.playbackContext) {
    state.playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    state.playbackNextTime = state.playbackContext.currentTime;
  }
  if (state.playbackContext.state === 'suspended') await state.playbackContext.resume();
  return state.playbackContext;
}

async function playAudioChunk(pcm16Base64, mimeType = 'audio/pcm;rate=24000', done = false) {
  if (!pcm16Base64) {
    if (done) notifyPlaybackFinishedSoon();
    return;
  }
  const ctx = await ensurePlaybackContext();
  const samples = base64ToInt16(pcm16Base64);
  if (!samples.length) return;
  const rate = parseRate(mimeType, 24000);
  const buffer = ctx.createBuffer(1, samples.length, rate);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i += 1) channel[i] = Math.max(-1, Math.min(1, samples[i] / 0x8000));

  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  const startAt = Math.max(ctx.currentTime + 0.02, state.playbackNextTime || ctx.currentTime);
  state.playbackNextTime = startAt + buffer.duration;
  const generation = state.playbackGeneration;
  state.playbackSources.add(source);
  state.playbackActive = true;
  source.onended = () => {
    state.playbackSources.delete(source);
    if (!state.playbackSources.size) {
      state.playbackActive = false;
      emitFairyCallAudioEvent('commandcenter:voice-playback-stop', { source: 'fairy-live', sessionId: state.sessionId, fairy: true });
    }
    if (done && generation === state.playbackGeneration) notifyPlaybackFinishedSoon();
  };
  emitFairyCallAudioEvent('commandcenter:voice-playback-start', { source: 'fairy-live', sessionId: state.sessionId, fairy: true });
  source.start(startAt);
}

let playbackFinishedTimer = null;
function notifyPlaybackFinishedSoon() {
  if (playbackFinishedTimer) clearTimeout(playbackFinishedTimer);
  playbackFinishedTimer = setTimeout(() => {
    playbackFinishedTimer = null;
    if (!state.sessionId) return;
    fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'assistant.playback_finished' }),
    }).catch(() => {});
  }, 180);
}

function stopPlayback() {
  state.playbackGeneration += 1;
  if (state.playbackActive) emitFairyCallAudioEvent('commandcenter:voice-playback-stop', { source: 'fairy-live', sessionId: state.sessionId, fairy: true, interrupted: true });
  state.playbackActive = false;
  if (playbackFinishedTimer) clearTimeout(playbackFinishedTimer);
  playbackFinishedTimer = null;
  for (const source of state.playbackSources) {
    try { source.stop(); } catch (_) {}
  }
  state.playbackSources.clear();
  if (state.playbackContext) state.playbackNextTime = state.playbackContext.currentTime;
}

function stopFairyAudio() {
  stopPlayback();
  notifyPlaybackFinishedSoon();
  setStatus(state.sessionId ? 'ready' : state.status, 'Fairy audio stopped. Blessed silence, for once.');
  emitLog('Fairy audio stopped', 'info');
  showOverlay('Fairy silenced.', 'info', 2200);
  markEvent('audio stopped');
}

async function startMic() {
  if (!state.sessionId) {
    setStatus('idle', 'Start Fairy Live before opening the mic. Obviously.');
    return;
  }
  if (state.micActive) {
    state.micMuted = !state.micMuted;
    updateMicUi();
    setStatus(state.micMuted ? 'ready' : 'listening', state.micMuted ? 'Mic muted.' : 'Mic streaming to Fairy.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    state.vad = createVadState();
    state.pcmQueue = [];
    const source = ctx.createMediaStreamSource(stream);
    const processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!state.micActive || state.micMuted || !state.sessionId) return;
      const input = event.inputBuffer.getChannelData(0);
      queuePcmSamples(resampleToInt16(input, ctx.sampleRate, INPUT_SAMPLE_RATE));
    };
    source.connect(processor);
    processor.connect(ctx.destination);

    state.micStream = stream;
    state.micContext = ctx;
    state.micSource = source;
    state.micProcessor = processor;
    state.micActive = true;
    state.micMuted = false;
    updateMicUi();
    setStatus('listening', 'Mic is live. Fairy can hear you now, which is probably legally dangerous.');
    appendTranscript('system', 'Mic streaming started.', 'audio');
    emitLog('Mic streaming started', 'info');
    markEvent('mic started');
  } catch (err) {
    setStatus('error', err.message || 'Microphone permission denied');
  }
}

async function stopMic() {
  flushPcmQueue();
  state.micActive = false;
  state.micMuted = false;
  try { state.micProcessor?.disconnect(); } catch (_) {}
  try { state.micSource?.disconnect(); } catch (_) {}
  try { await state.micContext?.close(); } catch (_) {}
  try { state.micStream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  state.micStream = null;
  state.micContext = null;
  state.micSource = null;
  state.micProcessor = null;
  state.pcmQueue = [];
  state.vad = null;
  updateMicUi();
  if (state.sessionId) {
    emitLog('Mic stopped', 'info');
    markEvent('mic stopped');
  }
}

function postScreenFrame(jpegBase64) {
  if (!state.sessionId || !jpegBase64) return;
  const sessionId = state.sessionId;
  state.screenPostChain = state.screenPostChain
    .catch(() => {})
    .then(() => fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/screen`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpegBase64, mimeType: 'image/jpeg' }),
    }))
    .catch((err) => {
      if (state.sessionId === sessionId && state.screenActive) {
        setStatus('error', err.message || 'Screen frame upload failed');
        stopScreenShare().catch(() => {});
      }
    });
}

function sampleVisualSignature(video, canvas) {
  if (!video || !canvas) return null;
  const width = 32;
  const height = 18;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.drawImage(video, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  const sample = new Uint8Array(width * height);
  let total = 0;
  for (let i = 0, p = 0; i < data.length; i += 4, p += 1) {
    const lum = Math.round((data[i] * 0.299) + (data[i + 1] * 0.587) + (data[i + 2] * 0.114));
    sample[p] = lum;
    total += lum;
  }
  return { sample, avg: total / sample.length };
}

function detectMeaningfulScreenChange(video) {
  if (!video || !state.screenCanvas) return;
  const signature = sampleVisualSignature(video, state.screenCanvas);
  if (!signature) return;
  const previous = state.screenChangeLastSample;
  state.screenChangeLastSample = signature;
  if (!previous) return;

  let diffTotal = 0;
  let changedCells = 0;
  for (let i = 0; i < signature.sample.length; i += 1) {
    const diff = Math.abs(signature.sample[i] - previous.sample[i]);
    diffTotal += diff;
    if (diff >= 28) changedCells += 1;
  }
  const avgDiff = diffTotal / signature.sample.length;
  const changedRatio = changedCells / signature.sample.length;
  const now = Date.now();
  const significant = avgDiff >= 16 || changedRatio >= 0.22;
  if (!significant) return;
  if (now - state.screenChangeLastAt < 8000) return;
  state.screenChangeLastAt = now;
  markEvent(`screen changed (${Math.round(avgDiff)} / ${Math.round(changedRatio * 100)}%)`);
  fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'screen.changed',
      avgDiff: Number(avgDiff.toFixed(1)),
      changedRatio: Number(changedRatio.toFixed(3)),
    }),
  }).catch(() => {});
}

function captureScreenFrame() {
  if (!state.screenActive || !state.sessionId || !state.screenVideo || !state.screenCanvas) return;
  detectMeaningfulScreenChange(state.screenVideo);
  const jpegBase64 = captureVisualFrame(state.screenVideo, state.screenCanvas, { quality: 0.68 });
  if (!jpegBase64) return;
  postScreenFrame(jpegBase64);
}

function captureCameraFrame() {
  if (!state.cameraActive || !state.sessionId || !state.cameraVideo || !state.cameraCanvas) return;
  const jpegBase64 = captureVisualFrame(state.cameraVideo, state.cameraCanvas, { quality: 0.72 });
  if (!jpegBase64) return;
  postScreenFrame(jpegBase64);
}

function captureVisualFrame(video, canvas, { quality = 0.68 } = {}) {
  if (!video || !canvas) return '';
  const width = video.videoWidth || 1280;
  const height = video.videoHeight || 720;
  if (!width || !height) return '';
  const maxWidth = 960;
  const scale = Math.min(1, maxWidth / width);
  const outWidth = Math.max(1, Math.round(width * scale));
  const outHeight = Math.max(1, Math.round(height * scale));
  canvas.width = outWidth;
  canvas.height = outHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.drawImage(video, 0, 0, outWidth, outHeight);
  const dataUrl = canvas.toDataURL('image/jpeg', quality);
  return dataUrl.split(',')[1] || '';
}

async function startScreenShare() {
  if (!state.sessionId) {
    setStatus('idle', 'Start Fairy Live before sharing your screen. One portal at a time.');
    return;
  }
  if (state.screenActive) {
    await stopScreenShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setStatus('error', 'Screen sharing is not supported in this browser/context.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 2 },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    state.screenStream = stream;
    state.screenVideo = video;
    state.screenCanvas = document.createElement('canvas');
    state.screenChangeLastSample = null;
    state.screenChangeLastAt = 0;
    state.screenActive = true;
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => stopScreenShare().catch(() => {});
    });
    captureScreenFrame();
    fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'screen.started' }),
    }).catch(() => {});
    state.screenTimer = setInterval(captureScreenFrame, 1500);
    updateScreenUi();
    setStatus('ready', 'Screen sharing is live. Fairy can see snapshots now. Behave accordingly.');
    appendTranscript('system', 'Screen sharing started.', 'screen');
    emitLog('Screen sharing started', 'info');
    markEvent('screen started');
  } catch (err) {
    setStatus('error', err.message || 'Screen share permission denied');
  }
}

async function stopScreenShare() {
  if (state.screenTimer) clearInterval(state.screenTimer);
  state.screenTimer = null;
  state.screenActive = false;
  try { state.screenStream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  try { if (state.screenVideo) state.screenVideo.srcObject = null; } catch (_) {}
  const hadSession = !!state.sessionId;
  const sessionId = state.sessionId;
  state.screenStream = null;
  state.screenVideo = null;
  state.screenCanvas = null;
  state.screenChangeLastSample = null;
  state.screenChangeLastAt = 0;
  updateScreenUi();
  if (hadSession) {
    emitLog('Screen sharing stopped', 'info');
    markEvent('screen stopped');
    fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'screen.stopped' }),
    }).catch(() => {});
  }
}

async function startCameraShare() {
  if (!state.sessionId) {
    setStatus('idle', 'Start Fairy Live before showing camera frames. One little surveillance demon at a time.');
    return;
  }
  if (state.cameraActive) {
    await stopCameraShare();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus('error', 'Camera capture is not supported in this browser/context.');
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: state.cameraFacingMode }, frameRate: { ideal: 3, max: 5 } },
      audio: false,
    });
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    await video.play();

    state.cameraStream = stream;
    state.cameraVideo = video;
    state.cameraPreview = els.cameraPreview || null;
    if (state.cameraPreview) {
      state.cameraPreview.srcObject = stream;
      state.cameraPreview.muted = true;
      state.cameraPreview.playsInline = true;
      await state.cameraPreview.play().catch(() => {});
    }
    state.cameraCanvas = document.createElement('canvas');
    state.cameraActive = true;
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => stopCameraShare().catch(() => {});
    });
    captureCameraFrame();
    fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'camera.started' }),
    }).catch(() => {});
    state.cameraTimer = setInterval(captureCameraFrame, 1400);
    updateCameraUi();
    setStatus('ready', `Camera sharing is live. ${personaName()} can see what you're showing her now.`);
    appendTranscript('system', 'Camera sharing started.', 'camera');
    emitLog('Camera sharing started', 'info');
    markEvent('camera started');
  } catch (err) {
    setStatus('error', err.message || 'Camera permission denied');
  }
}

async function stopCameraShare({ silent = false } = {}) {
  if (state.cameraTimer) clearInterval(state.cameraTimer);
  state.cameraTimer = null;
  state.cameraActive = false;
  try { state.cameraStream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  try { if (state.cameraVideo) state.cameraVideo.srcObject = null; } catch (_) {}
  try { if (state.cameraPreview) state.cameraPreview.srcObject = null; } catch (_) {}
  const hadSession = !!state.sessionId;
  const sessionId = state.sessionId;
  state.cameraStream = null;
  state.cameraVideo = null;
  state.cameraPreview = null;
  state.cameraCanvas = null;
  updateCameraUi();
  if (hadSession && !silent) {
    emitLog('Camera sharing stopped', 'info');
    markEvent('camera stopped');
    fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'camera.stopped' }),
    }).catch(() => {});
  }
}

async function toggleCameraFacingMode() {
  state.cameraFacingMode = state.cameraFacingMode === 'user' ? 'environment' : 'user';
  updateCameraUi();
  if (!state.cameraActive) {
    setStatus(state.sessionId ? state.status : 'idle', `Camera source set to ${state.cameraFacingMode === 'user' ? 'front camera' : 'back camera'}.`);
    return;
  }
  await stopCameraShare({ silent: true });
  await startCameraShare();
}

export async function refreshConfig() {
  try {
    const data = await fetchJson(`${BASE}/api/live/config`);
    const config = data.config || {};
    state.model = config.model || 'unknown';
    state.hasApiKey = !!config.hasApiKey;
    state.personaName = String(config.personaName || 'Fairy').trim() || 'Fairy';
    applyPersonaUi();
    if (els.model) {
      els.model.textContent = state.hasApiKey
        ? `${state.model} · ${Array.isArray(config.responseModalities) ? config.responseModalities.join('+') : 'LIVE'}`
        : 'Gemini key missing in Command Center settings';
    }
    markEvent('config refreshed');
    if (!state.hasApiKey) setStatus('idle', `${personaName()} is installed, but Gemini Live needs a local Gemini key in Command Center settings before calls can start.`);
  } catch (err) {
    if (els.model) els.model.textContent = 'Gemini config unavailable';
    markError(err.message || 'Gemini config unavailable');
    setStatus('error', err.message || 'Gemini config unavailable');
  }
}

async function startCall() {
  try {
    renderHandoff('');
    stopPlayback();
    setStatus('connecting', `Connecting ${personaName()} to Gemini Live…`);
    const data = await fetchJson(`${BASE}/api/call/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ persona: 'fairy' }),
    });
    state.sessionId = data.session?.id || '';
    state.transcriptEntries = [];
    state.pendingAssistantText = '';
    emitDirectChatSync('session-start');
    setStatus(data.session?.state || 'ready', `${personaName()} is live. Auto-enabling the mic now.`);
    emitFairyCallAudioEvent('commandcenter:fairy-call-start', { sessionId: state.sessionId });
    appendTranscript('system', `${personaName()} session started: ${state.sessionId}`, 'system');
    emitLog(`${personaName()} Live started: ${state.sessionId}`, 'info');
    showOverlay(`${personaName()} connected.`, 'info', 2200);
    markEvent('call started');
    startMic().catch((err) => {
      markError(err?.message || 'Microphone permission denied');
      setStatus('ready', `${personaName()} connected, but mic permission was denied. Use the MIC button if you want to retry.`);
    });
  } catch (err) {
    state.sessionId = '';
    setStatus('error', err.message || `Failed to start ${personaName()} Live`);
  }
}

async function endCall() {
  if (!state.sessionId) return;
  const id = state.sessionId;
  try {
    await stopMic();
    await stopScreenShare();
    stopPlayback();
    state.interrupting = false;
    await fetchJson(`${BASE}/api/call/${encodeURIComponent(id)}/end`, { method: 'POST' });
    state.sessionId = '';
    emitDirectChatSync('session-end');
    setStatus('ended', `${personaName()} Live ended. The desk is quiet again. Suspiciously quiet.`);
    emitFairyCallAudioEvent('commandcenter:fairy-call-end', { sessionId: id });
    appendTranscript('system', `${personaName()} session ended: ${id}`, 'system');
    emitLog(`${personaName()} Live ended: ${id}`, 'info');
    showOverlay('', 'info', 0);
    markEvent('call ended');
  } catch (err) {
    setStatus('error', err.message || `Failed to end ${personaName()} Live`);
  }
}

async function sendTextTurn() {
  const text = els.text?.value?.trim() || '';
  if (!text) return;
  if (!state.sessionId) {
    setStatus('idle', `Start ${personaName()} Live before sending a test turn, menace.`);
    return;
  }
  els.text.value = '';
  appendTranscript('user', text, 'Epic');
  setStatus('thinking', `${personaName()} is deciding whether to answer or hand this to Astra…`);
  try {
    await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'transcript.final', text }),
    });
  } catch (err) {
    setStatus('error', err.message || 'Fairy turn failed');
  }
}

function handleTaskUpdate(task) {
  if (!task?.id) return;
  state.tasks.set(task.id, task);
  if (state.lastTaskId && state.lastTaskId === task.id) {
    renderHandoff(`
      <strong>Handed to Astra/OpenClaw:</strong> ${escapeHtml(task.title || task.id)}<br>
      <span>Status: ${escapeHtml(task.status || 'queued')}</span><br>
      <span>${escapeHtml(task.summary || '')}</span>
    `, task.status === 'failed' ? 'error' : task.status === 'completed' ? 'done' : '');
    const overlayTone = task.status === 'failed' ? 'error' : task.status === 'completed' ? 'done' : 'info';
    const overlayDuration = task.status === 'working' ? 4200 : 9000;
    showOverlay(`${escapeHtml(task.title || task.id)} · ${escapeHtml(task.status || 'queued')}${task.summary ? `<br>${escapeHtml(task.summary)}` : ''}`, overlayTone, overlayDuration);
    if (task.status === 'working') {
      setStatus('task_running', `Astra/OpenClaw is actively working. ${personaName()} is tracking it.`);
      markEvent('task working');
      return;
    }
    if (['completed', 'failed', 'needs_input'].includes(task.status)) {
      appendTranscript(task.status === 'failed' ? 'error' : 'system', task.summary || `Task ${task.status}`, `task:${task.status}`);
      if (state.status === 'task_running') setStatus('ready', `Task update received. ${personaName()} is ready for the next bit of chaos.`);
    }
  }
}

export function init() {
  els.panel = document.getElementById('fairy-live-panel');
  if (!els.panel) return;
  els.state = document.getElementById('fairy-live-state');
  els.launch = document.getElementById('fairy-live-launch-btn');
  els.headerMic = document.getElementById('fairy-live-mic-header-btn');
  els.headerScreen = document.getElementById('fairy-live-screen-header-btn');
  els.headerCamera = document.getElementById('fairy-live-camera-header-btn');
  els.headerCameraFacing = document.getElementById('fairy-live-camera-facing-header-btn');
  els.overlay = document.getElementById('fairy-live-overlay');
  els.model = document.getElementById('fairy-live-model');
  els.status = document.getElementById('fairy-live-status');
  els.audioStatus = document.getElementById('fairy-live-audio-status');
  els.transcript = document.getElementById('fairy-live-transcript');
  els.handoff = document.getElementById('fairy-live-handoff');
  els.start = document.getElementById('fairy-live-start');
  els.end = document.getElementById('fairy-live-end');
  els.stopAudio = document.getElementById('fairy-live-stop-audio');
  els.diagnostics = document.getElementById('fairy-live-diagnostics');
  els.mic = document.getElementById('fairy-live-mic');
  els.screen = document.getElementById('fairy-live-screen');
  els.screenStatus = document.getElementById('fairy-live-screen-status');
  els.camera = document.getElementById('fairy-live-camera');
  els.cameraFacing = document.getElementById('fairy-live-camera-facing');
  els.cameraStatus = document.getElementById('fairy-live-camera-status');
  els.cameraPreviewWrap = document.getElementById('fairy-live-camera-preview-wrap');
  els.cameraPreview = document.getElementById('fairy-live-camera-preview');
  els.cameraPreviewLabel = document.getElementById('fairy-live-camera-preview-label');
  els.imageCard = document.getElementById('fairy-live-image-card');
  els.imageCardImg = document.getElementById('fairy-live-image-card-img');
  els.imageCardTitle = document.getElementById('fairy-live-image-card-title');
  els.imageCardOpen = document.getElementById('fairy-live-image-card-open');
  els.imageCardCopy = document.getElementById('fairy-live-image-card-copy');
  els.imageCardDismiss = document.getElementById('fairy-live-image-card-dismiss');
  els.text = document.getElementById('fairy-live-text');
  els.send = document.getElementById('fairy-live-send');

  els.panel?.addEventListener('click', (event) => event.stopPropagation());
  els.launch?.addEventListener('click', (event) => { event.stopPropagation(); if (isSessionActive()) endCall(); else startCall(); });
  els.headerMic?.addEventListener('click', (event) => { event.stopPropagation(); startMic(); });
  els.headerScreen?.addEventListener('click', (event) => { event.stopPropagation(); startScreenShare(); });
  els.headerCamera?.addEventListener('click', (event) => { event.stopPropagation(); startCameraShare(); });
  els.headerCameraFacing?.addEventListener('click', (event) => { event.stopPropagation(); toggleCameraFacingMode(); });
  els.start?.addEventListener('click', (event) => { event.stopPropagation(); startCall(); });
  els.end?.addEventListener('click', (event) => { event.stopPropagation(); endCall(); });
  els.stopAudio?.addEventListener('click', (event) => { event.stopPropagation(); stopFairyAudio(); });
  els.mic?.addEventListener('click', (event) => { event.stopPropagation(); startMic(); });
  els.screen?.addEventListener('click', (event) => { event.stopPropagation(); startScreenShare(); });
  els.camera?.addEventListener('click', (event) => { event.stopPropagation(); startCameraShare(); });
  els.cameraFacing?.addEventListener('click', (event) => { event.stopPropagation(); toggleCameraFacingMode(); });
  els.send?.addEventListener('click', (event) => { event.stopPropagation(); sendTextTurn(); });
  els.imageCardCopy?.addEventListener('click', async (event) => {
    event.stopPropagation();
    const ok = await copyTextValue(state.imageCard?.copyText || state.imageCard?.imageUrl || '');
    showOverlay(ok ? 'Image link copied.' : 'Could not copy image link.', ok ? 'tool' : 'error', 2800);
  });
  els.imageCardDismiss?.addEventListener('click', (event) => {
    event.stopPropagation();
    dismissImageCard();
    showOverlay('Image dismissed.', 'tool', 1800);
  });
  els.text?.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.key === 'Enter') {
      event.preventDefault();
      sendTextTurn();
    }
  });

  updateMicUi();
  updateScreenUi();
  updateCameraUi();
  updateImageCardUi();
  updateLaunchUi();
  updateHeaderCallControls();
  renderDiagnostics();
  applyPersonaUi();
  refreshConfig();
}

export function handleEvent(msg = {}) {
  const type = msg.type || '';
  const data = msg.data || {};

  if (type === 'call:session.started') {
    state.sessionId = data.id || data.sessionId || state.sessionId;
    setStatus(data.state || 'ready', `${personaName()} is live.`);
    appendTranscript('system', `Session ready: ${state.sessionId}`, 'system');
    emitLog(`${personaName()} session ready: ${state.sessionId}`, 'info');
    showOverlay(`${personaName()} is listening.`, 'info', 2200);
    markEvent('session ready');
    return;
  }

  if (type === 'call:session.ended') {
    if (!state.sessionId || data.id === state.sessionId || data.sessionId === state.sessionId) {
      stopMic().catch(() => {});
      stopScreenShare().catch(() => {});
      stopCameraShare().catch(() => {});
      stopPlayback();
      commitPendingAssistantText('session-ended');
      state.interrupting = false;
      state.sessionId = '';
      setStatus('ended', `${personaName()} Live ended.`);
      emitFairyCallAudioEvent('commandcenter:fairy-call-end', { sessionId: data.id || data.sessionId || state.sessionId });
      emitLog(`${personaName()} Live ended`, 'info');
      showOverlay('', 'info', 0);
      markEvent('call ended');
    }
    return;
  }

  if (type === 'call:session.state' && (!state.sessionId || data.sessionId === state.sessionId)) {
    setStatus(data.state || 'ready');
    return;
  }

  if (type === 'call:transcript.partial' && data.sessionId === state.sessionId) {
    setStatus(data.state || 'listening', data.text ? `Hearing: ${data.text}` : 'Listening…');
    return;
  }

  if (type === 'call:transcript.final' && data.sessionId === state.sessionId) {
    state.pendingAssistantText = '';
    setStatus(data.state || 'thinking', `${personaName()} is thinking…`);
    return;
  }

  if (type === 'call:response.text' && data.sessionId === state.sessionId) {
    const rawText = String(data.text || '').trim();
    if (rawText) state.pendingAssistantText = mergeAssistantChunk(state.pendingAssistantText, rawText);
    const displayText = String(state.pendingAssistantText || rawText || '').trim();
    const tone = /confirmed from the web|web check says|checked the web/i.test(displayText) ? 'tool' : 'fairy';
    showOverlay(escapeHtml(displayText), tone, 8500);
    markEvent('response text');
    setStatus(data.state || (data.done ? 'speaking' : 'thinking'), displayText || `${personaName()} responded.`);
    if (data.taskId) state.lastTaskId = data.taskId;
    if (data.done) commitPendingAssistantText('done');
    return;
  }

  if (type === 'call:response.audio' && data.sessionId === state.sessionId) {
    if (!state.interrupting) setStatus(data.state || 'speaking', `${personaName()} is speaking. Try not to look too impressed.`);
    if (data.text) showOverlay(escapeHtml(data.text), 'fairy', 8500);
    markEvent('response audio');
    playAudioChunk(data.pcm16Base64, data.mimeType, !!data.done).catch((err) => {
      markError(err.message || `${personaName()} audio playback failed`);
      setStatus('error', err.message || `${personaName()} audio playback failed`);
    });
    return;
  }

  if (type === 'call:screen.enabled' && data.sessionId === state.sessionId) {
    if (els.screenStatus) els.screenStatus.textContent = `Screen frame received by ${personaName()}.`;
    return;
  }

  if (type === 'call:screen.changed' && data.sessionId === state.sessionId) {
    const pct = Math.round(Number(data.changedRatio || 0) * 100);
    markEvent(`screen change noticed (${pct}%)`);
    if (els.screenStatus) els.screenStatus.textContent = `Screen changed noticeably (${pct}%). ${personaName()} has the new frame.`;
    return;
  }

  if (type === 'call:screen.disabled' && data.sessionId === state.sessionId) {
    state.screenActive = false;
    updateScreenUi();
    return;
  }

  if (type === 'call:camera.enabled' && data.sessionId === state.sessionId) {
    state.cameraActive = true;
    if (els.cameraStatus) els.cameraStatus.textContent = `Camera frames received by ${personaName()}.`;
    updateCameraUi();
    return;
  }

  if (type === 'call:camera.disabled' && data.sessionId === state.sessionId) {
    state.cameraActive = false;
    updateCameraUi();
    return;
  }

  if (type === 'call:memory.saved' && data.sessionId === state.sessionId) {
    const text = String(data.entry?.text || 'Memory saved.').trim();
    showOverlay(`Memory saved: ${escapeHtml(text.slice(0, 180))}`, 'tool', 6500);
    markEvent('memory saved');
    return;
  }

  if (type === 'call:settings.updated' && data.sessionId === state.sessionId) {
    const section = String(data.section || 'settings').trim();
    const changed = Array.isArray(data.changedKeys) ? data.changedKeys.filter(Boolean).slice(0, 6) : [];
    showOverlay(`Saved ${escapeHtml(section)} settings${changed.length ? `<br>${escapeHtml(changed.join(', '))}` : ''}`, 'tool', 7000);
    markEvent('settings updated');
    return;
  }

  if (type === 'call:image.search.started' && data.sessionId === state.sessionId) {
    showOverlay(`Finding image${data.query ? `: ${escapeHtml(String(data.query))}` : '…'}`, 'tool', 8000);
    markEvent('image search started');
    return;
  }

  if (type === 'call:image.search.result' && data.sessionId === state.sessionId && !data.ok) {
    showOverlay(`Image lookup failed${data.error ? `: ${escapeHtml(String(data.error))}` : ''}`, 'error', 9000);
    markEvent('image search failed');
    return;
  }

  if (type === 'call:image.display' && data.sessionId === state.sessionId && data.ok) {
    showImageCard(data, 45000);
    const why = String(data.why || '').trim();
    showOverlay(`Image ready: ${escapeHtml(String(data.title || data.query || 'Image'))}${why ? `<br>${escapeHtml(why)}` : ''}<br>Link is copyable.`, 'tool', 10000);
    markEvent('image display ready');
    return;
  }

  if (type === 'call:web_search.started' && data.sessionId === state.sessionId) {
    const query = String(data.query || '').trim();
    showOverlay(`Checking the web${query ? `: ${escapeHtml(query)}` : '…'}`, 'tool', 7000);
    markEvent('web search started');
    return;
  }

  if (type === 'call:web_search.result' && data.sessionId === state.sessionId) {
    if (data.ok) {
      const domains = Array.isArray(data.domains) ? data.domains.filter(Boolean).slice(0, 4) : [];
      const urls = Array.isArray(data.urls) ? data.urls.filter(Boolean).slice(0, 3) : [];
      const preview = escapeHtml(String(data.preview || '').trim());
      const meta = domains.length ? `Sources: ${escapeHtml(domains.join(', '))}` : 'Web check complete';
      const links = urls.length ? `<br>${urls.map((url) => `<span>${escapeHtml(url)}</span>`).join('<br>')}` : '';
      showOverlay(`${meta}${preview ? `<br>${preview}` : ''}${links}`, 'tool', 10000);
    } else {
      showOverlay(`Web check failed${data.error ? `: ${escapeHtml(data.error)}` : ''}`, 'error', 9000);
    }
    markEvent('web search result');
    return;
  }

  if (type === 'call:handoff.started' && data.sessionId === state.sessionId) {
    setStatus('handing_off', `${personaName()} is handing that to Astra/OpenClaw…`);
    renderHandoff(`<strong>Routing to Astra/OpenClaw:</strong> ${escapeHtml(data.title || 'Background task')}<br><span>${escapeHtml(data.summary || '')}</span>`);
    showOverlay(`Routing to Astra: ${escapeHtml(data.title || 'Background task')}${data.summary ? `<br>${escapeHtml(data.summary)}` : ''}`, 'tool', 9000);
    emitLog(`${personaName()} handed off: ${data.title || 'Background task'}`, 'info');
    markEvent('handoff started');
    return;
  }

  if (type === 'call:handoff.task_created' && data.sessionId === state.sessionId) {
    state.lastTaskId = data.taskId || data.task?.id || '';
    setStatus('task_running', `Astra/OpenClaw has the task now. ${personaName()} is watching the board.`);
    handleTaskUpdate(data.task || { id: state.lastTaskId, title: data.title, status: 'queued' });
    markEvent('task created');
    return;
  }

  if (type === 'call:handoff.progress' && data.sessionId === state.sessionId) {
    state.lastTaskId = data.taskId || state.lastTaskId;
    setStatus('task_running', `${personaName()} is tracking the live task.`);
    showOverlay(`${escapeHtml(data.title || 'Background task')} · working${data.summary ? `<br>${escapeHtml(data.summary)}` : ''}`, 'tool', 4200);
    markEvent('handoff progress');
    return;
  }

  if (type === 'call:handoff.failed' && data.sessionId === state.sessionId) {
    markError(data.message || `${personaName()} handoff failed`);
    showOverlay(escapeHtml(data.message || `${personaName()} handoff failed`), 'error', 9000);
    setStatus('error', data.message || `${personaName()} handoff failed`);
    renderHandoff(`<strong>Handoff failed:</strong> ${escapeHtml(data.message || 'Unknown error')}`, 'error');
    return;
  }

  if (type === 'call:error' && (!state.sessionId || data.sessionId === state.sessionId)) {
    markError(data.message || `${personaName()} Live error`);
    showOverlay(escapeHtml(data.message || `${personaName()} Live error`), 'error', 9000);
    setStatus('error', data.message || `${personaName()} Live error`);
    return;
  }

  if (type === 'call:assistant.interrupted' && data.sessionId === state.sessionId) {
    stopPlayback();
    commitPendingAssistantText('interrupted');
    showOverlay('Interrupted.', 'tool', 1200);
    setStatus('listening', `Go on. ${personaName()} is listening.`);
    markEvent('interrupt ack');
    return;
  }

  if (type === 'live_task:update') handleTaskUpdate(data);
}
