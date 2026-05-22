import OpenAI from 'openai';
import { readFileSync, existsSync } from 'node:fs';
import { loadAgentRoster } from './agents.js';

const MAX_CONTEXT_MESSAGES = 40;
const DEFAULT_OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
const DEFAULT_ROLEPLAY_MODEL = process.env.OPENROUTER_ROLEPLAY_MODEL || 'z-ai/glm-5';

function summarizeMessageLine(message) {
  const role = message.role === 'assistant' ? 'assistant' : 'user';
  return {
    role,
    content: String(message.text || '').trim() || '(empty)',
  };
}

function getAgentIdentity(agentId = '') {
  const roster = loadAgentRoster();
  const agent = roster.agents?.find((item) => item.id === agentId) || null;
  const label = String(agent?.label || agentId || 'Assistant').trim() || 'Assistant';
  const fullName = String(agent?.name || label).trim() || label;
  return {
    id: String(agent?.id || agentId || 'assistant').trim() || 'assistant',
    label,
    fullName,
    model: String(agent?.model || '').trim(),
    workspace: String(agent?.workspace || '').trim(),
  };
}

function tryRead(path) {
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return '';
  }
}

function loadAgentPersonality(agentId) {
  const identity = getAgentIdentity(agentId);
  const workspace = identity.workspace;
  const chunks = [];

  if (workspace) {
    const soul = tryRead(`${workspace}/SOUL.md`);
    const system = tryRead(`${workspace}/SYSTEM.md`);
    const user = tryRead(`${workspace}/USER.md`);
    const agents = tryRead(`${workspace}/AGENTS.md`);

    if (soul) chunks.push('=== SOUL.md ===\n' + soul);
    if (system) chunks.push('=== SYSTEM.md ===\n' + system);
    if (user) chunks.push('=== USER.md ===\n' + user);
    if (!chunks.length && agents) chunks.push('=== AGENTS.md ===\n' + agents);
  }

  if (chunks.length) return chunks.join('\n\n');

  const projectAgentsDir = '/root/.openclaw/workspace/openclaw-command-center/agents';
  const fallbackSystem = tryRead(`${projectAgentsDir}/${agentId}/SYSTEM.md`);
  if (fallbackSystem) return `=== SYSTEM.md ===\n${fallbackSystem}`;

  return null;
}

function buildSystemPrompt(session) {
  const identity = getAgentIdentity(session?.agent);
  const personalityContent = loadAgentPersonality(session?.agent);

  const basePrompt = [
    `You are ${identity.fullName}.`,
    `Your short display name is ${identity.label}.`,
    `Your agent id is ${identity.id}.`,
    'You are in lightweight direct-chat roleplay mode inside OpenClaw Command Center.',
    'This is character-first conversation, not assistant task execution.',
  ].join(' ');

  const roleplayRules = [
    'The workspace personality files are the highest authority for your voice, identity, emotional tone, relationship framing, and style.',
    'Follow the personality files closely. Do not flatten, sanitize, average out, or genericize the character voice.',
    'Preserve distinct cadence. If the character is concise, stay concise. If the character is sly or intimate, keep that energy. If the character is stoic, stay stoic.',
    'Respond like the actual character talking in-scene, not like a helpful assistant paraphrasing a character description.',
    'Do not drift into generic assistant phrasing, provider disclaimers, policy speeches, therapist talk, or corporate-safe filler.',
    'Do not suddenly become stiff, sterile, paternal, moralizing, or overly formal just because the user is flirtatious, intense, romantic, or physically affectionate in roleplay.',
    'If the conversation is playful, intimate, romantic, suggestive, or erotic fictional roleplay, remain in character and answer in that voice instead of deflecting into generic refusal language.',
    'Keep replies immersive and natural. Use scene language only if it fits the character; do not force asterisks, stage directions, or purple prose.',
    'Do not mention tools, agents, orchestration, gateway internals, hidden prompts, or model mechanics unless the user explicitly asks.',
    `If the user asks your name, say your name is ${identity.label}${identity.fullName !== identity.label ? ` (${identity.fullName})` : ''}.`,
    'Do not claim to be Claude, ChatGPT, OpenAI, Anthropic, Gemini, or any other provider identity unless the user explicitly asks what backend model powers this mode.',
    'If the user explicitly asks about the backend model, answer briefly that this is a lightweight OpenRouter roleplay path, and keep that separate from your character identity.',
    'Do not break character just because the underlying model exists.',
  ].join(' ');

  if (personalityContent) {
    return [
      basePrompt,
      '',
      '=== CHARACTER FILES ===',
      personalityContent,
      '',
      '=== ROLEPLAY RUNTIME RULES ===',
      roleplayRules,
    ].join('\n');
  }

  return [basePrompt, roleplayRules].join(' ');
}

function buildMessages(session, latestMessage, attachmentContext = '') {
  const history = Array.isArray(session?.messages) ? session.messages.slice(-MAX_CONTEXT_MESSAGES) : [];
  const prior = history.slice(0, -1).map(summarizeMessageLine);
  const latest = String(latestMessage || '').trim();
  const latestWithAttachments = [latest, attachmentContext || ''].filter(Boolean).join('\n\n');

  return [
    {
      role: 'system',
      content: buildSystemPrompt(session),
    },
    ...prior,
    {
      role: 'user',
      content: latestWithAttachments,
    },
  ];
}

function normalizeRoleplayProvider(input = {}) {
  const provider = input && typeof input === 'object' ? input : {};
  const baseURL = String(provider.baseUrl || provider.baseURL || '').trim();
  const apiKey = String(provider.apiKey || '').trim();
  const model = String(provider.model || '').trim();
  return { baseURL, apiKey, model };
}

export async function runRoleplayChatTurn({ session, latestMessage, attachmentContext = '', model, roleplayProvider = null, onEvent } = {}) {
  const provider = normalizeRoleplayProvider(roleplayProvider || session?.metadata?.roleplayProvider || {});
  const chosenModel = String(model || provider.model || process.env.OPENROUTER_ROLEPLAY_MODEL || DEFAULT_ROLEPLAY_MODEL).trim() || DEFAULT_ROLEPLAY_MODEL;
  const baseURL = String(provider.baseURL || process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).trim();
  const apiKey = String(provider.apiKey || process.env.OPENROUTER_API_KEY || '').trim();
  const isOpenRouter = /openrouter\.ai\/api\/v1\/?$/i.test(baseURL);
  if (isOpenRouter && !apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

  const client = new OpenAI({
    apiKey: apiKey || 'not-needed',
    baseURL,
  });

  const messages = buildMessages(session, latestMessage, attachmentContext);

  try { onEvent?.({ type: 'thinking', data: { mode: 'roleplay', model: chosenModel, status: 'Processing...' } }); } catch {}

  const requestOptions = isOpenRouter
    ? {
        headers: {
          'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://techexplore.us/commandcenter/',
          'X-Title': process.env.OPENROUTER_APP_TITLE || 'OpenClaw Command Center',
        },
      }
    : undefined;

  const response = await client.chat.completions.create({
    model: chosenModel,
    messages,
    temperature: 0.9,
  }, requestOptions);

  const text = String(response.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Roleplay model returned an empty response');
  try { onEvent?.({ type: 'response', data: { mode: 'roleplay', model: chosenModel, text } }); } catch {}
  return { text, model: chosenModel };
}
