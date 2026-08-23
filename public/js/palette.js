// Command palette (Ctrl+K / Cmd+K): keyboard-first launcher over the shared
// action registry + unified search. Pure keyboard operation: arrows, enter,
// escape, tab to toggle scope.
import { listActions, runAction, searchActions } from './actions.js';
import { searchAll, escapeHtml } from './ops.js';

const paletteState = {
  open: false,
  query: '',
  results: [],
  cursor: 0,
  remoteResults: [],
  remoteTimer: null,
};

function el(id) {
  return document.getElementById(id);
}

function render() {
  const input = el('palette-input');
  const list = el('palette-results');
  if (!input || !list) return;
  const query = paletteState.query.trim();
  const actions = query ? searchActions(query).slice(0, 8) : listActions().slice(0, 10);
  const remotes = (paletteState.remoteResults || []).slice(0, 6);
  const rows = [];
  for (const action of actions) {
    rows.push(`
      <button type="button" class="palette-row ${rows.length === paletteState.cursor ? 'cursor' : ''}" data-palette-action="${escapeHtml(action.id)}">
        <span class="palette-row-title">${escapeHtml(action.title)}</span>
        <span class="palette-row-hint">${escapeHtml(action.hint || action.group)}</span>
      </button>`);
  }
  for (const hit of remotes) {
    rows.push(`
      <button type="button" class="palette-row remote ${rows.length === paletteState.cursor ? 'cursor' : ''}" data-palette-kind="${escapeHtml(hit.kind)}" data-palette-id="${escapeHtml(hit.id)}">
        <span class="palette-row-title">${escapeHtml(hit.label)}</span>
        <span class="palette-row-hint">${escapeHtml(hit.sub || hit.kind)}</span>
      </button>`);
  }
  list.innerHTML = rows.length
    ? rows.join('')
    : '<div class="ops-empty">No matches. Try an agent, task, space or machine name.</div>';
}

function moveCursor(delta) {
  const total = el('palette-results')?.querySelectorAll('.palette-row').length || 0;
  if (!total) return;
  paletteState.cursor = (paletteState.cursor + delta + total) % total;
  render();
  el('palette-results')?.querySelector('.palette-row.cursor')?.scrollIntoView({ block: 'nearest' });
}

async function executeCurrent(target) {
  const row = target || el('palette-results')?.querySelectorAll('.palette-row')[paletteState.cursor];
  if (!row) return;
  closePalette();
  const actionId = row.dataset.paletteAction;
  if (actionId) {
    try {
      await runAction(actionId);
    } catch (error) {
      console.error('[palette] action failed:', error);
    }
    return;
  }
  const kind = row.dataset.paletteKind;
  const id = row.dataset.paletteId;
  if (kind && id) {
    const ops = await import('./ops.js');
    if (kind === 'space') await ops.setCurrentSpace(id);
    else if (['agent', 'task', 'machine', 'harness'].includes(kind)) ops.select({ kind: kind === 'harness' ? 'harness' : kind, id });
    if (kind === 'agent' || kind === 'task') ops.setTab(kind === 'agent' ? 'agents' : 'tasks');
  }
}

export function openPalette() {
  const root = el('command-palette-root');
  const input = el('palette-input');
  if (!root) return;
  paletteState.open = true;
  paletteState.query = '';
  paletteState.cursor = 0;
  paletteState.remoteResults = [];
  root.classList.remove('hidden');
  render();
  if (input) { input.value = ''; setTimeout(() => input.focus(), 30); }
}

export function closePalette() {
  const root = el('command-palette-root');
  if (!root) return;
  paletteState.open = false;
  root.classList.add('hidden');
}

export function isPaletteOpen() {
  return paletteState.open;
}

async function onQueryChanged(value) {
  paletteState.query = value || '';
  paletteState.cursor = 0;
  render();
  clearTimeout(paletteState.remoteTimer);
  const query = paletteState.query.trim();
  if (query.length < 2) {
    paletteState.remoteResults = [];
    render();
    return;
  }
  paletteState.remoteTimer = setTimeout(async () => {
    try {
      const result = await searchAll(query);
      paletteState.remoteResults = (result.groups || []).flatMap((group) => group.hits.map((hit) => ({ ...hit })));
    } catch {
      paletteState.remoteResults = [];
    }
    render();
  }, 140);
}

function bind() {
  const input = el('palette-input');
  input?.addEventListener('input', (event) => onQueryChanged(event.target.value));
  input?.addEventListener('keydown', async (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveCursor(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); moveCursor(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); await executeCurrent(); }
    else if (event.key === 'Escape') { event.preventDefault(); closePalette(); }
  });

  el('palette-results')?.addEventListener('click', (event) => {
    const row = event.target.closest('.palette-row');
    if (row) executeCurrent(row);
  });

  el('palette-backdrop')?.addEventListener('click', closePalette);

  window.addEventListener('keydown', (event) => {
    const isCtrlK = (event.ctrlKey || event.metaKey) && String(event.key).toLowerCase() === 'k';
    if (isCtrlK) {
      event.preventDefault();
      if (paletteState.open) closePalette();
      else openPalette();
      return;
    }
    // Slash focuses the palette when nothing else has focus and no modal is up
    if (event.key === '/' && !paletteState.open) {
      const active = document.activeElement;
      const typingSomewhere = active && ['INPUT', 'TEXTAREA'].includes(active.tagName);
      if (!typingSomewhere) {
        event.preventDefault();
        openPalette();
      }
    }
  });
}

let paletteBound = false;

export function init() {
  // init() runs twice by design (module self-boot + app bootstrap); bind once.
  if (paletteBound) return;
  paletteBound = true;
  bind();
}

// Self-boot so Ctrl+K works regardless of host bootstrap order.
if (typeof document !== 'undefined') {
  const boot = () => init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
}
