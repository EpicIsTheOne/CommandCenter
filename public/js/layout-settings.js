const BASE = window.__BASE_PATH__ || '';
const WIDGETS = [
  { id: 'zone-mascot', label: 'STATUS' },
  { id: 'zone-terminal', label: 'ACTIVITY LOG' },
  { id: 'zone-office', label: 'AGENT WORKSPACE' },
];
const WIDGET_IDS = WIDGETS.map((item) => item.id);
let state = { widgetOrder: [...WIDGET_IDS], hiddenWidgets: [], collapsedWidgets: {}, defaultPanel: 'zone-office', savedLayouts: [] };
let dragWidgetId = '';

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function qs(id) { return document.getElementById(id); }
function getWidgetLabel(id) { return WIDGETS.find((item) => item.id === id)?.label || id; }
function setStatus(text, isError = false) {
  const el = qs('layout-status');
  if (!el) return;
  el.textContent = text || '';
  el.style.color = isError ? 'var(--red)' : '';
}
function normalizeState(input = {}) {
  const order = (Array.isArray(input.widgetOrder) ? input.widgetOrder : []).filter((id) => WIDGET_IDS.includes(id));
  const widgetOrder = [...new Set([...order, ...WIDGET_IDS])];
  const hiddenWidgets = [...new Set((Array.isArray(input.hiddenWidgets) ? input.hiddenWidgets : []).filter((id) => WIDGET_IDS.includes(id)))];
  const collapsedWidgets = Object.fromEntries(WIDGET_IDS.map((id) => [id, !!input.collapsedWidgets?.[id]]));
  const defaultPanel = WIDGET_IDS.includes(input.defaultPanel) && !hiddenWidgets.includes(input.defaultPanel)
    ? input.defaultPanel
    : widgetOrder.find((id) => !hiddenWidgets.includes(id)) || 'zone-office';
  return { ...state, ...input, widgetOrder, hiddenWidgets, collapsedWidgets, defaultPanel };
}

function renderOrderList() {
  const mount = qs('layout-order-list');
  if (!mount) return;
  mount.innerHTML = state.widgetOrder.map((id) => `
    <div class="layout-order-item" data-widget-id="${id}" draggable="true">
      <div class="layout-order-drag" title="Drag to reorder">⋮⋮</div>
      <div class="layout-order-label">${getWidgetLabel(id)}</div>
    </div>
  `).join('');
}

function apply() {
  const root = document.getElementById('command-center');
  if (!root) return;
  const workspaceOnly = state.hiddenWidgets.includes('zone-mascot') && state.hiddenWidgets.includes('zone-terminal');
  root.classList.toggle('workspace-only', workspaceOnly);
  document.body?.classList.toggle('workspace-only', workspaceOnly);
  for (const id of WIDGET_IDS) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.style.display = state.hiddenWidgets.includes(id) ? 'none' : '';
    const collapsed = !!state.collapsedWidgets[id];
    el.classList.toggle('zone-collapsed', collapsed);
  }
  for (const id of state.widgetOrder) {
    const el = document.getElementById(id);
    if (el) root.appendChild(el);
  }
}

function bindUi() {
  for (const id of WIDGET_IDS) {
    const chk = qs(`layout-show-${id}`);
    if (chk) chk.checked = !state.hiddenWidgets.includes(id);
    const col = qs(`layout-collapse-${id}`);
    if (col) col.checked = !!state.collapsedWidgets[id];
  }
  const dp = qs('layout-default-panel');
  if (dp) {
    dp.innerHTML = state.widgetOrder
      .filter((id) => !state.hiddenWidgets.includes(id))
      .map((id) => `<option value="${id}">${getWidgetLabel(id)}</option>`)
      .join('');
    dp.value = state.defaultPanel;
  }
  renderOrderList();
}

function collect() {
  const hiddenWidgets = WIDGET_IDS.filter((id) => !qs(`layout-show-${id}`)?.checked);
  const collapsedWidgets = Object.fromEntries(WIDGET_IDS.map((id) => [id, !!qs(`layout-collapse-${id}`)?.checked]));
  const visible = state.widgetOrder.filter((id) => !hiddenWidgets.includes(id));
  const defaultPanel = visible.includes(qs('layout-default-panel')?.value) ? qs('layout-default-panel')?.value : (visible[0] || 'zone-office');
  return normalizeState({ ...state, hiddenWidgets, collapsedWidgets, defaultPanel });
}

function reorderWidget(sourceId, targetId) {
  if (!sourceId || !targetId || sourceId === targetId) return;
  const next = state.widgetOrder.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  if (targetIndex < 0) return;
  next.splice(targetIndex, 0, sourceId);
  state = normalizeState({ ...state, widgetOrder: next });
  bindUi();
  apply();
  setStatus(`Reordered ${getWidgetLabel(sourceId)}. Save settings to keep it.`);
}

export async function refresh() {
  const data = await fetchJson(`${BASE}/api/settings/layout`);
  state = normalizeState(data.settings || {});
  bindUi();
  apply();
}

export async function saveSettings() {
  const payload = collect();
  if (payload.hiddenWidgets.length >= WIDGET_IDS.length) {
    throw new Error('At least one widget must stay visible. Do not hide the whole dashboard like a goblin.');
  }
  const data = await fetchJson(`${BASE}/api/settings/layout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  state = normalizeState(data.settings || payload);
  bindUi();
  apply();
  setStatus('Layout settings saved.');
}

export function init() {
  for (const id of WIDGET_IDS) {
    qs(`layout-show-${id}`)?.addEventListener('change', () => {
      state = collect();
      bindUi();
      apply();
      setStatus(`Updated visibility for ${getWidgetLabel(id)}. Save settings to keep it.`);
    });
    qs(`layout-collapse-${id}`)?.addEventListener('change', () => {
      state = collect();
      bindUi();
      apply();
      setStatus(`Updated collapse state for ${getWidgetLabel(id)}. Save settings to keep it.`);
    });
  }
  qs('layout-default-panel')?.addEventListener('change', () => {
    state = collect();
    setStatus(`Default panel set to ${getWidgetLabel(state.defaultPanel)}. Save settings to keep it.`);
  });
  const orderList = qs('layout-order-list');
  orderList?.addEventListener('dragstart', (event) => {
    const item = event.target?.closest?.('.layout-order-item');
    if (!item) return;
    dragWidgetId = item.dataset.widgetId || '';
    item.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', dragWidgetId);
  });
  orderList?.addEventListener('dragend', (event) => {
    event.target?.closest?.('.layout-order-item')?.classList?.remove('dragging');
    dragWidgetId = '';
    orderList.querySelectorAll('.layout-order-item').forEach((item) => item.classList.remove('drag-over'));
  });
  orderList?.addEventListener('dragover', (event) => {
    event.preventDefault();
    const item = event.target?.closest?.('.layout-order-item');
    if (!item) return;
    orderList.querySelectorAll('.layout-order-item').forEach((row) => row.classList.remove('drag-over'));
    item.classList.add('drag-over');
  });
  orderList?.addEventListener('dragleave', (event) => {
    event.target?.closest?.('.layout-order-item')?.classList?.remove('drag-over');
  });
  orderList?.addEventListener('drop', (event) => {
    event.preventDefault();
    const item = event.target?.closest?.('.layout-order-item');
    if (!item) return;
    item.classList.remove('drag-over');
    reorderWidget(dragWidgetId || event.dataTransfer.getData('text/plain') || '', item.dataset.widgetId || '');
  });
}
