import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveRoleplayModelChain, runRoleplayChatTurn } from '../server/roleplay-chat-runner.js';

// Use a non-OpenRouter base URL so the runner's OpenRouter-only API-key
// requirement is skipped; the injected fake client ignores the URL anyway.
const ORIG_BASE = process.env.OPENROUTER_BASE_URL;
process.env.OPENROUTER_BASE_URL = 'http://localhost:9999/v1';

test('resolveRoleplayModelChain puts explicit model first, then fallbacks, deduped', () => {
  const chain = resolveRoleplayModelChain('z-ai/glm-5', '');
  assert.equal(chain[0], 'z-ai/glm-5');
  assert.ok(chain.length >= 2, 'should include fallbacks');
  assert.equal(new Set(chain).size, chain.length, 'chain must be de-duplicated');
});

test('resolveRoleplayModelChain honors OPENROUTER_ROLEPLAY_MODEL_FALLBACKS env', () => {
  process.env.OPENROUTER_ROLEPLAY_MODEL_FALLBACKS = 'openai/gpt-4o, anthropic/claude-3.5-sonnet';
  try {
    const chain = resolveRoleplayModelChain('z-ai/glm-5', '');
    assert.deepEqual(chain, ['z-ai/glm-5', 'openai/gpt-4o', 'anthropic/claude-3.5-sonnet']);
  } finally {
    delete process.env.OPENROUTER_ROLEPLAY_MODEL_FALLBACKS;
  }
});

test('runRoleplayChatTurn falls back to the second model when the first fails', async () => {
  const calls = [];
  const createClient = () => ({
    chat: {
      completions: {
        create: async ({ model }) => {
          calls.push(model);
          if (model === 'z-ai/glm-5') throw new Error('provider 503');
          return { choices: [{ message: { content: ' fallback response ' } }] };
        },
      },
    },
  });
  const events = [];
  const result = await runRoleplayChatTurn({
    session: { agent: 'test', messages: [] },
    latestMessage: 'hello',
    createClient,
    onEvent: (e) => events.push(e),
  });
  assert.equal(result.text, 'fallback response', 'should use the second model text');
  assert.equal(result.model, calls[1], 'result.model should be the model that succeeded');
  assert.deepEqual(calls, ['z-ai/glm-5', calls[1]], 'tried primary then fallback');
  assert.ok(events.some((e) => e.type === 'model-fallback'), 'should emit a fallback event');
});

test('runRoleplayChatTurn returns primary model when it succeeds', async () => {
  const calls = [];
  const createClient = () => ({
    chat: { completions: { create: async ({ model }) => { calls.push(model); return { choices: [{ message: { content: ' primary ok ' } }] }; } } },
  });
  const result = await runRoleplayChatTurn({
    session: { agent: 'test', messages: [] },
    latestMessage: 'hi',
    createClient,
  });
  assert.equal(result.text, 'primary ok');
  assert.equal(calls.length, 1, 'should not invoke fallbacks when primary works');
});

test('runRoleplayChatTurn throws after all models fail', async () => {
  const createClient = () => ({
    chat: { completions: { create: async () => { throw new Error('boom'); } } },
  });
  await assert.rejects(() => runRoleplayChatTurn({
    session: { agent: 'test', messages: [] },
    latestMessage: 'hi',
    createClient,
  }), /failed across all models/);
});

test('runRoleplayChatTurn falls back on empty response from primary', async () => {
  let first = true;
  const createClient = () => ({
    chat: {
      completions: {
        create: async () => {
          if (first) { first = false; return { choices: [{ message: { content: '   ' } }] }; }
          return { choices: [{ message: { content: ' real text ' } }] };
        },
      },
    },
  });
  const result = await runRoleplayChatTurn({
    session: { agent: 'test', messages: [] },
    latestMessage: 'hi',
    createClient,
  });
  assert.equal(result.text, 'real text', 'empty primary response must trigger fallback');
});
