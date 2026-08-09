import * as companions from './companions.js?v=20260531-vrmfix6';
import * as vrmStage from './vrm-stage.js?v=20260531-vrmfix6';
import * as voice from './voice.js?v=20260531-vrmfix6';
import { listAgentSessions, loadSessionMessages, createSession, sendDirectMessage } from './chat-session-core.js?v=20260524-singleagent1';

const AUTO_SPEAK_STORAGE_KEY = 'commandcenter:single-agent:auto-speak';
const BASE = window.__BASE_PATH__ || '';

const state = {
  roster: { agents: [], primaryAgentId: 'main' },
  companionVisuals: {},
  companionItems: [],
  isOpen: false,
  activeAgentId: '',
  activeSessionId: '',
  sessions: [],
  messages: [],
  presence: 'idle',
  autoSpeak: localStorage.getItem(AUTO_SPEAK_STORAGE_KEY) !== '0',
  sending: false,
  loadingSessions: false,
  loadingMessages: false,
  sessionError: '',
  messageError: '',
  recording: false,
  awaitingTranscription: false,
  sessionBrowserOpen: false,
};

const els = {};

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function getAgents() {
  return Array.isArray(state.roster?.agents) && state.roster.agents.length
    ? state.roster.agents
    : [{ id: 'main', label: 'Main', color: '#FFD700' }];
}

function getAgent(agentId = '') {
  return getAgents().find((agent) => agent.id === agentId) || getAgents()[0] || { id: 'main', label: 'Main', color: '#FFD700' };
}

function getPresenceLabel() {
  switch (state.presence) {
    case 'thinking': return 'THINKING';
    case 'speaking': return 'SPEAKING';
    case 'error': return 'ERROR';
    default: return 'IDLE';
  }
}

function formatTime(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function getSessionLabel(session = null) {
  if (!session) return 'Latest';
  return String(session.title || session.lastMessagePreview || 'Untitled session').trim().slice(0, 42) || 'Untitled session';
}

function formatSessionMeta(session = {}) {
  const count = Number(session.messageCount || 0);
  const updated = session.updatedAt
    ? new Date(session.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'new';
  return `${count} msg${count === 1 ? '' : 's'} • ${updated}`;
}

function setPresence(next = 'idle') {
  state.presence = next || 'idle';
  if (els.status) {
    els.status.textContent = getPresenceLabel();
    els.status.className = `sa-state sa-state-${state.presence}`;
  }
  if (els.presenceText) {
    const agent = getAgent(state.activeAgentId);
    const label = state.presence === 'thinking'
      ? 'thinking…'
      : state.presence === 'speaking'
        ? 'speaking…'
        : state.presence === 'error'
          ? 'having a moment.'
          : 'idle.';
    els.presenceText.textContent = `${agent.label || 'Agent'} is ${label}`;
  }
  if (state.activeAgentId) {
    const companionState = state.presence === 'speaking'
      ? 'responding'
      : state.presence === 'thinking'
        ? 'thinking'
        : state.presence === 'error'
          ? 'error'
          : 'idle';
    const visual = companions.getAgentVisual(state.activeAgentId);
    if (visual?.mode === 'live2d') renderLive2dStage(visual);
    else if (visual?.mode === 'vrm') {
      if (els.vrmStage) {
        vrmStage.setVrmState(els.vrmStage, state.presence);
        vrmStage.setVrmSpeaking(els.vrmStage, state.presence === 'speaking');
      }
    } else companions.setCompanionState(state.activeAgentId, companionState);
  }
}

function renderAgentOptions() {
  if (!els.agentSelect) return;
  const agents = getAgents();
  els.agentSelect.innerHTML = agents.map((agent) => `<option value="${escapeAttr(agent.id)}">${escapeHtml(agent.label || agent.id)}</option>`).join('');
  if (agents.some((agent) => agent.id === state.activeAgentId)) els.agentSelect.value = state.activeAgentId;
}

function syncControls() {
  const busy = !!state.sending;
  const micBusy = !!state.recording;
  const processingMic = !!state.awaitingTranscription;
  if (els.send) {
    els.send.disabled = busy || micBusy || processingMic;
    els.send.textContent = busy ? 'SENDING…' : processingMic ? 'PROCESSING…' : 'SEND';
  }
  if (els.input) els.input.disabled = busy || micBusy || processingMic;
  if (els.agentSelect) els.agentSelect.disabled = busy || micBusy || processingMic;
  if (els.newSessionBtn) els.newSessionBtn.disabled = busy || micBusy || processingMic || !state.activeAgentId;
  if (els.sessionRefreshBtn) {
    els.sessionRefreshBtn.disabled = busy || micBusy || processingMic || state.loadingSessions || !state.activeAgentId;
    els.sessionRefreshBtn.textContent = state.loadingSessions ? 'REFRESHING…' : 'REFRESH';
  }
  if (els.micBtn) {
    els.micBtn.disabled = busy || processingMic || !state.activeAgentId;
    els.micBtn.textContent = micBusy ? 'STOP MIC' : processingMic ? 'PROCESSING…' : 'MIC';
    els.micBtn.classList.toggle('is-recording', micBusy);
    els.micBtn.classList.toggle('is-processing', !micBusy && processingMic);
  }
  if (els.autoSpeak) els.autoSpeak.checked = state.autoSpeak !== false;
}

function syncSessionBrowserVisibility() {
  if (!els.chat) return;
  const open = !!state.sessionBrowserOpen;
  els.chat.classList.toggle('sa-chat-sessions-open', open);
  els.sessionToolbar?.classList.toggle('has-open-browser', open);
  if (els.sessionToggleBtn) els.sessionToggleBtn.textContent = open ? 'HIDE SESSIONS' : 'SESSIONS';
  if (els.sessionToggleBtn) els.sessionToggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openSessionBrowser() {
  state.sessionBrowserOpen = true;
  syncSessionBrowserVisibility();
}

function closeSessionBrowser() {
  state.sessionBrowserOpen = false;
  syncSessionBrowserVisibility();
}

function toggleSessionBrowser(force) {
  state.sessionBrowserOpen = typeof force === 'boolean' ? force : !state.sessionBrowserOpen;
  syncSessionBrowserVisibility();
}

function renderSessionStatus() {
  if (!els.sessionMeta) return;
  if (state.loadingSessions) {
    els.sessionMeta.textContent = 'Refreshing sessions…';
    return;
  }
  if (state.sessionError) {
    els.sessionMeta.textContent = 'Session list unavailable';
    return;
  }
  const count = state.sessions.length;
  els.sessionMeta.textContent = count ? `${count} saved session${count === 1 ? '' : 's'}` : 'No saved sessions yet';
}

function renderSessionList() {
  if (!els.sessionList) return;
  if (state.loadingSessions) {
    els.sessionList.innerHTML = '<div class="sa-empty">Loading sessions…</div>';
    return;
  }
  if (state.sessionError) {
    els.sessionList.innerHTML = `
      <div class="sa-empty sa-empty-error">
        <div>${escapeHtml(state.sessionError)}</div>
        <button class="sa-inline-action" type="button" data-sa-action="retry-sessions">Retry</button>
      </div>
    `;
    els.sessionList.querySelector('[data-sa-action="retry-sessions"]')?.addEventListener('click', () => refreshSessions({ preserveSelection: true }));
    return;
  }
  if (!state.sessions.length) {
    els.sessionList.innerHTML = `
      <div class="sa-empty">
        <div>No saved sessions yet.</div>
        <button class="sa-inline-action" type="button" data-sa-action="new-session-empty">Start a session</button>
      </div>
    `;
    els.sessionList.querySelector('[data-sa-action="new-session-empty"]')?.addEventListener('click', () => els.newSessionBtn?.click());
    return;
  }
  els.sessionList.innerHTML = state.sessions.map((session) => `
    <button class="sa-session-item ${session.id === state.activeSessionId ? 'active' : ''}" type="button" data-session-id="${escapeAttr(session.id)}">
      <span class="sa-session-item-title">${escapeHtml(getSessionLabel(session))}</span>
      <span class="sa-session-item-meta">${escapeHtml(formatSessionMeta(session))}</span>
    </button>
  `).join('');
  els.sessionList.querySelectorAll('.sa-session-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectSession(btn.dataset.sessionId || '');
      closeSessionBrowser();
    });
  });
}

function renderMessages() {
  if (!els.messages) return;
  if (state.loadingMessages) {
    els.messages.innerHTML = '<div class="sa-empty">Loading messages…</div>';
    return;
  }
  if (state.messageError) {
    els.messages.innerHTML = `
      <div class="sa-empty sa-empty-error">
        <div>${escapeHtml(state.messageError)}</div>
        <button class="sa-inline-action" type="button" data-sa-action="retry-messages">Retry</button>
      </div>
    `;
    els.messages.querySelector('[data-sa-action="retry-messages"]')?.addEventListener('click', () => {
      if (state.activeSessionId) selectSession(state.activeSessionId);
    });
    return;
  }
  if (!state.messages.length) {
    els.messages.innerHTML = `
      <div class="sa-empty">
        <div>Say something clever. Or cursed. I don’t judge.</div>
        <button class="sa-inline-action" type="button" data-sa-action="focus-compose">Start talking</button>
      </div>
    `;
    els.messages.querySelector('[data-sa-action="focus-compose"]')?.addEventListener('click', () => els.input?.focus());
    return;
  }
  els.messages.innerHTML = state.messages.map((msg) => {
    const isUser = msg.role === 'user';
    const roleLabel = isUser ? 'You' : (getAgent(state.activeAgentId).label || 'Assistant');
    const body = msg.kind === 'typing'
      ? '<div class="sa-msg-text"><div class="sa-typing"><span></span><span></span><span></span></div></div>'
      : `<div class="sa-msg-text">${escapeHtml(msg.text || '').replace(/\n/g, '<br>')}</div>`;
    return `
      <div class="sa-msg ${isUser ? 'sa-msg-user' : 'sa-msg-agent'} ${msg.kind === 'typing' ? 'sa-msg-typing' : ''}">
        <div class="sa-msg-top"><span>${escapeHtml(roleLabel)}</span><span>${escapeHtml(formatTime(msg.timestamp))}</span></div>
        ${body}
      </div>
    `;
  }).join('');
  els.messages.scrollTop = els.messages.scrollHeight;
}

function getTypingMessage() {
  return { id: `typing_${Date.now()}`, role: 'agent', kind: 'typing', text: '', timestamp: Date.now() };
}

function getDefaultLive2dBridgeUrl(visual = {}) {
  return String(visual?.live2d?.modelUrl || '').trim() ? `${BASE}/live2d-viewer.html` : '';
}

function getLive2dFrameUrl(bridgeUrl = '', visual = {}) {
  const raw = String(bridgeUrl || '').trim() || getDefaultLive2dBridgeUrl(visual);
  if (!raw) return '';
  try {
    const url = new URL(raw, window.location.href);
    const modelUrl = String(visual?.live2d?.modelUrl || '').trim();
    if (modelUrl && !url.searchParams.has('model')) url.searchParams.set('model', modelUrl);
    if (state.activeAgentId && !url.searchParams.has('agent')) url.searchParams.set('agent', state.activeAgentId);
    return url.toString();
  } catch {
    return raw;
  }
}

function postLive2dMessage(payload = {}) {
  const frame = els.live2dStage?.querySelector('.sa-live2d-frame');
  if (!frame?.contentWindow) return;
  frame.contentWindow.postMessage(payload, window.location.origin);
}

function postLive2dState(nextState = state.presence) {
  postLive2dMessage({ type: 'commandcenter-live2d-state', state: nextState || 'idle', speaking: nextState === 'speaking' });
}

function postLive2dMouthLevel(level = 0) {
  postLive2dMessage({ type: 'commandcenter-live2d-mouth-level', level: Math.max(0, Math.min(1, Number(level) || 0)) });
}

function renderLive2dStage(visual = null) {
  if (!els.live2dStage) return;
  const live2d = visual?.live2d || {};
  const modelUrl = String(live2d.modelUrl || '').trim();
  const bridgeUrl = String(live2d.bridgeUrl || '').trim() || getDefaultLive2dBridgeUrl(visual);
  const scale = Math.min(2, Math.max(0.45, Number(visual?.scale || 1) || 1));
  els.live2dStage.style.setProperty('--sa-live2d-scale', String(scale));
  if (bridgeUrl) {
    const src = getLive2dFrameUrl(bridgeUrl, visual);
    const existing = els.live2dStage.querySelector('.sa-live2d-frame');
    if (existing && existing.dataset.src === src) {
      postLive2dState(state.presence);
      return;
    }
    els.live2dStage.innerHTML = `<iframe class="sa-live2d-frame" title="Live2D stage" src="${escapeAttr(src)}" data-src="${escapeAttr(src)}" allow="autoplay; fullscreen"></iframe>`;
    els.live2dStage.querySelector('.sa-live2d-frame')?.addEventListener('load', () => postLive2dState(state.presence), { once: true });
    return;
  }
  els.live2dStage.innerHTML = `
    <div class="sa-live2d-placeholder">
      <div class="sa-live2d-orb"></div>
      <div class="sa-live2d-title">LIVE2D MODE</div>
      <div class="sa-live2d-copy">${modelUrl ? `Model configured: ${escapeHtml(modelUrl)}` : 'Upload or add a Live2D model in Settings.'}</div>
      <div class="sa-live2d-note">CommandCenter will use its local Live2D web viewer automatically when a model URL exists.</div>
    </div>
  `;
}

function mountActiveCompanion() {
  if ((!els.companionCanvas && !els.live2dStage && !els.vrmStage) || !state.activeAgentId) return;
  const visual = companions.getAgentVisual(state.activeAgentId);
  const live2dMode = visual?.mode === 'live2d';
  const vrmMode = visual?.mode === 'vrm';
  els.companionCanvas?.classList.toggle('hidden', live2dMode || vrmMode);
  els.live2dStage?.classList.toggle('hidden', !live2dMode);
  els.vrmStage?.classList.toggle('hidden', !vrmMode);
  if (live2dMode) {
    vrmStage.unmountVrmStage(els.vrmStage);
    renderLive2dStage(visual);
    return;
  }
  if (vrmMode) {
    els.live2dStage.innerHTML = '';
    vrmStage.mountVrmStage(els.vrmStage, visual, { agentId: state.activeAgentId, label: getAgent(state.activeAgentId).label || '' })
      .then(() => {
        vrmStage.setVrmState(els.vrmStage, state.presence);
        vrmStage.setVrmSpeaking(els.vrmStage, state.presence === 'speaking');
      })
      .catch(() => {});
    return;
  }
  vrmStage.unmountVrmStage(els.vrmStage);
  els.live2dStage.innerHTML = '';
  els.companionCanvas?.classList.toggle('is-fallback', visual?.mode !== 'companion');
  companions.mountCompanionCanvas(els.companionCanvas, {
    agentId: state.activeAgentId,
    state: state.presence === 'speaking' ? 'responding' : state.presence === 'thinking' ? 'thinking' : state.presence === 'error' ? 'error' : 'idle',
    label: getAgent(state.activeAgentId).label || '',
  });
}

function renderHeader() {
  const agent = getAgent(state.activeAgentId);
  const activeSession = state.sessions.find((item) => item.id === state.activeSessionId) || null;
  const subtitle = activeSession ? getSessionLabel(activeSession) : 'No session selected';
  if (els.title) els.title.textContent = `${agent.label || 'Agent'} — SINGLE AGENT MODE`;
  if (els.subtitle) els.subtitle.textContent = subtitle;
  if (els.sessionFocusLabel) els.sessionFocusLabel.textContent = subtitle;
}

async function refreshSessions({ preserveSelection = true } = {}) {
  if (!state.activeAgentId) return;
  state.loadingSessions = true;
  state.sessionError = '';
  renderSessionList();
  try {
    state.sessions = await listAgentSessions(state.activeAgentId, { mode: 'agent', limit: 40 });
    if (!preserveSelection || !state.sessions.some((session) => session.id === state.activeSessionId)) {
      state.activeSessionId = state.sessions[0]?.id || '';
    }
    if (!state.activeSessionId && state.sessions.length) state.activeSessionId = state.sessions[0]?.id || '';
  } catch (err) {
    state.sessions = [];
    state.sessionError = err?.message || 'Could not load sessions.';
    state.activeSessionId = '';
  } finally {
    state.loadingSessions = false;
    renderSessionStatus();
    renderSessionList();
    renderHeader();
  }
}

async function selectSession(sessionId = '') {
  if (!sessionId) return;
  state.activeSessionId = sessionId;
  state.messageError = '';
  state.loadingMessages = true;
  state.messageError = '';
  state.messages = [];
  renderSessionStatus();
  renderSessionList();
  renderHeader();
  renderMessages();
  try {
    state.messages = await loadSessionMessages(sessionId);
  } catch (err) {
    state.messages = [];
    state.messageError = err?.message || 'Could not load messages.';
  } finally {
    state.loadingMessages = false;
    renderMessages();
    renderSessionStatus();
    setPresence('idle');
  }
}

async function ensureSession() {
  if (state.activeSessionId) return state.activeSessionId;
  const created = await createSession({ agent: state.activeAgentId, title: '', mode: 'agent' });
  if (!created?.id) throw new Error('Failed to create session');
  state.activeSessionId = created.id;
  await refreshSessions({ preserveSelection: true });
  return state.activeSessionId;
}

async function chooseAgent(agentId = '') {
  if (state.sending) return;
  state.activeAgentId = agentId || getAgents()[0]?.id || 'main';
  state.activeSessionId = '';
  state.messages = [];
  state.sessionError = '';
  state.messageError = '';
  state.loadingMessages = false;
  renderAgentOptions();
  renderHeader();
  renderMessages();
  mountActiveCompanion();
  closeSessionBrowser();
  syncControls();
  await refreshSessions({ preserveSelection: false });
  if (state.activeSessionId) await selectSession(state.activeSessionId);
  else {
    state.messages = [];
    renderMessages();
    setPresence('idle');
  }
}

async function toggleMicRecording() {
  if (state.sending || state.awaitingTranscription || !state.activeAgentId) return;
  try {
    if (voice.getIsRecording()) {
      voice.stopRecording();
      return;
    }
    voice.setTargetAgent(state.activeAgentId);
    await voice.startRecording({ maxRecordSeconds: 30, silenceTimeoutMs: 2000, silenceThreshold: 0.016 });
  } catch (err) {
    state.recording = false;
    state.awaitingTranscription = false;
    syncControls();
    setPresence('error');
    state.messages.push({ id: `err_mic_${Date.now()}`, role: 'agent', kind: 'text', text: `Mic error: ${err.message || 'Could not start recording'}`, timestamp: Date.now() });
    renderMessages();
    window.setTimeout(() => {
      if (state.presence === 'error') setPresence('idle');
    }, 1800);
  }
}

async function sendMessage() {
  if (state.sending || !state.activeAgentId) return;
  const text = String(els.input?.value || '').trim();
  if (!text) return;
  state.sending = true;
  syncControls();
  els.input.value = '';
  const localUserMessage = { id: `local_user_${Date.now()}`, role: 'user', kind: 'text', text, timestamp: Date.now() };
  state.messages.push(localUserMessage);
  state.messages.push(getTypingMessage());
  renderMessages();
  setPresence('thinking');

  try {
    closeSessionBrowser();
    window.clearTimeout(state.micProcessingTimer);
    state.awaitingTranscription = false;
    syncControls();
    const sessionId = await ensureSession();
    const data = await sendDirectMessage({ message: text, sessionId, mode: 'agent' });
    if (data.session?.id) state.activeSessionId = data.session.id;
    state.messages = state.messages.filter((msg) => msg.kind !== 'typing');
    const localUserIndex = state.messages.findIndex((msg) => msg.id === localUserMessage.id);
    if (localUserIndex !== -1) {
      state.messages[localUserIndex] = {
        id: data.message?.id || localUserMessage.id,
        role: 'user',
        kind: 'text',
        text,
        timestamp: data.message?.timestamp ? new Date(data.message.timestamp).getTime() : localUserMessage.timestamp,
      };
    }
    if (data.response?.id) {
      state.messages.push({
        id: data.response.id,
        role: 'agent',
        kind: 'text',
        text: String(data.response.text || ''),
        timestamp: data.response.timestamp ? new Date(data.response.timestamp).getTime() : Date.now(),
      });
    }
    await refreshSessions({ preserveSelection: true });
    renderMessages();
    renderHeader();
    if (state.autoSpeak && String(data.response?.text || '').trim()) {
      setPresence('speaking');
      voice.playSpokenResponse(String(data.response.text || '').trim(), state.activeAgentId, { force: true })
        .catch(() => setPresence('error'))
        .finally(() => {
          if (state.presence === 'speaking' || state.presence === 'error') setPresence('idle');
        });
    } else {
      setPresence('idle');
    }
  } catch (err) {
    window.clearTimeout(state.micProcessingTimer);
    state.awaitingTranscription = false;
    state.loadingMessages = false;
    state.messageError = '';
    state.messages = state.messages.filter((msg) => msg.kind !== 'typing');
    state.messages.push({ id: `err_${Date.now()}`, role: 'agent', kind: 'text', text: `Error: ${err.message || 'Request failed'}`, timestamp: Date.now() });
    renderMessages();
    setPresence('error');
    window.setTimeout(() => {
      if (state.presence === 'error') setPresence('idle');
    }, 1800);
  } finally {
    state.sending = false;
    syncControls();
  }
}

function createUi() {
  if (els.panel) return;
  const root = document.getElementById('command-center') || document.body;
  const actions = document.querySelector('#zone-terminal .zone-header-actions');

  els.launchBtn = document.createElement('button');
  els.launchBtn.type = 'button';
  els.launchBtn.className = 'header-button';
  els.launchBtn.id = 'single-agent-launch-btn';
  els.launchBtn.textContent = 'SINGLE AGENT';
  els.launchBtn.addEventListener('click', () => open());
  actions?.appendChild(els.launchBtn);

  els.panel = document.createElement('section');
  els.panel.className = 'single-agent-panel hidden';
  els.panel.setAttribute('aria-label', 'Single Agent Mode');
  els.panel.innerHTML = `
    <div class="single-agent-shell">
      <div class="sa-header">
        <div>
          <div class="sa-kicker">COMPANION MODE</div>
          <div class="sa-title"></div>
          <div class="sa-subtitle"></div>
        </div>
        <div class="sa-header-actions">
          <label class="sa-toggle"><input class="sa-auto-speak" type="checkbox" checked> <span>Auto voice</span></label>
          <button class="sa-close" type="button">CLOSE</button>
        </div>
      </div>
      <div class="sa-body">
        <div class="sa-stage">
          <div class="sa-visual-shell">
            <canvas class="sa-companion" width="220" height="220"></canvas>
            <div class="sa-live2d-stage hidden"></div>
            <div class="sa-vrm-stage hidden"></div>
          </div>
          <div class="sa-stage-bar">
            <span class="sa-state sa-state-idle">IDLE</span>
            <span class="sa-presence-text">Agent is idle.</span>
          </div>
          <div class="sa-controls">
            <label class="sa-field sa-agent-field">
              <span>Agent</span>
              <select class="sa-agent-select"></select>
            </label>
            <button class="sa-new-session" type="button">NEW SESSION</button>
          </div>
        </div>
        <div class="sa-chat">
          <div class="sa-session-toolbar">
            <div class="sa-session-toolbar-main">
              <div class="sa-session-meta"></div>
              <div class="sa-session-focus-pill">Viewing: <span class="sa-session-focus-label">Latest</span></div>
            </div>
            <div class="sa-session-toolbar-actions">
              <button class="sa-session-toggle" type="button" aria-expanded="false">SESSIONS</button>
              <button class="sa-session-refresh" type="button">REFRESH</button>
            </div>
          </div>
          <div class="sa-session-list"></div>
          <div class="sa-messages"></div>
          <div class="sa-compose">
            <input class="sa-input" type="text" placeholder="Type a message..." autocomplete="off">
            <button class="sa-mic" type="button">MIC</button>
            <button class="sa-send" type="button">SEND</button>
          </div>
        </div>
      </div>
    </div>
  `;
  root.appendChild(els.panel);

  els.title = els.panel.querySelector('.sa-title');
  els.subtitle = els.panel.querySelector('.sa-subtitle');
  els.agentSelect = els.panel.querySelector('.sa-agent-select');
  els.newSessionBtn = els.panel.querySelector('.sa-new-session');
  els.companionCanvas = els.panel.querySelector('.sa-companion');
  els.live2dStage = els.panel.querySelector('.sa-live2d-stage');
  els.vrmStage = els.panel.querySelector('.sa-vrm-stage');
  els.status = els.panel.querySelector('.sa-state');
  els.presenceText = els.panel.querySelector('.sa-presence-text');
  els.chat = els.panel.querySelector('.sa-chat');
  els.sessionToolbar = els.panel.querySelector('.sa-session-toolbar');
  els.sessionMeta = els.panel.querySelector('.sa-session-meta');
  els.sessionFocusLabel = els.panel.querySelector('.sa-session-focus-label');
  els.sessionToggleBtn = els.panel.querySelector('.sa-session-toggle');
  els.sessionRefreshBtn = els.panel.querySelector('.sa-session-refresh');
  els.sessionList = els.panel.querySelector('.sa-session-list');
  els.messages = els.panel.querySelector('.sa-messages');
  els.input = els.panel.querySelector('.sa-input');
  els.micBtn = els.panel.querySelector('.sa-mic');
  els.send = els.panel.querySelector('.sa-send');
  els.autoSpeak = els.panel.querySelector('.sa-auto-speak');

  els.panel.querySelector('.sa-close')?.addEventListener('click', close);
  els.panel.addEventListener('click', (event) => {
    if (event.target === els.panel) close();
  });
  els.agentSelect?.addEventListener('change', () => chooseAgent(els.agentSelect.value));
  els.newSessionBtn?.addEventListener('click', async () => {
    if (state.sending || !state.activeAgentId) return;
    const session = await createSession({ agent: state.activeAgentId, title: '', mode: 'agent' }).catch(() => null);
    if (!session?.id) return;
    state.activeSessionId = session.id;
    await refreshSessions({ preserveSelection: true });
    await selectSession(session.id);
  });
  els.sessionToggleBtn?.addEventListener('click', () => toggleSessionBrowser());
  els.sessionRefreshBtn?.addEventListener('click', () => refreshSessions({ preserveSelection: true }));
  els.micBtn?.addEventListener('click', toggleMicRecording);
  els.send?.addEventListener('click', sendMessage);
  els.input?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });
  els.autoSpeak?.addEventListener('change', () => {
    state.autoSpeak = els.autoSpeak.checked !== false;
    localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, state.autoSpeak ? '1' : '0');
    syncControls();
  });

  window.addEventListener('keydown', (event) => {
    if (!state.isOpen) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    }
  });

  document.addEventListener('commandcenter:voice-recording-start', (event) => {
    const agentId = event?.detail?.agentId || '';
    if (!state.isOpen || agentId !== state.activeAgentId) return;
    state.recording = true;
    state.awaitingTranscription = false;
    syncControls();
    setPresence('idle');
    if (els.presenceText) els.presenceText.textContent = `${getAgent(state.activeAgentId).label || 'Agent'} is listening…`;
  });
  document.addEventListener('commandcenter:voice-recording-stop', (event) => {
    const agentId = event?.detail?.agentId || '';
    if (!state.isOpen || agentId !== state.activeAgentId) return;
    state.recording = false;
    state.awaitingTranscription = true;
    syncControls();
    setPresence('thinking');
    if (els.presenceText) els.presenceText.textContent = `${getAgent(state.activeAgentId).label || 'Agent'} is processing your audio…`;
    window.clearTimeout(state.micProcessingTimer);
    state.micProcessingTimer = window.setTimeout(() => {
      if (!state.awaitingTranscription || state.sending) return;
      state.awaitingTranscription = false;
      syncControls();
      if (state.presence === 'thinking') setPresence('idle');
      if (els.presenceText) els.presenceText.textContent = `${getAgent(state.activeAgentId).label || 'Agent'} is idle.`;
      state.messages.push({
        id: `mic_timeout_${Date.now()}`,
        role: 'agent',
        kind: 'text',
        text: 'Mic capture finished, but no transcript came back. Try again.',
        timestamp: Date.now(),
      });
      renderMessages();
    }, 12000);
  });
  document.addEventListener('commandcenter:voice-transcription', (event) => {
    const agentId = event?.detail?.agentId || '';
    const text = String(event?.detail?.text || '').trim();
    if (!state.isOpen || agentId !== state.activeAgentId || !text) return;
    window.clearTimeout(state.micProcessingTimer);
    state.recording = false;
    state.awaitingTranscription = false;
    syncControls();
    els.input.value = text;
    sendMessage();
  });
  document.addEventListener('commandcenter:voice-playback-start', (event) => {
    const agentId = event?.detail?.agentId || '';
    if (state.isOpen && agentId === state.activeAgentId) setPresence('speaking');
  });
  document.addEventListener('commandcenter:voice-playback-level', (event) => {
    const agentId = event?.detail?.agentId || '';
    if (state.isOpen && agentId === state.activeAgentId) {
      const level = event?.detail?.level || 0;
      postLive2dMouthLevel(level);
      if (els.vrmStage && !els.vrmStage.classList.contains('hidden')) vrmStage.setVrmMouthLevel(els.vrmStage, level);
    }
  });
  document.addEventListener('commandcenter:voice-playback-stop', (event) => {
    const agentId = event?.detail?.agentId || '';
    if (state.isOpen && agentId === state.activeAgentId && state.presence === 'speaking') setPresence('idle');
  });
}

export function init() {
  createUi();
  renderAgentOptions();
  state.activeAgentId = state.activeAgentId || getAgents()[0]?.id || 'main';
  renderHeader();
  renderSessionStatus();
  renderMessages();
  syncSessionBrowserVisibility();
  syncControls();
}

export async function open(agentId = '') {
  if (!els.panel) createUi();
  state.isOpen = true;
  closeSessionBrowser();
  els.panel?.classList.remove('hidden');
  document.body.classList.add('single-agent-open');
  syncControls();
  await chooseAgent(agentId || state.activeAgentId || getAgents()[0]?.id || 'main');
  els.input?.focus();
}

export function close() {
  if (state.recording && voice.getIsRecording()) voice.stopRecording({ immediate: true });
  if (els.vrmStage) vrmStage.unmountVrmStage(els.vrmStage);
  window.clearTimeout(state.micProcessingTimer);
  state.isOpen = false;
  state.recording = false;
  state.awaitingTranscription = false;
  closeSessionBrowser();
  els.panel?.classList.add('hidden');
  document.body.classList.remove('single-agent-open');
  syncControls();
  if (state.presence !== 'idle') setPresence('idle');
}

export function setRoster(nextRoster = { agents: [], primaryAgentId: 'main' }) {
  state.roster = nextRoster || { agents: [], primaryAgentId: 'main' };
  if (!getAgents().some((agent) => agent.id === state.activeAgentId)) {
    state.activeAgentId = getAgents()[0]?.id || 'main';
    state.activeSessionId = '';
    state.messages = [];
    state.sessionError = '';
    state.messageError = '';
  }
  renderAgentOptions();
  renderHeader();
  renderMessages();
  syncControls();
}

export function setCompanionData(visuals = {}, items = []) {
  state.companionVisuals = visuals || {};
  state.companionItems = items || [];
  companions.setCompanionData({ visuals: state.companionVisuals, items: state.companionItems });
  if (state.activeAgentId) {
    mountActiveCompanion();
    setPresence(state.presence || 'idle');
  }
}
