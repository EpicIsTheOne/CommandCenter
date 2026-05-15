import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const SETTINGS_FILE = join(DATA_DIR, 'voice-settings.json');

const DEFAULT_SETTINGS = {
  provider: 'elevenlabs',
  elevenlabsApiKey: '',
  defaultVoiceId: '',
  fishAudioApiBase: 'https://your-domain.example/aichat',
  fishVoiceId: '',
  fishSessionCookie: '',
  fishFormat: 'mp3',
  fishIncludeAsteriskNarration: false,
  fishPlaybackMode: 'auto',
  fishAutoStreamMinChars: 260,
  agentVoices: {},
  elevenlabsAgentVoices: {},
  fishAgentVoices: {},
};

function normalizeProvider(provider = '') {
  const value = String(provider || '').trim().toLowerCase();
  return value === 'fish' || value === 'fish-audio' || value === 'fish_audio' ? 'fish' : 'elevenlabs';
}

function normalizeVoiceMap(value = {}) {
  return Object.fromEntries(
    Object.entries(value || {}).map(([agentId, voiceId]) => [
      String(agentId),
      String(voiceId || '').trim(),
    ]),
  );
}

function looksLikeElevenLabsVoiceId(value = '') {
  return /^[A-Za-z0-9]{20}$/.test(String(value || '').trim());
}

function normalize(input = {}) {
  const provider = normalizeProvider(input.provider || DEFAULT_SETTINGS.provider);
  const legacyAgentVoices = normalizeVoiceMap(input.agentVoices || {});
  const elevenlabsAgentVoices = normalizeVoiceMap(
    input.elevenlabsAgentVoices || (provider === 'elevenlabs' ? legacyAgentVoices : {}),
  );
  const fishAgentVoices = normalizeVoiceMap(
    input.fishAgentVoices || (provider === 'fish' ? legacyAgentVoices : {}),
  );

  // Old CommandCenter builds stored ElevenLabs IDs in agentVoices only. Preserve those
  // as ElevenLabs voices even if the user later switches provider to Fish.
  for (const [agentId, voiceId] of Object.entries(legacyAgentVoices)) {
    if (!elevenlabsAgentVoices[agentId] && looksLikeElevenLabsVoiceId(voiceId)) {
      elevenlabsAgentVoices[agentId] = voiceId;
    }
  }

  return {
    provider,
    elevenlabsApiKey: String(input.elevenlabsApiKey || '').trim(),
    defaultVoiceId: String(input.defaultVoiceId || '').trim(),
    fishAudioApiBase: String(input.fishAudioApiBase || DEFAULT_SETTINGS.fishAudioApiBase).trim().replace(/\/+$/, ''),
    fishVoiceId: String(input.fishVoiceId || '').trim(),
    fishSessionCookie: String(input.fishSessionCookie || '').trim(),
    fishFormat: ['mp3', 'wav', 'opus', 'pcm'].includes(String(input.fishFormat || '').trim()) ? String(input.fishFormat || '').trim() : 'mp3',
    fishIncludeAsteriskNarration: input.fishIncludeAsteriskNarration === true,
    fishPlaybackMode: ['auto', 'stream', 'full'].includes(String(input.fishPlaybackMode || '').trim()) ? String(input.fishPlaybackMode || '').trim() : 'auto',
    fishAutoStreamMinChars: Math.min(4000, Math.max(80, Number(input.fishAutoStreamMinChars || DEFAULT_SETTINGS.fishAutoStreamMinChars) || DEFAULT_SETTINGS.fishAutoStreamMinChars)),
    agentVoices: provider === 'fish' ? fishAgentVoices : elevenlabsAgentVoices,
    elevenlabsAgentVoices,
    fishAgentVoices,
  };
}

export async function loadVoiceSettings() {
  try {
    if (!existsSync(SETTINGS_FILE)) return { ...DEFAULT_SETTINGS };
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    return { ...DEFAULT_SETTINGS, ...normalize(JSON.parse(raw)) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveVoiceSettings(input) {
  const settings = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
  return settings;
}

export function maskApiKey(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return '';
  if (key.length <= 8) return '••••••••';
  return `${key.slice(0, 4)}••••${key.slice(-4)}`;
}


export function maskSessionCookie(cookie) {
  const value = String(cookie || '').trim();
  if (!value) return '';
  const token = value.includes('=') ? value.split('=').pop() : value;
  if (token.length <= 12) return '••••••••';
  return `${token.slice(0, 6)}••••${token.slice(-6)}`;
}
