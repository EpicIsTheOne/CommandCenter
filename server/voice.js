import { execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { loadVoiceSettings } from './settings.js';

const ROOT = process.cwd();
const PYTHONPATH = join(ROOT, '.pydeps');
const WHISPER_CACHE_DIR = join(ROOT, '.cache', 'whisper');
const ELEVENLABS_BASE_URL = 'https://api.elevenlabs.io';
const DEFAULT_FISH_AUDIO_BASE_URL = 'https://your-domain.example/aichat';

async function ensureDirs() {
  await mkdir(WHISPER_CACHE_DIR, { recursive: true });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

export async function transcribe(audioBuffer, filename = 'audio.webm') {
  await ensureDirs();
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = join(tmpdir(), `cc-${id}-${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
  const wavFile = join(tmpdir(), `cc-${id}.wav`);
  try {
    await writeFile(inFile, audioBuffer);
    await run('ffmpeg', ['-y', '-i', inFile, '-ac', '1', '-ar', '16000', wavFile], { maxBuffer: 20 * 1024 * 1024 });
    const { stdout } = await run('python3', [join(ROOT, 'server', 'transcribe_local.py'), wavFile], {
      env: {
        ...process.env,
        PYTHONPATH,
        WHISPER_CACHE_DIR,
        WHISPER_MODEL: process.env.WHISPER_MODEL || 'small.en',
        WHISPER_COMPUTE_TYPE: process.env.WHISPER_COMPUTE_TYPE || 'int8',
      },
      maxBuffer: 20 * 1024 * 1024,
    });
    return stdout.trim();
  } finally {
    await unlink(inFile).catch(() => {});
    await unlink(wavFile).catch(() => {});
  }
}

function speakWithEspeak(text) {
  const voice = process.env.ESPEAK_VOICE || 'en-us';
  const speed = process.env.ESPEAK_SPEED || '165';
  const pitch = process.env.ESPEAK_PITCH || '48';
  const amplitude = process.env.ESPEAK_AMPLITUDE || '120';

  return new Promise((resolve, reject) => {
    execFile('espeak-ng', ['-v', voice, '-s', speed, '-p', pitch, '-a', amplitude, '--stdout', text], {
      encoding: 'buffer',
      maxBuffer: 20 * 1024 * 1024,
    }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr?.toString() || err.message));
      resolve(Buffer.from(stdout));
    });
  });
}

function resolveFishVoiceId(settings, agentId = 'main') {
  return String(
    settings.fishAgentVoices?.[agentId]
    || (settings.provider === 'fish' ? settings.agentVoices?.[agentId] : '')
    || settings.fishVoiceId
    || process.env.FISH_AUDIO_VOICE_ID
    || ''
  ).trim();
}

async function resolveElevenLabsVoiceId(settings, agentId = 'main') {
  const specific = String(
    settings.elevenlabsAgentVoices?.[agentId]
    || (settings.provider !== 'fish' ? settings.agentVoices?.[agentId] : '')
    || ''
  ).trim();
  if (specific) return specific;
  if (settings.defaultVoiceId) return settings.defaultVoiceId;

  const voices = await listElevenLabsVoices(settings.elevenlabsApiKey).catch(() => []);
  return voices[0]?.voice_id || '';
}

export async function resolveAgentVoice(settings, agentId = 'main') {
  const provider = settings?.provider === 'fish' ? 'fish' : 'elevenlabs';
  if (provider === 'fish') {
    return { provider, voiceId: resolveFishVoiceId(settings, agentId) };
  }
  return { provider, voiceId: await resolveElevenLabsVoiceId(settings, agentId) };
}

export async function listElevenLabsVoices(apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return [];

  const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/voices`, {
    headers: {
      'xi-api-key': key,
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`ElevenLabs voices failed (${res.status}): ${text || 'request failed'}`);
  }

  const json = await res.json();
  return (json.voices || []).map((voice) => ({
    voice_id: voice.voice_id,
    name: voice.name,
    category: voice.category || '',
    labels: voice.labels || {},
  }));
}


function getFishApiBase(settings) {
  return String(settings.fishAudioApiBase || process.env.FISH_AUDIO_API_BASE || DEFAULT_FISH_AUDIO_BASE_URL).trim().replace(/\/+$/, '');
}

function getFishSessionCookie(settings) {
  const raw = String(settings.fishSessionCookie || process.env.FISH_AUDIO_SESSION_COOKIE || '').trim();
  if (!raw) return '';
  return raw.includes('=') ? raw : `aichat_session=${raw}`;
}


export async function searchFishAudioVoices(query, settings = {}, options = {}) {
  const base = getFishApiBase(settings);
  const cookie = getFishSessionCookie(settings);
  const params = new URLSearchParams({
    q: String(query || '').trim(),
    limit: String(Math.min(Math.max(Number(options.limit || 8), 1), 12)),
    pageSize: String(Math.min(Math.max(Number(options.pageSize || 12), 1), 25)),
  });
  const headers = { Accept: 'application/json' };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${base}/api/fish/models?${params.toString()}`, { headers });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Fish voice search failed (${res.status}): ${errText || 'request failed'}`);
  }
  return await res.json();
}

function resolveFishPlaybackMode(text, settings = {}) {
  const mode = String(settings.fishPlaybackMode || 'auto').trim().toLowerCase();
  if (mode === 'stream' || mode === 'full') return mode;
  const threshold = Math.min(4000, Math.max(80, Number(settings.fishAutoStreamMinChars || 260) || 260));
  const normalizedLength = String(text || '').replace(/\s+/g, ' ').trim().length;
  return normalizedLength >= threshold ? 'stream' : 'full';
}

async function speakWithFishAudio(text, settings, overrideVoiceId = '', agentId = 'main') {
  const voiceId = String(overrideVoiceId || resolveFishVoiceId(settings, agentId) || '').trim();
  if (!voiceId) return null;

  const base = getFishApiBase(settings);
  const cookie = getFishSessionCookie(settings);
  const playbackMode = resolveFishPlaybackMode(text, settings);
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg,audio/*,*/*',
  };
  if (cookie) headers.Cookie = cookie;

  const res = await fetch(`${base}/api/tts/audio`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      text,
      voiceId,
      format: settings.fishFormat || 'mp3',
      includeAsteriskNarration: settings.fishIncludeAsteriskNarration === true,
      stream: playbackMode === 'stream',
      latency: playbackMode === 'stream' ? 'low' : 'normal',
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Fish Audio TTS failed (${res.status}): ${errText || 'request failed'}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    contentType: res.headers.get('content-type') || (settings.fishFormat === 'wav' ? 'audio/wav' : 'audio/mpeg'),
    taggedText: res.headers.get('x-tts-tagged-text') || '',
    mode: res.headers.get('x-tts-mode') || playbackMode,
  };
}


export async function previewFishAudioVoice({ text = '', voiceId = '', settings = null } = {}) {
  const nextSettings = settings || await loadVoiceSettings();
  const fish = await speakWithFishAudio(String(text || 'This is a Fish Audio voice preview.'), nextSettings, voiceId);
  if (!fish) throw new Error('Fish Audio voice ID is required for preview.');
  return { buffer: fish.buffer, contentType: fish.contentType };
}

async function speakWithElevenLabs(text, settings, agentId = 'main') {
  const apiKey = settings.elevenlabsApiKey;
  if (!apiKey) {
    return null;
  }

  const voiceId = await resolveElevenLabsVoiceId(settings, agentId);
  if (!voiceId) {
    return null;
  }

  const res = await fetch(`${ELEVENLABS_BASE_URL}/v1/text-to-speech/${encodeURIComponent(voiceId)}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.45,
        similarity_boost: 0.8,
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${errText || 'request failed'}`);
  }

  const arrayBuffer = await res.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

export async function speak(text, agentId = 'main') {
  const settings = await loadVoiceSettings();
  const resolved = await resolveAgentVoice(settings, agentId);

  if (resolved.provider === 'fish') {
    try {
      const fish = await speakWithFishAudio(text, settings, resolved.voiceId, agentId);
      if (fish) {
        return {
          buffer: fish.buffer,
          contentType: fish.contentType,
          provider: 'fish',
          voiceId: resolved.voiceId,
          mode: fish.mode || 'full',
        };
      }
    } catch (err) {
      console.error('[voice] Fish Audio error:', err.message);
    }
  } else {
    try {
      const eleven = await speakWithElevenLabs(text, settings, agentId);
      if (eleven) {
        return {
          buffer: eleven,
          contentType: 'audio/mpeg',
          provider: 'elevenlabs',
          voiceId: resolved.voiceId,
        };
      }
    } catch (err) {
      console.error('[voice] ElevenLabs error:', err.message);
    }
  }

  const fallback = await speakWithEspeak(text);
  return { buffer: fallback, contentType: 'audio/wav', provider: 'espeak', voiceId: '' };
}
