import { randomUUID } from 'node:crypto';

const sessions = new Map();

function nowIso() {
  return new Date().toISOString();
}

export function createCallSession({ agent = 'orchestrator', mode = 'gemini-live', persona = 'fairy' } = {}) {
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
    handoffTaskId: '',
    handoffTitle: '',
    screenShareActive: false,
    cameraShareActive: false,
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
