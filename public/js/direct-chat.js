// Direct Chat Module - text-based chat with agents + reusable file library + session switching
import * as terminal from './terminal.js?v=20260320j';
import * as companions from './companions.js?v=20260321w';

const BASE = window.__BASE_PATH__ || '';

let roster = { agents: [], primaryAgentId: 'main' };
let activeChatAgent = null;
let activeChatSessionId = null;
let isChatOpen = false;
let launcherEl = null;
let panelEl = null;
let agentListEl = null;
let chatAreaEl = null;
let messageInputEl = null;
let sendBtnEl = null;
let fileInputEl = null;
let fileListEl = null;
let selectedFilesEl = null;
let filePanelEl = null;
let filePanelBodyEl = null;
let filePanelToggleEl = null;
let linkNameEl = null;
let linkUrlEl = null;
let linkNotesEl = null;
let sessionTitleEl = null;
let sessionMenuEl = null;
let sessionListEl = null;
let sessionSearchEl = null;
let newSessionBtnEl = null;
let sessionMenuToggleEl = null;

const chatHistory = {};
const pendingByAgent = {};
const sessionsByAgent = {};
let fileLibrary = [];
let selectedFileIds = [];
let isFileLibraryExpanded = false;
let isSessionMenuOpen = false;
let companionVisuals = {};
let companionItems = [];

export function init() {
  createLauncher();
  createPanel();
  loadRoster();
  loadFileLibrary();
}

function createLauncher() {
  if (launcherEl) return;
  launcherEl = document.createElement('button');
  launcherEl.id = 'direct-chat-launcher';
  launcherEl.type = 'button';
  launcherEl.innerHTML = '<span class="dc-launcher-dot"></span><span>CHAT</span>';
  launcherEl.addEventListener('click', openChatPanel);
  document.body.appendChild(launcherEl);
}

function createPanel() {
  if (panelEl) return;
  panelEl = document.createElement('div');
  panelEl.id = 'direct-chat-panel';
  panelEl.innerHTML = `
    <div class="dc-header">
      <span class="dc-title">DIRECT CHAT</span>
      <button class="dc-close" aria-label="Close chat">×</button>
    </div>
    <div class="dc-agent-list"></div>
    <div class="dc-chat-area hidden">
      <div class="dc-chat-header">
        <button class="dc-back" type="button">←</button>
        <canvas class="dc-agent-companion hidden" width="44" height="44"></canvas>
        <div class="dc-chat-header-main">
          <span class="dc-agent-name"></span>
          <div class="dc-session-bar">
            <button class="dc-session-toggle" type="button" aria-expanded="false">Session: <span class="dc-session-title">Latest</span> ▾</button>
            <button class="dc-session-new" type="button">＋ New</button>
          </div>
        </div>
      </div>
      <div class="dc-session-menu hidden">
        <div class="dc-session-menu-toolbar">
          <input class="dc-session-search" type="text" placeholder="Find a session..." autocomplete="off">
        </div>
        <div class="dc-session-list"></div>
      </div>
      <div class="dc-messages"></div>
      <div class="dc-files-panel collapsed">
        <div class="dc-files-title-row">
          <button class="dc-files-toggle" type="button" aria-expanded="false">
            <span class="dc-files-toggle-label">FILES</span>
            <span class="dc-files-toggle-count">0</span>
            <span class="dc-files-toggle-chevron">▾</span>
          </button>
          <label class="dc-upload-btn">
            <input class="dc-file-input" type="file" multiple>
            <span>UPLOAD</span>
          </label>
        </div>
        <div class="dc-files-body hidden">
          <div class="dc-link-row">
            <input class="dc-link-name" type="text" placeholder="Link title (optional)">
            <input class="dc-link-url" type="url" placeholder="Paste Google Doc / URL">
            <input class="dc-link-notes" type="text" placeholder="Notes (optional)">
            <button class="dc-link-save" type="button">SAVE LINK</button>
          </div>
          <div class="dc-selected-files"></div>
          <div class="dc-file-list"></div>
        </div>
      </div>
      <div class="dc-input-area">
        <input type="text" class="dc-input" placeholder="Type a message..." autocomplete="off">
        <button class="dc-send" type="button">SEND</button>
      </div>
    </div>
  `;

  document.getElementById('command-center').appendChild(panelEl);

  agentListEl = panelEl.querySelector('.dc-agent-list');
  chatAreaEl = panelEl.querySelector('.dc-chat-area');
  messageInputEl = panelEl.querySelector('.dc-input');
  sendBtnEl = panelEl.querySelector('.dc-send');
  fileInputEl = panelEl.querySelector('.dc-file-input');
  fileListEl = panelEl.querySelector('.dc-file-list');
  selectedFilesEl = panelEl.querySelector('.dc-selected-files');
  filePanelEl = panelEl.querySelector('.dc-files-panel');
  filePanelBodyEl = panelEl.querySelector('.dc-files-body');
  filePanelToggleEl = panelEl.querySelector('.dc-files-toggle');
  linkNameEl = panelEl.querySelector('.dc-link-name');
  linkUrlEl = panelEl.querySelector('.dc-link-url');
  linkNotesEl = panelEl.querySelector('.dc-link-notes');
  sessionTitleEl = panelEl.querySelector('.dc-session-title');
  sessionMenuEl = panelEl.querySelector('.dc-session-menu');
  sessionListEl = panelEl.querySelector('.dc-session-list');
  sessionSearchEl = panelEl.querySelector('.dc-session-search');
  newSessionBtnEl = panelEl.querySelector('.dc-session-new');
  sessionMenuToggleEl = panelEl.querySelector('.dc-session-toggle');

  panelEl.querySelector('.dc-close').addEventListener('click', closeChatPanel);
  panelEl.querySelector('.dc-back').addEventListener('click', showAgentList);
  sendBtnEl.addEventListener('click', sendMessage);
  messageInputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  fileInputEl.addEventListener('change', uploadFiles);
  panelEl.querySelector('.dc-link-save').addEventListener('click', saveLink);
  filePanelToggleEl?.addEventListener('click', toggleFileLibrary);
  sessionMenuToggleEl?.addEventListener('click', toggleSessionMenu);
  newSessionBtnEl?.addEventListener('click', createNewSession);
  sessionSearchEl?.addEventListener('input', () => renderSessionList(sessionSearchEl.value));

  syncFileLibraryVisibility();
  syncSessionMenuVisibility();
}

async function loadRoster() {
  try {
    const res = await fetch(`${BASE}/api/agents`);
    if (res.ok) roster = await res.json();
    renderAgentList();
  } catch (_) {}
}

async function loadFileLibrary() {
  try {
    const res = await fetch(`${BASE}/api/chat/files`);
    if (!res.ok) return;
    const data = await res.json();
    fileLibrary = Array.isArray(data.items) ? data.items : [];
    renderFileLibrary();
  } catch (_) {}
}

async function loadAgentSessions(agentId) {
  try {
    const res = await fetch(`${BASE}/api/chat/sessions?agent=${encodeURIComponent(agentId)}&limit=40`);
    if (!res.ok) return [];
    const data = await res.json();
    sessionsByAgent[agentId] = Array.isArray(data.sessions) ? data.sessions : [];
    return sessionsByAgent[agentId];
  } catch (_) {
    return [];
  }
}

async function loadSessionMessages(sessionId) {
  if (!sessionId) return [];
  try {
    const res = await fetch(`${BASE}/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`);
    if (!res.ok) return [];
    const data = await res.json();
    const messages = Array.isArray(data.messages) ? data.messages : [];
    chatHistory[sessionId] = messages.map((msg) => ({
      id: msg.id,
      role: msg.role === 'user' ? 'user' : 'agent',
      kind: msg.meta?.error ? 'error' : 'text',
      text: String(msg.text || ''),
      timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
      files: Array.isArray(msg.meta?.files) ? msg.meta.files : [],
    }));
    return chatHistory[sessionId];
  } catch (_) {
    return [];
  }
}

function renderAgentList() {
  if (!agentListEl) return;
  const agents = roster.agents?.length ? roster.agents : [{ id: 'main', label: 'Main', color: '#FFD700' }];
  agentListEl.innerHTML = agents.map((agent) => `
    <div class="dc-agent-item" data-agent-id="${agent.id}" style="--agent-color: ${agent.color || '#AA66FF'}">
      ${agent.visual?.mode === 'companion'
        ? `<canvas class="dc-agent-avatar dc-agent-avatar-canvas" data-agent-id="${escapeAttr(agent.id)}" width="42" height="42"></canvas>`
        : `<div class="dc-agent-avatar">${escapeHtml((agent.label || agent.id).charAt(0).toUpperCase())}</div>`}
      <div class="dc-agent-info">
        <div class="dc-agent-label">${escapeHtml(agent.label || agent.id)}</div>
        <div class="dc-agent-status">Text ${escapeHtml(agent.label || agent.id)}</div>
      </div>
    </div>
  `).join('');

  agentListEl.querySelectorAll('.dc-agent-item').forEach((item) => {
    item.addEventListener('click', () => openChatWithAgent(item.dataset.agentId));
  });
  agentListEl.querySelectorAll('.dc-agent-avatar-canvas').forEach((canvas) => {
    companions.mountCompanionCanvas(canvas, { agentId: canvas.dataset.agentId, state: 'idle' });
  });
}

function openChatPanel() {
  panelEl?.classList.add('open');
  launcherEl?.classList.add('active');
  isChatOpen = true;
  loadRoster();
  loadFileLibrary();
}

function closeChatPanel() {
  showAgentList();
  panelEl?.classList.remove('open');
  launcherEl?.classList.remove('active');
  isChatOpen = false;
}

async function openChatWithAgent(agentId) {
  activeChatAgent = agentId;
  activeChatSessionId = null;
  isFileLibraryExpanded = false;
  isSessionMenuOpen = false;

  const agent = getAgent(agentId);
  panelEl.querySelector('.dc-agent-name').textContent = agent.label;
  panelEl.querySelector('.dc-agent-name').style.color = agent.color;
  applyAgentTheme(agent);

  const companionCanvas = panelEl.querySelector('.dc-agent-companion');
  if (agent.visual?.mode === 'companion') {
    companionCanvas?.classList.remove('hidden');
    companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
  } else {
    companionCanvas?.classList.add('hidden');
    companionCanvas?.getContext('2d')?.clearRect(0, 0, companionCanvas.width, companionCanvas.height);
  }

  agentListEl.classList.add('hidden');
  chatAreaEl.classList.remove('hidden');
  syncFileLibraryVisibility();
  syncSessionMenuVisibility();

  const sessions = await loadAgentSessions(agentId);
  if (sessions.length) {
    await selectSession(sessions[0].id);
  } else {
    chatHistory[agentId] = [];
    updateSessionTitle('New session');
    renderMessages();
    renderSessionList();
  }

  renderFileLibrary();
  setTimeout(() => messageInputEl?.focus(), 60);
}

function showAgentList() {
  activeChatAgent = null;
  activeChatSessionId = null;
  selectedFileIds = [];
  isFileLibraryExpanded = false;
  isSessionMenuOpen = false;
  applyAgentTheme(null);
  renderSelectedFiles();
  syncFileLibraryVisibility();
  syncSessionMenuVisibility();
  chatAreaEl?.classList.add('hidden');
  agentListEl?.classList.remove('hidden');
}

function getAgent(agentId) {
  return roster.agents?.find((a) => a.id === agentId)
    || { id: agentId, label: agentId, color: '#AA66FF', visual: companionVisuals[agentId] || { mode: 'default' } };
}

function applyAgentTheme(agent = null) {
  if (!panelEl) return;
  const color = agent?.color || '#05d9e8';
  panelEl.style.setProperty('--dc-accent', color);
  panelEl.style.setProperty('--dc-accent-soft', `${color}24`);
  panelEl.style.setProperty('--dc-accent-border', `${color}99`);
}

function getActiveHistoryKey() {
  return activeChatSessionId || activeChatAgent || 'main';
}

function toggleFileLibrary() {
  isFileLibraryExpanded = !isFileLibraryExpanded;
  syncFileLibraryVisibility();
}

function syncFileLibraryVisibility() {
  if (!filePanelEl || !filePanelBodyEl || !filePanelToggleEl) return;
  filePanelEl.classList.toggle('collapsed', !isFileLibraryExpanded);
  filePanelBodyEl.classList.toggle('hidden', !isFileLibraryExpanded);
  filePanelToggleEl.setAttribute('aria-expanded', String(isFileLibraryExpanded));
  const countEl = filePanelToggleEl.querySelector('.dc-files-toggle-count');
  if (countEl) countEl.textContent = String(fileLibrary.length || 0);
}

function toggleSessionMenu() {
  isSessionMenuOpen = !isSessionMenuOpen;
  renderSessionList(sessionSearchEl?.value || '');
  syncSessionMenuVisibility();
}

function syncSessionMenuVisibility() {
  if (!sessionMenuEl || !sessionMenuToggleEl) return;
  sessionMenuEl.classList.toggle('hidden', !isSessionMenuOpen);
  sessionMenuToggleEl.setAttribute('aria-expanded', String(isSessionMenuOpen));
}

function ensureHistory(key) {
  if (!chatHistory[key]) chatHistory[key] = [];
  return chatHistory[key];
}

function addMessage(key, message) {
  const history = ensureHistory(key);
  history.push({ id: crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, timestamp: Date.now(), ...message });
  if (history.length > 120) history.splice(0, history.length - 120);
}

function removeTypingMessage(key) {
  const history = ensureHistory(key);
  const idx = history.findIndex((entry) => entry.role === 'agent' && entry.kind === 'typing');
  if (idx !== -1) history.splice(idx, 1);
}

function renderMessages() {
  if (!activeChatAgent || !chatAreaEl) return;
  const container = chatAreaEl.querySelector('.dc-messages');
  const messages = chatHistory[getActiveHistoryKey()] || [];

  if (!messages.length) {
    container.innerHTML = '<div class="dc-empty">Send a message to start the conversation</div>';
    return;
  }

  container.innerHTML = messages.map((msg, index) => renderMessage(msg, index, messages)).join('');
  container.scrollTop = container.scrollHeight;
}

function renderMessage(msg, index = 0, messages = []) {
  const isUser = msg.role === 'user';
  const prev = messages[index - 1] || null;
  const next = messages[index + 1] || null;
  const isGroupedWithPrev = !!prev && prev.role === msg.role && prev.kind === msg.kind;
  const isGroupedWithNext = !!next && next.role === msg.role && next.kind === msg.kind;

  const classes = ['dc-message', isUser ? 'dc-message-user' : 'dc-message-agent'];
  if (msg.kind === 'tool') classes.push('dc-message-tool');
  if (msg.kind === 'typing') classes.push('dc-message-typing');
  if (msg.kind === 'file') classes.push('dc-message-file');
  if (msg.kind === 'error') classes.push('dc-message-tool');
  if (isGroupedWithPrev) classes.push('dc-message-grouped-prev');
  if (isGroupedWithNext) classes.push('dc-message-grouped-next');

  const label = msg.kind === 'tool'
    ? 'Tool'
    : msg.kind === 'error'
      ? 'Error'
      : (isUser ? 'You' : (getAgent(activeChatAgent || 'main').label || 'Assistant'));

  const body = msg.kind === 'typing'
    ? '<div class="dc-message-text"><div class="dc-typing"><span></span><span></span><span></span></div></div>'
    : `<div class="dc-message-text">${renderImmersionText(msg.text || '')}</div>`;

  const attachments = Array.isArray(msg.files) && msg.files.length
    ? `<div class="dc-message-files">${msg.files.map(renderAttachedBadge).join('')}</div>`
    : '';

  return `
    <div class="${classes.join(' ')}">
      ${isGroupedWithPrev ? '' : `<div class="dc-message-topline">
        <div class="dc-message-name">${escapeHtml(label)}</div>
        <div class="dc-message-time">${formatTime(msg.timestamp)}</div>
      </div>`}
      ${body}
      ${attachments}
      ${isGroupedWithPrev ? `<div class="dc-message-time dc-message-time-inline">${formatTime(msg.timestamp)}</div>` : ''}
    </div>
  `;
}

function renderAttachedBadge(file) {
  return `<span class="dc-file-pill">${escapeHtml(file.name || file.originalName || 'file')}</span>`;
}

function renderSelectedFiles() {
  if (!selectedFilesEl) return;
  if (!selectedFileIds.length) {
    selectedFilesEl.innerHTML = '';
    syncFileLibraryVisibility();
    return;
  }
  const files = selectedFileIds.map((id) => fileLibrary.find((item) => item.id === id)).filter(Boolean);
  selectedFilesEl.innerHTML = files.map((file) => `
    <button class="dc-selected-pill" data-file-id="${file.id}" type="button">
      ${escapeHtml(file.name || file.originalName || 'file')}
      <span>×</span>
    </button>
  `).join('');
  selectedFilesEl.querySelectorAll('.dc-selected-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedFileIds = selectedFileIds.filter((id) => id !== btn.dataset.fileId);
      renderSelectedFiles();
      renderFileLibrary();
    });
  });
  syncFileLibraryVisibility();
}

function renderFileLibrary() {
  if (!fileListEl) return;
  const items = fileLibrary || [];
  if (!items.length) {
    fileListEl.innerHTML = '<div class="dc-empty dc-files-empty">No saved files yet</div>';
    renderSelectedFiles();
    syncFileLibraryVisibility();
    return;
  }

  fileListEl.innerHTML = items.map((item) => {
    const selected = selectedFileIds.includes(item.id);
    return `
      <div class="dc-file-item ${selected ? 'selected' : ''}" data-file-id="${item.id}">
        <div class="dc-file-main">
          <button class="dc-file-toggle" type="button">${selected ? 'REMOVE' : 'USE'}</button>
          <div class="dc-file-meta">
            <div class="dc-file-name">${escapeHtml(item.name || item.originalName || 'file')}</div>
            <div class="dc-file-sub">${escapeHtml(item.kind === 'link' ? (item.sourceUrl || 'link') : `${formatBytes(item.size)} • ${item.mimeType || 'file'}`)}</div>
          </div>
        </div>
        <div class="dc-file-actions">
          <a class="dc-file-link" href="${escapeAttr(item.downloadUrl)}" target="_blank" rel="noopener noreferrer">OPEN</a>
          <button class="dc-file-delete" type="button">DELETE</button>
        </div>
      </div>
    `;
  }).join('');

  fileListEl.querySelectorAll('.dc-file-item').forEach((row) => {
    const id = row.dataset.fileId;
    row.querySelector('.dc-file-toggle')?.addEventListener('click', () => toggleSelectedFile(id));
    row.querySelector('.dc-file-delete')?.addEventListener('click', () => deleteFile(id));
  });

  renderSelectedFiles();
  syncFileLibraryVisibility();
}

function toggleSelectedFile(id) {
  if (selectedFileIds.includes(id)) selectedFileIds = selectedFileIds.filter((value) => value !== id);
  else selectedFileIds = [...selectedFileIds, id];
  renderSelectedFiles();
  renderFileLibrary();
}

async function uploadFiles() {
  const files = Array.from(fileInputEl?.files || []);
  if (!files.length) return;

  const form = new FormData();
  files.forEach((file) => form.append('files', file, file.name));

  try {
    const res = await fetch(`${BASE}/api/chat/files/upload`, { method: 'POST', body: form });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Upload failed');
    fileLibrary = [...(data.items || []), ...fileLibrary];
    selectedFileIds = [...new Set([...selectedFileIds, ...(data.items || []).map((item) => item.id)])];
    renderFileLibrary();
    terminal.log(`[chat] Uploaded ${files.length} file${files.length === 1 ? '' : 's'}`, 'info', true);
  } catch (err) {
    terminal.log(`[chat] Upload failed: ${err.message}`, 'error', true);
  } finally {
    if (fileInputEl) fileInputEl.value = '';
  }
}

async function saveLink() {
  const url = String(linkUrlEl?.value || '').trim();
  const name = String(linkNameEl?.value || '').trim();
  const notes = String(linkNotesEl?.value || '').trim();
  if (!url) return;
  try {
    const res = await fetch(`${BASE}/api/chat/files/link`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, name, notes }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save link');
    if (data.item) {
      fileLibrary = [data.item, ...fileLibrary];
      selectedFileIds = [...new Set([...selectedFileIds, data.item.id])];
      renderFileLibrary();
    }
    linkNameEl.value = '';
    linkUrlEl.value = '';
    linkNotesEl.value = '';
  } catch (err) {
    terminal.log(`[chat] Link save failed: ${err.message}`, 'error', true);
  }
}

async function deleteFile(id) {
  try {
    const res = await fetch(`${BASE}/api/chat/files/${id}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Delete failed');
    fileLibrary = fileLibrary.filter((item) => item.id !== id);
    selectedFileIds = selectedFileIds.filter((value) => value !== id);
    renderFileLibrary();
  } catch (err) {
    terminal.log(`[chat] Delete failed: ${err.message}`, 'error', true);
  }
}

function getSessionLabel(session = null) {
  if (!session) return 'Latest';
  return String(session.title || session.lastMessagePreview || 'Untitled session').trim().slice(0, 36) || 'Untitled session';
}

function formatSessionMeta(session = {}) {
  const count = Number(session.messageCount || 0);
  const updated = session.updatedAt
    ? new Date(session.updatedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : 'new';
  return `${count} msg${count === 1 ? '' : 's'} • ${updated}`;
}

function updateSessionTitle(label = '') {
  if (!sessionTitleEl) return;
  const session = (sessionsByAgent[activeChatAgent] || []).find((item) => item.id === activeChatSessionId);
  sessionTitleEl.textContent = label || getSessionLabel(session) || 'Latest';
}

function renderSessionList(query = '') {
  if (!sessionListEl || !activeChatAgent) return;
  const needle = String(query || '').trim().toLowerCase();
  const sessions = (sessionsByAgent[activeChatAgent] || []).filter((session) => {
    if (!needle) return true;
    return `${session.title || ''} ${session.lastMessagePreview || ''}`.toLowerCase().includes(needle);
  });

  if (!sessions.length) {
    sessionListEl.innerHTML = '<div class="dc-empty dc-session-empty">No saved sessions yet</div>';
    return;
  }

  sessionListEl.innerHTML = sessions.map((session) => `
    <button class="dc-session-item ${session.id === activeChatSessionId ? 'active' : ''}" data-session-id="${escapeAttr(session.id)}" type="button">
      <span class="dc-session-item-title">${escapeHtml(getSessionLabel(session))}</span>
      <span class="dc-session-item-meta">${escapeHtml(formatSessionMeta(session))}</span>
    </button>
  `).join('');

  sessionListEl.querySelectorAll('.dc-session-item').forEach((btn) => {
    btn.addEventListener('click', () => selectSession(btn.dataset.sessionId));
  });
}

async function selectSession(sessionId) {
  if (!sessionId) return;
  activeChatSessionId = sessionId;
  await loadSessionMessages(sessionId);
  updateSessionTitle();
  renderMessages();
  renderSessionList(sessionSearchEl?.value || '');
  isSessionMenuOpen = false;
  syncSessionMenuVisibility();
}

async function createNewSession() {
  if (!activeChatAgent) return;
  try {
    const res = await fetch(`${BASE}/api/chat/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent: activeChatAgent, title: '' }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to create session');
    if (!sessionsByAgent[activeChatAgent]) sessionsByAgent[activeChatAgent] = [];
    sessionsByAgent[activeChatAgent] = [data.session, ...sessionsByAgent[activeChatAgent].filter((item) => item.id !== data.session.id)];
    activeChatSessionId = data.session.id;
    chatHistory[activeChatSessionId] = [];
    updateSessionTitle('New session');
    renderMessages();
    renderSessionList(sessionSearchEl?.value || '');
    isSessionMenuOpen = false;
    syncSessionMenuVisibility();
    messageInputEl?.focus();
  } catch (err) {
    terminal.log(`[chat] New session failed: ${err.message}`, 'error', true);
  }
}

async function sendMessage() {
  if (!activeChatAgent) return;
  const text = String(messageInputEl?.value || '').trim();
  if (!text) return;

  const historyKey = getActiveHistoryKey();
  const files = selectedFileIds.map((id) => fileLibrary.find((item) => item.id === id)).filter(Boolean);
  addMessage(historyKey, { role: 'user', text, kind: 'text', files });
  addMessage(historyKey, { role: 'agent', kind: 'typing', text: '' });
  pendingByAgent[activeChatAgent] = true;
  messageInputEl.value = '';
  renderMessages();

  const agentLabel = getAgent(activeChatAgent).label;
  terminal.log(`[you → ${agentLabel}] ${text}`, 'agent', true);

  try {
    const payload = activeChatSessionId
      ? { message: text, sessionId: activeChatSessionId, fileIds: selectedFileIds }
      : { message: text, agent: activeChatAgent, fileIds: selectedFileIds };

    const res = await fetch(`${BASE}/api/chat/direct`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Failed to send');

    if (data.session?.id) {
      activeChatSessionId = data.session.id;
      await loadAgentSessions(activeChatAgent);
      updateSessionTitle();
    }

    if (data.message?.id && data.response?.id) {
      const activeKey = getActiveHistoryKey();
      const history = ensureHistory(activeKey);
      if (history.length >= 2) {
        history[history.length - 2] = {
          id: data.message.id,
          role: 'user',
          kind: 'text',
          text,
          timestamp: data.message.timestamp ? new Date(data.message.timestamp).getTime() : history[history.length - 2].timestamp,
          files,
        };
        history[history.length - 1] = {
          id: data.response.id,
          role: 'agent',
          kind: 'text',
          text: data.response.text || '',
          timestamp: data.response.timestamp ? new Date(data.response.timestamp).getTime() : Date.now(),
          files: Array.isArray(data.response.meta?.files) ? data.response.meta.files : [],
        };
      }
      renderMessages();
      renderSessionList(sessionSearchEl?.value || '');
    }
  } catch (err) {
    pendingByAgent[activeChatAgent] = false;
    removeTypingMessage(historyKey);
    addMessage(historyKey, { role: 'agent', text: `Error: ${err.message}`, kind: 'error' });
    renderMessages();
    terminal.log(`[chat] Error: ${err.message}`, 'error', true);
  }
}

export function handleChatEvent(msg) {
  const { type, data } = msg || {};
  const agentId = data?.agent;
  if (!agentId || !pendingByAgent[agentId]) return;
  if (agentId !== activeChatAgent) return;

  const historyKey = getActiveHistoryKey();

  if (type === 'agent:thinking') {
    if (agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:tool_use') {
    removeTypingMessage(historyKey);
    addMessage(historyKey, {
      role: 'agent',
      kind: 'tool',
      text: `${data.tool || 'tool'}(${shortenToolInput(data.input)})`,
    });
    addMessage(historyKey, { role: 'agent', kind: 'typing', text: '' });
    if (agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:responding' && data?.message) {
    pendingByAgent[agentId] = false;
    removeTypingMessage(historyKey);
    const history = ensureHistory(historyKey);
    const last = history[history.length - 1];
    if (!last || last.text !== data.message || last.kind === 'typing') {
      addMessage(historyKey, { role: 'agent', kind: 'text', text: data.message });
    }
    if (agentId === activeChatAgent) renderMessages();
    return;
  }

  if (type === 'agent:error') {
    pendingByAgent[agentId] = false;
    removeTypingMessage(historyKey);
    addMessage(historyKey, { role: 'agent', kind: 'error', text: `Error: ${data.message || 'Unknown error'}` });
    if (agentId === activeChatAgent) renderMessages();
  }
}

function shortenToolInput(input) {
  const text = String(input || '').replace(/\s+/g, ' ').trim();
  return text.length > 40 ? `${text.slice(0, 39)}…` : text;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderImmersionText(value = '') {
  const source = String(value || '');
  const placeholders = [];
  const stash = (html) => {
    const token = `\u0000${placeholders.length}\u0000`;
    placeholders.push(html);
    return token;
  };

  let text = escapeHtml(source);
  text = text.replace(/`([^`\n]+?)`/g, (_, content) => stash(`<code class="dc-immersion-code">${content}</code>`));
  text = text.replace(/\*\*\*([\s\S]+?)\*\*\*/g, (_, content) => stash(`<strong class="dc-immersion-strong"><em class="dc-immersion-action dc-immersion-action-strong">${content}</em></strong>`));
  text = text.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, (_, content) => stash(`<strong class="dc-immersion-strong">${content}</strong>`));
  text = text.replace(/(^|[\s([{“"'—-])\*([^*\n][\s\S]*?[^*\n])\*(?=$|[\s.,!?;:)}\]”"'—-])/g, (match, prefix, content) => `${prefix}${stash(`<em class="dc-immersion-action">${content}</em>`)}`);
  text = text.replace(/\n/g, '<br>');

  return placeholders.reduce((html, replacement, index) => html.replaceAll(`\u0000${index}\u0000`, replacement), text);
}

function escapeAttr(text) {
  return escapeHtml(String(text || '')).replace(/"/g, '&quot;');
}

function formatTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatBytes(bytes = 0) {
  const value = Number(bytes || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

export function setRoster(nextRoster = { agents: [], primaryAgentId: 'main' }) {
  roster = nextRoster || { agents: [], primaryAgentId: 'main' };
  renderAgentList();
  if (activeChatAgent) {
    const agent = getAgent(activeChatAgent);
    const companionCanvas = panelEl?.querySelector('.dc-agent-companion');
    applyAgentTheme(agent);
    if (panelEl?.querySelector('.dc-agent-name')) {
      panelEl.querySelector('.dc-agent-name').textContent = agent.label;
      panelEl.querySelector('.dc-agent-name').style.color = agent.color;
    }
    if (agent.visual?.mode === 'companion') {
      companionCanvas?.classList.remove('hidden');
      companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
    } else {
      companionCanvas?.classList.add('hidden');
    }
  }
}

export function setCompanionData(visuals = {}, items = []) {
  companionVisuals = visuals || {};
  companionItems = items || [];
  companions.setCompanionData({ visuals: companionVisuals, items: companionItems });
  renderAgentList();
  if (activeChatAgent) {
    const agent = getAgent(activeChatAgent);
    const companionCanvas = panelEl?.querySelector('.dc-agent-companion');
    applyAgentTheme(agent);
    if (agent.visual?.mode === 'companion') {
      companionCanvas?.classList.remove('hidden');
      companions.mountCompanionCanvas(companionCanvas, { agentId: agent.id, state: 'idle' });
    } else {
      companionCanvas?.classList.add('hidden');
    }
  }
}

export function open() {
  openChatPanel();
}

export function isOpen() {
  return isChatOpen;
}

export function getActiveAgent() {
  return activeChatAgent;
}
