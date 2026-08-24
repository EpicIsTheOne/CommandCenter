import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { GeminiLiveSession } from '../server/gemini-live.js';

const settingsSource = readFileSync(resolve(process.cwd(), 'server/settings.js'), 'utf8');
const indexSource = readFileSync(resolve(process.cwd(), 'server/index.js'), 'utf8');
const voiceSource = readFileSync(resolve(process.cwd(), 'server/voice.js'), 'utf8');
const fairyLiveSource = readFileSync(resolve(process.cwd(), 'public/js/fairy-live.js'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
const wakeSource = readFileSync(resolve(process.cwd(), 'public/js/wake.js'), 'utf8');

function makeSession(overrides = {}) {
  return new GeminiLiveSession({
    apiKey: 'test-key',
    responseModalities: ['AUDIO'],
    systemPrompt: 'p',
    voiceName: 'Sulafat',
    ...overrides,
  });
}

test('Fish Audio is the default TTS provider and loopback ships disabled', () => {
  assert.match(settingsSource, /provider:\s*'fish'/);
  assert.match(settingsSource, /loopbackEnabled:\s*false/);
  // Unknown providers fall back to Fish now that ElevenLabs is legacy.
  const normalizeMatch = settingsSource.match(/function normalizeProvider[\s\S]*?\n}/);
  assert.ok(normalizeMatch, 'normalizeProvider exists');
  assert.match(normalizeMatch[0], /:\s*'fish';/);
});

test('Server voices agent replies through the loopback hook when enabled', () => {
  assert.match(indexSource, /maybeSpeakLoopback\(msg\)/);
  assert.match(indexSource, /voice:loopback/);
  assert.match(indexSource, /settings\.loopbackEnabled !== true/);
  // Never double-speak an agent that is mid live call.
  assert.match(indexSource, /session\.state !== 'ended'/);
});

test('Call audio uplink is shared between HTTP POST and the WebSocket', () => {
  assert.match(indexSource, /function handleCallAudioChunk/);
  assert.match(indexSource, /'call:audio'/);
  assert.match(indexSource, /isValidSession\(cookies\.cc_auth\)/);
  assert.match(fairyLiveSource, /__ccWsSend\?\.\(\{\s*type:\s*'call:audio'/);
});

test('App exposes a guarded WebSocket send hook for streaming modules', () => {
  assert.match(appSource, /window\.__ccWsSend = /);
  assert.match(appSource, /bufferedAmount > 512 \* 1024/);
});

test('Fairy streams Fish speech sentence-by-sentence instead of flat delays', () => {
  assert.match(fairyLiveSource, /queueCompletedFishSentences/);
  assert.match(fairyLiveSource, /drainFishSentences/);
  assert.match(fairyLiveSource, /resetFishStream/);
  assert.doesNotMatch(fairyLiveSource, /fishSpeakDelayForText/);
});

test('Fairy ducks playback while local VAD hears the operator', () => {
  assert.match(fairyLiveSource, /setPlaybackDuck\(true\)/);
  assert.match(fairyLiveSource, /PLAYBACK_DUCK_VOLUME/);
});

test('Push-to-talk bypasses mute gates only while held', () => {
  assert.match(fairyLiveSource, /state\.pttActive/);
  assert.match(fairyLiveSource, /fairy-live-ptt/);
});

test('Wake mode uses on-device Porcupine spotting with server fallback', () => {
  assert.match(wakeSource, /PorcupineWorker\.create/);
  assert.match(wakeSource, /voiceProcessor\.start\(\{ porcupine: worker \}\)/);
  assert.match(wakeSource, /api\/settings\/wake\/runtime/);
  assert.match(wakeSource, /getUserMedia\(/);
});

test('Fish TTS refuses HTML responses instead of playing them as audio', () => {
  const matches = voiceSource.match(/returned HTML instead of audio/g) || [];
  assert.ok(matches.length >= 2, 'guard present in full-buffer and streaming paths');
});

test('Gemini live sessions request resumption handles and resume from them', () => {
  const session = makeSession();
  const fresh = session._buildSetup();
  assert.deepEqual(fresh.setup.sessionResumption, {});

  session.sessionHandle = 'handle-abc';
  const resumed = session._buildSetup();
  assert.equal(resumed.setup.sessionResumption.handle, 'handle-abc');
});

test('Gemini live sessions auto-reconnect with capped backoff and stop on close', () => {
  const session = makeSession();
  const events = [];
  session.onEvent = (event) => events.push(event);

  assert.equal(session.autoReconnect, true);
  assert.equal(session._scheduleReconnect('socket drop'), true);
  assert.equal(session.reconnectAttempts, 1);
  assert.ok(session._reconnectTimer);
  assert.equal(events.filter((e) => e.type === 'reconnecting').length, 1);

  session.close();
  assert.equal(session._closing, true);
  assert.equal(session._reconnectTimer, null);

  const exhausted = makeSession();
  exhausted.reconnectAttempts = 5;
  assert.equal(exhausted._scheduleReconnect('socket drop'), false);
});
