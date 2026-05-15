import * as terminal from './terminal.js?v=20260320j';
import * as mascot from './mascot.js?v=20260509y';
import * as office from './office.js?v=20260515-voicefix2';
import * as voice from './voice.js?v=20260515-voicefix2';
import * as wake from './wake.js?v=20260320l';
import * as directChat from './direct-chat.js?v=20260515-voicefix2';
import * as companions from './companions.js?v=20260515-voicefix2';
import * as music from './music.js?v=20260514c';
import * as intro from './intro.js?v=20260514b';
import * as appearance from './appearance.js?v=20260514b';
import * as branding from './branding.js?v=20260514b';
import * as layoutSettings from './layout-settings.js?v=20260514b';

const APP_BUILD = '20260513-folder-upload-debug-1';
console.log('[CommandCenter] app build:', APP_BUILD);

let roster = { agents: [], primaryAgentId: 'main' };
let activeOfficeAgent = null;
let ws = null;
let reconnectTimer = null;
let isFullscreen = false;
let playbackToken = 0;
let availableVoices = [];
let currentWakeSettings = { wakeWords: {} };
let currentCompanionSettings = { agentVisuals: {} };
let availableCompanions = [];
let wakeDesired = false;
let lastSpokenSignature = '';
let lastSpokenAt = 0;
let lastResponseSignature = '';
let lastResponseAt = 0;
const BASE = window.__BASE_PATH__ || '';
const VIGNETTE_STORAGE_KEY = 'commandcenter.vignetteStrength';
const VIGNETTE_DIRECTION_STORAGE_KEY = 'commandcenter.vignetteDirectionStrengths';
const DEFAULT_VIGNETTE_STRENGTH = 96;
const DEFAULT_VIGNETTE_DIRECTIONS = { top: 100, side: 100, bottom: 100 };
const BUILT_IN_WAKE_WORDS = ['Alexa','Americano','Blueberry','Bumblebee','Computer','Grapefruit','Grasshopper','Hey Google','Hey Siri','Jarvis','Okay Google','Picovoice','Porcupine','Terminator'];


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function setConnectionState(state, text) {
  const el = document.getElementById('connection-indicator');
  if (!el) return;
  el.className = `connection-state state-${state}`;
  el.textContent = text;
}

function setSettingsStatus(text, isError = false) {
  const el = document.getElementById('settings-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
}

function setSetupStatus(summary = '', issues = [], tone = 'ok', pillText = '') {
  const pill = document.getElementById('setup-status-pill');
  const summaryEl = document.getElementById('setup-status-summary');
  const list = document.getElementById('setup-issues-list');
  if (pill) {
    pill.className = `setup-status-pill ${tone}`.trim();
    pill.textContent = pillText || (tone === 'error' ? 'Needs Fixes' : tone === 'warn' ? 'Attention' : 'Ready');
  }
  if (summaryEl) summaryEl.textContent = summary || '';
  if (list) {
    list.innerHTML = '';
    (issues || []).forEach((issue) => {
      const item = document.createElement('li');
      item.textContent = issue.message || String(issue || '');
      list.appendChild(item);
    });
  }
}

function setSetupTestResult(summary = '', checks = [], tone = 'ok') {
  const status = document.getElementById('setup-test-status');
  const list = document.getElementById('setup-test-results');
  if (status) status.textContent = summary || '';
  if (list) {
    list.innerHTML = '';
    (checks || []).forEach((check) => {
      const item = document.createElement('li');
      item.textContent = check.message || String(check || '');
      list.appendChild(item);
    });
  }
  if (status) status.style.color = tone === 'error' ? 'var(--red)' : tone === 'warn' ? '#ffd479' : 'var(--text-dim)';
}

function clampVignetteStrength(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return DEFAULT_VIGNETTE_STRENGTH;
  return Math.min(220, Math.max(0, Math.round(num)));
}

function applyVignetteStrength(value) {
  const strength = clampVignetteStrength(value);
  document.documentElement.style.setProperty('--vignette-strength', String(strength / 100));
  document.documentElement.style.setProperty('--vignette-size', `${Math.max(0, strength - 100)}px`);
  const slider = document.getElementById('vignette-strength');
  const label = document.getElementById('vignette-strength-value');
  if (slider) slider.value = String(strength);
  if (label) label.textContent = `${strength}%`;
  return strength;
}

function loadVignetteStrength() {
  try {
    const raw = localStorage.getItem(VIGNETTE_STORAGE_KEY);
    return clampVignetteStrength(raw ?? DEFAULT_VIGNETTE_STRENGTH);
  } catch (_) {
    return DEFAULT_VIGNETTE_STRENGTH;
  }
}

function persistVignetteStrength(value) {
  const strength = clampVignetteStrength(value);
  try {
    localStorage.setItem(VIGNETTE_STORAGE_KEY, String(strength));
  } catch (_) {}
  return strength;
}

function clampDirectionalVignette(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 100;
  return Math.min(200, Math.max(0, Math.round(num)));
}

function applyDirectionalVignette(values = {}) {
  const top = clampDirectionalVignette(values.top ?? DEFAULT_VIGNETTE_DIRECTIONS.top);
  const side = clampDirectionalVignette(values.side ?? DEFAULT_VIGNETTE_DIRECTIONS.side);
  const bottom = clampDirectionalVignette(values.bottom ?? DEFAULT_VIGNETTE_DIRECTIONS.bottom);
  document.documentElement.style.setProperty('--vignette-top', String(top / 100));
  document.documentElement.style.setProperty('--vignette-side', String(side / 100));
  document.documentElement.style.setProperty('--vignette-bottom', String(bottom / 100));

  const topSlider = document.getElementById('vignette-top');
  const sideSlider = document.getElementById('vignette-side');
  const bottomSlider = document.getElementById('vignette-bottom');
  const topLabel = document.getElementById('vignette-top-value');
  const sideLabel = document.getElementById('vignette-side-value');
  const bottomLabel = document.getElementById('vignette-bottom-value');
  if (topSlider) topSlider.value = String(top);
  if (sideSlider) sideSlider.value = String(side);
  if (bottomSlider) bottomSlider.value = String(bottom);
  if (topLabel) topLabel.textContent = `${top}%`;
  if (sideLabel) sideLabel.textContent = `${side}%`;
  if (bottomLabel) bottomLabel.textContent = `${bottom}%`;

  return { top, side, bottom };
}

function loadDirectionalVignette() {
  try {
    const raw = localStorage.getItem(VIGNETTE_DIRECTION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return applyDirectionalVignette(parsed || {});
  } catch (_) {
    return applyDirectionalVignette(DEFAULT_VIGNETTE_DIRECTIONS);
  }
}

function persistDirectionalVignette(values = {}) {
  const normalized = {
    top: clampDirectionalVignette(values.top ?? DEFAULT_VIGNETTE_DIRECTIONS.top),
    side: clampDirectionalVignette(values.side ?? DEFAULT_VIGNETTE_DIRECTIONS.side),
    bottom: clampDirectionalVignette(values.bottom ?? DEFAULT_VIGNETTE_DIRECTIONS.bottom),
  };
  try {
    localStorage.setItem(VIGNETTE_DIRECTION_STORAGE_KEY, JSON.stringify(normalized));
  } catch (_) {}
  return normalized;
}

function playWakeChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(1320, ctx.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.08, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.18);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.2);
    osc.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function playProcessingChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(620, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(420, ctx.currentTime + 0.16);
    gain.gain.setValueAtTime(0.0001, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.07, ctx.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.22);
    osc.onended = () => ctx.close().catch(() => {});
  } catch (_) {}
}

function setWakeButtonState(state, detail = '') {
  const btn = document.getElementById('wake-mode-btn');
  if (!btn) return;
  const text = state === 'armed'
    ? 'WAKE MODE: ARMED'
    : state === 'arming'
      ? 'WAKE MODE: ARMING'
      : state === 'triggered'
        ? `WAKE MODE: ${String(detail || '').toUpperCase()}`
        : 'WAKE MODE: OFF';
  btn.textContent = text;
  btn.dataset.state = state;
}

const EVENT_TO_EMOTION = {
  'agent:idle': 'idle',
  'agent:listening': 'listening',
  'agent:thinking': 'thinking',
  'agent:tool_use': 'working',
  'agent:responding': 'happy',
  'agent:error': 'error',
};

const EVENT_TO_OFFICE_STATE = {
  'agent:idle': 'idle',
  'agent:listening': 'idle',
  'agent:thinking': 'thinking',
  'agent:tool_use': 'working',
  'agent:responding': 'talking',
  'agent:error': 'idle',
};

const EVENT_TO_LOG_TYPE = {
  'agent:listening': 'agent',
  'agent:thinking': 'agent',
  'agent:tool_use': 'tool',
  'agent:responding': 'agent',
  'agent:error': 'error',
};

function getPrimaryAgent() {
  return roster.primaryAgentId || roster.agents[0]?.id || 'main';
}

function getAgentLabel(agentId) {
  return roster.agents.find(a => a.id === agentId)?.label || agentId || 'main';
}

function normalizeSpeechText(text = '') {
  return String(text || '')
    .replace(/^\s*\[\[\s*reply_to[^\]]*\]\]\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      const snippet = text.replace(/\s+/g, ' ').trim().slice(0, 180);
      throw new Error(snippet || `Request failed (${res.status})`);
    }
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function loadSetupStatus() {
  try {
    const data = await fetchJson(`${BASE}/api/status`);
    const setup = data.setup || {};
    const bridge = data.bridge || {};
    const issues = Array.isArray(setup.issues) ? setup.issues : [];
    const hasError = issues.some((issue) => issue.level === 'error');
    const hasWarn = issues.some((issue) => issue.level === 'warn');
    const tone = hasError ? 'error' : hasWarn ? 'warn' : 'ok';
    const pillText = setup.demoMode
      ? 'Demo Mode'
      : bridge.mode === 'live'
        ? 'Live Connected'
        : bridge.mode === 'demo'
          ? 'Demo Fallback'
          : 'Connecting';
    const summary = `${setup.modeLabel || 'Unknown mode'} • STT: ${String(setup.sttMode || 'api').toUpperCase()}${setup.sttMode === 'api' ? ` → ${setup.sttProvider || 'fish'}` : ''} • TTS: ${setup.ttsProvider || 'elevenlabs'}${bridge.gatewayTokenSource ? ` • Gateway token: ${bridge.gatewayTokenSource}` : ''}`;
    setSetupStatus(summary, issues, tone, pillText);
    return data;
  } catch (err) {
    setSetupStatus('Could not load setup status from the server.', [{ message: err.message || 'Status request failed.' }], 'error', 'Status Error');
    return null;
  }
}

async function loadRoster() {
  try {
    const res = await fetch(`${BASE}/api/agents`);
    if (res.ok) {
      roster = await res.json();
      office.setRoster?.(roster);
      directChat.setRoster?.(roster);
    }
  } catch (_) {}
}

async function loadCompanionSettings() {
  try {
    const data = await fetchJson(`${BASE}/api/settings/companions`);
    currentCompanionSettings = data.settings || { agentVisuals: {} };
    availableCompanions = data.items || [];
    companions.setCompanionData({ visuals: data.resolved || {}, items: availableCompanions });
  } catch (_) {}
}

async function requestFullscreen() {
  if (isFullscreen) return;
  try {
    const el = document.documentElement;
    if (el.requestFullscreen) await el.requestFullscreen();
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen();
    isFullscreen = true;
  } catch (err) {
    console.log('[fullscreen] Request denied:', err.message);
  }
}

function bootSequence() {
  const lines = [
    ['[sys] OpenClaw Command Center v1.0', 'system'],
    ['[sys] Initializing display modules...', 'system'],
    ['[sys] Mascot renderer: OK', 'info'],
    [`[sys] Office renderer: OK (${roster.agents.length || 1} agents)`, 'info'],
    ['[sys] Terminal: OK', 'info'],
    [`[sys] Voice: tap mascot for ${getAgentLabel(getPrimaryAgent())}, tap any agent in office`, 'agent'],
    ['[sys] Wake mode: local whisper name detection', 'agent'],
    [`[sys] Agents: ${roster.agents.map(a => `${a.id}(${a.label})`).join(' | ') || 'main(Main)'}`, 'info'],
    ['[sys] Connecting to OpenClaw gateway...', 'system'],
  ];

  let i = 0;
  const step = () => {
    if (i >= lines.length) return;
    const [text, type] = lines[i++];
    terminal.log(text, type, true);
    setTimeout(step, 300 + Math.random() * 200);
  };
  step();
}

function connect() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}${BASE}/ws`);

  ws.onopen = () => {
    terminal.log('[ws] Connected to server', 'info');
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  };

  ws.onmessage = (event) => {
    try {
      handleEvent(JSON.parse(event.data));
    } catch (err) {
      console.error('Failed to parse message:', err);
    }
  };

  ws.onclose = () => {
    setConnectionState('disconnected', 'DISCONNECTED');
    terminal.log('[ws] Disconnected, reconnecting...', 'error');
    if (!reconnectTimer) {
      setConnectionState('connecting', 'RECONNECTING');
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, 2000);
    }
  };

  ws.onerror = () => {};
}


function isNoisyIdleEvent(type, data = {}) {
  if (type !== 'agent:idle') return false;
  const status = String(data?.status || data?.message || '').trim().toLowerCase();
  return !status || ['ready', 'awaiting tasks', 'standing by', 'all systems nominal'].includes(status);
}

async function handleEvent(msg) {
  const { type, data } = msg;

  if (isNoisyIdleEvent(type, data)) {
    if (data?.agent && activeOfficeAgent === data.agent) {
      office.setAgentHighlight(data.agent, false);
      activeOfficeAgent = null;
    }
    if (data?.agent) office.setAgentState(data.agent, 'idle', data);
    directChat.handleChatEvent(msg);
    return;
  }

  if (type === 'status' || type === 'bridge:connected') {
    const mode = String(data?.mode || 'unknown');
    setConnectionState(mode === 'demo' ? 'disconnected' : 'connected', mode === 'demo' ? 'DEMO MODE' : 'CONNECTED');
    if (data?.agents?.length) roster = { agents: data.agents, primaryAgentId: data.primaryAgentId || data.agents[0]?.id };
    terminal.log(`[bridge] Mode: ${mode}`, mode === 'demo' ? 'error' : 'system', true);
    if (mode === 'demo' && data?.fallbackReason) {
      terminal.log(`[bridge] Demo fallback reason: ${data.fallbackReason}`, 'error', true);
    }
    if (data?.authError) {
      terminal.log(`[bridge] Gateway auth error: ${data.authError}`, 'error', true);
    }
    loadSetupStatus().catch(() => {});
    return;
  }

  if (type === 'bridge:disconnected') {
    terminal.log('[bridge] Gateway disconnected', 'error');
    mascot.setEmotion('error');
    return;
  }

  if (type === 'voice:transcription') return;

  if (type === 'agent:responding' && data?.message) {
    const agentId = data.agent || getPrimaryAgent();
    const messageText = String(data.message || '').trim();
    const speechText = normalizeSpeechText(messageText);
    const signature = `${agentId}::${speechText}`;
    const now = Date.now();
    const fromDirectChat = !!data?.chat || data?.source === 'direct-chat';
    const isReplyTagMirror = /^\s*\[\[\s*reply_to[^\]]*\]\]/i.test(messageText);
    const isDuplicateResponseEvent = !!(speechText && signature === lastResponseSignature && (now - lastResponseAt) < 12000);
    const isDuplicateSpeech = !!(speechText && signature === lastSpokenSignature && (now - lastSpokenAt) < 4000);

    if (isReplyTagMirror && !fromDirectChat) {
      terminal.log('[voice] Ignoring mirrored reply-tag event', 'system', true);
      return;
    }

    if (isDuplicateResponseEvent) {
      terminal.log('[voice] Ignoring duplicate response event', 'system', true);
      return;
    }

    lastResponseSignature = signature;
    lastResponseAt = now;

    mascot.setEmotion('happy');
    terminal.log(formatLogEntry(type, data), 'agent', true);
    office.setAgentState(agentId, 'talking', data);
    directChat.handleChatEvent(msg);

    if (activeOfficeAgent === agentId) {
      office.setAgentHighlight(agentId, false);
      activeOfficeAgent = null;
    }

    if (!speechText) {
      mascot.setEmotion('idle');
      office.onTaskComplete(agentId);
      office.setAgentState(agentId, 'idle', {});
      rearmWakeMode();
      return;
    }

    if (isDuplicateSpeech) {
      terminal.log('[voice] Skipping duplicate response speech', 'system', true);
      mascot.setEmotion('idle');
      office.onTaskComplete(agentId);
      office.setAgentState(agentId, 'idle', {});
      rearmWakeMode();
      return;
    }

    lastSpokenSignature = signature;
    lastSpokenAt = now;

    const token = ++playbackToken;
    voice.stopPlayback();
    voice.playSpokenResponse(speechText, agentId).then(async (completed) => {
      if (token !== playbackToken) return;
      mascot.setEmotion('idle');
      office.onTaskComplete(agentId);
      office.setAgentState(agentId, 'idle', {});
      if (!completed) terminal.log('[voice] Playback stopped', 'system', true);
      await rearmWakeMode();
    });
    return;
  }

  const emotion = EVENT_TO_EMOTION[type];
  if (emotion) mascot.setEmotion(emotion);

  if (data?.agent && (type === 'agent:thinking' || type === 'agent:tool_use' || type === 'agent:responding')) {
    activeOfficeAgent = data.agent;
    office.setAgentHighlight(data.agent, true);
  }
  if (data?.agent && type === 'agent:idle' && activeOfficeAgent === data.agent) {
    office.setAgentHighlight(data.agent, false);
    activeOfficeAgent = null;
  }

  const officeState = EVENT_TO_OFFICE_STATE[type];
  if (officeState && data?.agent) {
    office.setAgentState(data.agent, officeState, data);
    companions.setCompanionState(data.agent, officeState === 'talking' ? 'responding' : officeState === 'working' ? 'tool' : officeState);
  }

  if (type === 'agent:tool_use' && data?.agent) {
    office.showTransientBubble(data.agent, formatToolBubble(data), {
      duration: 1000,
      color: '#7EE7FF',
      badge: getToolBubbleBadge(data.tool),
      badgeColor: getToolBubbleBadgeColor(data.tool),
    });
  }

  const logType = EVENT_TO_LOG_TYPE[type];
  if (logType) terminal.log(formatLogEntry(type, data), logType, true);

  // Pass events to direct chat
  directChat.handleChatEvent(msg);
}

function formatLogEntry(type, data) {
  const agent = data?.agent || '?';
  const shortType = type.split(':')[1] || type;
  switch (type) {
    case 'agent:tool_use':
      return `[${agent}] ${shortType}: ${data.tool || '?'}(${data.input || ''})`;
    case 'agent:responding':
      return `[${agent}] ${data.message || 'responding...'}`;
    case 'agent:error':
      return `[${agent}] ERROR: ${data.message || data.status || 'unknown'}`;
    default:
      return `[${agent}] ${data.status || shortType}`;
  }
}

function formatToolBubble(data = {}) {
  const tool = String(data.tool || 'tool').trim();
  const input = String(data.input || '').replace(/\s+/g, ' ').trim();
  if (!input) return `${tool}()`;
  return `${tool}(${input.length > 18 ? `${input.slice(0, 17)}…` : input})`;
}

function getToolBubbleBadge(tool = '') {
  const value = String(tool || '').toLowerCase();
  if (value.includes('web')) return 'WEB';
  if (value.includes('read') || value.includes('fetch')) return 'RD';
  if (value.includes('write') || value.includes('edit')) return 'WR';
  if (value.includes('exec') || value.includes('shell') || value.includes('bash')) return 'CMD';
  if (value.includes('search') || value.includes('grep')) return 'FND';
  if (value.includes('memory')) return 'MEM';
  if (value.includes('image') || value.includes('vision')) return 'IMG';
  if (value.includes('cron') || value.includes('schedule')) return 'CLK';
  return 'TL';
}

function getToolBubbleBadgeColor(tool = '') {
  const value = String(tool || '').toLowerCase();
  if (value.includes('web')) return '#7EE7FF';
  if (value.includes('read') || value.includes('fetch')) return '#9AE6B4';
  if (value.includes('write') || value.includes('edit')) return '#F6AD55';
  if (value.includes('exec') || value.includes('shell') || value.includes('bash')) return '#F56565';
  if (value.includes('search') || value.includes('grep')) return '#C084FC';
  if (value.includes('memory')) return '#63B3ED';
  if (value.includes('image') || value.includes('vision')) return '#F6E05E';
  if (value.includes('cron') || value.includes('schedule')) return '#FC8181';
  return '#7EE7FF';
}

function renderVoiceOptions(selectedValue = '') {
  const manualLabel = selectedValue && !availableVoices.some((v) => v.voice_id === selectedValue)
    ? `<option value="${selectedValue}" selected>${selectedValue} (manual)</option>`
    : '';
  return `
    <option value="">Default / blank</option>
    ${manualLabel}
    ${availableVoices.map((voice) => {
      const label = `${voice.name}${voice.category ? ` — ${voice.category}` : ''}`;
      const selected = voice.voice_id === selectedValue ? 'selected' : '';
      return `<option value="${voice.voice_id}" ${selected}>${label}</option>`;
    }).join('')}
  `;
}

function buildAgentVoiceRow(agent, currentVoice = '', provider = 'elevenlabs') {
  const wrapper = document.createElement('details');
  wrapper.className = 'agent-voice-row agent-voice-details';
  wrapper.dataset.agentId = agent.id;
  const agentLabel = agent.label || agent.id;
  const providerLabel = provider === 'fish' ? 'Fish Audio' : 'ElevenLabs';
  wrapper.innerHTML = `
    <summary class="agent-voice-summary">
      <span class="agent-voice-title">${escapeHtml(agentLabel)}</span>
      <span class="agent-voice-current">${currentVoice ? escapeHtml(currentVoice) : `Default ${providerLabel}`}</span>
    </summary>
    <div class="agent-voice-panel">
      <input class="agent-voice-input" data-agent-id="${escapeHtml(agent.id)}" type="text" placeholder="Paste ${providerLabel} voice/reference ID" value="${escapeHtml(currentVoice || '')}">
      <div class="agent-elevenlabs-tools ${provider === 'fish' ? 'hidden' : ''}">
        <select class="agent-voice-select" data-agent-id="${escapeHtml(agent.id)}">${renderVoiceOptions(currentVoice)}</select>
        <div class="setting-hint">Use the dropdown or paste an ElevenLabs voice ID manually.</div>
      </div>
      <div class="agent-fish-tools ${provider === 'fish' ? '' : 'hidden'}">
        <div class="voice-search-toolbar">
          <input class="agent-fish-search" data-agent-id="${escapeHtml(agent.id)}" type="text" placeholder="Search Fish voices for ${escapeHtml(agentLabel)}">
          <button class="secondary-button agent-fish-search-btn" data-agent-id="${escapeHtml(agent.id)}" type="button">SEARCH</button>
        </div>
        <div class="setting-hint agent-fish-status" data-agent-id="${escapeHtml(agent.id)}"></div>
        <div class="agent-fish-results" data-agent-id="${escapeHtml(agent.id)}"></div>
      </div>
    </div>
  `;
  const select = wrapper.querySelector('.agent-voice-select');
  const input = wrapper.querySelector('.agent-voice-input');
  const current = wrapper.querySelector('.agent-voice-current');
  if (select) select.addEventListener('change', () => {
    input.value = select.value;
    current.textContent = select.value || `Default ${providerLabel}`;
  });
  input.addEventListener('input', () => {
    const value = input.value.trim();
    const match = select ? Array.from(select.options).find((option) => option.value === value) : null;
    if (select) select.value = match ? match.value : '';
    current.textContent = value || `Default ${providerLabel}`;
  });
  return wrapper;
}


function renderFishVoiceResults(items = []) {
  const results = document.getElementById('fish-voice-results');
  const current = document.getElementById('fish-voice-id')?.value?.trim() || '';
  if (!results) return;
  if (!items.length) {
    results.innerHTML = '<div class="setting-hint">No voices found. Try a different name.</div>';
    return;
  }
  results.innerHTML = items.map((item) => {
    const id = String(item._id || item.id || '').trim();
    const title = String(item.title || item.name || id || 'Untitled voice');
    const active = id && id === current;
    const tags = Array.isArray(item.tags) ? item.tags.slice(0, 4).join(' · ') : '';
    const author = item.author?.nickname || item.author?.username || 'Fish Audio';
    const stats = [item.task_count ? `${item.task_count} uses` : '', item.like_count ? `${item.like_count} likes` : ''].filter(Boolean).join(' · ');
    const reasons = Array.isArray(item.matchReasons) && item.matchReasons.length ? item.matchReasons.slice(0, 2).join(' · ') : '';
    return `
      <div class="fish-voice-result ${active ? 'active' : ''}">
        <div class="fish-voice-main">
          <div class="fish-voice-title">${escapeHtml(title)}</div>
          <div class="fish-voice-meta">${escapeHtml(author)}${tags ? ` · ${escapeHtml(tags)}` : ''}${stats ? ` · ${escapeHtml(stats)}` : ''}</div>
          ${reasons ? `<div class="fish-voice-meta">${escapeHtml(reasons)}</div>` : ''}
          <code>${escapeHtml(id)}</code>
        </div>
        <div class="fish-voice-actions">
          <button class="secondary-button" type="button" data-fish-voice-preview="${escapeHtml(id)}" data-fish-voice-label="${escapeHtml(title)}">PREVIEW</button>
          <button class="secondary-button" type="button" data-fish-voice-pick="${escapeHtml(id)}" data-fish-voice-label="${escapeHtml(title)}">${active ? 'SELECTED' : 'USE'}</button>
        </div>
      </div>
    `;
  }).join('');
}


async function previewFishVoice(voiceId, label = '') {
  const status = document.getElementById('fish-voice-search-status');
  if (!voiceId) return;
  if (status) status.textContent = `Previewing ${label || voiceId}…`;
  try {
    const response = await fetch(`${BASE}/api/settings/voice/fish/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voiceId,
        text: `Hey, this is ${label || 'a Fish Audio voice'} previewing inside Command Center.`,
        fishAudioApiBase: document.getElementById('fish-audio-api-base')?.value?.trim() || 'https://your-domain.example/aichat',
        fishSessionCookie: document.getElementById('fish-session-cookie')?.value?.trim() || '',
        fishFormat: document.getElementById('fish-format')?.value?.trim() || 'mp3',
        fishIncludeAsteriskNarration: document.getElementById('fish-include-narration')?.checked === true,
      }),
    });
    if (!response.ok) {
      let detail = '';
      try { detail = (await response.json()).error || ''; } catch (_) { detail = await response.text().catch(() => ''); }
      throw new Error(detail || `Preview failed (${response.status})`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.onended = () => URL.revokeObjectURL(url);
    audio.onerror = () => URL.revokeObjectURL(url);
    await audio.play();
    if (status) status.textContent = `Playing preview: ${label || voiceId}`;
  } catch (err) {
    if (status) status.textContent = err.message || 'Preview failed.';
  }
}

async function searchFishVoices() {
  const queryInput = document.getElementById('fish-voice-search');
  const status = document.getElementById('fish-voice-search-status');
  const query = queryInput?.value?.trim() || '';
  if (!query) {
    if (status) status.textContent = 'Type a voice name first, menace.';
    return;
  }
  if (status) status.textContent = 'Searching Fish voices…';
  try {
    const data = await fetchJson(`${BASE}/api/settings/voice/fish/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: query,
        fishAudioApiBase: document.getElementById('fish-audio-api-base')?.value?.trim() || 'https://your-domain.example/aichat',
        fishSessionCookie: document.getElementById('fish-session-cookie')?.value?.trim() || '',
        limit: 8,
        pageSize: 12,
      }),
    });
    const items = data.items || [];
    renderFishVoiceResults(items);
    if (status) status.textContent = items.length ? `Found ${items.length} Fish voice${items.length === 1 ? '' : 's'}.` : 'No Fish voices found.';
  } catch (err) {
    if (status) status.textContent = err.message || 'Fish voice search failed.';
    renderFishVoiceResults([]);
  }
}


function renderAgentFishVoiceResults(agentId, items = []) {
  const results = document.querySelector(`.agent-fish-results[data-agent-id="${CSS.escape(agentId)}"]`);
  const row = document.querySelector(`.agent-voice-row[data-agent-id="${CSS.escape(agentId)}"]`);
  const input = row?.querySelector('.agent-voice-input');
  const current = input?.value?.trim() || '';
  if (!results) return;
  if (!items.length) {
    results.innerHTML = '<div class="setting-hint">No voices found. Try a different name.</div>';
    return;
  }
  results.innerHTML = items.map((item) => {
    const id = String(item._id || item.id || '').trim();
    const title = String(item.title || item.name || id || 'Untitled voice');
    const active = id && id === current;
    const tags = Array.isArray(item.tags) ? item.tags.slice(0, 3).join(' · ') : '';
    const author = item.author?.nickname || item.author?.username || 'Fish Audio';
    return `
      <div class="fish-voice-result compact ${active ? 'active' : ''}">
        <div class="fish-voice-main">
          <div class="fish-voice-title">${escapeHtml(title)}</div>
          <div class="fish-voice-meta">${escapeHtml(author)}${tags ? ` · ${escapeHtml(tags)}` : ''}</div>
          <code>${escapeHtml(id)}</code>
        </div>
        <div class="fish-voice-actions">
          <button class="secondary-button" type="button" data-agent-fish-preview="${escapeHtml(id)}" data-agent-id="${escapeHtml(agentId)}" data-fish-voice-label="${escapeHtml(title)}">PREVIEW</button>
          <button class="secondary-button" type="button" data-agent-fish-pick="${escapeHtml(id)}" data-agent-id="${escapeHtml(agentId)}" data-fish-voice-label="${escapeHtml(title)}">${active ? 'SELECTED' : 'USE'}</button>
        </div>
      </div>
    `;
  }).join('');
}

async function searchAgentFishVoices(agentId) {
  const row = document.querySelector(`.agent-voice-row[data-agent-id="${CSS.escape(agentId)}"]`);
  const queryInput = row?.querySelector('.agent-fish-search');
  const status = row?.querySelector('.agent-fish-status');
  const query = queryInput?.value?.trim() || row?.querySelector('.agent-voice-title')?.textContent?.trim() || '';
  if (!query) {
    if (status) status.textContent = 'Type a voice name first.';
    return;
  }
  if (status) status.textContent = 'Searching Fish voices…';
  try {
    const data = await fetchJson(`${BASE}/api/settings/voice/fish/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        q: query,
        fishAudioApiBase: document.getElementById('fish-audio-api-base')?.value?.trim() || 'https://your-domain.example/aichat',
        fishSessionCookie: document.getElementById('fish-session-cookie')?.value?.trim() || '',
        limit: 6,
        pageSize: 12,
      }),
    });
    const items = data.items || [];
    renderAgentFishVoiceResults(agentId, items);
    if (status) status.textContent = items.length ? `Found ${items.length} voice${items.length === 1 ? '' : 's'}.` : 'No Fish voices found.';
  } catch (err) {
    const raw = err.message || 'Fish search failed.';
    const friendly = /Expected JSON, but got an HTML page/i.test(raw)
      ? 'Fish voice search hit a normal webpage instead of the API. Check Fish Audio API Base and use the main NEXUS / AIChat URL, like https://your-domain.example/aichat — not /api/nexus or /api/fish/models.'
      : raw;
    if (status) status.textContent = friendly;
    renderAgentFishVoiceResults(agentId, []);
  }
}

function buildWakeWordRow(agent, wakeCfg = {}) {
  const wrapper = document.createElement('div');
  wrapper.className = 'agent-voice-row';
  wrapper.innerHTML = `
    <div class="agent-voice-title">${agent.label || agent.id}</div>
    <input class="wake-label-input" data-agent-id="${agent.id}" type="text" placeholder="Wake word label" value="${wakeCfg.label || agent.label || agent.id}">
    <select class="wake-builtin-select" data-agent-id="${agent.id}">
      <option value="">Custom .ppn / none</option>
      ${BUILT_IN_WAKE_WORDS.map((word) => `<option value="${word}" ${wakeCfg.builtIn === word ? 'selected' : ''}>${word}</option>`).join('')}
    </select>
    <input class="wake-file-input" data-agent-id="${agent.id}" type="file" accept=".ppn">
    <div class="setting-hint">${wakeCfg.builtIn ? `Built-in wake word: ${wakeCfg.builtIn}` : wakeCfg.publicPath ? `Keyword uploaded: ${wakeCfg.publicPath.split('/').pop()}` : 'No keyword file uploaded yet.'}</div>
  `;
  return wrapper;
}


function updateVoiceProviderVisibility(provider = '') {
  const selected = String(provider || document.getElementById('voice-provider')?.value || 'elevenlabs').trim();
  document.querySelectorAll('.provider-elevenlabs').forEach((el) => {
    el.style.display = selected === 'fish' ? 'none' : '';
  });
  document.querySelectorAll('.provider-fish').forEach((el) => {
    el.style.display = selected === 'fish' ? '' : 'none';
  });
}

function updateSttReadinessStatus(mode = '', provider = '') {
  const selectedMode = String(mode || document.getElementById('stt-mode')?.value || 'api').trim().toLowerCase() === 'local' ? 'local' : 'api';
  const rawProvider = String(provider || document.getElementById('stt-api-provider')?.value || 'fish').trim().toLowerCase();
  const selectedProvider = rawProvider === 'openai' || rawProvider === 'elevenlabs' ? rawProvider : 'fish';
  const status = document.getElementById('stt-ready-status');
  if (!status) return;

  if (selectedMode === 'local') {
    status.textContent = 'Ready: Local Whisper on this server.';
    return;
  }

  const fishHint = document.getElementById('saved-stt-fish-key-hint')?.textContent || '';
  const openAiHint = document.getElementById('saved-stt-openai-key-hint')?.textContent || '';
  const elevenHint = document.getElementById('saved-stt-elevenlabs-key-hint')?.textContent || '';
  const hasFish = !/No saved/i.test(fishHint) || /Using AIChat server Fish API key/i.test(fishHint);
  const hasOpenAi = !/No saved/i.test(openAiHint);
  const hasEleven = !/No saved/i.test(elevenHint);

  if (selectedProvider === 'fish') {
    status.textContent = hasFish
      ? 'Ready: AIChat API → Fish Audio is configured.'
      : 'Not ready: Fish Audio STT key is missing.';
    return;
  }
  if (selectedProvider === 'openai') {
    status.textContent = hasOpenAi
      ? 'Ready: AIChat API → OpenAI is configured.'
      : 'Not ready: OpenAI STT key is missing.';
    return;
  }
  status.textContent = hasEleven
    ? 'Ready: AIChat API → ElevenLabs is configured.'
    : 'Not ready: ElevenLabs STT key is missing.';
}

function updateSttVisibility(mode = '', provider = '') {
  const selectedMode = String(mode || document.getElementById('stt-mode')?.value || 'api').trim().toLowerCase() === 'local' ? 'local' : 'api';
  const rawProvider = String(provider || document.getElementById('stt-api-provider')?.value || 'fish').trim().toLowerCase();
  const selectedProvider = rawProvider === 'openai' || rawProvider === 'elevenlabs' ? rawProvider : 'fish';
  document.querySelectorAll('.stt-api-only').forEach((el) => {
    el.style.display = selectedMode === 'api' ? '' : 'none';
  });
  document.querySelectorAll('.stt-provider-fish').forEach((el) => {
    el.style.display = selectedMode === 'api' && selectedProvider === 'fish' ? '' : 'none';
  });
  document.querySelectorAll('.stt-provider-openai').forEach((el) => {
    el.style.display = selectedMode === 'api' && selectedProvider === 'openai' ? '' : 'none';
  });
  document.querySelectorAll('.stt-provider-elevenlabs').forEach((el) => {
    el.style.display = selectedMode === 'api' && selectedProvider === 'elevenlabs' ? '' : 'none';
  });
  const status = document.getElementById('stt-active-status');
  if (status) {
    status.textContent = selectedMode === 'local'
      ? 'Active path: Local Whisper'
      : `Active path: AIChat API → ${selectedProvider === 'fish' ? 'Fish Audio' : selectedProvider === 'openai' ? 'OpenAI' : 'ElevenLabs'}`;
  }
  updateSttReadinessStatus(selectedMode, selectedProvider);
}


function getProviderAgentVoices(voiceSettings = {}, provider = 'elevenlabs') {
  return provider === 'fish'
    ? (voiceSettings.fishAgentVoices || {})
    : (voiceSettings.elevenlabsAgentVoices || voiceSettings.agentVoices || {});
}

function setCompanionImportStatus(text = '') {
  const status = document.getElementById('companion-import-status');
  if (status) status.textContent = text;
}

function buildImportResultCard(item, assignedAgentId = '') {
  if (!item) return '';
  const current = assignedAgentId ? `Assigned to ${assignedAgentId}` : 'Imported and ready to assign';
  return `
    <div class="companion-import-result-card">
      <canvas class="companion-import-result-preview" data-companion-id="${escapeHtml(item.id)}" width="116" height="116"></canvas>
      <div class="companion-import-result-copy">
        <div class="agent-voice-title">${escapeHtml(item.name || item.id)}</div>
        <div class="setting-hint">${escapeHtml(current)}</div>
        <div class="setting-hint">${escapeHtml(item.sourceType || 'companion')}</div>
      </div>
      <div class="companion-import-result-actions">
        <select class="companion-result-agent-select" data-companion-id="${escapeHtml(item.id)}">
          <option value="">Assign to agent...</option>
          ${roster.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.label || agent.id)}</option>`).join('')}
        </select>
        <button class="secondary-button companion-result-assign-btn" type="button" data-companion-id="${escapeHtml(item.id)}">ASSIGN</button>
      </div>
    </div>
  `;
}

function attachImportResultPreview() {
  document.querySelectorAll('.companion-import-result-preview').forEach((canvas) => {
    const companionId = canvas.dataset.companionId;
    const item = companions.getCompanionById(companionId);
    if (item) companions.renderCompanionPreview(canvas, item, 'idle', '');
  });
}

function bindImportResultActions() {
  document.querySelectorAll('.companion-result-assign-btn').forEach((button) => {
    button.onclick = async () => {
      const companionId = button.dataset.companionId || '';
      const select = document.querySelector(`.companion-result-agent-select[data-companion-id="${CSS.escape(companionId)}"]`);
      const agentId = select?.value || '';
      if (!agentId) {
        setCompanionImportStatus('Pick an agent before assigning the imported pet.');
        return;
      }
      try {
        setCompanionImportStatus(`Assigning ${companionId} to ${agentId}...`);
        await fetchJson(`${BASE}/api/settings/companions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentId, mode: 'companion', companionId }),
        });
        await reloadCompanionStateFromServer();
        setCompanionImportStatus(`Assigned ${companionId} to ${agentId}.`);
      } catch (err) {
        setCompanionImportStatus(err.message || 'Assignment failed.');
      }
    };
  });
}

function renderImportResult(item, assignedAgentId = '') {
  const mount = document.getElementById('companion-import-status');
  if (!mount) return;
  mount.innerHTML = buildImportResultCard(item, assignedAgentId);
  attachImportResultPreview();
  bindImportResultActions();
}

function buildAgentCompanionRow(agent, saved = {}, items = []) {
  const wrapper = document.createElement('div');
  wrapper.className = 'agent-voice-row agent-companion-row';
  wrapper.dataset.agentId = agent.id;
  const mode = saved?.mode === 'companion' ? 'companion' : 'default';
  const companionId = String(saved?.companionId || '').trim();
  const selected = items.find((item) => item.id === companionId) || null;
  const scale = Math.min(2, Math.max(0.45, Number(saved?.scale || 1) || 1));
  const scalePercent = Math.round(scale * 100);
  wrapper.innerHTML = `
    <button class="agent-companion-toggle" type="button" aria-expanded="false">
      <span class="agent-voice-title">${escapeHtml(agent.label || agent.id)}</span>
      <span class="agent-companion-summary">${mode === 'companion' ? escapeHtml(selected?.name || companionId || 'Unassigned companion') : 'Default character view'}</span>
    </button>
    <div class="agent-companion-body hidden">
      <div class="agent-companion-grid">
        <label>
          <span class="setting-hint">Visual mode</span>
          <select class="agent-companion-mode" data-agent-id="${escapeHtml(agent.id)}">
            <option value="default" ${mode === 'default' ? 'selected' : ''}>Default</option>
            <option value="companion" ${mode === 'companion' ? 'selected' : ''}>Companion</option>
          </select>
        </label>
        <label>
          <span class="setting-hint">Companion package</span>
          <select class="agent-companion-select" data-agent-id="${escapeHtml(agent.id)}">
            <option value="">Select companion</option>
            ${items.map((item) => `<option value="${escapeHtml(item.id)}" ${item.id === companionId ? 'selected' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('')}
          </select>
        </label>
        <label class="agent-companion-size-field">
          <span class="setting-hint">Companion size <strong class="agent-companion-size-value">${scalePercent}%</strong></span>
          <input class="agent-companion-size" data-agent-id="${escapeHtml(agent.id)}" type="range" min="45" max="200" step="5" value="${scalePercent}">
        </label>
      </div>
      <div class="agent-companion-preview-wrap ${mode === 'companion' ? '' : 'is-default'}">
        <canvas class="agent-companion-preview" width="84" height="84"></canvas>
        <div class="setting-hint agent-companion-preview-text">${mode === 'companion' ? escapeHtml(selected?.name || companionId || 'Companion preview') : 'Using current CommandCenter visuals for this agent.'}</div>
      </div>
    </div>
  `;
  return wrapper;
}

function wireCompanionRows() {
  document.querySelectorAll('.agent-companion-row').forEach((row) => {
    const toggle = row.querySelector('.agent-companion-toggle');
    const body = row.querySelector('.agent-companion-body');
    const modeSelect = row.querySelector('.agent-companion-mode');
    const companionSelect = row.querySelector('.agent-companion-select');
    const previewCanvas = row.querySelector('.agent-companion-preview');
    const previewText = row.querySelector('.agent-companion-preview-text');
    const sizeInput = row.querySelector('.agent-companion-size');
    const sizeValue = row.querySelector('.agent-companion-size-value');
    const summary = row.querySelector('.agent-companion-summary');
    const renderPreview = () => {
      const mode = modeSelect?.value === 'companion' ? 'companion' : 'default';
      const item = availableCompanions.find((entry) => entry.id === companionSelect?.value) || null;
      row.querySelector('.agent-companion-preview-wrap')?.classList.toggle('is-default', mode !== 'companion');
      summary.textContent = mode === 'companion' ? (item?.name || companionSelect?.value || 'Unassigned companion') : 'Default character view';
      previewText.textContent = mode === 'companion'
        ? (item?.name || companionSelect?.value || 'Choose a companion package for this agent.')
        : 'Using current CommandCenter visuals for this agent.';
      const scale = Math.min(2, Math.max(0.45, Number(sizeInput?.value || 100) / 100 || 1));
      if (sizeValue) sizeValue.textContent = `${Math.round(scale * 100)}%`;
      if (mode === 'companion' && item) companions.renderCompanionPreview(previewCanvas, item, 'idle', '', { scale });
      else if (previewCanvas) previewCanvas.getContext('2d')?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    };
    toggle?.addEventListener('click', () => {
      const next = body.classList.contains('hidden');
      body.classList.toggle('hidden', !next);
      toggle.setAttribute('aria-expanded', String(next));
    });
    modeSelect?.addEventListener('change', renderPreview);
    companionSelect?.addEventListener('change', renderPreview);
    sizeInput?.addEventListener('input', renderPreview);
    renderPreview();
  });
}

async function reloadCompanionStateFromServer() {
  const companionData = await fetchJson(`${BASE}/api/settings/companions`);
  currentCompanionSettings = companionData.settings || { agentVisuals: {} };
  availableCompanions = companionData.items || [];
  companions.setCompanionData({ visuals: companionData.resolved || {}, items: availableCompanions });
  await loadRoster();
  office.setAgentVisuals(companionData.resolved || {}, availableCompanions || []);
  directChat.setCompanionData(companionData.resolved || {}, availableCompanions || []);
  populateSettingsForm(window.__lastVoiceSettings || {}, currentWakeSettings || { wakeWords: {} });
}

async function importCompanionPackage() {
  const input = document.getElementById('companion-import-source');
  const sourceDir = String(input?.value || '').trim();
  if (!sourceDir) {
    setCompanionImportStatus('Paste a folder path that contains pet.json and the pet spritesheet asset.');
    return;
  }
  setCompanionImportStatus('Importing Codex pet package...');
  try {
    const data = await fetchJson(`${BASE}/api/companions/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceDir }),
    });
    availableCompanions = data.items || [];
    await reloadCompanionStateFromServer();
    renderImportResult(data.item);
  } catch (err) {
    setCompanionImportStatus(err.message);
  }
}

async function importCompanionFolder() {
  const input = document.getElementById('companion-import-folder');
  const agentSelect = document.getElementById('companion-import-agent');
  const files = Array.from(input?.files || []);
  if (!files.length) {
    setCompanionImportStatus('Choose a Codex pet folder first. Browser reported 0 files.');
    return;
  }
  const form = new FormData();
  for (const file of files) {
    const relativePath = file.webkitRelativePath || file.name;
    form.append('files', file, relativePath);
  }
  if (agentSelect?.value) form.append('agentId', agentSelect.value);
  const folderLabel = files[0]?.webkitRelativePath?.split('/')?.[0] || `${files.length} files`;
  console.log('[CommandCenter] folder upload selection', {
    build: APP_BUILD,
    count: files.length,
    first: files[0]?.webkitRelativePath || files[0]?.name || '',
  });
  setCompanionImportStatus(`Uploading folder ${folderLabel} (${files.length} files)...`);
  try {
    const data = await fetchJson(`${BASE}/api/companions/import-folder`, { method: 'POST', body: form });
    if (input) input.value = '';
    await reloadCompanionStateFromServer();
    renderImportResult(data.item, data.assigned?.agentId || '');
  } catch (err) {
    setCompanionImportStatus(err.message);
  }
}

async function importCompanionZip() {
  const input = document.getElementById('companion-import-zip');
  const agentSelect = document.getElementById('companion-import-agent');
  const file = input?.files?.[0];
  if (!file) {
    setCompanionImportStatus('Choose a Codex pet zip first.');
    return;
  }
  const form = new FormData();
  form.append('package', file, file.name);
  if (agentSelect?.value) form.append('agentId', agentSelect.value);
  setCompanionImportStatus(`Uploading ${file.name}...`);
  try {
    const data = await fetchJson(`${BASE}/api/companions/import-zip`, { method: 'POST', body: form });
    if (input) input.value = '';
    await reloadCompanionStateFromServer();
    renderImportResult(data.item, data.assigned?.agentId || '');
  } catch (err) {
    setCompanionImportStatus(err.message);
  }
}

function populateSettingsForm(voiceSettings = {}, wakeSettings = {}) {
  window.__lastVoiceSettings = voiceSettings || {};
  currentWakeSettings = wakeSettings || { wakeWords: {} };

  const providerSelect = document.getElementById('voice-provider');
  const keyInput = document.getElementById('elevenlabs-key');
  const keyHint = document.getElementById('saved-key-hint');
  const defaultVoiceId = document.getElementById('default-voice-id');
  const defaultVoiceSelect = document.getElementById('default-voice-select');
  const fishApiBase = document.getElementById('fish-audio-api-base');
  const fishVoiceId = document.getElementById('fish-voice-id');
  const fishSessionCookie = document.getElementById('fish-session-cookie');
  const fishCookieHint = document.getElementById('saved-fish-cookie-hint');
  const fishFormat = document.getElementById('fish-format');
  const sttMode = document.getElementById('stt-mode');
  const sttApiBase = document.getElementById('stt-api-base');
  const sttApiProvider = document.getElementById('stt-api-provider');
  const sttLanguage = document.getElementById('stt-language');
  const sttFishKey = document.getElementById('stt-fish-key');
  const sttFishHint = document.getElementById('saved-stt-fish-key-hint');
  const aiChatLearnMoreBtn = document.getElementById('aichat-learn-more-btn');
  const aiChatLearnMorePanel = document.getElementById('aichat-learn-more-panel');
  const sttOpenAiKey = document.getElementById('stt-openai-key');
  const sttOpenAiHint = document.getElementById('saved-stt-openai-key-hint');
  const sttElevenlabsKey = document.getElementById('stt-elevenlabs-key');
  const sttElevenlabsHint = document.getElementById('saved-stt-elevenlabs-key-hint');
  const fishPlaybackMode = document.getElementById('fish-playback-mode');
  const fishIncludeNarration = document.getElementById('fish-include-narration');
  const fishAutoStreamMinChars = document.getElementById('fish-auto-stream-min-chars');
  const fishAutoStreamMinCharsValue = document.getElementById('fish-auto-stream-min-chars-value');
  const voiceList = document.getElementById('agent-voice-list');
  const companionList = document.getElementById('agent-companion-list');
  const wakeList = document.getElementById('wakeword-list');
  const porcupineKeyInput = document.getElementById('porcupine-access-key');
  const porcupineKeyHint = document.getElementById('saved-porcupine-key-hint');
  const vignetteSlider = document.getElementById('vignette-strength');
  const vignetteTopSlider = document.getElementById('vignette-top');
  const vignetteSideSlider = document.getElementById('vignette-side');
  const vignetteBottomSlider = document.getElementById('vignette-bottom');

  providerSelect.value = voiceSettings.provider || 'elevenlabs';
  providerSelect.onchange = () => {
    updateVoiceProviderVisibility(providerSelect.value);
    voiceList.innerHTML = '';
    roster.agents.forEach((agent) => {
      voiceList.appendChild(buildAgentVoiceRow(agent, getProviderAgentVoices(window.__lastVoiceSettings || {}, providerSelect.value)?.[agent.id] || '', providerSelect.value));
    });
  };
  if (sttMode) sttMode.value = voiceSettings.sttMode || 'api';
  if (sttApiBase) sttApiBase.value = voiceSettings.sttApiBase || 'https://your-domain.example/aichat';
  if (sttApiProvider) sttApiProvider.value = voiceSettings.sttApiProvider || 'fish';
  if (sttLanguage) sttLanguage.value = voiceSettings.sttLanguage || 'en';
  if (sttFishKey) sttFishKey.value = '';
  if (sttOpenAiKey) sttOpenAiKey.value = '';
  if (sttElevenlabsKey) sttElevenlabsKey.value = '';
  if (sttFishHint) sttFishHint.textContent = voiceSettings.hasSttFishApiKey
    ? `Saved key: ${voiceSettings.sttFishApiKeyMasked}`
    : (voiceSettings.sttFishUsesServerKey ? 'Using AIChat server Fish API key.' : 'No saved Fish STT key yet.');
  if (sttOpenAiHint) sttOpenAiHint.textContent = voiceSettings.hasSttOpenAiApiKey ? `Saved key: ${voiceSettings.sttOpenAiApiKeyMasked}` : 'No saved OpenAI STT key yet.';
  if (sttElevenlabsHint) sttElevenlabsHint.textContent = voiceSettings.hasSttElevenlabsApiKey ? `Saved key: ${voiceSettings.sttElevenlabsApiKeyMasked}` : 'No saved ElevenLabs STT key yet.';
  if (sttMode) sttMode.onchange = () => updateSttVisibility(sttMode.value, sttApiProvider?.value || 'openai');
  if (sttApiProvider) sttApiProvider.onchange = () => updateSttVisibility(sttMode?.value || 'local', sttApiProvider.value);
  if (aiChatLearnMoreBtn && aiChatLearnMorePanel) {
    aiChatLearnMorePanel.classList.add('hidden');
    aiChatLearnMoreBtn.textContent = 'LEARN MORE';
    aiChatLearnMoreBtn.onclick = () => {
      const isHidden = aiChatLearnMorePanel.classList.toggle('hidden');
      aiChatLearnMoreBtn.textContent = isHidden ? 'LEARN MORE' : 'HIDE DETAILS';
    };
  }
  fishApiBase.value = voiceSettings.fishAudioApiBase || 'https://your-domain.example/aichat';
  fishVoiceId.value = voiceSettings.fishVoiceId || '';
  fishSessionCookie.value = '';
  fishCookieHint.textContent = voiceSettings.hasFishSessionCookie ? `Saved AIChat session: ${voiceSettings.fishSessionCookieMasked}` : 'No saved AIChat session cookie yet. Paste aichat_session or full cookie.';
  fishFormat.value = voiceSettings.fishFormat || 'mp3';
  if (fishPlaybackMode) fishPlaybackMode.value = voiceSettings.fishPlaybackMode || 'auto';
  if (fishAutoStreamMinChars) fishAutoStreamMinChars.value = Number(voiceSettings.fishAutoStreamMinChars || 260);
  if (fishAutoStreamMinCharsValue) fishAutoStreamMinCharsValue.textContent = `${Number(voiceSettings.fishAutoStreamMinChars || 260)} chars`;
  if (fishAutoStreamMinChars) fishAutoStreamMinChars.oninput = () => {
    if (fishAutoStreamMinCharsValue) fishAutoStreamMinCharsValue.textContent = `${fishAutoStreamMinChars.value} chars`;
  };
  fishIncludeNarration.checked = voiceSettings.fishIncludeAsteriskNarration === true;
  keyInput.value = '';
  keyHint.textContent = voiceSettings.hasApiKey ? `Saved key: ${voiceSettings.apiKeyMasked}` : 'No saved ElevenLabs key yet.';
  defaultVoiceId.value = voiceSettings.defaultVoiceId || '';
  defaultVoiceSelect.innerHTML = renderVoiceOptions(voiceSettings.defaultVoiceId || '');
  defaultVoiceSelect.value = availableVoices.some((v) => v.voice_id === (voiceSettings.defaultVoiceId || '')) ? (voiceSettings.defaultVoiceId || '') : '';
  defaultVoiceSelect.onchange = () => { defaultVoiceId.value = defaultVoiceSelect.value; };
  defaultVoiceId.oninput = () => {
    const match = Array.from(defaultVoiceSelect.options).find((option) => option.value === defaultVoiceId.value.trim());
    defaultVoiceSelect.value = match ? match.value : '';
  };

  voiceList.innerHTML = '';
  roster.agents.forEach((agent) => {
    voiceList.appendChild(buildAgentVoiceRow(agent, getProviderAgentVoices(voiceSettings, providerSelect.value)?.[agent.id] || '', providerSelect.value));
  });
  voiceList.onclick = async (event) => {
    const searchButton = event.target?.closest?.('.agent-fish-search-btn');
    if (searchButton) {
      await searchAgentFishVoices(searchButton.dataset.agentId || '');
      return;
    }
    const previewButton = event.target?.closest?.('[data-agent-fish-preview]');
    if (previewButton) {
      await previewFishVoice(previewButton.getAttribute('data-agent-fish-preview') || '', previewButton.getAttribute('data-fish-voice-label') || '');
      return;
    }
    const pickButton = event.target?.closest?.('[data-agent-fish-pick]');
    if (!pickButton) return;
    const agentId = pickButton.dataset.agentId || '';
    const id = pickButton.getAttribute('data-agent-fish-pick') || '';
    const label = pickButton.getAttribute('data-fish-voice-label') || id;
    const row = voiceList.querySelector(`.agent-voice-row[data-agent-id="${CSS.escape(agentId)}"]`);
    const input = row?.querySelector('.agent-voice-input');
    const current = row?.querySelector('.agent-voice-current');
    const status = row?.querySelector('.agent-fish-status');
    if (input) input.value = id;
    if (current) current.textContent = id || 'Default Fish Audio';
    if (status) status.textContent = `Selected ${label}. Save settings to keep it.`;
  };
  voiceList.onkeydown = async (event) => {
    if (event.key !== 'Enter') return;
    const input = event.target?.closest?.('.agent-fish-search');
    if (!input) return;
    event.preventDefault();
    await searchAgentFishVoices(input.dataset.agentId || '');
  };

  porcupineKeyInput.value = '';
  porcupineKeyHint.textContent = wakeSettings.hasAccessKey ? `Saved key: ${wakeSettings.accessKeyMasked}` : 'No saved Porcupine key yet.';
  companionList.innerHTML = '';
  roster.agents.forEach((agent) => {
    companionList.appendChild(buildAgentCompanionRow(agent, currentCompanionSettings.agentVisuals?.[agent.id] || {}, availableCompanions));
  });
  wireCompanionRows();

  const importAgentSelect = document.getElementById('companion-import-agent');
  if (importAgentSelect) {
    importAgentSelect.innerHTML = '<option value="">Do not auto-assign</option>' + roster.agents.map((agent) => `<option value="${escapeHtml(agent.id)}">${escapeHtml(agent.label || agent.id)}</option>`).join('');
  }

  wakeList.innerHTML = '';
  roster.agents.forEach((agent) => {
    wakeList.appendChild(buildWakeWordRow(agent, wakeSettings.wakeWords?.[agent.id] || {}));
  });

  if (vignetteSlider) {
    const savedVignetteStrength = loadVignetteStrength();
    applyVignetteStrength(savedVignetteStrength);
    vignetteSlider.oninput = () => applyVignetteStrength(vignetteSlider.value);
  }

  const wireDirectionalSlider = () => {
    applyDirectionalVignette({
      top: vignetteTopSlider?.value,
      side: vignetteSideSlider?.value,
      bottom: vignetteBottomSlider?.value,
    });
  };
  applyDirectionalVignette(loadDirectionalVignette());
  if (vignetteTopSlider) vignetteTopSlider.oninput = wireDirectionalSlider;
  if (vignetteSideSlider) vignetteSideSlider.oninput = wireDirectionalSlider;
  if (vignetteBottomSlider) vignetteBottomSlider.oninput = wireDirectionalSlider;

  const companionImportBtn = document.getElementById('import-companion-btn');
  if (companionImportBtn) companionImportBtn.onclick = importCompanionPackage;
  const companionImportFolderBtn = document.getElementById('import-companion-folder-btn');
  if (companionImportFolderBtn) companionImportFolderBtn.onclick = importCompanionFolder;
  const companionImportZipBtn = document.getElementById('import-companion-zip-btn');
  if (companionImportZipBtn) companionImportZipBtn.onclick = importCompanionZip;

  const fishVoiceSearch = document.getElementById('fish-voice-search');
  const fishVoiceSearchBtn = document.getElementById('fish-voice-search-btn');
  const fishVoiceResults = document.getElementById('fish-voice-results');
  if (fishVoiceSearch) fishVoiceSearch.onkeydown = (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      searchFishVoices();
    }
  };
  if (fishVoiceSearchBtn) fishVoiceSearchBtn.onclick = searchFishVoices;
  if (fishVoiceResults) fishVoiceResults.onclick = async (event) => {
    const previewButton = event.target?.closest?.('[data-fish-voice-preview]');
    if (previewButton) {
      await previewFishVoice(previewButton.getAttribute('data-fish-voice-preview') || '', previewButton.getAttribute('data-fish-voice-label') || '');
      return;
    }
    const button = event.target?.closest?.('[data-fish-voice-pick]');
    if (!button) return;
    const id = button.getAttribute('data-fish-voice-pick') || '';
    const label = button.getAttribute('data-fish-voice-label') || id;
    fishVoiceId.value = id;
    const status = document.getElementById('fish-voice-search-status');
    if (status) status.textContent = `Selected ${label}. Save settings to keep it.`;
    renderFishVoiceResults(Array.from(fishVoiceResults.querySelectorAll('.fish-voice-result')).map((row) => ({
      _id: row.querySelector('code')?.textContent || '',
      title: row.querySelector('.fish-voice-title')?.textContent || '',
    })));
  };

  updateVoiceProviderVisibility(providerSelect.value);
  updateSttVisibility(sttMode?.value || 'local', sttApiProvider?.value || 'openai');
}

async function runSetupTest() {
  setSetupTestResult('Running setup test...', [], 'ok');
  try {
    const data = await fetchJson(`${BASE}/api/setup/test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    setSetupTestResult(data.summary || 'Setup test finished.', data.checks || [], data.tone || 'ok');
    setSettingsStatus('Setup test finished.');
  } catch (err) {
    setSetupTestResult(err.message || 'Setup test failed.', [{ message: err.message || 'Setup test failed.' }], 'error');
    setSettingsStatus(err.message || 'Setup test failed.', true);
  }
}

async function openSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.remove('hidden');
  modal.setAttribute('aria-hidden', 'false');
  setSettingsStatus('Loading settings...');
  try {
    const [voiceData, wakeData, companionData] = await Promise.all([
      fetchJson(`${BASE}/api/settings/voice`),
      fetchJson(`${BASE}/api/settings/wake`),
      fetchJson(`${BASE}/api/settings/companions`),
      appearance.refresh(),
      branding.refresh(),
      layoutSettings.refresh(),
      intro.refresh(),
      music.refresh(),
    ]);
    currentCompanionSettings = companionData.settings || { agentVisuals: {} };
    availableCompanions = companionData.items || [];
    companions.setCompanionData({ visuals: companionData.resolved || {}, items: availableCompanions });
    populateSettingsForm(voiceData.settings || {}, wakeData.settings || {});
    setSetupTestResult('No setup test run yet.', [], 'ok');
    setSettingsStatus('Settings loaded.');
  } catch (err) {
    setSettingsStatus(err.message, true);
  }
}

function closeSettings() {
  const modal = document.getElementById('settings-modal');
  modal.classList.add('hidden');
  modal.setAttribute('aria-hidden', 'true');
}

async function refreshVoices() {
  const apiKey = document.getElementById('elevenlabs-key').value.trim();
  setSettingsStatus('Loading ElevenLabs voices...');
  try {
    const data = await fetchJson(`${BASE}/api/settings/voice/voices`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ elevenlabsApiKey: apiKey }),
    });
    availableVoices = data.voices || [];
    const [voiceData, wakeData] = await Promise.all([
      fetchJson(`${BASE}/api/settings/voice`),
      fetchJson(`${BASE}/api/settings/wake`),
    ]);
    populateSettingsForm(voiceData.settings || {}, wakeData.settings || {});
    setSettingsStatus(`Loaded ${availableVoices.length} voices.`);
  } catch (err) {
    setSettingsStatus(err.message, true);
  }
}

async function saveSettings() {
  const provider = document.getElementById('voice-provider').value.trim() || 'elevenlabs';
  const apiKey = document.getElementById('elevenlabs-key').value.trim();
  const defaultVoiceId = document.getElementById('default-voice-id').value.trim();
  const fishAudioApiBase = document.getElementById('fish-audio-api-base').value.trim() || 'https://your-domain.example/aichat';
  const fishVoiceId = document.getElementById('fish-voice-id').value.trim();
  const fishSessionCookie = document.getElementById('fish-session-cookie').value.trim();
  const fishFormat = document.getElementById('fish-format').value.trim() || 'mp3';
  const sttMode = document.getElementById('stt-mode')?.value?.trim() || 'local';
  const sttApiBase = document.getElementById('stt-api-base')?.value?.trim() || 'https://your-domain.example/aichat';
  const sttApiProvider = document.getElementById('stt-api-provider')?.value?.trim() || 'fish';
  const sttLanguage = document.getElementById('stt-language')?.value?.trim() || 'en';
  const sttFishApiKey = document.getElementById('stt-fish-key')?.value?.trim() || '';
  const sttOpenAiApiKey = document.getElementById('stt-openai-key')?.value?.trim() || '';
  const sttElevenlabsApiKey = document.getElementById('stt-elevenlabs-key')?.value?.trim() || '';
  const fishPlaybackMode = document.getElementById('fish-playback-mode')?.value?.trim() || 'auto';
  const fishAutoStreamMinChars = Number(document.getElementById('fish-auto-stream-min-chars')?.value || 260);
  const fishIncludeAsteriskNarration = document.getElementById('fish-include-narration').checked;
  const porcupineAccessKey = document.getElementById('porcupine-access-key').value.trim();
  const vignetteStrength = clampVignetteStrength(document.getElementById('vignette-strength')?.value || DEFAULT_VIGNETTE_STRENGTH);
  const directionalVignette = {
    top: clampDirectionalVignette(document.getElementById('vignette-top')?.value || DEFAULT_VIGNETTE_DIRECTIONS.top),
    side: clampDirectionalVignette(document.getElementById('vignette-side')?.value || DEFAULT_VIGNETTE_DIRECTIONS.side),
    bottom: clampDirectionalVignette(document.getElementById('vignette-bottom')?.value || DEFAULT_VIGNETTE_DIRECTIONS.bottom),
  };

  const existingVoiceSettings = window.__lastVoiceSettings || {};
  const elevenlabsAgentVoices = { ...(existingVoiceSettings.elevenlabsAgentVoices || {}) };
  const fishAgentVoices = { ...(existingVoiceSettings.fishAgentVoices || {}) };
  document.querySelectorAll('.agent-voice-input').forEach((input) => {
    const agentId = input.dataset.agentId;
    if (!agentId) return;
    if (provider === 'fish') fishAgentVoices[agentId] = input.value.trim();
    else elevenlabsAgentVoices[agentId] = input.value.trim();
  });
  const agentVoices = provider === 'fish' ? fishAgentVoices : elevenlabsAgentVoices;

  const wakeWords = {};
  document.querySelectorAll('.wake-label-input').forEach((input) => {
    const agentId = input.dataset.agentId;
    if (!agentId) return;
    const existing = currentWakeSettings.wakeWords?.[agentId] || {};
    const builtIn = document.querySelector(`.wake-builtin-select[data-agent-id="${agentId}"]`)?.value?.trim() || '';
    wakeWords[agentId] = {
      label: input.value.trim() || getAgentLabel(agentId),
      publicPath: existing.publicPath || '',
      builtIn,
      sensitivity: existing.sensitivity || 0.6,
    };
  });

  const companionEntries = Array.from(document.querySelectorAll('.agent-companion-row')).map((row) => {
    const agentId = row.dataset.agentId;
    const mode = row.querySelector('.agent-companion-mode')?.value === 'companion' ? 'companion' : 'default';
    const companionId = String(row.querySelector('.agent-companion-select')?.value || '').trim();
    const scale = Math.min(2, Math.max(0.45, Number(row.querySelector('.agent-companion-size')?.value || 100) / 100 || 1));
    return [agentId, { mode, companionId, scale }];
  }).filter(([agentId]) => agentId);
  const agentVisuals = Object.fromEntries(companionEntries);

  setSettingsStatus('Saving settings...');
  try {
    await fetchJson(`${BASE}/api/settings/voice`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, elevenlabsApiKey: apiKey, defaultVoiceId, fishAudioApiBase, fishVoiceId, fishSessionCookie, fishFormat, fishPlaybackMode, fishAutoStreamMinChars, fishIncludeAsteriskNarration, sttMode, sttApiBase, sttApiProvider, sttLanguage, sttFishApiKey, sttOpenAiApiKey, sttElevenlabsApiKey, agentVoices, elevenlabsAgentVoices, fishAgentVoices }),
    });

    await fetchJson(`${BASE}/api/settings/companions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentVisuals }),
    });

    await fetchJson(`${BASE}/api/settings/wake`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ porcupineAccessKey, wakeWords }),
    });

    await appearance.saveSettings();
    await branding.saveSettings();
    await layoutSettings.saveSettings();
    await intro.saveSettings();
    await music.saveSettings();

    const uploads = [];
    document.querySelectorAll('.wake-file-input').forEach((input) => {
      const file = input.files?.[0];
      const agentId = input.dataset.agentId;
      if (!file || !agentId) return;
      const label = document.querySelector(`.wake-label-input[data-agent-id="${agentId}"]`)?.value?.trim() || getAgentLabel(agentId);
      const form = new FormData();
      form.append('agentId', agentId);
      form.append('label', label);
      form.append('keyword', file, file.name);
      uploads.push(fetchJson(`${BASE}/api/settings/wake/keyword`, { method: 'POST', body: form }));
    });
    await Promise.all(uploads);

    const [voiceData, wakeData, companionData] = await Promise.all([
      fetchJson(`${BASE}/api/settings/voice`),
      fetchJson(`${BASE}/api/settings/wake`),
      fetchJson(`${BASE}/api/settings/companions`),
    ]);
    currentCompanionSettings = companionData.settings || { agentVisuals: {} };
    availableCompanions = companionData.items || [];
    companions.setCompanionData({ visuals: companionData.resolved || {}, items: availableCompanions });
    populateSettingsForm(voiceData.settings || {}, wakeData.settings || {});
    office.setAgentVisuals(companionData.resolved || {}, availableCompanions || []);
    directChat.setCompanionData(companionData.resolved || {}, availableCompanions || []);
    persistVignetteStrength(vignetteStrength);
    applyVignetteStrength(vignetteStrength);
    persistDirectionalVignette(directionalVignette);
    applyDirectionalVignette(directionalVignette);
    setSettingsStatus('Settings saved. Wake mode changes apply the next time you arm it.');
    terminal.log('[settings] Voice, companion, and wake settings updated', 'info', true);
  } catch (err) {
    setSettingsStatus(err.message, true);
  }
}

async function armWakeMode(silent = false) {
  try {
    voice.stopPlayback();
    await wake.start();
    if (!silent) terminal.log('[wake] Wake mode armed', 'info', true);
  } catch (err) {
    terminal.log(`[wake] ${err.message}`, 'error', true);
    setWakeButtonState('off');
  }
}

async function rearmWakeMode() {
  if (!wakeDesired) return;
  if (wake.isActive && wake.isActive()) {
    wake.resume();
    return;
  }
  if (wake.getState() === 'off') {
    await armWakeMode(true);
  }
}

async function disarmWakeMode() {
  await wake.stop();
  terminal.log('[wake] Wake mode off', 'info', true);
}

async function main() {
  applyVignetteStrength(loadVignetteStrength());
  loadDirectionalVignette();
  terminal.init('terminal-output');
  mascot.init('mascot-canvas');
  await loadRoster();
  await loadCompanionSettings();
  office.init('office-canvas', roster);
  await appearance.init({ office });
  branding.init();
  layoutSettings.init();
  await branding.refresh();
  await layoutSettings.refresh();
  await music.init();
  await intro.init();
  office.setAgentVisuals(currentCompanionSettings.agentVisuals ? Object.fromEntries(roster.agents.map((agent) => [agent.id, companions.getAgentVisual(agent.id)])) : {}, availableCompanions);
  directChat.init();
  directChat.setRoster(roster);
  directChat.setCompanionData(Object.fromEntries(roster.agents.map((agent) => [agent.id, companions.getAgentVisual(agent.id)])), availableCompanions);

  voice.init({
    onTranscription: (text, agent) => {
      terminal.log(`[you → ${getAgentLabel(agent || getPrimaryAgent())}] ${text}`, 'agent', true);
      mascot.setEmotion('thinking');
    },
    onRecordingStopped: () => {
      playProcessingChime();
      mascot.setEmotion('thinking');
      terminal.log('[mic] Processing...', 'system', true);
    },
  });

  wake.init({
    onStateChange: (state, detail) => setWakeButtonState(state, detail),
    onWake: async (agentId, payload = {}) => {
      playWakeChime();
      voice.stopPlayback();
      playbackToken += 1;
      if (voice.getIsRecording()) voice.stopRecording();
      if (!isFullscreen) {
        await requestFullscreen();
        await new Promise((r) => setTimeout(r, 250));
      }
      voice.setTargetAgent(agentId);
      activeOfficeAgent = agentId;
      office.setAgentHighlight(agentId, true);
      office.onVoiceStart(agentId);
      mascot.setEmotion('listening');
      terminal.log(`[wake] ${getAgentLabel(agentId)} detected`, 'agent', true);

      const remainder = String(payload.remainder || '').trim();
      if (remainder) {
        terminal.log(`[wake] sending inline request: ${remainder}`, 'system', true);
        await fetchJson(`${BASE}/api/browser/send`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: remainder, agent: agentId }),
        });
        return;
      }

      terminal.log(`[wake] hands-free listening for ${getAgentLabel(agentId)}...`, 'system', true);
      try {
        await voice.startRecording({ maxRecordSeconds: 30, silenceTimeoutMs: 2000, silenceThreshold: 0.016 });
      } catch (err) {
        mascot.setEmotion('error');
        office.setAgentHighlight(agentId, false);
        activeOfficeAgent = null;
        terminal.log(`[voice] ${err.message || 'Microphone start failed.'}`, 'error', true);
      }
    },
  });

  document.getElementById('wake-mode-btn')?.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (wake.getState() === 'off') {
      wakeDesired = true;
      await armWakeMode();
    } else {
      wakeDesired = false;
      await disarmWakeMode();
    }
  });

  document.getElementById('stop-audio-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    playbackToken += 1;
    voice.stopPlayback();
    mascot.setEmotion('idle');
    terminal.log('[voice] Playback stopped', 'system', true);
  });

  document.getElementById('settings-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
  document.getElementById('global-settings-btn')?.addEventListener('click', (e) => { e.stopPropagation(); openSettings(); });
  document.getElementById('close-settings-btn')?.addEventListener('click', closeSettings);
  document.querySelector('[data-close-settings="true"]')?.addEventListener('click', closeSettings);
  document.getElementById('save-settings-btn')?.addEventListener('click', saveSettings);
  document.getElementById('run-setup-test-btn')?.addEventListener('click', runSetupTest);
  document.getElementById('refresh-voices-btn')?.addEventListener('click', refreshVoices);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
  });

  document.addEventListener('fullscreenchange', () => {
    isFullscreen = !!document.fullscreenElement;
  });
  document.addEventListener('click', () => {
    if (!isFullscreen) requestFullscreen();
  }, { once: false });

  const mascotZone = document.getElementById('zone-mascot');
  mascotZone.addEventListener('click', async () => {
    const primary = getPrimaryAgent();
    if (!isFullscreen) {
      await requestFullscreen();
      await new Promise(r => setTimeout(r, 300));
    }

    if (voice.getIsRecording()) {
      voice.stopRecording();
      if (activeOfficeAgent) {
        office.setAgentHighlight(activeOfficeAgent, false);
        activeOfficeAgent = null;
      }
      mascot.setEmotion('thinking');
      return;
    }

    voice.setTargetAgent(primary);
    const recording = await voice.toggleRecording();
    if (recording) {
      activeOfficeAgent = primary;
      mascot.setEmotion('listening');
      office.setAgentHighlight(primary, true);
      office.onVoiceStart(primary);
      terminal.log(`[mic] Listening for ${getAgentLabel(primary)}... tap to stop`, 'system', true);
    } else {
      mascot.setEmotion('thinking');
      terminal.log('[mic] Processing...', 'system', true);
    }
  });

  const officeCanvas = document.getElementById('office-canvas');
  officeCanvas.addEventListener('click', async (e) => {
    const rect = officeCanvas.getBoundingClientRect();
    const scaleX = officeCanvas.width / Math.max(1, rect.width);
    const scaleY = officeCanvas.height / Math.max(1, rect.height);
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const agentId = office.getAgentAtPoint(x, y);
    if (!agentId) return;

    if (!isFullscreen) {
      await requestFullscreen();
      await new Promise(r => setTimeout(r, 300));
    }

    if (voice.getIsRecording() && activeOfficeAgent === agentId) {
      voice.stopRecording();
      office.setAgentHighlight(agentId, false);
      activeOfficeAgent = null;
      mascot.setEmotion('thinking');
      terminal.log('[mic] Processing...', 'system', true);
      return;
    }

    if (voice.getIsRecording() && activeOfficeAgent) {
      voice.stopRecording();
      office.setAgentHighlight(activeOfficeAgent, false);
      await new Promise(r => setTimeout(r, 200));
    }

    activeOfficeAgent = agentId;
    voice.setTargetAgent(agentId);
    office.setAgentHighlight(agentId, true);
    office.onVoiceStart(agentId);
    try {
      await voice.startRecording();
      mascot.setEmotion('listening');
      terminal.log(`[mic] Listening for ${getAgentLabel(agentId)}... tap again to send`, 'system', true);
    } catch (err) {
      office.setAgentHighlight(agentId, false);
      activeOfficeAgent = null;
      mascot.setEmotion('error');
      terminal.log(`[voice] ${err.message || 'Microphone start failed.'}`, 'error', true);
    }
  });

  terminal.log('[voice] STT: server-local faster-whisper or AIChat API, depending on settings', 'info', true);
  terminal.log('[voice] TTS: Fish Audio or ElevenLabs when configured, otherwise espeak-ng fallback', 'info', true);
  terminal.log('[wake] Wake mode: local whisper name detection', 'info', true);
  setConnectionState('connecting', 'CONNECTING');
  setWakeButtonState('off');
  bootSequence();
  loadSetupStatus().catch(() => {});
  setSetupTestResult('No setup test run yet.', [], 'ok');
  connect();

  let lastTime = performance.now();
  function frame(now) {
    const dt = now - lastTime;
    lastTime = now;
    mascot.update(dt);
    office.update(dt);
    mascot.draw();
    office.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

main();
