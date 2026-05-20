import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'gemini-settings.json');

export const GEMINI_LIVE_VOICE_OPTIONS = [
  'Zephyr', 'Kore', 'Orus', 'Autonoe', 'Umbriel', 'Erinome', 'Laomedeia', 'Schedar', 'Achird', 'Sadachbia',
  'Puck', 'Fenrir', 'Aoede', 'Enceladus', 'Algieba', 'Algenib', 'Achernar', 'Gacrux', 'Zubenelgenubi', 'Sadaltager',
  'Charon', 'Leda', 'Callirrhoe', 'Iapetus', 'Despina', 'Rasalgethi', 'Alnilam', 'Pulcherrima', 'Vindemiatrix', 'Sulafat',
];

const DEFAULT_GEMINI_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.1-flash-live-preview',
  responseModalities: ['AUDIO'],
  thinkingLevel: 'minimal',
  voiceName: 'Sulafat',
  speechOutputMode: 'gemini',
  fishVoiceId: '',
  personaName: 'Fairy',
  operatorName: 'Epic',
  personalityPrompt: '',
  memoryEnabled: true,
  memoryNotes: '',
};

function normalizeModalities(value) {
  if (Array.isArray(value)) {
    const items = value.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean);
    return items.length ? [...new Set(items)] : ['AUDIO'];
  }
  const text = String(value || '').trim();
  if (!text) return ['AUDIO'];
  const items = text.split(/[,+\s]+/).map((item) => item.trim().toUpperCase()).filter(Boolean);
  return items.length ? [...new Set(items)] : ['AUDIO'];
}

function normalizeThinkingLevel(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['none', 'minimal', 'low', 'medium', 'high'].includes(normalized) ? normalized : 'minimal';
}

function normalizeVoiceName(value = '') {
  const raw = String(value || '').trim();
  if (!raw) return DEFAULT_GEMINI_SETTINGS.voiceName;
  const matched = GEMINI_LIVE_VOICE_OPTIONS.find((item) => item.toLowerCase() == raw.toLowerCase());
  return matched || DEFAULT_GEMINI_SETTINGS.voiceName;
}

function normalizeSpeechOutputMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'fish' ? 'fish' : 'gemini';
}

function normalizeFishVoiceId(value = '') {
  return String(value || '').trim().slice(0, 200);
}

function normalizePersonaName(value = '') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 80) || DEFAULT_GEMINI_SETTINGS.personaName;
}

function normalizeOperatorName(value = '') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  return raw.slice(0, 80) || DEFAULT_GEMINI_SETTINGS.operatorName;
}

function normalizePersonalityPrompt(value = '') {
  return String(value || '').trim().slice(0, 8000);
}

function normalizeMemoryEnabled(value = true) {
  if (value === false) return false;
  if (typeof value === 'string') return !['false', '0', 'off', 'no'].includes(value.trim().toLowerCase());
  return true;
}

function normalizeMemoryNotes(value = '') {
  return String(value || '').trim().slice(0, 12000);
}

function normalizeGeminiSettings(input = {}) {
  return {
    apiKey: String(input.apiKey || '').trim(),
    model: String(input.model || DEFAULT_GEMINI_SETTINGS.model).trim() || DEFAULT_GEMINI_SETTINGS.model,
    responseModalities: normalizeModalities(input.responseModalities || DEFAULT_GEMINI_SETTINGS.responseModalities),
    thinkingLevel: normalizeThinkingLevel(input.thinkingLevel || DEFAULT_GEMINI_SETTINGS.thinkingLevel),
    voiceName: normalizeVoiceName(input.voiceName || DEFAULT_GEMINI_SETTINGS.voiceName),
    speechOutputMode: normalizeSpeechOutputMode(input.speechOutputMode || DEFAULT_GEMINI_SETTINGS.speechOutputMode),
    fishVoiceId: normalizeFishVoiceId(input.fishVoiceId || DEFAULT_GEMINI_SETTINGS.fishVoiceId),
    personaName: normalizePersonaName(input.personaName || DEFAULT_GEMINI_SETTINGS.personaName),
    operatorName: normalizeOperatorName(input.operatorName || DEFAULT_GEMINI_SETTINGS.operatorName),
    personalityPrompt: normalizePersonalityPrompt(input.personalityPrompt || DEFAULT_GEMINI_SETTINGS.personalityPrompt),
    memoryEnabled: normalizeMemoryEnabled(input.memoryEnabled ?? DEFAULT_GEMINI_SETTINGS.memoryEnabled),
    memoryNotes: normalizeMemoryNotes(input.memoryNotes || DEFAULT_GEMINI_SETTINGS.memoryNotes),
  };
}

export async function loadGeminiSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_GEMINI_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_GEMINI_SETTINGS, ...normalizeGeminiSettings(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_GEMINI_SETTINGS };
  }
}

export async function saveGeminiSettings(input = {}) {
  const settings = normalizeGeminiSettings(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export async function loadGeminiRuntimeConfig() {
  const local = await loadGeminiSettings();
  if (local.apiKey) {
    return {
      ok: true,
      hasApiKey: true,
      apiKey: local.apiKey,
      model: local.model,
      responseModalities: local.responseModalities,
      thinkingLevel: local.thinkingLevel,
      voiceName: local.voiceName,
      speechOutputMode: local.speechOutputMode,
      fishVoiceId: local.fishVoiceId,
      personaName: local.personaName,
      operatorName: local.operatorName,
      personalityPrompt: local.personalityPrompt,
      memoryEnabled: local.memoryEnabled,
      memoryNotes: local.memoryNotes,
      source: 'command-center-local',
    };
  }

  const envApiKey = String(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '').trim();
  if (envApiKey) {
    return {
      ok: true,
      hasApiKey: true,
      apiKey: envApiKey,
      model: String(process.env.GEMINI_LIVE_MODEL || local.model || DEFAULT_GEMINI_SETTINGS.model).trim(),
      responseModalities: normalizeModalities(process.env.GEMINI_LIVE_RESPONSE_MODALITIES || local.responseModalities),
      thinkingLevel: normalizeThinkingLevel(process.env.GEMINI_LIVE_THINKING_LEVEL || local.thinkingLevel),
      voiceName: normalizeVoiceName(process.env.GEMINI_LIVE_VOICE_NAME || local.voiceName),
      speechOutputMode: normalizeSpeechOutputMode(process.env.GEMINI_LIVE_SPEECH_OUTPUT_MODE || local.speechOutputMode),
      fishVoiceId: normalizeFishVoiceId(process.env.GEMINI_LIVE_FISH_VOICE_ID || local.fishVoiceId),
      personaName: normalizePersonaName(process.env.GEMINI_LIVE_PERSONA_NAME || local.personaName),
      operatorName: normalizeOperatorName(process.env.GEMINI_LIVE_OPERATOR_NAME || local.operatorName),
      personalityPrompt: normalizePersonalityPrompt(process.env.GEMINI_LIVE_PERSONALITY_PROMPT || local.personalityPrompt),
      memoryEnabled: normalizeMemoryEnabled(process.env.GEMINI_LIVE_MEMORY_ENABLED ?? local.memoryEnabled),
      memoryNotes: normalizeMemoryNotes(process.env.GEMINI_LIVE_MEMORY_NOTES || local.memoryNotes),
      source: process.env.GEMINI_API_KEY ? 'env:GEMINI_API_KEY' : 'env:GOOGLE_API_KEY',
    };
  }

  return {
    ok: false,
    hasApiKey: false,
    apiKey: '',
    model: local.model || DEFAULT_GEMINI_SETTINGS.model,
    responseModalities: local.responseModalities || ['AUDIO'],
    thinkingLevel: local.thinkingLevel || 'minimal',
    voiceName: local.voiceName || DEFAULT_GEMINI_SETTINGS.voiceName,
    speechOutputMode: local.speechOutputMode || DEFAULT_GEMINI_SETTINGS.speechOutputMode,
    fishVoiceId: local.fishVoiceId || DEFAULT_GEMINI_SETTINGS.fishVoiceId,
    personaName: local.personaName || DEFAULT_GEMINI_SETTINGS.personaName,
    operatorName: local.operatorName || DEFAULT_GEMINI_SETTINGS.operatorName,
    personalityPrompt: local.personalityPrompt || DEFAULT_GEMINI_SETTINGS.personalityPrompt,
    memoryEnabled: local.memoryEnabled,
    memoryNotes: local.memoryNotes || DEFAULT_GEMINI_SETTINGS.memoryNotes,
    source: 'command-center-local',
    error: 'Gemini API key is not configured in Command Center settings',
  };
}
