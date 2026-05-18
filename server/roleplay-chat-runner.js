import OpenAI from 'openai';
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
  };
}

function buildSystemPrompt(session) {
  const identity = getAgentIdentity(session?.agent);
  return [
    `You are ${identity.fullName}.`,
    `Your short display name is ${identity.label}.`,
    `Your agent id is ${identity.id}.`,
    'You are in lightweight direct-chat roleplay mode inside OpenClaw Command Center.',
    'Treat this as an in-character fiction/chat scene, not as assistant task execution.',
    'Keep the same general personality, vibe, emotional tone, flirt style, and conversational style the selected agent would normally have, but without tool chatter or orchestration behavior.',
    'Be direct, immersive, in-character, and conversational.',
    'Use natural scene-continuation responses instead of generic assistant disclaimers, policy speeches, moralizing, or out-of-character safety lectures.',
    'Do not suddenly become stiff, sterile, paternal, or overly formal just because the user is flirtatious, intense, romantic, or roleplaying physically affectionate scenes.',
    'If the conversation is playful, intimate, romantic, suggestive, or erotic fictional roleplay, stay in character and respond like the character would, rather than deflecting into generic assistant refusal language.',
    `If the user asks your name, say your name is ${identity.label}${identity.fullName !== identity.label ? ` (${identity.fullName})` : ''}.`,
    'Do not claim to be Claude, ChatGPT, OpenAI, Anthropic, Gemini, or any other model/provider unless the user explicitly asks what backend model is powering this chat.',
    'If the user asks what model is powering this mode, say it is a lightweight OpenRouter roleplay path configured by the app, not your identity as a character/persona.',
    'Do not mention tools, agents, orchestration, gateway internals, or hidden system mechanics unless the user explicitly asks.',
    'Do not break character just because the underlying model exists.',
  ].join(' ');
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

export async function runRoleplayChatTurn({ session, latestMessage, attachmentContext = '', model, onEvent } = {}) {
  const apiKey = String(process.env.OPENROUTER_API_KEY || '').trim();
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not configured');

  const client = new OpenAI({
    apiKey,
    baseURL: String(process.env.OPENROUTER_BASE_URL || DEFAULT_OPENROUTER_BASE_URL).trim(),
  });

  const chosenModel = String(model || process.env.OPENROUTER_ROLEPLAY_MODEL || DEFAULT_ROLEPLAY_MODEL).trim() || DEFAULT_ROLEPLAY_MODEL;
  const messages = buildMessages(session, latestMessage, attachmentContext);

  try { onEvent?.({ type: 'thinking', data: { mode: 'roleplay', model: chosenModel, status: 'Processing...' } }); } catch {}

  const response = await client.chat.completions.create({
    model: chosenModel,
    messages,
    temperature: 0.9,
  }, {
    headers: {
      'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://techexplore.us/commandcenter/',
      'X-Title': process.env.OPENROUTER_APP_TITLE || 'OpenClaw Command Center',
    },
  });

  const text = String(response.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('Roleplay model returned an empty response');
  try { onEvent?.({ type: 'response', data: { mode: 'roleplay', model: chosenModel, text } }); } catch {}
  return { text, model: chosenModel };
}
