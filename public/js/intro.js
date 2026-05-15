import * as music from './music.js?v=20260514b';

const BASE = window.__BASE_PATH__ || '';

let state = {
  settings: {
    enabled: true,
    volume: 0.7,
    selectedIntroId: '',
  },
  intros: [],
};

let overlayEl = null;
let videoEl = null;
let hasTriedToPlay = false;
let hasFinishedIntro = false;
let introFailSafeTimer = null;

function qs(id) {
  return document.getElementById(id);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function getSelectedIntro() {
  const id = String(state.settings.selectedIntroId || '').trim();
  return state.intros.find((item) => String(item.id) === id) || null;
}

function ensureOverlay() {
  if (overlayEl && videoEl) return;
  overlayEl = document.createElement('div');
  overlayEl.id = 'startup-intro-overlay';
  overlayEl.className = 'hidden';
  overlayEl.innerHTML = '<video id="startup-intro-video" playsinline preload="auto"></video>';
  document.body.appendChild(overlayEl);
  videoEl = overlayEl.querySelector('video');
  videoEl.addEventListener('ended', fadeOutAndHide);
  videoEl.addEventListener('error', fadeOutAndHide);
}

function applySelectedIntro() {
  ensureOverlay();
  const intro = getSelectedIntro();
  videoEl.pause();
  videoEl.removeAttribute('src');
  videoEl.load();
  videoEl.volume = Number(state.settings.volume || 0.7);
  if (!intro) return;
  videoEl.src = intro.url;
  videoEl.load();
}

function clearIntroFailSafe() {
  if (introFailSafeTimer) {
    clearTimeout(introFailSafeTimer);
    introFailSafeTimer = null;
  }
}

function scheduleIntroFailSafe(ms = 12000) {
  clearIntroFailSafe();
  introFailSafeTimer = setTimeout(() => {
    fadeOutAndHide();
  }, ms);
}

function fadeOutAndHide() {
  if (!overlayEl || hasFinishedIntro) return;
  hasFinishedIntro = true;
  clearIntroFailSafe();
  document.dispatchEvent(new CustomEvent('commandcenter:intro-crossfade', { detail: { durationMs: 1400 } }));
  overlayEl.classList.add('is-fading-out');
  setTimeout(() => {
    overlayEl.classList.add('hidden');
    overlayEl.classList.remove('is-visible', 'is-fading-out');
    if (videoEl) {
      videoEl.pause();
      videoEl.currentTime = 0;
    }
  }, 900);
}

export async function refresh() {
  const [settingsData, introsData] = await Promise.all([
    fetchJson(`${BASE}/api/settings/intro`),
    fetchJson(`${BASE}/api/intro/videos`),
  ]);
  state.settings = { ...state.settings, ...(settingsData.settings || {}) };
  state.intros = Array.isArray(introsData.intros) ? introsData.intros : [];
  if (!state.settings.selectedIntroId && state.intros[0]?.id) {
    state.settings.selectedIntroId = state.intros[0].id;
  }
  applySelectedIntro();
  renderSettings();
  return state;
}

export function renderSettings() {
  const enabled = qs('intro-enabled');
  const volume = qs('intro-volume');
  const volumeValue = qs('intro-volume-value');
  const select = qs('intro-video-select');
  const status = qs('intro-upload-status');

  if (enabled) enabled.checked = state.settings.enabled === true;
  if (volume) volume.value = String(Math.round(Number(state.settings.volume || 0.7) * 100));
  if (volumeValue) volumeValue.textContent = `${Math.round(Number(state.settings.volume || 0.7) * 100)}%`;
  if (select) {
    const selectedId = String(state.settings.selectedIntroId || '');
    select.innerHTML = state.intros.length
      ? state.intros.map((intro) => `<option value="${String(intro.id).replace(/"/g, '&quot;')}" ${String(intro.id) === selectedId ? 'selected' : ''}>${String(intro.name || intro.filename || intro.id)}</option>`).join('')
      : '<option value="">No uploaded intro videos yet</option>';
  }
  if (status && !status.dataset.busy) {
    const intro = getSelectedIntro();
    status.textContent = intro
      ? `Selected intro: ${intro.name || intro.filename}`
      : state.intros.length
        ? 'Pick which startup intro should play.'
        : 'No intro video uploaded yet. Use the upload button below.';
  }
  if (videoEl) videoEl.volume = Number(state.settings.volume || 0.7);
}

export function collectSettings() {
  return {
    enabled: qs('intro-enabled')?.checked === true,
    volume: Math.min(1, Math.max(0, Number(qs('intro-volume')?.value || 70) / 100)),
    selectedIntroId: String(qs('intro-video-select')?.value || '').trim(),
  };
}

export async function saveSettings() {
  const payload = collectSettings();
  const data = await fetchJson(`${BASE}/api/settings/intro`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.settings = { ...state.settings, ...(data.settings || payload) };
  applySelectedIntro();
  renderSettings();
  return data;
}

export async function uploadSelectedFile() {
  const input = qs('intro-upload-input');
  const status = qs('intro-upload-status');
  const file = input?.files?.[0];
  if (!file) {
    if (status) status.textContent = 'Pick a video file first.';
    return null;
  }
  const form = new FormData();
  form.append('intro', file, file.name);
  if (status) {
    status.dataset.busy = '1';
    status.textContent = `Uploading ${file.name}...`;
  }
  try {
    const data = await fetchJson(`${BASE}/api/intro/upload`, { method: 'POST', body: form });
    state.intros = Array.isArray(data.intros) ? data.intros : state.intros;
    if (data.intro?.id) state.settings.selectedIntroId = data.intro.id;
    renderSettings();
    applySelectedIntro();
    if (input) input.value = '';
    if (status) status.textContent = `${data.intro?.name || file.name} uploaded.`;
    return data;
  } finally {
    if (status) delete status.dataset.busy;
  }
}

async function playIntro() {
  ensureOverlay();
  if (hasFinishedIntro || hasTriedToPlay) return;
  hasTriedToPlay = true;
  if (!state.settings.enabled) {
    hasFinishedIntro = true;
    return;
  }
  const intro = getSelectedIntro();
  if (!intro || !videoEl) {
    hasFinishedIntro = true;
    return;
  }
  videoEl.volume = Number(state.settings.volume || 0.7);
  overlayEl.classList.remove('hidden', 'is-fading-out');
  overlayEl.classList.add('is-visible');
  scheduleIntroFailSafe(Math.max(12000, Math.ceil((videoEl.duration || 0) * 1000) + 3000));
  try {
    await videoEl.play();
    await music.prepareForIntroCrossfade();
  } catch (_) {
    const start = async () => {
      document.removeEventListener('click', start);
      document.removeEventListener('keydown', start);
      try {
        await videoEl.play();
        await music.prepareForIntroCrossfade();
      } catch (_) { fadeOutAndHide(); }
    };
    document.addEventListener('click', start, { once: true });
    document.addEventListener('keydown', start, { once: true });
  }
}

function installEventHandlers() {
  qs('intro-volume')?.addEventListener('input', () => {
    const value = Number(qs('intro-volume')?.value || 70);
    if (qs('intro-volume-value')) qs('intro-volume-value').textContent = `${value}%`;
    if (videoEl) videoEl.volume = Math.min(1, Math.max(0, value / 100));
  });
  qs('intro-video-select')?.addEventListener('change', () => {
    state.settings.selectedIntroId = String(qs('intro-video-select')?.value || '').trim();
    applySelectedIntro();
    renderSettings();
  });
  qs('intro-upload-btn')?.addEventListener('click', uploadSelectedFile);
}

export async function init() {
  ensureOverlay();
  installEventHandlers();
  await refresh();
  await playIntro();
}
