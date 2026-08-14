import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildFairyLiveSystemPrompt, FAIRY_LIVE_TOOLS } from '../server/gemini-live.js';

const fairyLiveSource = readFileSync(resolve(process.cwd(), 'public/js/fairy-live.js'), 'utf8');
const appSource = readFileSync(resolve(process.cwd(), 'public/js/app.js'), 'utf8');
const directChatSource = readFileSync(resolve(process.cwd(), 'public/js/direct-chat.js'), 'utf8');

test('Fairy live prompt describes relay agents as actionable remote targets', () => {
  const prompt = buildFairyLiveSystemPrompt({
    roster: {
      primaryAgentId: 'main',
      agents: [{
        id: 'relay:windows:hermes:default',
        label: 'Reika',
        source: 'relay',
        relay: true,
        relayProviderLabel: 'Hermes',
        relayDeviceName: 'Epic Windows Hermes',
        relayAgentStatus: 'thinking',
      }],
    },
  });

  assert.match(prompt, /runtime: Hermes/);
  assert.match(prompt, /device: Epic Windows Hermes/);
  assert.match(prompt, /status: thinking/);
  assert.match(prompt, /inspect_agents/);
  assert.match(prompt, /check_agent_progress/);
  assert.match(prompt, /relay:windows:hermes:default/);
});

test('Fairy live tool declarations include agent inspection and progress checks', () => {
  const declarations = FAIRY_LIVE_TOOLS.flatMap((group) => group.functionDeclarations || []);
  const names = declarations.map((tool) => tool.name);
  assert.ok(names.includes('inspect_agents'));
  assert.ok(names.includes('check_agent_progress'));
  assert.ok(names.includes('handoff_to_agent'));
});

test('Fairy keeps mic capture alive across transient audio upload failures', () => {
  const postAudioChunk = fairyLiveSource.slice(fairyLiveSource.indexOf('function postAudioChunk'), fairyLiveSource.indexOf('function supportsStreamingAudioMime'));
  assert.match(postAudioChunk, /micUploadFailureCount/);
  assert.match(postAudioChunk, /keeping capture alive/);
  assert.doesNotMatch(postAudioChunk, /stopMic\s*\(/);
});

test('Fairy has mic capture and audio-context recovery hooks', () => {
  assert.match(fairyLiveSource, /track\.addEventListener\?\.\('ended'/);
  assert.match(fairyLiveSource, /scheduleMicRecovery\('microphone track ended'/);
  assert.match(fairyLiveSource, /ctx\.state === 'suspended' \|\| ctx\.state === 'interrupted'/);
  assert.match(fairyLiveSource, /visibilitychange/);
  assert.match(fairyLiveSource, /devicechange/);
});

test('Fairy module cache keys advance with the microphone fix', () => {
  assert.match(appSource, /fairy-live\.js\?v=20260813-fairy-mic-recovery1/);
  assert.match(directChatSource, /fairy-live\.js\?v=20260813-fairy-mic-recovery1/);
});
