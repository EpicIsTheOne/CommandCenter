const BASE = window.__BASE_PATH__ || '';

let state = 'off';
let recorder = null;
let streamRef = null;
let onWake = null;
let onStateChange = null;
let inFlight = false;
let cooldownUntil = 0;
let active = false;
let paused = false;

function setState(next, detail = '') {
  state = next;
  if (onStateChange) onStateChange(next, detail);
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function detectBlob(blob) {
  if (inFlight || paused || Date.now() < cooldownUntil || !blob || blob.size < 2000) return;
  inFlight = true;
  try {
    const form = new FormData();
    form.append('audio', blob, 'wake.webm');
    const data = await fetchJson(`${BASE}/api/wake/detect`, { method: 'POST', body: form });
    if (data.match) {
      cooldownUntil = Date.now() + 3000;
      paused = true;
      setState('triggered', data.match.label);
      if (onWake) onWake(data.match.agentId, { text: data.text || '', remainder: data.match.remainder || '' });
    }
  } finally {
    inFlight = false;
  }
}

function recordCycle() {
  if (!active || !streamRef) return;

  const chunks = [];
  try {
    recorder = new MediaRecorder(streamRef, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
    });
  } catch (err) {
    console.error('[wake] Failed to create recorder:', err);
    return;
  }

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  recorder.onstop = async () => {
    recorder = null;
    if (!paused) {
      const blob = new Blob(chunks, { type: 'audio/webm' });
      await detectBlob(blob);
    }
    if (active && !paused) {
      setTimeout(() => recordCycle(), 80);
    }
  };

  recorder.start();
  setTimeout(() => {
    if (recorder && recorder.state !== 'inactive') recorder.stop();
  }, 1200);
}

export function init(opts = {}) {
  onWake = opts.onWake || null;
  onStateChange = opts.onStateChange || null;
}

export function getState() {
  return state;
}

export function isActive() {
  return active;
}

export async function start() {
  if (active) return;
  paused = false;
  setState('arming');
  streamRef = await navigator.mediaDevices.getUserMedia({ audio: true });
  active = true;
  setState('armed');
  recordCycle();
}

export function resume() {
  if (!active) return;
  paused = false;
  setState('armed');
  recordCycle();
}

export async function stop() {
  active = false;
  paused = false;
  if (recorder && recorder.state !== 'inactive') {
    recorder.onstop = null;
    recorder.stop();
    recorder = null;
  }
  if (streamRef) {
    streamRef.getTracks().forEach((t) => t.stop());
    streamRef = null;
  }
  setState('off');
}
