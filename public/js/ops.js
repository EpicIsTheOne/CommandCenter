// Command Center Ops: Spaces, live overview, machines, harnesses, and the
// 2D <-> 3D mode bridge. All data comes from the server; nothing is faked.
// Switching modes never reloads backend state — it only swaps the renderer.
const BASE = window.__BASE_PATH__ || '';

const state = {
  initialized: false,
  overview: null,
  currentSpaceId: localStorage.getItem('commandcenter.currentSpaceId') || '',
  mode: localStorage.getItem('commandcenter.displayMode') || '2d',
  selectedRef: null,
  tab: 'agents',
  lastFetchAt: 0,
  fetchInFlight: null,
  scene: null,
  listeners: new Set(),
};

function el(id) {
  return document.getElementById(id);
}

export function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(path, options = {}) {
  const response = await fetch(`${BASE}${path}`, {
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { 'content-type': 'application/json' },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `Request failed (${response.status})`);
    error.code = payload?.code || 'OPS_ERROR';
    error.status = response.status;
    throw error;
  }
  return payload;
}

let retryTimer = null;

function applyOverviewPayload(payload) {
  state.overview = payload;
  state.lastFetchAt = Date.now();
  if (!state.currentSpaceId && payload.spaces?.length) {
    setCurrentSpace(payload.spaces[0].id, { persist: true, broadcast: false });
  }
  renderAll();
  emit({ type: 'overview' });
  syncScene();
}

function scheduleRetry() {
  // Boot polling: retry with a raw fetch until the first successful overview,
  // then stop. Covers the pre-auth window (the operator may log in much later)
  // and transient backend restarts. Uses its own fetch + direct state apply so
  // it cannot be defeated by in-flight/throttle bookkeeping.
  if (retryTimer || typeof document === 'undefined' || state.overview) return;
  retryTimer = setInterval(async () => {
    if (state.overview) {
      clearInterval(retryTimer);
      retryTimer = null;
      return;
    }
    if (document.hidden) return;
    try {
      const response = await fetch(`${BASE}/api/overview`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const payload = await response.json();
      if (payload?.ok) {
        applyOverviewPayload(payload);
        clearInterval(retryTimer);
        retryTimer = null;
      }
    } catch {}
  }, 5000);
}

export function onChange(listener) {
  state.listeners.add(listener);
  return () => state.listeners.delete(listener);
}

function emit(change = {}) {
  for (const listener of state.listeners) {
    try { listener({ ...change, state }); } catch {}
  }
}

// ---------- Data ----------
export async function refreshOverview({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - state.lastFetchAt < 4000) return state.overview;
  if (state.fetchInFlight) return state.fetchInFlight;
  state.fetchInFlight = api('/api/overview')
    .then((payload) => {
      applyOverviewPayload(payload);
      return payload;
    })
    .catch((error) => {
      if (error?.status === 401 || error?.status === 403) scheduleRetry();
      throw error;
    })
    .finally(() => { state.fetchInFlight = null; });
  return state.fetchInFlight;
}

export function getOverview() {
  return state.overview;
}

export function getCurrentSpace() {
  const overview = state.overview;
  if (!overview) return null;
  return overview.spaces.find((space) => space.id === state.currentSpaceId) || null;
}

export async function setCurrentSpace(spaceId, { persist = true, broadcast = true } = {}) {
  state.currentSpaceId = String(spaceId || '');
  if (persist) localStorage.setItem('commandcenter.currentSpaceId', state.currentSpaceId);
  if (broadcast) api('/api/spaces/current', { method: 'POST', body: { id: state.currentSpaceId } }).catch(() => {});
  emit({ type: 'space-changed' });
  syncScene();
}

export async function createSpace(input) {
  const result = await api('/api/spaces', { method: 'POST', body: input });
  await refreshOverview({ force: true });
  await setCurrentSpace(result.space.id);
  return result.space;
}

export async function attachMember(kind, ids) {
  const space = getCurrentSpace();
  if (!space) throw new Error('No current Space');
  return api(`/api/spaces/${encodeURIComponent(space.id)}/members/${kind}`, { method: 'POST', body: { ids } });
}

export async function detachMember(kind, id) {
  const space = getCurrentSpace();
  if (!space) throw new Error('No current Space');
  return api(`/api/spaces/${encodeURIComponent(space.id)}/members/${kind}`, { method: 'DELETE', body: { ids: [id] } });
}

export async function searchAll(query) {
  return api(`/api/search?q=${encodeURIComponent(String(query || ''))}`);
}

export function setMode(mode) {
  if (!['2d', '3d'].includes(mode)) return;
  state.mode = mode;
  localStorage.setItem('commandcenter.displayMode', mode);
  applyMode();
  emit({ type: 'mode-changed' });
}

export function getMode() {
  return state.mode;
}

export function select(ref) {
  state.selectedRef = ref;
  emit({ type: 'selection' });
  renderInspector();
}

// ---------- Live events (from the existing WS bus) ----------
let eventThrottleTimer = null;

export function handleWsEvent(message = {}) {
  if (message.type === 'control:event') {
    const resourceType = message.data?.resourceType || '';
    if (resourceType === 'task') {
      clearTimeout(eventThrottleTimer);
      eventThrottleTimer = setTimeout(() => refreshOverview({ force: true }), 900);
    }
    return;
  }
  if (message.type === 'spaces:changed' || message.type === 'relay:roster_updated') {
    clearTimeout(eventThrottleTimer);
    eventThrottleTimer = setTimeout(() => refreshOverview({ force: true }), 600);
    return;
  }
  if (message.type === 'agent:idle' || message.type === 'agent:thinking' || message.type === 'agent:responding' || message.type === 'agent:tool_use') {
    // Agent states ride along in the next throttled refresh; update local copy fast
    const agentId = message.data?.agent;
    const mapState = { 'agent:idle': 'idle', 'agent:thinking': 'thinking', 'agent:responding': 'responding', 'agent:tool_use': 'tool_use' };
    if (agentId && state.overview) {
      const agent = state.overview.agents.find((entry) => entry.id === agentId);
      if (agent) {
        agent.state = mapState[message.type] || agent.state;
        emit({ type: 'overview' });
        syncScene();
      }
    }
  }
}

// ---------- Rendering ----------
const AGENT_STATE_TONES = {
  idle: 'idle', thinking: 'active', coding: 'active', tool_use: 'active',
  responding: 'complete', working: 'active', blocked: 'warn', failed: 'error',
  completed: 'complete', disconnected: 'idle',
};

function agentTone(agent) {
  return AGENT_STATE_TONES[String(agent.state || '').toLowerCase()] || 'idle';
}

function renderSpaces() {
  const host = el('ops-spaces-list');
  if (!host) return;
  const overview = state.overview;
  if (!overview) { host.innerHTML = '<div class="ops-empty">Loading Spaces…</div>'; return; }
  if (!overview.spaces.length) {
    host.innerHTML = '<div class="ops-empty">No Spaces yet. Create your first operating environment.</div>';
    return;
  }
  const taskCounts = overview.counts ? {} : {};
  host.innerHTML = overview.spaces.map((space) => {
    const memberCount = Object.values(space.members).reduce((sum, m) => sum + m.ids.length, 0);
    const active = space.id === state.currentSpaceId ? 'active' : '';
    const accent = space.accent ? `style="--space-accent:${escapeHtml(space.accent)}"` : '';
    return `<button type="button" class="ops-space-row ${active}" ${accent} data-space-id="${escapeHtml(space.id)}" title="${escapeHtml(space.summary || '')}">
      <span class="ops-space-dot"></span>
      <span class="ops-space-name">${escapeHtml(space.name)}</span>
      <span class="ops-space-meta">${memberCount} linked</span>
    </button>`;
  }).join('');
}

function renderAgents() {
  const host = el('ops-agents-list');
  if (!host) return;
  const overview = state.overview;
  if (!overview) { host.innerHTML = '<div class="ops-empty">Loading…</div>'; return; }
  if (!overview.agents.length) {
    host.innerHTML = '<div class="ops-empty">No agents detected. Enable a harness or connect a relay client.</div>';
    return;
  }
  host.innerHTML = overview.agents.map((agent) => `
    <button type="button" class="ops-agent-row tone-${agentTone(agent)} ${state.selectedRef?.kind === 'agent' && state.selectedRef?.id === agent.id ? 'selected' : ''}" data-agent-id="${escapeHtml(agent.id)}">
      <span class="ops-state-dot"></span>
      <span class="ops-agent-main">
        <strong>${escapeHtml(agent.label)}</strong>
        <small>${escapeHtml(agent.source)}${agent.profile ? ' · ' + escapeHtml(agent.profile) : ''}${agent.model ? ' · ' + escapeHtml(agent.model) : ''}</small>
      </span>
      <span class="ops-agent-state">${escapeHtml(String(agent.state || 'idle').replace(/_/g, ' ').toUpperCase())}</span>
    </button>`).join('');
}

function renderTasks() {
  const host = el('ops-tasks-list');
  if (!host) return;
  const overview = state.overview;
  if (!overview) { host.innerHTML = '<div class="ops-empty">Loading…</div>'; return; }
  if (!overview.tasks.length) {
    host.innerHTML = '<div class="ops-empty">No tasks yet. Queue work from the Control Plane or launch an agent.</div>';
    return;
  }
  const tones = { running: 'active', queued: 'active', created: 'active', retrying: 'warn', waiting_for_approval: 'warn', blocked: 'warn', failed: 'error', cancelled: 'idle', completed: 'complete' };
  host.innerHTML = overview.tasks.slice().reverse().slice(0, 30).map((task) => `
    <button type="button" class="ops-task-row tone-${tones[task.state] || 'idle'} ${state.selectedRef?.kind === 'task' && state.selectedRef?.id === task.id ? 'selected' : ''}" data-task-id="${escapeHtml(task.id)}">
      <span class="ops-state-dot"></span>
      <span class="ops-task-main">
        <strong>${escapeHtml(task.title || task.id)}</strong>
        <small>${escapeHtml(task.agent || '')}${task.spaceId ? ' · ' + escapeHtml(spaceName(task.spaceId)) : ''}</small>
      </span>
      <span class="ops-agent-state">${escapeHtml(String(task.state || '').replace(/_/g, ' ').toUpperCase())}</span>
    </button>`).join('');
}

function spaceName(id) {
  return state.overview?.spaces.find((space) => space.id === id)?.name || id;
}

function fmtBytes(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let unitIndex = 0;
  let scaled = num;
  while (scaled >= 1024 && unitIndex < units.length - 1) { scaled /= 1024; unitIndex++; }
  return `${scaled.toFixed(scaled >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function renderMachines() {
  const host = el('ops-machines-list');
  if (!host) return;
  const overview = state.overview;
  if (!overview) { host.innerHTML = '<div class="ops-empty">Loading…</div>'; return; }
  host.innerHTML = overview.machines.map((machine) => `
    <div class="ops-machine-card ${machine.online ? '' : 'offline'} ${state.selectedRef?.kind === 'machine' && state.selectedRef?.id === machine.id ? 'selected' : ''}" data-machine-id="${escapeHtml(machine.id)}" role="button" tabindex="0">
      <div class="ops-machine-head"><strong>${escapeHtml(machine.label)}</strong><span class="ops-agent-state">${machine.online ? 'ONLINE' : 'OFFLINE'}</span></div>
      <div class="ops-meter"><label>CPU</label><div class="ops-meter-track"><div class="ops-meter-fill" style="width:${machine.cpuPercent ?? 0}%"></div></div><span>${machine.cpuPercent ?? 'n/a'}%</span></div>
      <div class="ops-meter"><label>MEM</label><div class="ops-meter-track"><div class="ops-meter-fill" style="width:${machine.memPercent ?? 0}%"></div></div><span>${machine.memPercent != null ? machine.memPercent + '%' : 'n/a'}</span></div>
      <div class="ops-machine-meta">${escapeHtml(machine.platformOs || '')} ${machine.cpuCores ? '· ' + machine.cpuCores + ' cores' : ''} · up ${machine.uptimeSeconds != null ? Math.round(machine.uptimeSeconds / 3600) + 'h' : '—'}</div>
      ${machine.disk?.drives?.length ? `<div class="ops-machine-disks">${machine.disk.drives.map((drive) => `<span title="${fmtBytes(drive.sizeBytes)} total">${escapeHtml(drive.caption)} ${drive.usedPercent != null ? drive.usedPercent + '%' : ''}</span>`).join('')}</div>` : ''}
      ${machine.note ? `<div class="ops-machine-note">${escapeHtml(machine.note)}</div>` : ''}
    </div>`).join('');
}

function renderHarnesses() {
  const host = el('ops-harnesses-list');
  if (!host) return;
  const overview = state.overview;
  if (!overview) { host.innerHTML = '<div class="ops-empty">Loading…</div>'; return; }
  host.innerHTML = overview.harnesses.map((harness) => `
    <div class="ops-harness-card">
      <div class="ops-machine-head"><strong>${escapeHtml(harness.label)}</strong><span class="ops-agent-state">${harness.available ? (harness.connected ? 'CONNECTED' : 'AVAILABLE') : 'UNAVAILABLE'}</span></div>
      <div class="ops-machine-meta">${escapeHtml(harness.detail || harness.kind)}</div>
      ${(harness.agents || []).map((agent) => `<div class="ops-harness-agent">· ${escapeHtml(agent.label)}${agent.model ? ` — ${escapeHtml(agent.model)}` : ''}${agent.stateDbPresent ? '' : ' (no session db)'}</div>`).join('')}
      <div class="ops-machine-meta caps">launch: ${harness.capabilities.launchSession ? 'yes' : 'no'} · steer: ${harness.capabilities.steer ? 'yes' : 'no'}</div>
    </div>`).join('');
}

function renderInspector() {
  const host = el('ops-inspector-body');
  if (!host) return;
  const ref = state.selectedRef;
  if (!ref) {
    host.innerHTML = '<div class="ops-empty">Select an agent, task, or machine to inspect it.<br/><br/>Tip: press <kbd>Ctrl</kbd>+<kbd>K</kbd> for the command palette.</div>';
    return;
  }
  const overview = state.overview;
  if (ref.kind === 'agent') {
    const agent = overview?.agents.find((entry) => entry.id === ref.id);
    if (!agent) { host.innerHTML = '<div class="ops-empty">Agent no longer visible.</div>'; return; }
    const tasksForAgent = (overview?.tasks || []).filter((task) => task.agent === agent.id && !['completed', 'cancelled', 'failed'].includes(task.state));
    host.innerHTML = `
      <h4>${escapeHtml(agent.label)}</h4>
      <dl class="ops-kv">
        <dt>Harness</dt><dd>${escapeHtml(agent.source)}${agent.profile ? ' · ' + escapeHtml(agent.profile) : ''}</dd>
        <dt>Model</dt><dd>${agent.model ? escapeHtml(agent.model) : '<em>unknown</em>'}</dd>
        <dt>State</dt><dd>${escapeHtml(String(agent.state || 'idle').toUpperCase())}</dd>
        <dt>Online</dt><dd>${agent.online ? 'yes' : 'no'}</dd>
        <dt>Active tasks</dt><dd>${tasksForAgent.length}</dd>
      </dl>
      ${tasksForAgent.slice(0, 5).map((task) => `<div class="ops-harness-agent">▸ ${escapeHtml(task.title)} — ${escapeHtml(task.state)}</div>`).join('')}
      <div class="ops-inspector-actions">
        <button type="button" class="secondary-button" data-ops-action="attach-agent" data-id="${escapeHtml(agent.id)}">ATTACH TO SPACE</button>
      </div>`;
    return;
  }
  if (ref.kind === 'task') {
    const task = overview?.tasks.find((entry) => entry.id === ref.id);
    if (!task) { host.innerHTML = '<div class="ops-empty">Task no longer visible.</div>'; return; }
    host.innerHTML = `
      <h4>${escapeHtml(task.title || task.id)}</h4>
      <dl class="ops-kv">
        <dt>State</dt><dd>${escapeHtml(String(task.state || '').toUpperCase())}</dd>
        <dt>Agent</dt><dd>${escapeHtml(task.agent || '—')}</dd>
        <dt>Space</dt><dd>${task.spaceId ? escapeHtml(spaceName(task.spaceId)) : '<em>unassigned</em>'}</dd>
        <dt>Machine</dt><dd>${task.machineId ? escapeHtml(task.machineId) : '<em>unassigned</em>'}</dd>
        <dt>Updated</dt><dd>${escapeHtml(String(task.updatedAt || '').replace('T', ' ').slice(0, 19))}</dd>
      </dl>
      <p class="ops-summary">${escapeHtml(task.summary || 'No summary yet.')}</p>
      <div class="ops-inspector-actions">
        ${task.spaceId ? '' : `<button type="button" class="secondary-button" data-ops-action="attach-task" data-id="${escapeHtml(task.id)}">ATTACH TO SPACE</button>`}
      </div>`;
    return;
  }
  if (ref.kind === 'machine') {
    const machine = overview?.machines.find((entry) => entry.id === ref.id);
    if (!machine) { host.innerHTML = '<div class="ops-empty">Machine no longer visible.</div>'; return; }
    host.innerHTML = `
      <h4>${escapeHtml(machine.label)}</h4>
      <dl class="ops-kv">
        <dt>Status</dt><dd>${machine.online ? 'online' : 'offline'}</dd>
        <dt>Platform</dt><dd>${escapeHtml(machine.platformOs || '—')}</dd>
        <dt>CPU</dt><dd>${machine.cpuModel ? escapeHtml(machine.cpuModel) : '—'} ${machine.cpuCores ? `(${machine.cpuCores} cores)` : ''}</dd>
        <dt>Load</dt><dd>${machine.cpuPercent ?? 'n/a'}% cpu · ${machine.memPercent ?? 'n/a'}% mem</dd>
        <dt>Memory</dt><dd>${machine.memTotalBytes ? `${fmtBytes(machine.memTotalBytes - machine.memFreeBytes)} / ${fmtBytes(machine.memTotalBytes)}` : '—'}</dd>
        <dt>Uptime</dt><dd>${machine.uptimeSeconds != null ? Math.round(machine.uptimeSeconds / 3600) + ' h' : '—'}</dd>
      </dl>
      <div class="ops-inspector-actions">
        <button type="button" class="secondary-button" data-ops-action="attach-machine" data-id="${escapeHtml(machine.id)}">ATTACH TO SPACE</button>
      </div>`;
  }
}

function renderCounts() {
  const counts = state.overview?.counts;
  const node = el('ops-count-line');
  if (!node || !counts) return;
  node.textContent = `${counts.spaces} spaces · ${counts.agents} agents · ${counts.activeTasks} active tasks · ${counts.machines} machines`;
}

function renderModeButtons() {
  for (const button of document.querySelectorAll('[data-ops-mode]')) {
    button.classList.toggle('active', button.dataset.opsMode === state.mode);
    button.setAttribute('aria-pressed', String(button.dataset.opsMode === state.mode));
  }
}

export function renderAll() {
  renderSpaces();
  renderTab();
  renderCounts();
  renderInspector();
  renderModeButtons();
  const spaceNameNode = el('ops-current-space-name');
  const currentSpace = getCurrentSpace();
  if (spaceNameNode && currentSpace) spaceNameNode.textContent = currentSpace.name;
}

function renderTab() {
  const tabs = ['agents', 'tasks', 'machines', 'harnesses'];
  for (const tab of tabs) {
    const panel = el(`ops-tab-${tab}`);
    if (panel) panel.classList.toggle('hidden', state.tab !== tab);
    const button = el(`ops-tab-btn-${tab}`);
    if (button) button.classList.toggle('active', state.tab === tab);
  }
  if (state.tab === 'agents') renderAgents();
  if (state.tab === 'tasks') renderTasks();
  if (state.tab === 'machines') renderMachines();
  if (state.tab === 'harnesses') renderHarnesses();
}

export function setTab(tab) {
  if (!['agents', 'tasks', 'machines', 'harnesses'].includes(tab)) return;
  state.tab = tab;
  renderTab();
}

// ---------- 3D bridge ----------
async function ensureScene() {
  if (state.scene || state.sceneFailed) return state.scene;
  try {
    const mod = await import('./cc3d.js');
    const container = el('cc3d-viewport') || el('zone-space3d');
    if (!container) return null;
    state.scene = new mod.SpaceScene({
      container,
      onSelect: (ref) => select(ref),
    });
    applyMode();
    return state.scene;
  } catch (error) {
    console.error('[ops] 3D scene unavailable:', error);
    state.sceneFailed = true;
    const fallback = el('cc3d-fallback');
    if (fallback) fallback.classList.remove('hidden');
    return null;
  }
}

function syncScene() {
  if (!state.scene) return;
  state.scene.setData(state.overview || {});
  state.scene.setCurrentSpace(state.currentSpaceId);
}

function applyMode() {
  const zone3d = el('zone-space3d');
  const zoneOffice = el('zone-office');
  if (zone3d) zone3d.classList.toggle('hidden', state.mode !== '3d');
  if (zoneOffice) zoneOffice.classList.toggle('hidden', state.mode === '3d');
  if (state.mode === '3d') {
    ensureScene()
      .then((scene) => {
        if (!scene) return;
        scene.setVisible(true);
        syncScene();
      })
      .catch((error) => {
        console.error('[ops] 3D scene failed:', error);
        state.sceneFailed = true;
        const badge = el('cc3d-perf');
        if (badge) badge.textContent = `3D unavailable: ${String(error?.message || error).slice(0, 80)}`;
        const fallback = el('cc3d-fallback');
        if (fallback) {
          fallback.textContent = `3D could not start here (${String(error?.message || error).slice(0, 120)}). 2D mode has everything.`;
          fallback.classList.remove('hidden');
        }
      });
  } else if (state.scene) {
    state.scene.setVisible(false); // stops RAF loop entirely; GPU rests
  }
}

// ---------- Wiring ----------
async function handleCreateSpace() {
  const input = el('ops-new-space-name');
  const name = String(input?.value || '').trim();
  if (!name) return;
  try {
    await createSpace({ name });
    if (input) input.value = '';
  } catch (error) {
    setStatus(error.message, 'error');
  }
}

function setStatus(message, tone = 'info') {
  const node = el('ops-status');
  if (!node) return;
  node.textContent = String(message || '');
  node.dataset.tone = tone;
  setTimeout(() => { if (node.textContent === message) node.textContent = ''; }, 5000);
}

function bindEvents() {
  el('ops-new-space-btn')?.addEventListener('click', handleCreateSpace);
  el('ops-panel-toggle')?.addEventListener('click', () => {
    const panel = el('ops-spaces-panel');
    if (!panel) return;
    const hidden = panel.classList.toggle('hidden');
    el('ops-panel-toggle').setAttribute('aria-expanded', String(!hidden));
    if (!hidden) refreshOverview({ force: true });
  });
  el('ops-new-space-name')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleCreateSpace(); }
  });

  el('ops-spaces-list')?.addEventListener('click', (event) => {
    const row = event.target.closest('[data-space-id]');
    if (row) setCurrentSpace(row.dataset.spaceId);
  });

  for (const tab of ['agents', 'tasks', 'machines', 'harnesses']) {
    el(`ops-tab-btn-${tab}`)?.addEventListener('click', () => setTab(tab));
  }

  const listClicks = [
    [el('ops-tab-agents'), '[data-agent-id]', (id) => select({ kind: 'agent', id })],
    [el('ops-tab-tasks'), '[data-task-id]', (id) => select({ kind: 'task', id })],
  ];
  for (const [host, selector, handler] of listClicks) {
    host?.addEventListener('click', (event) => {
      const row = event.target.closest(selector);
      if (row) handler(row.dataset.agentId || row.dataset.taskId);
    });
  }

  const machinesHost = el('ops-machines-list');
  machinesHost?.addEventListener('click', (event) => {
    const card = event.target.closest('[data-machine-id]');
    if (card) select({ kind: 'machine', id: card.dataset.machineId });
  });

  el('ops-inspector-body')?.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ops-action]');
    if (!button) return;
    const action = button.dataset.opsAction;
    const id = button.dataset.id;
    try {
      if (action === 'attach-agent') await attachMember('agents', [{ id }]);
      else if (action === 'attach-machine') await attachMember('machines', [{ id }]);
      else if (action === 'attach-task') await attachMember('tasks', [{ id }]);
      else return;
      setStatus('Attached to current Space.', 'ok');
      await refreshOverview({ force: true });
      renderInspector();
    } catch (error) {
      setStatus(error.message, 'error');
    }
  });

  for (const button of document.querySelectorAll('[data-ops-mode]')) {
    button.addEventListener('click', () => setMode(button.dataset.opsMode));
  }

  window.addEventListener('focus', () => refreshOverview());
}

export async function init() {
  if (state.initialized) return;
  state.initialized = true;
  bindEvents();
  renderAll();
  await refreshOverview({ force: true }).catch(() => {});
}

// Self-boot: these surfaces must work even if the host app's bootstrap
// stalls (e.g. blocked on the auth modal). Fetches retry after login via
// focus/WS events, so binding early is safe.
if (typeof document !== 'undefined') {
  const boot = () => { init().catch(() => {}); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
