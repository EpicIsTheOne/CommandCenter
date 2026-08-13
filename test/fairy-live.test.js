import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFairyLiveSystemPrompt, FAIRY_LIVE_TOOLS } from '../server/gemini-live.js';

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
