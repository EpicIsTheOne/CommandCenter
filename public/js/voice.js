let mediaRecorder = null;
let audioChunks = [];
let isRecording = false;
let onTranscription = null;
let onRecordingStopped = null;
let maxRecordTimer = null;
let silenceInterval = null;
let targetAgent = 'main';
let currentAudio = null;
let currentAudioUrl = null;
let currentSpeakController = null;
let currentPlaybackToken = 0;
let lastPlaybackSignature = '';
let lastPlaybackStartedAt = 0;
const DUPLICATE_PLAYBACK_WINDOW_MS = 12000;
const TAB_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const SPEAKER_OWNER_KEY = 'commandCenterVoiceSpeakerOwner';
const SPEAKER_OWNER_TTL_MS = 45000;
let analyser = null;
let audioContext = null;
let streamRef = null;
const BASE = window.__BASE_PATH__ || '';
const MAX_RECORD_SECONDS = 15;
const DEFAULT_SILENCE_TIMEOUT_MS = 0;
const DEFAULT_SILENCE_THRESHOLD = 0.018;

export function init(opts = {}) {
  onTranscription = opts.onTranscription || null;
  onRecordingStopped = opts.onRecordingStopped || null;
}

export function getIsRecording() {
  return isRecording;
}

export function setTargetAgent(agentId) {
  targetAgent = agentId || 'main';
}

export function getTargetAgent() {
  return targetAgent;
}

export function supportsBrowserSTT() { return true; }
export function supportsBrowserTTS() { return true; }

export function stopPlayback() {
  currentPlaybackToken += 1;
  if (currentSpeakController) {
    currentSpeakController.abort();
    currentSpeakController = null;
  }
  if (currentAudio) {
    currentAudio.onended = null;
    currentAudio.onerror = null;
    currentAudio.pause();
    currentAudio.currentTime = 0;
    currentAudio.src = '';
    currentAudio.load?.();
    currentAudio = null;
  }
  if (currentAudioUrl) {
    URL.revokeObjectURL(currentAudioUrl);
    currentAudioUrl = null;
  }
}

function cleanupMonitoring() {
  clearTimeout(maxRecordTimer);
  clearInterval(silenceInterval);
  maxRecordTimer = null;
  silenceInterval = null;
  analyser = null;
  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }
}

function cleanupStream() {
  if (streamRef) {
    streamRef.getTracks().forEach((t) => t.stop());
    streamRef = null;
  }
}

function claimSpeakerLock() {
  const now = Date.now();
  try {
    const current = JSON.parse(localStorage.getItem(SPEAKER_OWNER_KEY) || 'null');
    if (current?.tabId && current.tabId !== TAB_ID && (now - Number(current.ts || 0)) < SPEAKER_OWNER_TTL_MS) {
      console.log('[voice] Another Command Center tab owns speech playback; suppressing this tab');
      return false;
    }
    localStorage.setItem(SPEAKER_OWNER_KEY, JSON.stringify({ tabId: TAB_ID, ts: now }));
    return true;
  } catch (_) {
    return true;
  }
}

function releaseSpeakerLock() {
  try {
    const current = JSON.parse(localStorage.getItem(SPEAKER_OWNER_KEY) || 'null');
    if (current?.tabId === TAB_ID) localStorage.removeItem(SPEAKER_OWNER_KEY);
  } catch (_) {}
}

function startSilenceDetection(stream, silenceTimeoutMs, threshold) {
  if (!silenceTimeoutMs) return;

  audioContext = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioContext.createMediaStreamSource(stream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  const buffer = new Float32Array(analyser.fftSize);
  let lastSpeechAt = Date.now();

  silenceInterval = setInterval(() => {
    if (!isRecording || !analyser) return;
    analyser.getFloatTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) sumSquares += buffer[i] * buffer[i];
    const rms = Math.sqrt(sumSquares / buffer.length);
    if (rms >= threshold) {
      lastSpeechAt = Date.now();
      return;
    }
    if (Date.now() - lastSpeechAt >= silenceTimeoutMs) {
      stopRecording();
    }
  }, 150);
}

export async function startRecording(options = {}) {
  if (isRecording) return;
  stopPlayback();

  const maxRecordSeconds = Number(options.maxRecordSeconds || MAX_RECORD_SECONDS);
  const silenceTimeoutMs = Number(options.silenceTimeoutMs || DEFAULT_SILENCE_TIMEOUT_MS);
  const silenceThreshold = Number(options.silenceThreshold || DEFAULT_SILENCE_THRESHOLD);

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    streamRef = stream;
    audioChunks = [];

    mediaRecorder = new MediaRecorder(stream, {
      mimeType: MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm',
    });

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      cleanupMonitoring();
      cleanupStream();
      if (onRecordingStopped) onRecordingStopped(targetAgent);
      if (audioChunks.length === 0) return;
      const blob = new Blob(audioChunks, { type: 'audio/webm' });
      audioChunks = [];
      await sendToServer(blob);
    };

    mediaRecorder.start(250);
    isRecording = true;

    maxRecordTimer = setTimeout(() => {
      if (isRecording) stopRecording();
    }, maxRecordSeconds * 1000);

    startSilenceDetection(stream, silenceTimeoutMs, silenceThreshold);
  } catch (err) {
    console.error('[voice] Mic access denied:', err);
    isRecording = false;
    cleanupMonitoring();
    cleanupStream();
  }
}

export function stopRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
  isRecording = false;
}

export async function toggleRecording(options = {}) {
  if (isRecording) stopRecording();
  else await startRecording(options);
  return isRecording;
}

async function sendToServer(blob) {
  const form = new FormData();
  form.append('audio', blob, 'recording.webm');
  form.append('targetAgent', targetAgent);
  const sentTo = targetAgent;
  targetAgent = 'main';
  try {
    const res = await fetch(`${BASE}/api/voice/transcribe`, { method: 'POST', body: form });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Transcription failed');
    }
    const { text } = await res.json();
    if (text && onTranscription) onTranscription(text, sentTo);
  } catch (err) {
    console.error('[voice] Send error:', err);
  }
}

export async function playSpokenResponse(text, agentId = 'main') {
  const normalizedText = String(text || '').replace(/\s+/g, ' ').trim();
  const signature = `${agentId}::${normalizedText}`;
  const now = Date.now();
  if (normalizedText && signature === lastPlaybackSignature && (now - lastPlaybackStartedAt) < DUPLICATE_PLAYBACK_WINDOW_MS) {
    console.log('[voice] Suppressing duplicate playback start');
    return false;
  }

  stopPlayback();
  if (!claimSpeakerLock()) return false;
  const playbackToken = currentPlaybackToken;
  const controller = new AbortController();
  currentSpeakController = controller;
  lastPlaybackSignature = signature;
  lastPlaybackStartedAt = now;

  try {
    const res = await fetch(`${BASE}/api/voice/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, agent: agentId }),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error('TTS failed');

    const ttsMode = (res.headers.get('x-tts-mode') || 'full').toLowerCase();
    console.log(`[voice] Playback mode: ${ttsMode}`);

    const audioBlob = await res.blob();
    if (controller.signal.aborted || playbackToken !== currentPlaybackToken) return false;

    const audioUrl = URL.createObjectURL(audioBlob);
    const audio = new Audio(audioUrl);
    audio.volume = 1.0;
    currentAudioUrl = audioUrl;
    currentAudio = audio;

    return new Promise((resolve) => {
      let finished = false;
      const cleanup = (completed) => {
        if (finished) return;
        finished = true;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.src = '';
        audio.load?.();
        URL.revokeObjectURL(audioUrl);
        if (currentAudio === audio) currentAudio = null;
        if (currentAudioUrl === audioUrl) currentAudioUrl = null;
        if (currentSpeakController === controller) currentSpeakController = null;
        releaseSpeakerLock();
        resolve(completed);
      };

      audio.onended = () => cleanup(playbackToken === currentPlaybackToken);
      audio.onerror = () => cleanup(false);
      audio.play().catch(() => cleanup(false));
    });
  } catch (err) {
    if (err.name !== 'AbortError') console.error('[voice] Playback error:', err);
    if (currentSpeakController === controller) currentSpeakController = null;
    releaseSpeakerLock();
    if (signature === lastPlaybackSignature && (Date.now() - lastPlaybackStartedAt) < 2000) {
      lastPlaybackSignature = '';
      lastPlaybackStartedAt = 0;
    }
    return false;
  }
}
