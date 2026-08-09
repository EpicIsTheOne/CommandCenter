let BASE = '';
let fetchJsonImpl = null;
let roster = { agents: [], primaryAgentId: 'main' };
let messages = [];
let initialized = false;
let statusFn = null;

function byId(id) {
  return document.getElementById(id);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTime(value = '') {
  const ts = Date.parse(value || '');
  if (!Number.isFinite(ts)) return 'unknown time';
  const date = new Date(ts);
  return date.toLocaleString();
}

function agentOptionsHtml(selected = '', includeBlank = false) {
  const agents = Array.isArray(roster?.agents) ? roster.agents : [];
  const options = agents.map((agent) => `<option value="${escapeHtml(agent.id)}" ${agent.id === selected ? 'selected' : ''}>${escapeHtml(agent.label || agent.id)} (${escapeHtml(agent.source === 'hermes' ? 'Hermes' : 'OpenClaw')})</option>`);
  if (includeBlank) options.unshift('<option value="">Any</option>');
  return options.join('');
}

function setStatus(text = '', isError = false) {
  const el = byId('agent-comms-status');
  if (el) {
    el.textContent = text;
    el.style.color = isError ? 'var(--red)' : 'var(--text-dim)';
  }
  if (typeof statusFn === 'function') statusFn(text, isError);
}

function currentFilters() {
  return {
    fromAgent: String(byId('agent-comms-filter-from')?.value || '').trim(),
    toAgent: String(byId('agent-comms-filter-to')?.value || '').trim(),
    scopeType: String(byId('agent-comms-filter-scope-type')?.value || '').trim(),
    scopeId: String(byId('agent-comms-filter-scope-id')?.value || '').trim(),
    unreadFor: String(byId('agent-comms-filter-unread-for')?.value || '').trim(),
    limit: 100,
  };
}

function renderFilters() {
  const primary = roster?.primaryAgentId || roster?.agents?.[0]?.id || '';
  const from = byId('agent-comms-filter-from');
  const to = byId('agent-comms-filter-to');
  const unread = byId('agent-comms-filter-unread-for');
  const sender = byId('agent-comms-from-agent');
  const receiver = byId('agent-comms-to-agent');
  if (from) from.innerHTML = agentOptionsHtml(from.value, true);
  if (to) to.innerHTML = agentOptionsHtml(to.value, true);
  if (unread) unread.innerHTML = ['<option value="">Anyone</option>', agentOptionsHtml(unread.value, false)].join('');
  if (sender) {
    sender.innerHTML = agentOptionsHtml(sender.value || primary, false);
    if (!sender.value && primary) sender.value = primary;
  }
  if (receiver) receiver.innerHTML = agentOptionsHtml(receiver.value, false);
}

function renderMessages() {
  const listEl = byId('agent-comms-list');
  if (!listEl) return;
  if (!messages.length) {
    listEl.innerHTML = '<div class="setting-hint">No internal comms yet. Apparently the girls are being quiet. Suspicious.</div>';
    return;
  }
  listEl.innerHTML = messages.slice().reverse().map((entry) => {
    const fromRuntime = entry.fromRuntime === 'hermes' ? 'Hermes' : 'OpenClaw';
    const toRuntime = entry.toRuntime === 'hermes' ? 'Hermes' : 'OpenClaw';
    const scopeLabel = entry.scopeType === 'global' ? 'global' : `${entry.scopeType} · ${entry.scopeId || '—'}`;
    return `
      <div class="agent-comms-card">
        <div class="agent-comms-meta-row">
          <div><strong>${escapeHtml(entry.fromLabel || entry.fromAgent)}</strong> <span class="agent-comms-runtime">${escapeHtml(fromRuntime)}</span> → <strong>${escapeHtml(entry.toLabel || entry.toAgent)}</strong> <span class="agent-comms-runtime">${escapeHtml(toRuntime)}</span></div>
          <div class="agent-comms-time">${escapeHtml(formatTime(entry.createdAt))}</div>
        </div>
        <div class="agent-comms-meta-row">
          <span class="agent-comms-pill">${escapeHtml(entry.type || 'note')}</span>
          <span class="agent-comms-pill">${escapeHtml(scopeLabel)}</span>
          ${entry.threadId ? `<span class="agent-comms-pill">thread · ${escapeHtml(entry.threadId)}</span>` : ''}
          ${entry.replyToId ? `<span class="agent-comms-pill">reply</span>` : ''}
          ${entry.source ? `<span class="agent-comms-pill">${escapeHtml(entry.source)}</span>` : ''}
        </div>
        <div class="agent-comms-text">${escapeHtml(entry.text || '')}</div>
        <div class="agent-comms-actions">
          <button class="secondary-button agent-comms-reply-btn" type="button" data-id="${escapeHtml(entry.id || '')}">ASK ${escapeHtml(entry.toLabel || entry.toAgent || 'AGENT')} TO REPLY</button>
        </div>
      </div>
    `;
  }).join('');
}

export async function loadAgentComms() {
  if (!fetchJsonImpl) return;
  const params = new URLSearchParams();
  const filters = currentFilters();
  for (const [key, value] of Object.entries(filters)) {
    if (value) params.set(key, String(value));
  }
  setStatus('Loading backchannel…');
  try {
    const data = await fetchJsonImpl(`${BASE}/api/agent-comms${params.toString() ? `?${params.toString()}` : ''}`);
    messages = Array.isArray(data.messages) ? data.messages : [];
    renderMessages();
    setStatus(`${messages.length} internal message${messages.length === 1 ? '' : 's'} loaded.`);
  } catch (err) {
    setStatus(err.message || 'Could not load agent comms.', true);
  }
}

async function sendAgentComm() {
  if (!fetchJsonImpl) return;
  const payload = {
    fromAgent: String(byId('agent-comms-from-agent')?.value || '').trim(),
    toAgent: String(byId('agent-comms-to-agent')?.value || '').trim(),
    type: String(byId('agent-comms-type')?.value || 'note').trim(),
    scopeType: String(byId('agent-comms-scope-type')?.value || 'global').trim(),
    scopeId: String(byId('agent-comms-scope-id')?.value || '').trim(),
    text: String(byId('agent-comms-text')?.value || '').trim(),
    source: 'manual-ui',
  };
  const sendBtn = byId('agent-comms-send-btn');
  if (sendBtn) sendBtn.disabled = true;
  setStatus('Sending internal comm…');
  try {
    await fetchJsonImpl(`${BASE}/api/agent-comms`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (byId('agent-comms-text')) byId('agent-comms-text').value = '';
    if (payload.scopeType === 'global' && byId('agent-comms-scope-id')) byId('agent-comms-scope-id').value = '';
    setStatus('Internal comm sent. Look at you, giving the dolls a private channel.');
    await loadAgentComms();
  } catch (err) {
    setStatus(err.message || 'Could not send internal comm.', true);
  } finally {
    if (sendBtn) sendBtn.disabled = false;
  }
}


async function askAgentReply(messageId = '', button = null) {
  if (!fetchJsonImpl || !messageId) return;
  if (button) button.disabled = true;
  setStatus('Asking recipient agent to reply privately…');
  try {
    const data = await fetchJsonImpl(`${BASE}/api/agent-comms/${encodeURIComponent(messageId)}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxThreadTurns: 12 }),
    });
    const reply = data?.message;
    if (reply?.id && !messages.some((item) => item.id === reply.id)) {
      messages.push(reply);
      messages = messages.slice(-100);
      renderMessages();
    }
    setStatus('Private reply generated and stored in the backchannel. Deliciously dangerous, but bounded.');
    await loadAgentComms();
  } catch (err) {
    setStatus(err.message || 'Could not generate private reply.', true);
  } finally {
    if (button) button.disabled = false;
  }
}

function bindEventsOnce() {
  if (initialized) return;
  initialized = true;
  byId('refresh-agent-comms-btn')?.addEventListener('click', () => loadAgentComms());
  byId('agent-comms-send-btn')?.addEventListener('click', () => sendAgentComm());
  byId('agent-comms-filter-from')?.addEventListener('change', () => loadAgentComms());
  byId('agent-comms-filter-to')?.addEventListener('change', () => loadAgentComms());
  byId('agent-comms-filter-scope-type')?.addEventListener('change', () => loadAgentComms());
  byId('agent-comms-filter-scope-id')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') loadAgentComms(); });
  byId('agent-comms-filter-unread-for')?.addEventListener('change', () => loadAgentComms());
  byId('agent-comms-list')?.addEventListener('click', (event) => {
    const btn = event.target?.closest?.('.agent-comms-reply-btn');
    if (!btn) return;
    const id = String(btn.dataset?.id || '').trim();
    askAgentReply(id, btn);
  });
  byId('agent-comms-scope-type')?.addEventListener('change', () => {
    const scopeType = String(byId('agent-comms-scope-type')?.value || 'global');
    const scopeId = byId('agent-comms-scope-id');
    if (scopeId) {
      scopeId.disabled = scopeType === 'global';
      if (scopeType === 'global') scopeId.value = '';
    }
  });
  byId('agent-comms-text')?.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      sendAgentComm();
    }
  });
}

export function setRoster(nextRoster = { agents: [], primaryAgentId: 'main' }) {
  roster = nextRoster || { agents: [], primaryAgentId: 'main' };
  renderFilters();
}

export function handleEvent(msg = {}) {
  const type = String(msg?.type || '');
  if (type === 'agent_comms:message') {
    const entry = msg?.data?.message;
    if (entry?.id && !messages.some((item) => item.id === entry.id)) {
      messages.push(entry);
      messages = messages.slice(-100);
      renderMessages();
      setStatus('New internal comm received. The backchannel is alive.');
    }
    return;
  }
  if (type === 'agent_comms:read') return;
}

export function initAgentComms({ base = '', fetchJson, initialRoster = { agents: [], primaryAgentId: 'main' }, onStatus } = {}) {
  BASE = base || '';
  fetchJsonImpl = fetchJson;
  roster = initialRoster || { agents: [], primaryAgentId: 'main' };
  statusFn = onStatus || null;
  renderFilters();
  bindEventsOnce();
  loadAgentComms().catch(() => {});
}
