const BASE = window.__BASE_PATH__ || '';

let state = {
  settings: {
    enabled: false,
    volume: 0.45,
    speechDuckLevel: 0.35,
    fairyCallDuckLevel: 0.22,
    playbackScope: 'tab',
    selectedTrackId: '',
  },
  tracks: [],
};

let audioEl = null;
let unlocked = false;
let attemptedAutoplay = false;
let fadeFrame = 0;
let speechDuckActive = false;
let fairyCallDuckActive = false;

function qs(id) {
  return document.getElementById(id);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function clamp01(value, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function getSelectedTrack() {
  const id = String(state.settings.selectedTrackId || '').trim();
  return state.tracks.find((track) => String(track.id) === id) || null;
}

function shouldPlayInCurrentContext() {
  if (!state.settings.enabled) return false;
  if (!getSelectedTrack()) return false;
  if (state.settings.playbackScope === 'always') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

function ensureAudio() {
  if (audioEl) return audioEl;
  audioEl = new Audio();
  audioEl.loop = true;
  audioEl.preload = 'auto';
  audioEl.autoplay = false;
  audioEl.volume = getTargetVolume();
  return audioEl;
}

function cancelFade() {
  if (fadeFrame) cancelAnimationFrame(fadeFrame);
  fadeFrame = 0;
}

function getBaseVolume() {
  return clamp01(state.settings.volume, 0.45);
}

function getDuckLevel() {
  return clamp01(state.settings.speechDuckLevel, 0.35);
}

function getFairyCallDuckLevel() {
  return clamp01(state.settings.fairyCallDuckLevel, 0.22);
}

function getTargetVolume() {
  const base = getBaseVolume();
  let multiplier = 1;
  if (fairyCallDuckActive) multiplier *= getFairyCallDuckLevel();
  if (speechDuckActive) multiplier *= getDuckLevel();
  return base * multiplier;
}

function fadeToVolume(targetVolume, durationMs = 450) {
  const audio = ensureAudio();
  cancelFade();
  const fromVolume = Number(audio.volume || 0);
  const target = clamp01(targetVolume, fromVolume);
  const start = performance.now();
  const tick = (now) => {
    const progress = Math.min(1, Math.max(0, (now - start) / Math.max(1, durationMs)));
    audio.volume = fromVolume + ((target - fromVolume) * progress);
    if (progress < 1) fadeFrame = requestAnimationFrame(tick);
    else fadeFrame = 0;
  };
  fadeFrame = requestAnimationFrame(tick);
}

function applyTargetVolume({ fade = true, durationMs = 450 } = {}) {
  const audio = ensureAudio();
  const target = getTargetVolume();
  if (fade && !audio.paused) fadeToVolume(target, durationMs);
  else audio.volume = target;
}

function syncAudioSource() {
  const audio = ensureAudio();
  const track = getSelectedTrack();
  const nextSrc = track?.url || '';
  if ((audio.dataset.trackId || '') === String(track?.id || '')) {
    applyTargetVolume({ fade: false });
    return;
  }
  audio.pause();
  audio.currentTime = 0;
  audio.removeAttribute('src');
  audio.load();
  audio.dataset.trackId = String(track?.id || '');
  applyTargetVolume({ fade: false });
  if (nextSrc) {
    audio.src = nextSrc;
    audio.load();
  }
}

export async function refresh() {
  const [settingsData, tracksData] = await Promise.all([
    fetchJson(`${BASE}/api/settings/music`),
    fetchJson(`${BASE}/api/music/tracks`),
  ]);
  state.settings = { ...state.settings, ...(settingsData.settings || {}) };
  state.tracks = Array.isArray(tracksData.tracks) ? tracksData.tracks : [];
  if (!state.settings.selectedTrackId && state.tracks[0]?.id) {
    state.settings.selectedTrackId = state.tracks[0].id;
  }
  syncAudioSource();
  syncPlayback();
  renderSettings();
  return state;
}

export function renderSettings() {
  const enabled = qs('music-enabled');
  const mode = qs('music-playback-scope');
  const volume = qs('music-volume');
  const volumeValue = qs('music-volume-value');
  const duck = qs('music-speech-duck-level');
  const duckValue = qs('music-speech-duck-level-value');
  const fairyDuck = qs('music-fairy-call-duck-level');
  const fairyDuckValue = qs('music-fairy-call-duck-level-value');
  const select = qs('music-track-select');
  const status = qs('music-upload-status');

  if (enabled) enabled.checked = state.settings.enabled === true;
  if (mode) mode.value = state.settings.playbackScope || 'tab';
  if (volume) volume.value = String(Math.round(getBaseVolume() * 100));
  if (volumeValue) volumeValue.textContent = `${Math.round(getBaseVolume() * 100)}%`;
  if (duck) duck.value = String(Math.round(getDuckLevel() * 100));
  if (duckValue) duckValue.textContent = `${Math.round(getDuckLevel() * 100)}% of normal`;
  if (fairyDuck) fairyDuck.value = String(Math.round(getFairyCallDuckLevel() * 100));
  if (fairyDuckValue) fairyDuckValue.textContent = `${Math.round(getFairyCallDuckLevel() * 100)}% of normal`;

  if (select) {
    const selectedId = String(state.settings.selectedTrackId || '');
    select.innerHTML = state.tracks.length
      ? state.tracks.map((track) => `<option value="${String(track.id).replace(/"/g, '&quot;')}" ${String(track.id) === selectedId ? 'selected' : ''}>${String(track.name || track.filename || track.id)}</option>`).join('')
      : '<option value="">No uploaded tracks yet</option>';
  }

  if (status && !status.dataset.busy) {
    const track = getSelectedTrack();
    status.textContent = track
      ? `Selected: ${track.name || track.filename}`
      : state.tracks.length
        ? 'Pick a track to use as background music.'
        : 'No music uploaded yet. Use the upload button below.';
  }
}

export function collectSettings() {
  const volumePercent = Number(qs('music-volume')?.value || 45);
  const duckPercent = Number(qs('music-speech-duck-level')?.value || 35);
  const fairyDuckPercent = Number(qs('music-fairy-call-duck-level')?.value || 22);
  return {
    enabled: qs('music-enabled')?.checked === true,
    playbackScope: qs('music-playback-scope')?.value === 'always' ? 'always' : 'tab',
    selectedTrackId: String(qs('music-track-select')?.value || '').trim(),
    volume: clamp01(volumePercent / 100, 0.45),
    speechDuckLevel: clamp01(duckPercent / 100, 0.35),
    fairyCallDuckLevel: clamp01(fairyDuckPercent / 100, 0.22),
  };
}

export async function saveSettings() {
  const payload = collectSettings();
  const data = await fetchJson(`${BASE}/api/settings/music`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  state.settings = { ...state.settings, ...(data.settings || payload) };
  syncAudioSource();
  syncPlayback();
  renderSettings();
  return data;
}

export async function uploadSelectedFile() {
  const input = qs('music-upload-input');
  const status = qs('music-upload-status');
  const file = input?.files?.[0];
  if (!file) {
    if (status) status.textContent = 'Pick an audio file first.';
    return null;
  }
  const form = new FormData();
  form.append('track', file, file.name);
  if (status) {
    status.dataset.busy = '1';
    status.textContent = `Uploading ${file.name}...`;
  }
  try {
    const data = await fetchJson(`${BASE}/api/music/upload`, { method: 'POST', body: form });
    state.tracks = Array.isArray(data.tracks) ? data.tracks : state.tracks;
    if (data.track?.id) state.settings.selectedTrackId = data.track.id;
    renderSettings();
    syncAudioSource();
    syncPlayback(true);
    if (input) input.value = '';
    if (status) status.textContent = `${data.track?.name || file.name} uploaded.`;
    return data;
  } finally {
    if (status) delete status.dataset.busy;
  }
}

export function setSpeechDuckActive(active, options = {}) {
  const next = active === true;
  if (speechDuckActive === next) return;
  speechDuckActive = next;
  applyTargetVolume({ fade: options.fade !== false, durationMs: Number(options.durationMs || (next ? 320 : 650)) });
}

export function setFairyCallDuckActive(active, options = {}) {
  const next = active === true;
  if (fairyCallDuckActive === next) return;
  fairyCallDuckActive = next;
  applyTargetVolume({ fade: options.fade !== false, durationMs: Number(options.durationMs || (next ? 280 : 700)) });
}

export function duckForSpeech() {
  setSpeechDuckActive(true, { durationMs: 320 });
}

export function releaseSpeechDuck() {
  setSpeechDuckActive(false, { durationMs: 650 });
}

export async function syncPlayback(forceAttempt = false) {
  syncAudioSource();
  const audio = ensureAudio();
  applyTargetVolume({ fade: false });
  if (!shouldPlayInCurrentContext()) {
    cancelFade();
    if (!audio.paused) audio.pause();
    return;
  }
  if (!unlocked && !forceAttempt) return;
  if (!audio.src) return;
  if (!audio.paused) return;
  if (attemptedAutoplay && !forceAttempt && !unlocked) return;
  attemptedAutoplay = true;
  try {
    await audio.play();
    unlocked = true;
    applyTargetVolume({ fade: false });
  } catch (_) {}
}

export async function prepareForIntroCrossfade() {
  syncAudioSource();
  const audio = ensureAudio();
  if (!shouldPlayInCurrentContext()) return false;
  if (!audio.src) return false;
  cancelFade();
  audio.volume = 0;
  audio.muted = true;
  if (!audio.paused) return true;
  try {
    await audio.play();
    unlocked = true;
    return true;
  } catch (_) {
    return false;
  }
}

export async function startCrossfadeFromIntro(durationMs = 1400) {
  syncAudioSource();
  const audio = ensureAudio();
  const targetVolume = getTargetVolume();
  if (!shouldPlayInCurrentContext()) return false;
  if (!audio.src) return false;
  cancelFade();
  if (audio.paused) {
    audio.volume = 0;
    audio.muted = true;
    try {
      await audio.play();
      unlocked = true;
    } catch (_) {
      return false;
    }
  }
  audio.muted = false;
  fadeToVolume(targetVolume, durationMs);
  return true;
}

function installEventHandlers() {
  const unlock = () => {
    unlocked = true;
    syncPlayback(true);
  };
  document.addEventListener('commandcenter:intro-crossfade', (event) => {
    const durationMs = Number(event?.detail?.durationMs || 1400);
    startCrossfadeFromIntro(durationMs);
  });
  document.addEventListener('commandcenter:voice-playback-start', () => duckForSpeech());
  document.addEventListener('commandcenter:voice-playback-stop', () => releaseSpeechDuck());
  document.addEventListener('commandcenter:fairy-call-start', () => setFairyCallDuckActive(true, { durationMs: 280 }));
  document.addEventListener('commandcenter:fairy-call-end', () => setFairyCallDuckActive(false, { durationMs: 700 }));
  document.addEventListener('click', unlock, { passive: true });
  document.addEventListener('keydown', unlock, { passive: true });
  document.addEventListener('visibilitychange', () => syncPlayback());
  window.addEventListener('focus', () => syncPlayback());
  window.addEventListener('blur', () => syncPlayback());

  qs('music-volume')?.addEventListener('input', () => {
    const value = Number(qs('music-volume')?.value || 45);
    const percent = `${value}%`;
    if (qs('music-volume-value')) qs('music-volume-value').textContent = percent;
    state.settings.volume = clamp01(value / 100, 0.45);
    applyTargetVolume({ fade: true, durationMs: 180 });
  });
  qs('music-speech-duck-level')?.addEventListener('input', () => {
    const value = Number(qs('music-speech-duck-level')?.value || 35);
    if (qs('music-speech-duck-level-value')) qs('music-speech-duck-level-value').textContent = `${value}% of normal`;
    state.settings.speechDuckLevel = clamp01(value / 100, 0.35);
    if (speechDuckActive) applyTargetVolume({ fade: true, durationMs: 180 });
  });
  qs('music-fairy-call-duck-level')?.addEventListener('input', () => {
    const value = Number(qs('music-fairy-call-duck-level')?.value || 22);
    if (qs('music-fairy-call-duck-level-value')) qs('music-fairy-call-duck-level-value').textContent = `${value}% of normal`;
    state.settings.fairyCallDuckLevel = clamp01(value / 100, 0.22);
    if (fairyCallDuckActive) applyTargetVolume({ fade: true, durationMs: 180 });
  });
  qs('music-track-select')?.addEventListener('change', () => {
    state.settings.selectedTrackId = String(qs('music-track-select')?.value || '').trim();
    renderSettings();
    syncPlayback(true);
  });
  qs('music-enabled')?.addEventListener('change', () => syncPlayback(true));
  qs('music-playback-scope')?.addEventListener('change', () => syncPlayback(true));
  qs('music-upload-btn')?.addEventListener('click', uploadSelectedFile);
}

export async function init() {
  ensureAudio();
  installEventHandlers();
  await refresh();
}
