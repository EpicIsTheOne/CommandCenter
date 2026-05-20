import { randomUUID } from 'node:crypto';

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function createCallSession({ agent = 'orchestrator', mode = 'gemini-live', persona = 'fairy', callMode = 'universal' } = {}) {
  const id = `call-${randomUUID()}`;
  const session = {
    id,
    agent,
    mode,
    persona,
    state: 'connecting',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    partialTranscript: '',
    lastTranscript: '',
    lastAssistantText: '',
    transcriptEntries: [],
    memoryUpdate: null,
    imageDisplay: null,
    handoffTaskId: '',
    handoffTitle: '',
    screenShareActive: false,
    cameraShareActive: false,
    lastScreenFrameAt: null,
    lastScreenFrameMeta: null,
    screenFrameCount: 0,
    lastCameraFrameAt: null,
    lastCameraFrameMeta: null,
    cameraFrameCount: 0,
    lastScreenChange: null,
    lastGeminiHint: '',
    lastGeminiHintAt: null,
    lastVisualAssumption: '',
    lastVisualConfidence: '',
    lastRoutingDecision: '',
    lastTaskSummary: '',
    callMode,
    modeDecision: '',
    modeReason: '',
    intensityLevel: 'low',
    lastCalloutTier: '',
    speechSuppressedReason: '',
    handoffPolicy: callMode === 'gaming' ? 'conservative' : 'normal',
    visualMemory: {
      current: null,
      recent: [],
      lastStableScreenFrameAt: null,
      lastStableScreenFrameMeta: null,
      lastChangeAt: null,
      lastChangeSummary: '',
    },
    recordingActive: false,
    recordingStartedAt: null,
    lastRecordingId: '',
    muted: false,
    uplinkAudioChunks: 0,
    geminiEventCount: 0,
    currentTurnGeminiEventCount: 0,
    currentTurnAudioChunks: 0,
    lastAudioAt: null,
    lastGeminiEventAt: null,
    active: true,
  };
  sessions.set(id, session);
  return session;
}

export function getCallSession(id) {
  return sessions.get(id) || null;
}

export function updateCallSession(id, patch = {}) {
  const existing = sessions.get(id);
  if (!existing) return null;
  const next = { ...existing, ...patch, updatedAt: nowIso() };
  sessions.set(id, next);
  return next;
}

export function endCallSession(id, reason = 'ended') {
  return updateCallSession(id, { active: false, state: reason });
}

export function listCallSessions() {
  return [...sessions.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
}
