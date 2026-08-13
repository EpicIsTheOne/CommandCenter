const state = {
  base: '',
  tasks: new Map(),
  approvals: new Map(),
  notifications: new Map(),
  agents: [],
  events: [],
  lastEventSequence: Number(localStorage.getItem('commandcenter.controlEventSequence') || 0) || 0,
  selectedTaskId: '',
  initialized: false,
};

function el(id) {
  return document.getElementById(id);
}

function text(value, max = 1200) {
  return String(value ?? '').trim().slice(0, max);
}

function operationId(prefix = 'ui') {
  if (globalThis.crypto?.randomUUID) return `${prefix}:${globalThis.crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

async function request(path, options = {}) {
  const response = await fetch(`${state.base}/api/control${path}`, {
    credentials: 'same-origin',
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  let payload = null;
  try { payload = await response.json(); } catch { payload = { ok: false, error: `HTTP ${response.status}` }; }
  if (!response.ok || payload?.ok === false) {
    const error = new Error(payload?.error || `Control-plane request failed (${response.status}).`);
    error.code = payload?.code || 'CONTROL_PLANE_ERROR';
    error.details = payload?.details || {};
    throw error;
  }
  return payload;
}

function setStatus(message, tone = 'info') {
  const node = el('control-plane-status');
  if (!node) return;
  node.textContent = text(message, 240);
  node.dataset.tone = tone;
}

function taskStateLabel(task = {}) {
  return text(task.state || task.status || 'unknown', 40).replace(/_/g, ' ').toUpperCase();
}

function taskTone(task = {}) {
  const stateValue = text(task.state || task.status).toLowerCase();
  if (['completed'].includes(stateValue)) return 'complete';
  if (['failed', 'cancelled'].includes(stateValue)) return 'error';
  if (['blocked', 'waiting_for_approval', 'cancelling'].includes(stateValue)) return 'warn';
  if (['running', 'queued', 'retrying', 'created'].includes(stateValue)) return 'active';
  return 'idle';
}

function applyTask(task) {
  if (!task?.id) return;
  state.tasks.set(task.id, { ...state.tasks.get(task.id), ...task });
  if (!state.selectedTaskId) state.selectedTaskId = task.id;
}

function applyEvent(event = {}, { render = true } = {}) {
  const sequence = Number(event.eventSequence || 0) || 0;
  if (sequence && sequence <= state.lastEventSequence) return false;
  if (sequence && state.lastEventSequence && sequence > state.lastEventSequence + 1) {
    request(`/events?afterEventSequence=${encodeURIComponent(state.lastEventSequence)}&limit=2000`).then((result) => {
      for (const missed of result.events || []) applyEvent(missed, { render: false });
      renderBoard();
    }).catch(() => {});
  }
  if (sequence) {
    state.lastEventSequence = sequence;
    localStorage.setItem('commandcenter.controlEventSequence', String(sequence));
  }
  if (event.resourceType === 'task' && event.resourceSnapshot) applyTask(event.resourceSnapshot);
  if (event.resourceType === 'approval' && event.resourceSnapshot?.id) state.approvals.set(event.resourceSnapshot.id, event.resourceSnapshot);
  if (event.resourceType === 'notification' && event.resourceSnapshot?.id) state.notifications.set(event.resourceSnapshot.id, event.resourceSnapshot);
  state.events.push(event);
  if (state.events.length > 200) state.events.splice(0, state.events.length - 200);
  if (render) renderBoard();
  return true;
}

function renderAgents() {
  const node = el('control-plane-agents');
  if (!node) return;
  node.innerHTML = state.agents.length
    ? state.agents.map((agent) => `
      <div class="control-agent-card">
        <div class="control-agent-name">${escapeHtml(agent.label || agent.name || agent.id)}</div>
        <div class="control-agent-meta">${escapeHtml(agent.runtime || agent.source || 'runtime')} · ${escapeHtml(agent.status || 'unknown')}</div>
        <div class="control-agent-meta">${escapeHtml((agent.capabilities || []).slice(0, 5).join(' · ') || 'status only')}</div>
      </div>`).join('')
    : '<div class="control-empty">No normalized agents visible yet.</div>';
}

function renderTasks() {
  const node = el('control-plane-tasks');
  if (!node) return;
  const tasks = [...state.tasks.values()].sort((a, b) => Date.parse(b.updatedAt || b.updated_at || 0) - Date.parse(a.updatedAt || a.updated_at || 0));
  node.innerHTML = tasks.length
    ? tasks.map((task) => `
      <button type="button" class="control-task-card ${task.id === state.selectedTaskId ? 'selected' : ''}" data-control-task-id="${escapeHtml(task.id)}">
        <span class="control-task-card-head"><strong>${escapeHtml(task.title || 'Background task')}</strong><span class="control-state control-state-${taskTone(task)}">${escapeHtml(taskStateLabel(task))}</span></span>
        <span class="control-task-card-meta">${escapeHtml(task.agent || 'orchestrator')} · rev ${Number(task.revision || 0)} · seq ${Number(task.progressSequence || 0)}</span>
        <span class="control-task-card-summary">${escapeHtml(task.summary || task.blocker?.message || task.error || 'No summary yet.')}</span>
      </button>`).join('')
    : '<div class="control-empty">No durable tasks yet. Fairy handoffs will appear here.</div>';
}

function renderSelectedTask() {
  const node = el('control-plane-task-detail');
  if (!node) return;
  const task = state.tasks.get(state.selectedTaskId);
  if (!task) {
    node.innerHTML = '<div class="control-empty">Select a task to inspect its timeline and controls.</div>';
    return;
  }
  const events = state.events.filter((event) => event.taskId === task.id || event.resourceId === task.id || event.payload?.taskId === task.id).slice(-12).reverse();
  const canCancel = !['completed', 'cancelled'].includes(task.state || task.status);
  const canRetry = (task.state || task.status) === 'failed';
  node.innerHTML = `
    <div class="control-detail-title"><div><div class="control-detail-kicker">TASK ${escapeHtml(task.id)}</div><h3>${escapeHtml(task.title || 'Background task')}</h3></div><span class="control-state control-state-${taskTone(task)}">${escapeHtml(taskStateLabel(task))}</span></div>
    <div class="control-detail-grid"><span>Agent<strong>${escapeHtml(task.agent || 'orchestrator')}</strong></span><span>Attempt<strong>${escapeHtml(task.attemptId || task.attempt_id || '—')}</strong></span><span>Revision<strong>${Number(task.revision || 0)}</strong></span><span>Thread<strong>${escapeHtml(task.threadId || task.thread_id || '—')}</strong></span></div>
    <div class="control-detail-summary">${escapeHtml(task.summary || task.blocker?.message || task.error || task.result || 'No task summary yet.')}</div>
    ${task.result ? `<pre class="control-result">${escapeHtml(task.result)}</pre>` : ''}
    ${task.review ? `<div class="control-review"><strong>Review</strong><span>${escapeHtml(task.review.summary || task.review.status || 'Read-only review attached.')}</span></div>` : ''}
    <div class="control-task-actions">
      <button type="button" class="secondary-button" data-control-action="queue" ${canCancel ? '' : 'disabled'}>QUEUE</button>
      <button type="button" class="secondary-button" data-control-action="cancel" ${canCancel ? '' : 'disabled'}>CANCEL</button>
      <button type="button" class="secondary-button" data-control-action="retry" ${canRetry ? '' : 'disabled'}>RETRY</button>
    </div>
    <div class="control-steer-row"><input id="control-steer-input" type="text" maxlength="4000" placeholder="Bounded steer guidance…"><button type="button" class="secondary-button" data-control-action="steer">STEER</button></div>
    <div class="control-timeline">${events.length ? events.map((event) => `<div class="control-event-row"><span>${escapeHtml(event.type || 'event')}</span><small>#${Number(event.eventSequence || 0)} · ${escapeHtml(event.state || event.resourceSnapshot?.state || '')}</small></div>`).join('') : '<div class="control-empty">No replayed events for this task yet.</div>'}</div>`;
}

function renderApprovals() {
  const node = el('control-plane-approvals');
  if (!node) return;
  const approvals = [...state.approvals.values()].filter((approval) => approval.state === 'pending');
  node.innerHTML = approvals.length
    ? approvals.map((approval) => `<div class="control-approval-card"><div><strong>${escapeHtml(approval.capability || 'Capability approval')}</strong><span>${escapeHtml(approval.summary || 'Approval required')}</span></div><div class="control-approval-actions"><button type="button" class="secondary-button" data-control-approval="approve" data-control-approval-id="${escapeHtml(approval.id)}">APPROVE</button><button type="button" class="secondary-button" data-control-approval="deny" data-control-approval-id="${escapeHtml(approval.id)}">DENY</button></div></div>`).join('')
    : '<div class="control-empty">No pending approvals.</div>';
}

function renderBoard() {
  renderAgents();
  renderTasks();
  renderSelectedTask();
  renderApprovals();
  const sequence = el('control-plane-sequence');
  if (sequence) sequence.textContent = `EVENT ${state.lastEventSequence}`;
  const active = [...state.tasks.values()].filter((task) => !['completed', 'cancelled', 'failed'].includes(task.state || task.status)).length;
  const summary = el('control-plane-summary');
  if (summary) summary.textContent = `${state.tasks.size} tasks · ${active} active · ${[...state.approvals.values()].filter((item) => item.state === 'pending').length} approvals`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function loadState() {
  try {
    const [tasks, approvals, capabilities, notifications, events] = await Promise.all([
      request('/tasks?limit=200'),
      request('/approvals?limit=200'),
      request('/agents/capabilities'),
      request('/notifications?limit=200'),
      request('/events?afterEventSequence=0&limit=2000'),
    ]);
    state.tasks.clear();
    for (const task of tasks.tasks || []) applyTask(task);
    state.approvals.clear();
    for (const approval of approvals.approvals || []) state.approvals.set(approval.id, approval);
    state.notifications.clear();
    for (const notification of notifications.notifications || []) state.notifications.set(notification.id, notification);
    state.agents = capabilities.agents || [];
    state.events = (events.events || []).slice(-200);
    const latestEventSequence = (events.events || []).reduce((latest, event) => Math.max(latest, Number(event.eventSequence || 0) || 0), state.lastEventSequence);
    if (latestEventSequence > state.lastEventSequence) {
      state.lastEventSequence = latestEventSequence;
      localStorage.setItem('commandcenter.controlEventSequence', String(latestEventSequence));
    }
    renderBoard();
    setStatus('Control plane synchronized.', 'ok');
  } catch (error) {
    setStatus(error.message || 'Control plane unavailable.', 'error');
  }
}

async function mutateTask(action, payload = {}) {
  const task = state.tasks.get(state.selectedTaskId);
  if (!task) return;
  try {
    const result = await request(`/tasks/${encodeURIComponent(task.id)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ ...payload, operationId: operationId(`ui:${action}`), expectedTaskRevision: task.revision }),
    });
    if (result.task) applyTask(result.task);
    if (result.childTask) applyTask(result.childTask);
    setStatus(`${action.toUpperCase()} committed.`, 'ok');
    renderBoard();
  } catch (error) {
    setStatus(`${action.toUpperCase()} failed: ${error.message}`, 'error');
    if (error.code === 'STALE_REVISION') await loadState();
  }
}

async function runCommand(raw) {
  const input = text(raw, 5000);
  if (!input) return;
  const [command, ...rest] = input.split(/\s+/);
  const args = rest.join(' ');
  if (command === '/status') return loadState();
  if (command === '/queue') return mutateTask('queue', { prompt: args, followUp: true });
  if (command === '/steer') return mutateTask('steer', { guidance: args });
  if (command === '/cancel') return mutateTask('cancel');
  if (command === '/retry') return mutateTask('retry');
  if (command === '/side') {
    const task = state.tasks.get(state.selectedTaskId);
    if (!task?.threadId) return setStatus('Select a task with a durable thread first.', 'error');
    try { await request('/threads', { method: 'POST', body: JSON.stringify({ kind: 'side-chat', title: args || 'Fairy side chat', parentThreadId: task.threadId, operationId: operationId('ui:side') }) }); setStatus('Side chat created.', 'ok'); } catch (error) { setStatus(error.message, 'error'); }
    return;
  }
  if (command === '/fork') {
    const task = state.tasks.get(state.selectedTaskId);
    if (!task?.threadId) return setStatus('Select a task with a durable thread first.', 'error');
    try { await request(`/threads/${encodeURIComponent(task.threadId)}/fork`, { method: 'POST', body: JSON.stringify({ title: args || 'Fairy fork', operationId: operationId('ui:fork') }) }); setStatus('Thread forked.', 'ok'); } catch (error) { setStatus(error.message, 'error'); }
    return;
  }
  if (command === '/compact') {
    const task = state.tasks.get(state.selectedTaskId);
    if (!task?.threadId) return setStatus('Select a task with a durable thread first.', 'error');
    try { await request(`/threads/${encodeURIComponent(task.threadId)}/compact`, { method: 'POST', body: JSON.stringify({ summary: args || 'Compact around the current task state.', operationId: operationId('ui:compact') }) }); setStatus('Thread compacted.', 'ok'); } catch (error) { setStatus(error.message, 'error'); }
    return;
  }
  setStatus('Commands: /status /queue /steer /cancel /retry /side /fork /compact', 'warn');
}

async function handleClick(event) {
  const taskButton = event.target.closest('[data-control-task-id]');
  if (taskButton) {
    state.selectedTaskId = taskButton.dataset.controlTaskId || '';
    renderBoard();
    return;
  }
  const actionButton = event.target.closest('[data-control-action]');
  if (actionButton) {
    const action = actionButton.dataset.controlAction;
    if (action === 'steer') {
      const input = el('control-steer-input');
      await mutateTask('steer', { guidance: text(input?.value, 4000) });
      if (input) input.value = '';
    } else if (action === 'queue') await mutateTask('queue', { followUp: true });
    else await mutateTask(action);
    return;
  }
  const approvalButton = event.target.closest('[data-control-approval]');
  if (approvalButton) {
    try {
      const approval = state.approvals.get(approvalButton.dataset.controlApprovalId);
      const action = approvalButton.dataset.controlApproval;
      const result = await request(`/approvals/${encodeURIComponent(approval.id)}/${action}`, { method: 'POST', body: JSON.stringify({ operationId: operationId(`ui:${action}`), expectedApprovalRevision: approval.revision }) });
      if (result.approval) state.approvals.set(result.approval.id, result.approval);
      if (result.task) applyTask(result.task);
      setStatus(`Approval ${action}d.`, 'ok');
      renderBoard();
    } catch (error) { setStatus(error.message, 'error'); }
  }
}

export function handleEvent(message = {}) {
  if (message.type === 'control:event') return applyEvent(message.data || {});
  if (message.type === 'live_task:update' && message.data?.id) {
    applyTask(message.data);
    renderBoard();
  }
  if (message.type === 'relay:roster_updated') loadState().catch(() => {});
}

export function getEventSequence() {
  return state.lastEventSequence;
}

export function init({ base = '' } = {}) {
  state.base = base;
  if (state.initialized) return;
  state.initialized = true;
  el('control-plane-toggle')?.addEventListener('click', () => {
    const panel = el('control-plane-panel');
    if (!panel) return;
    const hidden = panel.classList.toggle('hidden');
    el('control-plane-toggle').setAttribute('aria-expanded', String(!hidden));
    if (!hidden) loadState();
  });
  el('control-plane-panel')?.addEventListener('click', handleClick);
  el('control-plane-command')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); runCommand(event.target.value); event.target.value = ''; }
  });
  el('control-plane-new-task-btn')?.addEventListener('click', async () => {
    const input = el('control-plane-new-task');
    const prompt = text(input?.value, 12000);
    if (!prompt) return;
    try {
      const result = await request('/tasks', { method: 'POST', body: JSON.stringify({ prompt, title: prompt.slice(0, 80), operationId: operationId('ui:create') }) });
      applyTask(result.task);
      if (result.approval) state.approvals.set(result.approval.id, result.approval);
      if (input) input.value = '';
      setStatus('Task queued.', 'ok');
      renderBoard();
    } catch (error) { setStatus(error.message, 'error'); }
  });
  renderBoard();
  loadState();
}
