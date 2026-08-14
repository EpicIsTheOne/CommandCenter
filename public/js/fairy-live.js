const BASE = window.__BASE_PATH__ || '';
const INPUT_SAMPLE_RATE = 16000;
const AUDIO_CHUNK_SAMPLES = 3200; // 200ms at 16kHz
const VAD_HANGOVER_MS = 640;
const VAD_MIN_SPEECH_MS = 140;
const VAD_NOISE_LEARN_MS = 1700;
const VAD_MIN_RMS_START = 0.014;
const VAD_MIN_RMS_END = 0.0075;
const VAD_MIN_PEAK_START = 0.048;
const VAD_START_CONFIRM_MS = 90;
const VAD_NOISE_UPDATE_MAX = 0.028;
const VAD_INTERRUPT_RMS = 0.034;
const VAD_INTERRUPT_PEAK = 0.12;
const VAD_INTERRUPT_CONFIRM_MS = 260;
const VAD_INTERRUPT_MIN_SPEECH_MS = 220;

const state = {
  sessionId: '',
  status: 'idle',
  statusMessage: '',
  model: '',
  hasApiKey: false,
  lastTaskId: '',
  tasks: new Map(),
  micActive: false,
  micMuted: false,
  micRecovering: false,
  micRecoveryTimer: null,
  micRecoveryInFlight: false,
  micCaptureGeneration: 0,
  micUploadFailureCount: 0,
  micLastUploadFailureAt: 0,
  micEnvironmentListenersBound: false,
  micStream: null,
  micContext: null,
  micSource: null,
  micProcessor: null,
  vad: null,
  pcmQueue: [],
  audioPostChain: Promise.resolve(),
  audioUploadController: null,
  playbackContext: null,
  playbackNextTime: 0,
  playbackSources: new Set(),
  playbackGeneration: 0,
  playbackActive: false,
  fishPlaybackAudio: null,
  fishPlaybackUrl: '',
  fishSpeakController: null,
  fishSpeakTimer: null,
  lastFishSpeakSignature: '',
  lastFishSpeakAt: 0,
  screenActive: false,
  screenStream: null,
  screenVideo: null,
  screenCanvas: null,
  screenTimer: null,
  screenPostChain: Promise.resolve(),
  screenChangeLastSample: null,
  screenChangeLastAt: 0,
  screenFrameId: 0,
  screenStabilizeTimer: null,
  screenBurstTimers: [],
  cameraActive: false,
  cameraStream: null,
  cameraVideo: null,
  cameraPreview: null,
  cameraCanvas: null,
  cameraTimer: null,
  cameraPostChain: Promise.resolve(),
  cameraFrameId: 0,
  cameraFacingMode: 'environment',
  lastEvent: 'none',
  lastError: '',
  overlayTimer: null,
  interrupting: false,
  lastInterruptAt: 0,
  personaName: 'Fairy',
  speechOutputMode: 'gemini',
  fishVoiceId: '',
  callMode: 'universal',
  liveIntentOverride: '',
  intensityLevel: 'low',
  speechSuppressedReason: '',
  lastModeDecision: '',
  lastModeReason: '',
  lastCalloutTier: '',
  handoffPolicy: 'normal',
  modeProactivity: '',
  modeResponseStyle: '',
  transcriptEntries: [],
  pendingAssistantText: '',
  imageCard: null,
  imageHideTimer: null,
  debugPanelOpen: false,
  lastScreenChange: null,
  lastGeminiHint: '',
  lastGeminiHintAt: '',
  lastVisualAssumption: '',
  lastVisualConfidence: '',
  lastRoutingDecision: '',
  lastTaskSummary: '',
  serverSessionMeta: null,
  visualMemory: null,
  screenUploadFailures: 0,
  cameraUploadFailures: 0,
  recordingActive: false,
  recordingSaving: false,
  recordingNotes: '',
  recordingStartedAt: '',
  recordingEndedAt: '',
  recordingRecorder: null,
  recordingChunks: [],
  recordingStream: null,
  recordingVideoTrack: null,
  recordingMixContext: null,
  recordingMixDestination: null,
  recordingPlaybackDestination: null,
  recordingMicSource: null,
  recordingPlaybackSource: null,
  endingAfterRecording: false,
  callEnding: false,
  lastEndedSessionId: '',
};

const els = {};

const DIAGNOSTICS_RENDER_INTERVAL_MS = 250;
let diagnosticsRenderTimer = null;
let diagnosticsRenderFrame = 0;
let diagnosticsRenderQueued = false;
let lastDiagnosticsRenderAt = 0;


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

function describeCallMode(mode = 'universal') {
  const value = String(mode || 'universal').trim().toLowerCase();
  if (value === 'gaming') return 'Gaming mode trims chatter during intense gameplay and favors short copilot callouts.';
  if (value === 'observe') return 'Observe mode stays quiet unless something meaningful changes.';
  if (value === 'assist') return 'Assist mode stays helpful and brief, then backs off when the moment gets busy.';
  if (value === 'guide') return 'Guide mode is more proactive and step-by-step.';
  if (value === 'operator') return 'Operator mode routes real work more aggressively.';
  if (value === 'record') return 'Record mode favors concise review-friendly notes and cleaner transition-focused commentary.';
  return 'Universal mode keeps normal Fairy behavior.';
}

function describeLiveIntentOverride(intent = '') {
  const value = String(intent || '').trim().toLowerCase();
  if (value === 'just_watch') return 'Just Watch: stay especially quiet unless something clearly important happens.';
  if (value === 'quiet') return 'Quiet: still helpful, but less chatty and more defer-heavy.';
  if (value === 'guide_me') return 'Guide Me: be more proactive and step-by-step right now.';
  if (value === 'operator_now') return 'Operator Now: bias harder toward routing and execution-ready summaries.';
  if (value === 'narrate') return 'Narrate: allow more observational commentary for demos, streams, or active walkthroughs.';
  return 'Normal: follow the selected call mode with no temporary override.';
}

function applyLiveIntentUi() {
  if (els.intentOverrideSelect) {
    els.intentOverrideSelect.value = state.liveIntentOverride || '';
    els.intentOverrideSelect.disabled = !state.sessionId;
  }
  if (els.intentOverrideStatus) els.intentOverrideStatus.textContent = describeLiveIntentOverride(state.liveIntentOverride || '');
}

function applyCallModeUi() {
  if (els.callModeSelect) {
    els.callModeSelect.value = state.callMode || 'universal';
    els.callModeSelect.disabled = !state.sessionId;
  }
  if (els.callModeStatus) els.callModeStatus.textContent = describeCallMode(state.callMode || 'universal');
  applyLiveIntentUi();
}

function applyPersonaUi() {
  if (els.launch && !isSessionActive()) els.launch.textContent = callButtonLabel();
  const kicker = document.getElementById('fairy-live-kicker');
  if (kicker) kicker.textContent = livePanelLabel();
  if (els.panel) els.panel.setAttribute('aria-label', livePanelLabel());
  if (els.text) els.text.placeholder = `Test a ${personaName()} turn…`;
}

function emitLog(message, tone = 'info') {
  try { console.log(`[FairyLive:${tone}] ${message}`); } catch (_) {}
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

function formatDebugValue(value, fallback = '—') {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  return String(value);
}

function renderDebugSection(title, rows = []) {
  const body = rows.map(([key, value]) => `
    <div class="fairy-live-debug-key">${escapeHtml(key)}</div>
    <div class="fairy-live-debug-value">${escapeHtml(formatDebugValue(value))}</div>
  `).join('');
  return `
    <div class="fairy-live-debug-section">
      <div class="fairy-live-debug-title">${escapeHtml(title)}</div>
      <div class="fairy-live-debug-grid">${body}</div>
    </div>
  `;
}

function renderDebugPanel() {
  if (!els.debugPanel || !els.debugContent || !els.debugToggle) return;
  setHidden(els.debugPanel, !state.debugPanelOpen);
  els.debugToggle.setAttribute('aria-expanded', state.debugPanelOpen ? 'true' : 'false');
  els.debugToggle.textContent = state.debugPanelOpen ? 'DEBUG ON' : 'DEBUG';
  if (!state.debugPanelOpen) return;

  const screenMeta = state.serverSessionMeta?.lastScreenFrameMeta || {};
  const cameraMeta = state.serverSessionMeta?.lastCameraFrameMeta || {};
  const screenChange = state.lastScreenChange || state.serverSessionMeta?.lastScreenChange || {};
  const visualMemory = state.visualMemory || state.serverSessionMeta?.visualMemory || {};
  const recentVisual = Array.isArray(visualMemory?.recent) && visualMemory.recent[0] ? visualMemory.recent[0] : null;

  els.debugContent.innerHTML = [
    renderDebugSection('SESSION', [
      ['session', state.sessionId || 'none'],
      ['status', state.status || 'idle'],
      ['model', state.model || 'unknown'],
      ['persona', personaName()],
      ['playback', state.playbackActive],
      ['interrupting', state.interrupting],
      ['last interrupt', state.lastInterruptAt ? new Date(state.lastInterruptAt).toISOString() : '—'],
    ]),
    renderDebugSection('MODE', [
      ['mode', state.callMode || 'universal'],
      ['live intent', state.liveIntentOverride || 'normal'],
      ['intensity', state.intensityLevel || 'low'],
      ['suppressed', state.speechSuppressedReason || 'none'],
      ['callout tier', state.lastCalloutTier || '—'],
      ['handoff policy', state.handoffPolicy || 'normal'],
      ['proactivity', state.modeProactivity || '—'],
      ['response style', state.modeResponseStyle || '—'],
      ['decision', state.lastModeDecision || '—'],
      ['reason', state.lastModeReason || '—'],
    ]),
    renderDebugSection('AUDIO / VAD', [
      ['mic active', state.micActive],
      ['mic muted', state.micMuted],
      ['mic recovering', state.micRecovering],
      ['upload failures', state.micUploadFailureCount],
      ['last upload failure', state.micLastUploadFailureAt ? new Date(state.micLastUploadFailureAt).toISOString() : '—'],
      ['vad speaking', !!state.vad?.speaking],
      ['rms', state.vad ? state.vad.lastRms.toFixed(3) : '—'],
      ['peak', state.vad ? state.vad.lastPeak.toFixed(3) : '—'],
      ['noise floor', state.vad ? state.vad.noiseFloor.toFixed(3) : '—'],
      ['speech ms', state.vad?.speechMs ?? '—'],
      ['silence ms', state.vad?.silenceMs ?? '—'],
      ['speech candidate', state.vad?.speechCandidateMs ?? '—'],
      ['interrupt candidate', state.vad?.interruptCandidateMs ?? '—'],
    ]),
    renderDebugSection('SCREEN', [
      ['active', state.screenActive],
      ['frame id', state.screenFrameId || screenMeta.frameId || '—'],
      ['last frame at', state.serverSessionMeta?.lastScreenFrameAt || '—'],
      ['reason', screenMeta.reason || '—'],
      ['stable', screenMeta.stable === true ? 'true' : 'false'],
      ['size', screenMeta.videoWidth && screenMeta.videoHeight ? `${screenMeta.videoWidth}x${screenMeta.videoHeight}` : '—'],
      ['surface', screenMeta.displaySurface || '—'],
      ['track', screenMeta.trackLabel || '—'],
      ['change diff', screenChange.avgDiff ?? '—'],
      ['change ratio', screenChange.changedRatio ?? '—'],
    ]),
    renderDebugSection('CAMERA', [
      ['active', state.cameraActive],
      ['frame id', state.cameraFrameId || cameraMeta.frameId || '—'],
      ['last frame at', state.serverSessionMeta?.lastCameraFrameAt || '—'],
      ['reason', cameraMeta.reason || '—'],
      ['size', cameraMeta.videoWidth && cameraMeta.videoHeight ? `${cameraMeta.videoWidth}x${cameraMeta.videoHeight}` : '—'],
      ['track', cameraMeta.trackLabel || '—'],
    ]),
    renderDebugSection('VISUAL / HINTS', [
      ['last hint at', state.lastGeminiHintAt || '—'],
      ['last hint', state.lastGeminiHint ? state.lastGeminiHint.slice(0, 180) : '—'],
      ['assumption', state.lastVisualAssumption || '—'],
      ['confidence', state.lastVisualConfidence || '—'],
      ['vm current', visualMemory?.current?.summary || '—'],
      ['vm current confidence', visualMemory?.current?.confidence || '—'],
      ['vm recent', recentVisual?.summary || '—'],
      ['vm recent confidence', recentVisual?.confidence || '—'],
      ['vm stable at', visualMemory?.lastStableScreenFrameAt || '—'],
      ['vm change', visualMemory?.lastChangeSummary || '—'],
    ]),
    renderDebugSection('TASK / ROUTING', [
      ['last task', state.lastTaskId || '—'],
      ['routing', state.lastRoutingDecision || '—'],
      ['task summary', state.lastTaskSummary || '—'],
      ['transcript entries', state.transcriptEntries.length],
    ]),
  ].join('');
}

function renderDiagnosticsNow() {
  const html = `
    <div><strong>Key:</strong> ${state.hasApiKey ? 'configured' : 'missing'}</div>
    <div><strong>Session:</strong> ${state.sessionId ? state.sessionId.slice(0, 18) + '…' : 'none'}</div>
    <div><strong>Mic:</strong> ${state.micActive ? (state.micMuted ? 'muted' : 'live') : 'off'} · <strong>VAD:</strong> ${state.vad?.speaking ? 'speech' : 'idle'} · <strong>Screen:</strong> ${state.screenActive ? 'live' : 'off'} · <strong>Camera:</strong> ${state.cameraActive ? 'live' : 'off'}</div>
    ${state.micActive && state.vad ? `<div><strong>VAD level:</strong> rms ${state.vad.lastRms.toFixed(3)} · noise ${state.vad.noiseFloor.toFixed(3)} · peak ${state.vad.lastPeak.toFixed(3)}</div>` : ''}
    <div><strong>Last:</strong> ${escapeHtml(state.lastEvent || 'none')}</div>
    ${state.lastError ? `<div class="fairy-diag-error"><strong>Error:</strong> ${escapeHtml(state.lastError)}</div>` : ''}
  `;
  if (els.diagnostics) els.diagnostics.innerHTML = html;
  renderDebugPanel();
}

function renderDiagnostics({ immediate = false } = {}) {
  if (immediate) {
    diagnosticsRenderQueued = false;
    if (diagnosticsRenderTimer) clearTimeout(diagnosticsRenderTimer);
    if (diagnosticsRenderFrame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(diagnosticsRenderFrame);
    diagnosticsRenderTimer = null;
    diagnosticsRenderFrame = 0;
    lastDiagnosticsRenderAt = performance.now();
    renderDiagnosticsNow();
    return;
  }
  if (diagnosticsRenderQueued) return;
  diagnosticsRenderQueued = true;
  const elapsed = performance.now() - lastDiagnosticsRenderAt;
  const delay = Math.max(0, DIAGNOSTICS_RENDER_INTERVAL_MS - elapsed);
  const flush = () => {
    diagnosticsRenderQueued = false;
    diagnosticsRenderTimer = null;
    diagnosticsRenderFrame = 0;
    lastDiagnosticsRenderAt = performance.now();
    renderDiagnosticsNow();
  };
  if (delay <= 16 && typeof requestAnimationFrame === 'function') {
    diagnosticsRenderFrame = requestAnimationFrame(flush);
  } else {
    diagnosticsRenderTimer = setTimeout(flush, delay);
  }
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
    els.headerMic.disabled = !state.sessionId || state.micRecovering;
    els.headerMic.textContent = state.micRecovering ? 'MIC RECOVERING…' : state.micActive ? (state.micMuted ? 'MIC MUTED' : 'MIC LIVE') : 'MIC OFF';
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
  setStatus('thinking', `${personaName()} is deciding whether to answer or hand this to an agent…`);
  await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'transcript.final', text: value }),
  });
  return { ok: true, sessionId: state.sessionId };
}

function updateMicUi() {
  if (els.mic) {
    els.mic.disabled = !state.sessionId || state.micRecovering;
    els.mic.textContent = state.micRecovering ? 'MIC RECOVERING…' : state.micActive ? (state.micMuted ? 'MIC MUTED' : 'MIC LIVE') : 'START MIC';
    els.mic.classList.toggle('active', state.micActive && !state.micMuted);
    els.mic.classList.toggle('muted', state.micActive && state.micMuted);
  }
  if (els.audioStatus) {
    els.audioStatus.textContent = state.micRecovering
      ? 'Mic capture hiccupped. Keeping the call alive and reconnecting the microphone…'
      : state.micActive
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
  const nextStatus = status || 'idle';
  const nextMessage = String(message || '');
  const statusChanged = state.status !== nextStatus;
  const messageChanged = !!nextMessage && state.statusMessage !== nextMessage;
  state.status = nextStatus;
  if (nextMessage) state.statusMessage = nextMessage;
  if (!statusChanged && !messageChanged) return;
  if (els.state) {
    els.state.className = `fairy-live-state state-${state.status}`;
    els.state.textContent = state.status.replace(/_/g, ' ').toUpperCase();
  }
  if (els.status && nextMessage) els.status.textContent = nextMessage;
  if (els.start) els.start.disabled = ['connecting', 'ready', 'listening', 'thinking', 'speaking', 'handing_off', 'task_running'].includes(state.status);
  if (els.end) els.end.disabled = !state.sessionId || ['idle', 'ended'].includes(state.status);
  updateLaunchUi();
  updateHeaderCallControls();
  updateMicUi();
  updateScreenUi();
  emitDirectChatSync('status', { message: nextMessage });
  window.dispatchEvent(new CustomEvent('commandcenter:fairy-status', {
    detail: {
      sessionId: state.sessionId,
      active: isSessionActive(),
      status: state.status,
      message: nextMessage,
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

function fishSpeakDelayForText(text = '', done = false) {
  if (done) return 70;
  const value = String(text || '').trim();
  if (!value) return 650;
  if (/[.!?…]["')\]]?$/.test(value)) return 420;
  if (value.length >= 180) return 520;
  return 700;
}

function scheduleFishSpeak(text, reason = 'done', delayMs = 650) {
  const message = String(text || '').trim();
  emitLog(`scheduleFishSpeak called (${reason}) len=${message.length} mode=${state.speechOutputMode} delay=${delayMs}`, 'info');
  if (!message || state.speechOutputMode !== 'fish') return;
  if (state.fishSpeakTimer) clearTimeout(state.fishSpeakTimer);
  state.fishSpeakTimer = setTimeout(() => {
    state.fishSpeakTimer = null;
    const latest = String(state.pendingAssistantText || message).trim();
    const committed = commitPendingAssistantText(`fish-${reason}`) || latest;
    emitLog(`scheduleFishSpeak firing (${reason}) committed=${committed.length}`, 'info');
    if (state.fishPlaybackAudio && !state.fishPlaybackAudio.ended && !state.fishPlaybackAudio.paused) {
      emitLog('Skipping late Fish update because playback is already active', 'info');
      return;
    }
    playFairyFishResponse(committed).catch((err) => {
      markError(err.message || `${personaName()} Fish voice playback failed`);
      setStatus('error', err.message || `${personaName()} Fish voice playback failed`);
    });
  }, Math.max(0, Number(delayMs) || 0));
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
    speechCandidateMs: 0,
    interruptCandidateMs: 0,
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
  const startThreshold = Math.max(VAD_MIN_RMS_START, vad.noiseFloor * 3.25);
  const speechCandidate = rms >= startThreshold || (rms >= endThreshold && peak >= VAD_MIN_PEAK_START);
  const continuingSpeech = rms >= endThreshold || peak >= VAD_MIN_PEAK_START;

  if (!vad.speaking && !speechCandidate) {
    vad.speechCandidateMs = 0;
    if ((learningNoise || rms < Math.max(VAD_MIN_RMS_START, vad.noiseFloor * 2.5)) && rms <= VAD_NOISE_UPDATE_MAX) {
      vad.noiseFloor = (vad.noiseFloor * 0.95) + (rms * 0.05);
    }
    rememberVadPreroll(vad, samples, durationMs);
    renderDiagnostics();
    return;
  }

  if (!vad.speaking && speechCandidate) {
    vad.speechCandidateMs += durationMs;
    if (vad.speechCandidateMs < VAD_START_CONFIRM_MS) {
      renderDiagnostics();
      return;
    }
    vad.speaking = true;
    vad.speechMs = 0;
    vad.silenceMs = 0;
    vad.speechCandidateMs = 0;
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
  const vad = state.vad || (state.vad = createVadState());
  const floor = vad.noiseFloor || 0.006;
  const rmsThreshold = Math.max(VAD_INTERRUPT_RMS, floor * 6.2);
  const candidate = rms >= rmsThreshold
    && peak >= VAD_INTERRUPT_PEAK
    && vad.speaking
    && Number(vad.speechMs || 0) >= VAD_INTERRUPT_MIN_SPEECH_MS;
  if (!candidate) {
    vad.interruptCandidateMs = 0;
    return false;
  }
  vad.interruptCandidateMs += samplesDurationMs(samples);
  return vad.interruptCandidateMs >= VAD_INTERRUPT_CONFIRM_MS;
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
    .then(async () => {
      if (state.sessionId !== sessionId || !state.micActive) return null;
      const controller = new AbortController();
      state.audioUploadController = controller;
      try {
        const result = await fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/audio`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pcm16Base64, mimeType: `audio/pcm;rate=${INPUT_SAMPLE_RATE}` }),
          signal: controller.signal,
        });
        if (state.sessionId === sessionId) state.micUploadFailureCount = 0;
        return result;
      } finally {
        if (state.audioUploadController === controller) state.audioUploadController = null;
      }
    })
    .catch((err) => {
      if (err?.name === 'AbortError') return;
      if (state.sessionId === sessionId && state.micActive && !state.callEnding) {
        state.micUploadFailureCount += 1;
        state.micLastUploadFailureAt = Date.now();
        if (state.micUploadFailureCount === 1 || state.micUploadFailureCount % 10 === 0) {
          emitLog(`Mic audio upload hiccup #${state.micUploadFailureCount}; keeping capture alive`, 'warn');
          markEvent('mic upload hiccup');
          if (state.micUploadFailureCount === 1) showOverlay('Mic connection hiccup. Capture is still live.', 'tool', 1800);
        }
        renderDiagnostics();
      }
    });
}

function supportsStreamingAudioMime(mime = '') {
  const value = String(mime || '').toLowerCase();
  return value.includes('mpeg') || value.includes('mp3') || value.includes('aac') || value.includes('mp4') || value.includes('webm') || value.includes('ogg');
}

async function playStreamedFetchAudioResponse(res, { controller } = {}) {
  const mime = (res.headers.get('content-type') || 'audio/mpeg').split(';')[0] || 'audio/mpeg';
  if (!res.body || !supportsStreamingAudioMime(mime) || typeof MediaSource === 'undefined') return null;

  const mediaSource = new MediaSource();
  const audioUrl = URL.createObjectURL(mediaSource);
  const audio = new Audio(audioUrl);
  state.fishPlaybackAudio = audio;
  state.fishPlaybackUrl = audioUrl;
  state.playbackActive = true;

  return await new Promise((resolve, reject) => {
    let finished = false;
    let reader = null;
    const chunks = [];
    let appending = false;
    let sourceBuffer = null;
    let startedPlayback = false;

    const detachAudio = () => {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio.removeAttribute('src');
      audio.load?.();
      if (state.fishPlaybackAudio === audio) state.fishPlaybackAudio = null;
      if (state.fishPlaybackUrl === audioUrl) state.fishPlaybackUrl = '';
      if (state.fishSpeakController === controller) state.fishSpeakController = null;
      try { if (mediaSource.readyState === 'open') mediaSource.endOfStream(); } catch (_) {}
      URL.revokeObjectURL(audioUrl);
    };

    const cleanup = (completed) => {
      if (finished) return;
      finished = true;
      reader?.cancel?.().catch(() => {});
      detachAudio();
      state.playbackActive = false;
      emitFairyCallAudioEvent('commandcenter:voice-playback-stop', { source: 'fairy-live', sessionId: state.sessionId, fairy: true, completed });
      resolve(completed);
    };

    const fail = (err) => {
      if (finished) return;
      finished = true;
      reader?.cancel?.().catch(() => {});
      detachAudio();
      state.playbackActive = false;
      reject(err);
    };

    const pumpAppend = () => {
      if (!sourceBuffer || sourceBuffer.updating || appending || !chunks.length || finished) return;
      appending = true;
      const chunk = chunks.shift();
      try {
        sourceBuffer.appendBuffer(chunk);
      } catch (err) {
        fail(err);
      } finally {
        appending = false;
      }
    };

    mediaSource.addEventListener('sourceopen', async () => {
      try {
        sourceBuffer = mediaSource.addSourceBuffer(mime);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', () => {
          pumpAppend();
          if (!startedPlayback && audio.readyState >= 2) {
            startedPlayback = true;
            audio.play().catch(fail);
          }
          if (reader === null && !chunks.length && !sourceBuffer.updating && mediaSource.readyState === 'open') {
            try { mediaSource.endOfStream(); } catch (_) {}
          }
        });

        reader = res.body.getReader();
        emitFairyCallAudioEvent('commandcenter:voice-playback-start', { source: 'fairy-live', sessionId: state.sessionId, fairy: true, fish: true });
        while (!controller?.signal?.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) {
            chunks.push(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
            pumpAppend();
            if (!startedPlayback && audio.paused && chunks.length >= 1) {
              startedPlayback = true;
              audio.play().catch(() => {});
            }
          }
        }
        reader = null;
        if (!chunks.length && !sourceBuffer.updating && mediaSource.readyState === 'open') {
          try { mediaSource.endOfStream(); } catch (_) {}
        }
      } catch (err) {
        fail(err);
      }
    }, { once: true });

    audio.onended = () => cleanup(true);
    audio.onerror = () => fail(new Error('Streaming audio playback failed'));
    controller?.signal?.addEventListener('abort', () => cleanup(false), { once: true });
  });
}

async function ensurePlaybackContext() {
  if (!state.playbackContext) {
    state.playbackContext = new (window.AudioContext || window.webkitAudioContext)();
    state.playbackNextTime = state.playbackContext.currentTime;
    state.recordingPlaybackDestination = state.playbackContext.createMediaStreamDestination();
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
  if (state.recordingPlaybackDestination) source.connect(state.recordingPlaybackDestination);
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
  if (state.fishSpeakTimer) {
    clearTimeout(state.fishSpeakTimer);
    state.fishSpeakTimer = null;
  }
  if (state.fishSpeakController) {
    try { state.fishSpeakController.abort(); } catch (_) {}
    state.fishSpeakController = null;
  }
  if (state.fishPlaybackAudio) {
    try {
      state.fishPlaybackAudio.onended = null;
      state.fishPlaybackAudio.onerror = null;
      state.fishPlaybackAudio.pause();
      state.fishPlaybackAudio.currentTime = 0;
      state.fishPlaybackAudio.src = '';
      state.fishPlaybackAudio.load?.();
    } catch (_) {}
    state.fishPlaybackAudio = null;
  }
  if (state.fishPlaybackUrl) {
    try { URL.revokeObjectURL(state.fishPlaybackUrl); } catch (_) {}
    state.fishPlaybackUrl = '';
  }
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

async function playFairyFishResponse(text) {
  const message = String(text || '').trim();
  if (!state.sessionId || !message) return false;
  const signature = `${state.sessionId}::${message}`;
  const now = Date.now();
  if (signature === state.lastFishSpeakSignature && (now - state.lastFishSpeakAt) < 5000) {
    emitLog('Skipping duplicate Fish voice request', 'info');
    return false;
  }
  state.lastFishSpeakSignature = signature;
  state.lastFishSpeakAt = now;
  stopPlayback();
  emitLog(`Requesting Fish voice for ${message.length} chars`, 'info');
  markEvent('fish voice requested');
  const controller = new AbortController();
  state.fishSpeakController = controller;
  try {
    const res = await fetch(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/fairy-speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message }),
      signal: controller.signal,
    });
    if (!res.ok) {
      let errorText = 'Fairy Fish voice playback failed';
      try {
        const payload = await res.json();
        errorText = payload.error || errorText;
      } catch (_) {}
      throw new Error(errorText);
    }

    const ttsMode = (res.headers.get('x-tts-mode') || 'full').toLowerCase();
    emitLog(`Fish voice response received (${ttsMode})`, 'info');
    markEvent(`fish audio response (${ttsMode})`);

    // Fairy Fish playback prefers the simpler full-buffer path for reliability.
    // The streaming MediaSource path works for some browsers/codecs but is easier to fail silently.
    const audioBlob = await res.blob();
    emitLog(`Fish audio buffered (${Math.round(Number(audioBlob.size || 0) / 1024)} KB)`, 'info');
    if (controller.signal.aborted) return false;
    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.volume = 1.0;
    const ctx = await ensurePlaybackContext();
    let mediaSource = null;
    try {
      mediaSource = ctx.createMediaElementSource(audio);
      mediaSource.connect(ctx.destination);
      if (state.recordingPlaybackDestination) mediaSource.connect(state.recordingPlaybackDestination);
    } catch (_) {}
    state.fishPlaybackAudio = audio;
    state.fishPlaybackUrl = audioUrl;
    state.playbackActive = true;

    return await new Promise((resolve) => {
      let finished = false;
      const cleanup = (completed) => {
        if (finished) return;
        finished = true;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = '';
        audio.load?.();
        if (state.fishPlaybackAudio === audio) state.fishPlaybackAudio = null;
        if (state.fishPlaybackUrl === audioUrl) state.fishPlaybackUrl = '';
        if (state.fishSpeakController === controller) state.fishSpeakController = null;
        try { URL.revokeObjectURL(audioUrl); } catch (_) {}
        state.playbackActive = false;
        emitFairyCallAudioEvent('commandcenter:voice-playback-stop', { source: 'fairy-live', sessionId: state.sessionId, fairy: true, fish: true, completed });
        notifyPlaybackFinishedSoon();
        resolve(completed);
      };

      audio.onended = () => {
        emitLog('Fish audio playback ended', 'info');
        cleanup(true);
      };
      audio.onerror = () => {
        emitLog('Fish audio playback error', 'error');
        cleanup(false);
      };
      controller.signal.addEventListener('abort', () => cleanup(false), { once: true });
      audio.play().then(() => {
        emitLog('Fish audio playback started', 'info');
        markEvent('fish audio playback started');
        emitFairyCallAudioEvent('commandcenter:voice-playback-start', { source: 'fairy-live', sessionId: state.sessionId, fairy: true, fish: true });
      }).catch((err) => {
        emitLog(`Fish audio play() failed: ${err?.message || 'unknown error'}`, 'error');
        markError(err?.message || 'Fish audio play failed');
        cleanup(false);
      });
    });
  } finally {
    if (state.fishSpeakController === controller && controller.signal.aborted) state.fishSpeakController = null;
  }
}

function isMicCaptureHealthy() {
  const track = state.micStream?.getAudioTracks?.()?.[0];
  return !!track
    && track.readyState !== 'ended'
    && !!state.micContext
    && state.micContext.state !== 'closed'
    && !!state.micSource
    && !!state.micProcessor;
}

function isCurrentMicCapture(stream, generation, sessionId) {
  return state.sessionId === sessionId
    && state.micStream === stream
    && state.micCaptureGeneration === generation;
}

async function resumeMicContext(reason = 'resume') {
  const ctx = state.micContext;
  if (!state.sessionId || !state.micActive || state.micMuted || !ctx || ctx.state === 'closed') return false;
  if (ctx.state === 'running') return true;
  try {
    await ctx.resume();
    if (ctx.state === 'running') {
      emitLog(`Mic audio context resumed (${reason})`, 'info');
      markEvent('mic audio resumed');
      return true;
    }
  } catch (err) {
    emitLog(`Mic audio context resume deferred (${reason}): ${err?.message || 'browser did not resume it'}`, 'warn');
  }
  return false;
}

function bindMicCaptureLifecycle(stream, ctx, generation, sessionId) {
  const current = () => isCurrentMicCapture(stream, generation, sessionId) && !state.callEnding;
  const track = stream?.getAudioTracks?.()?.[0];
  if (track) {
    track.addEventListener?.('ended', () => {
      if (!current() || state.micMuted) return;
      emitLog('Microphone track ended unexpectedly; keeping the call alive and reconnecting', 'warn');
      markEvent('mic track ended; recovering');
      scheduleMicRecovery('microphone track ended');
    });
    track.addEventListener?.('mute', () => {
      if (!current()) return;
      emitLog('Microphone track temporarily muted by the browser or device', 'warn');
      markEvent('mic track temporarily muted');
    });
    track.addEventListener?.('unmute', () => {
      if (!current()) return;
      emitLog('Microphone track resumed', 'info');
      markEvent('mic track resumed');
    });
  }
  ctx.addEventListener?.('statechange', () => {
    if (!current()) return;
    if (ctx.state === 'closed') {
      scheduleMicRecovery('microphone audio context closed');
      return;
    }
    if (ctx.state === 'suspended' || ctx.state === 'interrupted') {
      resumeMicContext(`context:${ctx.state}`).then((resumed) => {
        if (!resumed && document.visibilityState === 'visible') markEvent('mic audio resume pending');
      }).catch(() => {});
    }
  });
}

async function teardownMicCapture({ flush = true, clearMute = true } = {}) {
  if (flush) flushPcmQueue();
  else state.pcmQueue = [];
  state.micActive = false;
  if (!flush) {
    try { state.audioUploadController?.abort?.(); } catch (_) {}
    state.audioUploadController = null;
  }
  // Invalidate track/context callbacks before stopping the underlying devices.
  state.micCaptureGeneration += 1;
  const processor = state.micProcessor;
  const source = state.micSource;
  const context = state.micContext;
  const stream = state.micStream;
  try { processor?.disconnect(); } catch (_) {}
  try { source?.disconnect(); } catch (_) {}
  try { await context?.close?.(); } catch (_) {}
  try { stream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  state.micStream = null;
  state.micContext = null;
  state.micSource = null;
  state.micProcessor = null;
  state.pcmQueue = [];
  state.vad = null;
  if (clearMute) state.micMuted = false;
}

async function recoverMicCapture(reason = 'capture lost') {
  if (!state.sessionId || state.callEnding || state.micMuted || state.micRecoveryInFlight) return false;
  const sessionId = state.sessionId;
  state.micRecoveryInFlight = true;
  state.micRecovering = true;
  updateMicUi();
  try {
    await teardownMicCapture({ flush: false, clearMute: false });
    if (state.sessionId !== sessionId || state.callEnding) return false;
    const started = await startMic({ recovering: true });
    if (!started) throw new Error('Microphone capture could not be reacquired');
    state.micUploadFailureCount = 0;
    emitLog(`Microphone recovered after ${reason}`, 'info');
    markEvent('mic recovered');
    return true;
  } catch (err) {
    if (state.sessionId === sessionId && !state.callEnding) {
      emitLog(`Microphone recovery failed: ${err?.message || 'unknown error'}`, 'error');
      markError(err?.message || 'Microphone recovery failed');
      showOverlay('Mic reconnect failed. Click MIC to retry.', 'error', 4500);
    }
    return false;
  } finally {
    state.micRecoveryInFlight = false;
    state.micRecovering = false;
    updateMicUi();
  }
}

function scheduleMicRecovery(reason = 'capture lost') {
  if (!state.sessionId || state.callEnding || state.micMuted || state.micRecoveryTimer || state.micRecoveryInFlight) return;
  state.micRecovering = true;
  updateMicUi();
  state.micRecoveryTimer = setTimeout(() => {
    state.micRecoveryTimer = null;
    recoverMicCapture(reason).catch(() => {});
  }, 260);
}

function handleMicEnvironmentChange(reason = 'environment changed') {
  if (!state.sessionId || !state.micActive || state.micMuted || state.callEnding) return;
  if (!isMicCaptureHealthy()) {
    scheduleMicRecovery(reason);
    return;
  }
  resumeMicContext(reason).catch(() => {});
}

async function startMic({ recovering = false } = {}) {
  if (!state.sessionId) {
    setStatus('idle', 'Start Fairy Live before opening the mic. Obviously.');
    return false;
  }
  if (state.micRecovering && !recovering) return false;
  if (state.micActive && !recovering) {
    state.micMuted = !state.micMuted;
    if (!state.micMuted && !isMicCaptureHealthy()) {
      scheduleMicRecovery('mic unmuted after capture loss');
    } else if (!state.micMuted) {
      resumeMicContext('mic unmuted').catch(() => {});
    }
    updateMicUi();
    setStatus(state.micMuted ? 'ready' : 'listening', state.micMuted ? 'Mic muted.' : 'Mic streaming to Fairy.');
    return true;
  }

  let stream = null;
  let ctx = null;
  let source = null;
  let processor = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    await ctx.resume();
    state.vad = createVadState();
    state.pcmQueue = [];
    source = ctx.createMediaStreamSource(stream);
    processor = ctx.createScriptProcessor(4096, 1, 1);
    processor.onaudioprocess = (event) => {
      if (!state.micActive || state.micMuted || !state.sessionId) return;
      const input = event.inputBuffer.getChannelData(0);
      queuePcmSamples(resampleToInt16(input, ctx.sampleRate, INPUT_SAMPLE_RATE));
    };
    source.connect(processor);
    processor.connect(ctx.destination);

    const generation = state.micCaptureGeneration + 1;
    state.micCaptureGeneration = generation;
    state.micStream = stream;
    state.micContext = ctx;
    state.micSource = source;
    state.micProcessor = processor;
    state.micActive = true;
    state.micMuted = false;
    state.micUploadFailureCount = 0;
    bindMicCaptureLifecycle(stream, ctx, generation, state.sessionId);
    updateMicUi();
    setStatus('listening', 'Mic is live. Fairy can hear you now, which is probably legally dangerous.');
    appendTranscript('system', recovering ? 'Mic streaming recovered.' : 'Mic streaming started.', 'audio');
    emitLog(recovering ? 'Mic streaming recovered' : 'Mic streaming started', 'info');
    markEvent(recovering ? 'mic recovered' : 'mic started');
    return true;
  } catch (err) {
    try { processor?.disconnect(); } catch (_) {}
    try { source?.disconnect(); } catch (_) {}
    try { await ctx?.close?.(); } catch (_) {}
    try { stream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
    state.micActive = false;
    state.micStream = null;
    state.micContext = null;
    state.micSource = null;
    state.micProcessor = null;
    state.vad = null;
    updateMicUi();
    setStatus('error', err.message || 'Microphone permission denied');
    return false;
  }
}

async function stopMic({ flush = true } = {}) {
  if (state.micRecoveryTimer) clearTimeout(state.micRecoveryTimer);
  state.micRecoveryTimer = null;
  state.micRecovering = false;
  await teardownMicCapture({ flush, clearMute: true });
  updateMicUi();
  if (state.sessionId) {
    emitLog('Mic stopped', 'info');
    markEvent('mic stopped');
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function nextAnimationFrame(timeoutMs = 120) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const timer = setTimeout(finish, Math.max(16, Number(timeoutMs) || 120));
    try {
      requestAnimationFrame(() => {
        clearTimeout(timer);
        finish();
      });
    } catch (_) {
      clearTimeout(timer);
      setTimeout(finish, 16);
    }
  });
}

async function waitForVideoReady(video, timeoutMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (video?.readyState >= 2 && video.videoWidth && video.videoHeight) return true;
    await wait(80);
  }
  return !!(video?.videoWidth && video?.videoHeight);
}

function getTrackMeta(stream) {
  const track = stream?.getVideoTracks?.()[0] || null;
  const settings = typeof track?.getSettings === 'function' ? track.getSettings() : {};
  return {
    displaySurface: settings?.displaySurface || '',
    logicalSurface: settings?.logicalSurface ?? null,
    cursor: settings?.cursor || '',
    trackLabel: track?.label || '',
  };
}

function compactFrameMeta(kind, video, extra = {}) {
  const stream = kind === 'camera' ? state.cameraStream : state.screenStream;
  const frameId = kind === 'camera' ? (state.cameraFrameId += 1) : (state.screenFrameId += 1);
  return {
    source: kind,
    frameId,
    capturedAt: new Date().toISOString(),
    videoWidth: video?.videoWidth || 0,
    videoHeight: video?.videoHeight || 0,
    ...getTrackMeta(stream),
    ...extra,
  };
}

function postVisualFrame(kind, jpegBase64, frameMeta = {}) {
  if (!state.sessionId || !jpegBase64) return Promise.resolve(null);
  const sessionId = state.sessionId;
  const endpoint = kind === 'camera' ? 'camera' : 'screen';
  const chainKey = kind === 'camera' ? 'cameraPostChain' : 'screenPostChain';
  const failureKey = kind === 'camera' ? 'cameraUploadFailures' : 'screenUploadFailures';
  state[chainKey] = state[chainKey]
    .catch(() => {})
    .then(() => fetchJson(`${BASE}/api/call/${encodeURIComponent(sessionId)}/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jpegBase64, mimeType: 'image/jpeg', frameMeta }),
    }))
    .then((result) => {
      state[failureKey] = 0;
      return result;
    })
    .catch((err) => {
      const stillActive = kind === 'camera' ? state.cameraActive : state.screenActive;
      if (state.sessionId === sessionId && stillActive) {
        state[failureKey] = Number(state[failureKey] || 0) + 1;
        const label = kind === 'camera' ? 'Camera' : 'Screen';
        const count = state[failureKey];
        const message = err.message || `${label} frame upload failed`;
        markEvent(`${label.toLowerCase()} upload hiccup #${count}`);
        if (count <= 2) {
          setStatus(state.playbackActive ? 'speaking' : (state.status === 'thinking' ? 'thinking' : 'ready'), `${label} share hit a brief upload hiccup. Retrying automatically.`);
        } else if (count <= 5) {
          setStatus('error', `${label} frame uplink is unstable (${count} failed attempts). Retrying without stopping the share.`);
        }
        console.warn(`[fairy-live] ${label} frame upload failed (#${count})`, message, frameMeta);
      }
      return null;
    });
  return state[chainKey];
}

function postScreenFrame(jpegBase64, frameMeta = {}) {
  return postVisualFrame('screen', jpegBase64, frameMeta);
}

function postCameraFrame(jpegBase64, frameMeta = {}) {
  return postVisualFrame('camera', jpegBase64, frameMeta);
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
  if (!video || !state.screenCanvas) return null;
  const signature = sampleVisualSignature(video, state.screenCanvas);
  if (!signature) return null;
  const previous = state.screenChangeLastSample;
  state.screenChangeLastSample = signature;
  if (!previous) return null;

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
  if (!significant) return null;
  if (now - state.screenChangeLastAt < 8000) return null;
  state.screenChangeLastAt = now;
  return {
    avgDiff: Number(avgDiff.toFixed(1)),
    changedRatio: Number(changedRatio.toFixed(3)),
  };
}

function sendScreenChangedEvent(change, frameMeta = {}) {
  if (!state.sessionId || !change) return;
  fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'screen.changed',
      avgDiff: change.avgDiff,
      changedRatio: change.changedRatio,
      frameMeta,
    }),
  }).catch(() => {});
}

function clearScreenStabilizers() {
  if (state.screenStabilizeTimer) clearTimeout(state.screenStabilizeTimer);
  state.screenStabilizeTimer = null;
  state.screenBurstTimers.forEach((timer) => clearTimeout(timer));
  state.screenBurstTimers = [];
}

function scheduleScreenBurst(reason = 'post-change-burst') {
  state.screenBurstTimers.forEach((timer) => clearTimeout(timer));
  state.screenBurstTimers = [1700, 2800].map((delayMs) => setTimeout(() => {
    if (state.screenActive) captureScreenFrame({ reason, stable: true, notifyChange: false });
  }, delayMs));
}

function scheduleStableScreenChange(change) {
  if (!change) return;
  if (state.screenStabilizeTimer) clearTimeout(state.screenStabilizeTimer);
  markEvent(`screen changed (${Math.round(change.avgDiff)} / ${Math.round(change.changedRatio * 100)}%)`);
  state.screenStabilizeTimer = setTimeout(async () => {
    state.screenStabilizeTimer = null;
    if (!state.screenActive || !state.sessionId || !state.screenVideo || !state.screenCanvas) return;
    await waitForVideoReady(state.screenVideo, 1200);
    await nextAnimationFrame(90);
    await wait(60);
    const jpegBase64 = captureVisualFrame(state.screenVideo, state.screenCanvas, { quality: 0.68 });
    if (!jpegBase64) return;
    const frameMeta = compactFrameMeta('screen', state.screenVideo, {
      reason: 'screen-change-stable',
      stable: true,
      avgDiff: change.avgDiff,
      changedRatio: change.changedRatio,
    });
    postScreenFrame(jpegBase64, frameMeta)
      .then((result) => { if (result) sendScreenChangedEvent(change, frameMeta); })
      .catch(() => {});
    scheduleScreenBurst();
  }, 950);
}

function captureScreenFrame({ reason = 'interval', stable = true, notifyChange = true } = {}) {
  if (!state.screenActive || !state.sessionId || !state.screenVideo || !state.screenCanvas) return;
  const change = notifyChange ? detectMeaningfulScreenChange(state.screenVideo) : null;
  if (change) {
    scheduleStableScreenChange(change);
    return;
  }
  const jpegBase64 = captureVisualFrame(state.screenVideo, state.screenCanvas, { quality: 0.68 });
  if (!jpegBase64) return;
  postScreenFrame(jpegBase64, compactFrameMeta('screen', state.screenVideo, { reason, stable }));
}

function captureCameraFrame() {
  if (!state.cameraActive || !state.sessionId || !state.cameraVideo || !state.cameraCanvas) return;
  const jpegBase64 = captureVisualFrame(state.cameraVideo, state.cameraCanvas, { quality: 0.72 });
  if (!jpegBase64) return;
  postCameraFrame(jpegBase64, compactFrameMeta('camera', state.cameraVideo, { reason: 'interval', stable: true }));
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

function preferredRecordingMimeType() {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm;codecs=h264,opus',
    'video/webm',
  ];
  return candidates.find((value) => window.MediaRecorder?.isTypeSupported?.(value)) || 'video/webm';
}

async function buildRecordingStream() {
  if (!state.screenStream?.getVideoTracks?.()?.length) throw new Error('Screen sharing must be active before recording can start.');
  await ensurePlaybackContext();
  const mixCtx = new (window.AudioContext || window.webkitAudioContext)();
  const mixDest = mixCtx.createMediaStreamDestination();
  const videoTrack = state.screenStream.getVideoTracks()[0];
  if (!videoTrack) throw new Error('No screen video track available for recording.');
  if (state.micStream?.getAudioTracks?.()?.length) {
    const micSource = mixCtx.createMediaStreamSource(state.micStream);
    micSource.connect(mixDest);
    state.recordingMicSource = micSource;
  }
  if (state.recordingPlaybackDestination?.stream?.getAudioTracks?.()?.length) {
    const playbackSource = mixCtx.createMediaStreamSource(state.recordingPlaybackDestination.stream);
    playbackSource.connect(mixDest);
    state.recordingPlaybackSource = playbackSource;
  }
  const out = new MediaStream([videoTrack.clone(), ...mixDest.stream.getAudioTracks()]);
  state.recordingMixContext = mixCtx;
  state.recordingMixDestination = mixDest;
  state.recordingStream = out;
  state.recordingVideoTrack = videoTrack;
  return out;
}

async function uploadSavedRecording(blob, { reason = 'manual-stop' } = {}) {
  if (!state.sessionId || !blob) return null;
  const form = new FormData();
  form.append('video', blob, `fairy-recording-${Date.now()}.webm`);
  form.append('mimeType', blob.type || 'video/webm');
  form.append('startedAt', state.recordingStartedAt || '');
  form.append('endedAt', state.recordingEndedAt || new Date().toISOString());
  form.append('durationMs', String(Math.max(0, Date.now() - new Date(state.recordingStartedAt || Date.now()).getTime())));
  form.append('includeMic', String(!!state.micStream?.getAudioTracks?.()?.length));
  form.append('includeFairy', String(true));
  form.append('notes', state.recordingNotes || reason || '');
  const res = await fetch(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/recording`, { method: 'POST', body: form });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Could not save Fairy recording');
  return data.record;
}

async function stopScreenRecording({ reason = 'manual-stop', keepStateForEnd = false } = {}) {
  if (!state.recordingActive || !state.recordingRecorder) return null;
  state.recordingSaving = true;
  state.recordingEndedAt = new Date().toISOString();
  const recorder = state.recordingRecorder;
  const stream = state.recordingStream;
  const mixCtx = state.recordingMixContext;
  const chunksRef = state.recordingChunks;
  await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'recording.stopped', reason }),
  }).catch(() => {});
  const blob = await new Promise((resolve) => {
    recorder.onstop = () => resolve(new Blob(chunksRef, { type: recorder.mimeType || 'video/webm' }));
    try { if (recorder.state !== 'inactive') recorder.stop(); else resolve(new Blob(chunksRef, { type: recorder.mimeType || 'video/webm' })); } catch (_) { resolve(new Blob(chunksRef, { type: recorder.mimeType || 'video/webm' })); }
  });
  try { stream?.getTracks?.().forEach((track) => track.stop()); } catch (_) {}
  try { await mixCtx?.close?.(); } catch (_) {}
  let saved = null;
  try {
    saved = await uploadSavedRecording(blob, { reason });
    if (saved?.downloadUrl) showOverlay('Fairy recording saved.', 'info', 2800);
  } finally {
    if (!keepStateForEnd) state.recordingActive = false;
    state.recordingSaving = false;
    state.recordingRecorder = null;
    state.recordingChunks = [];
    state.recordingStream = null;
    state.recordingMixContext = null;
    state.recordingMixDestination = null;
    state.recordingMicSource = null;
    state.recordingPlaybackSource = null;
  }
  return saved;
}

async function startScreenRecording(notes = '') {
  if (!state.sessionId) throw new Error('Start Fairy Live before recording.');
  if (!state.screenActive || !state.screenStream) throw new Error('Screen sharing must be active before recording can start.');
  if (state.recordingActive) return false;
  const stream = await buildRecordingStream();
  const chunks = [];
  const recorder = new MediaRecorder(stream, { mimeType: preferredRecordingMimeType() });
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.start(1000);
  state.recordingActive = true;
  state.recordingNotes = String(notes || '').trim().slice(0, 240);
  state.recordingStartedAt = new Date().toISOString();
  state.recordingEndedAt = '';
  state.recordingRecorder = recorder;
  state.recordingChunks = chunks;
  await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'recording.started', startedAt: state.recordingStartedAt }),
  }).catch(() => {});
  appendTranscript('system', 'Fairy started recording the shared screen.', 'recording');
  emitLog('Screen recording started', 'info');
  markEvent('recording started');
  showOverlay('Fairy is recording this screen.', 'tool', 2600);
  return true;
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
    state.screenFrameId = 0;
    state.screenUploadFailures = 0;
    clearScreenStabilizers();
    state.screenActive = true;
    stream.getVideoTracks().forEach((track) => {
      track.onended = () => stopScreenShare().catch(() => {});
    });
    await waitForVideoReady(video, 2500);
    await nextAnimationFrame(90);
    await wait(120);
    await wait(700);
    if (!state.screenActive || state.screenVideo !== video) return;
    captureScreenFrame({ reason: 'initial-stable', stable: true, notifyChange: false });
    fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'screen.started', frameMeta: compactFrameMeta('screen', video, { reason: 'screen-started', stable: true }) }),
    }).catch(() => {});
    state.screenTimer = setInterval(() => captureScreenFrame({ reason: 'interval', stable: true }), 1500);
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
  if (state.recordingActive) {
    try { await stopScreenRecording({ reason: 'screen-share-stopped' }); } catch (_) {}
  }
  if (state.screenTimer) clearInterval(state.screenTimer);
  state.screenTimer = null;
  clearScreenStabilizers();
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
  state.screenFrameId = 0;
  state.screenUploadFailures = 0;
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
    state.cameraFrameId = 0;
    state.cameraUploadFailures = 0;
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
  state.cameraFrameId = 0;
  state.cameraUploadFailures = 0;
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
    state.speechOutputMode = String(config.speechOutputMode || 'gemini').trim().toLowerCase() === 'fish' ? 'fish' : 'gemini';
    state.fishVoiceId = String(config.fishVoiceId || '').trim();
    state.callMode = String(config.callMode || 'universal').trim().toLowerCase() || 'universal';
    applyPersonaUi();
    applyCallModeUi();
    if (els.model) {
      els.model.textContent = state.hasApiKey
        ? `${state.model} · mode:${state.callMode} · ${Array.isArray(config.responseModalities) ? config.responseModalities.join('+') : 'LIVE'} · voice:${state.speechOutputMode === 'fish' ? 'fish' : 'gemini'}`
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
    state.callEnding = false;
    state.lastEndedSessionId = '';
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
  if (!state.sessionId || state.callEnding) return;
  const id = state.sessionId;
  state.callEnding = true;
  try {
    if (state.recordingActive) {
      try { await stopScreenRecording({ reason: 'call-ended' }); } catch (_) {}
    }
    await stopMic({ flush: false });
    await stopScreenShare();
    stopPlayback();
    state.interrupting = false;
    await fetchJson(`${BASE}/api/call/${encodeURIComponent(id)}/end`, { method: 'POST' });
    state.lastEndedSessionId = id;
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
  } finally {
    state.callEnding = false;
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
  setStatus('thinking', `${personaName()} is deciding whether to answer or hand this to an agent…`);
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

function taskRuntimeLabel(task = {}) {
  const runtime = String(task.runtime || '').trim().toLowerCase();
  if (runtime === 'relay') {
    const provider = String(task.relayProviderLabel || task.relayProviderId || '').trim();
    const device = String(task.relayDeviceName || task.relayDeviceId || '').trim();
    return `${provider || 'Relay agent'}${device ? ` on ${device}` : ''}`;
  }
  return runtime === 'hermes' ? 'Hermes' : 'Astra/OpenClaw';
}

function handleTaskUpdate(task) {
  if (!task?.id) return;
  state.tasks.set(task.id, task);
  state.lastTaskSummary = String(task.summary || task.result || task.error || '').trim();
  const runtimeLabel = taskRuntimeLabel(task);
  if (state.lastTaskId && state.lastTaskId === task.id) {
    renderHandoff(`
      <strong>Handed to ${escapeHtml(runtimeLabel)}:</strong> ${escapeHtml(task.title || task.id)}<br>
      <span>Status: ${escapeHtml(task.status || 'queued')}</span><br>
      <span>${escapeHtml(task.summary || '')}</span>
    `, task.status === 'failed' ? 'error' : task.status === 'completed' ? 'done' : '');
    const overlayTone = task.status === 'failed' ? 'error' : task.status === 'completed' ? 'done' : 'info';
    const overlayDuration = task.status === 'working' ? 4200 : 9000;
    showOverlay(`${escapeHtml(task.title || task.id)} · ${escapeHtml(task.status || 'queued')}${task.summary ? `<br>${escapeHtml(task.summary)}` : ''}`, overlayTone, overlayDuration);
    if (task.status === 'working') {
      setStatus('task_running', `${runtimeLabel} is actively working. ${personaName()} is tracking it.`);
      markEvent('task working');
      return;
    }
    if (['completed', 'failed', 'needs_input'].includes(task.status)) {
      appendTranscript(task.status === 'failed' ? 'error' : 'system', task.summary || `Task ${task.status}`, `task:${task.status}`);
      if (state.status === 'task_running') setStatus('ready', `Task update received. ${personaName()} is ready for the next bit of chaos.`);
    }
  }
  renderDiagnostics();
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
  els.callModeSelect = document.getElementById('fairy-live-call-mode');
  els.callModeStatus = document.getElementById('fairy-live-call-mode-status');
  els.intentOverrideSelect = document.getElementById('fairy-live-intent-override');
  els.intentOverrideStatus = document.getElementById('fairy-live-intent-status');
  els.debugToggle = document.getElementById('fairy-live-debug-toggle');
  els.debugPanel = document.getElementById('fairy-live-debug-panel');
  els.debugContent = document.getElementById('fairy-live-debug-content');
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
  els.callModeSelect?.addEventListener('change', async (event) => {
    const nextMode = String(event.target?.value || 'universal').trim().toLowerCase() || 'universal';
    if (!state.sessionId) { applyCallModeUi(); return; }
    try {
      const data = await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/mode`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callMode: nextMode }),
      });
      state.callMode = String(data.callMode || nextMode).trim().toLowerCase() || 'universal';
      state.serverSessionMeta = data.session || state.serverSessionMeta;
      markEvent(`mode ${state.callMode}`);
      applyCallModeUi();
      renderDiagnostics();
    } catch (err) {
      markError(err.message || 'Could not update call mode');
      applyCallModeUi();
    }
  });

  els.intentOverrideSelect?.addEventListener('change', async (event) => {
    const nextIntent = String(event.target?.value || '').trim().toLowerCase();
    if (!state.sessionId) { applyLiveIntentUi(); return; }
    try {
      const data = await fetchJson(`${BASE}/api/call/${encodeURIComponent(state.sessionId)}/intent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intentOverride: nextIntent }),
      });
      state.liveIntentOverride = String(data.liveIntentOverride || '').trim().toLowerCase();
      state.serverSessionMeta = data.session || state.serverSessionMeta;
      markEvent(`intent ${state.liveIntentOverride || 'normal'}`);
      applyLiveIntentUi();
      renderDiagnostics();
    } catch (err) {
      markError(err.message || 'Could not update live intent override');
      applyLiveIntentUi();
    }
  });

  els.debugToggle?.addEventListener('click', (event) => {
    event.stopPropagation();
    state.debugPanelOpen = !state.debugPanelOpen;
    try { localStorage.setItem('fairyDebugPanelOpen', state.debugPanelOpen ? '1' : '0'); } catch (_) {}
    renderDebugPanel();
  });
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

  if (!state.micEnvironmentListenersBound) {
    state.micEnvironmentListenersBound = true;
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') handleMicEnvironmentChange('page visible');
    });
    window.addEventListener('focus', () => handleMicEnvironmentChange('window focused'));
    navigator.mediaDevices?.addEventListener?.('devicechange', () => handleMicEnvironmentChange('audio device changed'));
  }

  try { state.debugPanelOpen = localStorage.getItem('fairyDebugPanelOpen') === '1'; } catch (_) {}
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
    if (data.session) state.serverSessionMeta = data.session;
    state.callMode = String(data.callMode || data.session?.callMode || state.callMode || 'universal').trim().toLowerCase() || 'universal';
    state.liveIntentOverride = String(data.liveIntentOverride || data.session?.liveIntentOverride || state.liveIntentOverride || '').trim().toLowerCase();
    applyCallModeUi();
    setStatus(data.state || 'ready', `${personaName()} is live.`);
    appendTranscript('system', `Session ready: ${state.sessionId}`, 'system');
    emitLog(`${personaName()} session ready: ${state.sessionId}`, 'info');
    showOverlay(`${personaName()} is listening.`, 'info', 2200);
    markEvent('session ready');
    return;
  }

  if (type === 'call:session.ended') {
    const endedId = String(data.id || data.sessionId || '').trim();
    if (state.callEnding || (endedId && endedId === state.lastEndedSessionId)) return;
    if (!state.sessionId || data.id === state.sessionId || data.sessionId === state.sessionId) {
      if (endedId) state.lastEndedSessionId = endedId;
      stopMic({ flush: false }).catch(() => {});
      stopScreenShare().catch(() => {});
      stopCameraShare().catch(() => {});
      stopPlayback();
      commitPendingAssistantText('session-ended');
      state.interrupting = false;
      state.sessionId = '';
      state.serverSessionMeta = null;
      state.visualMemory = null;
      state.intensityLevel = 'low';
      state.speechSuppressedReason = '';
      state.lastModeDecision = '';
      state.lastModeReason = '';
      state.lastCalloutTier = '';
      state.liveIntentOverride = '';
      applyCallModeUi();
      setStatus('ended', `${personaName()} Live ended.`);
      emitFairyCallAudioEvent('commandcenter:fairy-call-end', { sessionId: data.id || data.sessionId || state.sessionId });
      emitLog(`${personaName()} Live ended`, 'info');
      showOverlay('', 'info', 0);
      markEvent('call ended');
    }
    return;
  }

  if (type === 'call:session.state' && (!state.sessionId || data.sessionId === state.sessionId)) {
    if (data.session) state.serverSessionMeta = data.session;
    setStatus(data.state || 'ready');
    return;
  }

  if (type === 'call:debug.state' && data.sessionId === state.sessionId) {
    const debug = data.debug || {};
    state.serverSessionMeta = debug;
    state.lastScreenChange = debug.lastScreenChange || state.lastScreenChange;
    state.lastGeminiHint = String(debug.lastGeminiHint || '').trim();
    state.lastGeminiHintAt = String(debug.lastGeminiHintAt || '').trim();
    state.lastVisualAssumption = String(debug.lastVisualAssumption || '').trim();
    state.lastVisualConfidence = String(debug.lastVisualConfidence || '').trim();
    state.callMode = String(debug.callMode || state.callMode || 'universal').trim().toLowerCase() || 'universal';
    state.liveIntentOverride = String(debug.liveIntentOverride || state.liveIntentOverride || '').trim().toLowerCase();
    state.intensityLevel = String(debug.intensityLevel || state.intensityLevel || 'low').trim() || 'low';
    state.speechSuppressedReason = String(debug.speechSuppressedReason || '').trim();
    state.lastModeDecision = String(debug.modeDecision || '').trim();
    state.lastModeReason = String(debug.modeReason || '').trim();
    state.lastCalloutTier = String(debug.lastCalloutTier || '').trim();
    state.handoffPolicy = String(debug.handoffPolicy || '').trim() || state.handoffPolicy;
    state.modeProactivity = String(debug.proactivity || '').trim();
    state.modeResponseStyle = String(debug.responseStyle || '').trim();
    state.lastRoutingDecision = String(debug.lastRoutingDecision || '').trim();
    state.lastTaskSummary = String(debug.lastTaskSummary || state.lastTaskSummary || '').trim();
    state.visualMemory = debug.visualMemory || null;
    applyCallModeUi();
    renderDiagnostics();
    return;
  }

  if (type === 'call:mode.updated' && data.sessionId === state.sessionId) {
    state.callMode = String(data.callMode || data.session?.callMode || state.callMode || 'universal').trim().toLowerCase() || 'universal';
    state.liveIntentOverride = String(data.liveIntentOverride || data.session?.liveIntentOverride || state.liveIntentOverride || '').trim().toLowerCase();
    if (data.session) state.serverSessionMeta = data.session;
    applyCallModeUi();
    renderDiagnostics();
    return;
  }

  if (type === 'call:intent.updated' && data.sessionId === state.sessionId) {
    state.liveIntentOverride = String(data.liveIntentOverride || data.session?.liveIntentOverride || '').trim().toLowerCase();
    if (data.session) state.serverSessionMeta = data.session;
    applyLiveIntentUi();
    renderDiagnostics();
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
    if (rawText) {
      const currentTrimmed = String(state.pendingAssistantText || '').trim();
      const shouldReplaceOnDone = !!data.done && currentTrimmed && rawText === currentTrimmed;
      state.pendingAssistantText = shouldReplaceOnDone ? rawText : mergeAssistantChunk(state.pendingAssistantText, rawText);
    }
    const displayText = String(state.pendingAssistantText || rawText || '').trim();
    const tier = String(state.lastCalloutTier || '').trim();
    const suppressed = String(state.speechSuppressedReason || '').trim();
    const tone = /confirmed from the web|web check says|checked the web/i.test(displayText) ? 'tool' : tier === '1' ? 'error' : 'fairy';
    showOverlay(escapeHtml(displayText), tone, tier === '1' ? 9500 : 8500);
    markEvent(`response text${tier ? ` tier ${tier}` : ''}`);
    setStatus(data.state || (data.done ? 'speaking' : 'thinking'), suppressed ? `${personaName()} timed this for a calmer window.` : (displayText || `${personaName()} responded.`));
    if (data.taskId) state.lastTaskId = data.taskId;
    if (state.speechOutputMode === 'fish' && displayText) {
      scheduleFishSpeak(displayText, data.done ? 'response-text-done' : 'response-text-stream', fishSpeakDelayForText(displayText, !!data.done));
    } else if (data.done) {
      commitPendingAssistantText('done');
    }
    return;
  }

  if (type === 'call:response.audio' && data.sessionId === state.sessionId) {
    if (state.speechOutputMode === 'fish') {
      if (!state.interrupting) setStatus(data.state || 'speaking', `${personaName()} is speaking through Fish Audio…`);
      markEvent('response audio skipped (fish mode)');
      if (data.done) {
        const fishText = String(state.pendingAssistantText || data.text || '').trim();
        if (fishText) {
          scheduleFishSpeak(fishText, 'response-audio', 70);
        } else {
          emitLog('Fish mode reached end-of-audio with no speakable text', 'error');
          markError('Fish mode had no final text to speak');
        }
      }
      return;
    }
    if (!state.interrupting) setStatus(data.state || 'speaking', `${personaName()} is speaking. Try not to look too impressed.`);
    if (data.text) showOverlay(escapeHtml(data.text), 'fairy', 8500);
    markEvent('response audio');
    playAudioChunk(data.pcm16Base64, data.mimeType, !!data.done).catch((err) => {
      markError(err.message || `${personaName()} audio playback failed`);
      setStatus('error', err.message || `${personaName()} audio playback failed`);
    });
    return;
  }

  if (type === 'call:recording.command' && data.sessionId === state.sessionId) {
    const action = String(data.action || '').trim();
    if (action === 'start') {
      startScreenRecording(String(data.notes || '').trim()).catch((err) => {
        markError(err.message || 'Could not start Fairy recording');
        setStatus('error', err.message || 'Could not start Fairy recording');
      });
      return;
    }
    if (action === 'stop') {
      stopScreenRecording({ reason: String(data.reason || 'tool-stop').trim() || 'tool-stop' }).catch((err) => {
        markError(err.message || 'Could not stop Fairy recording');
      });
      return;
    }
    if (action === 'prepare-end') {
      endCall().catch((err) => {
        markError(err.message || `Failed to end ${personaName()} Live`);
      });
      return;
    }
  }

  if (type === 'call:end.requested' && data.sessionId === state.sessionId) {
    endCall().catch((err) => {
      markError(err.message || `Failed to end ${personaName()} Live`);
    });
    return;
  }

  if (type === 'call:recording.saved' && data.sessionId === state.sessionId) {
    showOverlay('Fairy saved the recording.', 'tool', 3200);
    markEvent('recording saved');
    return;
  }

  if (type === 'call:screen.enabled' && data.sessionId === state.sessionId) {
    if (els.screenStatus) els.screenStatus.textContent = `Screen frame received by ${personaName()}.`;
    return;
  }

  if (type === 'call:screen.changed' && data.sessionId === state.sessionId) {
    const pct = Math.round(Number(data.changedRatio || 0) * 100);
    state.lastScreenChange = {
      avgDiff: Number(data.avgDiff || 0),
      changedRatio: Number(data.changedRatio || 0),
      at: new Date().toISOString(),
      frameMeta: data.frameMeta || null,
    };
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
    state.lastRoutingDecision = 'handoff-started';
    state.lastTaskSummary = String(data.summary || '').trim();
    const runtimeLabel = taskRuntimeLabel(data);
    setStatus('handing_off', `${personaName()} is handing that to ${runtimeLabel}…`);
    renderHandoff(`<strong>Routing to ${escapeHtml(runtimeLabel)}:</strong> ${escapeHtml(data.title || 'Background task')}<br><span>${escapeHtml(data.summary || '')}</span>`);
    showOverlay(`Routing to ${escapeHtml(runtimeLabel)}: ${escapeHtml(data.title || 'Background task')}${data.summary ? `<br>${escapeHtml(data.summary)}` : ''}`, 'tool', 9000);
    emitLog(`${personaName()} handed off: ${data.title || 'Background task'}`, 'info');
    markEvent('handoff started');
    return;
  }

  if (type === 'call:handoff.task_created' && data.sessionId === state.sessionId) {
    state.lastTaskId = data.taskId || data.task?.id || '';
    state.lastRoutingDecision = 'task-created';
    setStatus('task_running', `${taskRuntimeLabel(data.task || data)} has the task now. ${personaName()} is watching the board.`);
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
    state.lastRoutingDecision = `interrupted:${String(data.reason || 'user_speaking')}`;
    stopPlayback();
    commitPendingAssistantText('interrupted');
    showOverlay('Interrupted.', 'tool', 1200);
    setStatus('listening', `Go on. ${personaName()} is listening.`);
    markEvent('interrupt ack');
    return;
  }

  if (type === 'live_task:update') handleTaskUpdate(data);
}
