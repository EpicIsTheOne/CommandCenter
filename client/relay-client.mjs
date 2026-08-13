import { execFile, execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const RELAY_CLIENT_SCHEMA_VERSION = 1;
export const RELAY_CLIENT_VERSION = '1.0.0';
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
export const DEFAULT_RECONNECT_DELAY_MS = 1_500;
export const MAX_RECONNECT_DELAY_MS = 30_000;
export const RELAY_CHAT_TIMEOUT_MS = 120_000;
export const RELAY_CHAT_MAX_IN_FLIGHT = 2;
const HERMES_BACKEND_START_TIMEOUT_MS = 60_000;
const HERMES_BACKEND_LAUNCHER = fileURLToPath(new URL('./hermes-backend-launcher.py', import.meta.url));

const DEVICE_METADATA_KEYS = ['name', 'label', 'platform', 'type', 'version'];
const PROFILE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SECRET_PREFIX_RE = /^cc[pr]_[A-Za-z0-9_-]{20,}$/;

function cleanText(value = '') {
  return String(value ?? '').trim();
}

function boundedText(value, fallback = '', max = 120) {
  const text = cleanText(value) || fallback;
  return Array.from(text).slice(0, max).join('');
}

function nextEnvelopeId(prefix = 'msg') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeProfile(profile = {}) {
  const name = boundedText(profile.name || profile.profile || profile.id, '', 128);
  if (!name || !PROFILE_NAME_RE.test(name)) return null;
  const model = boundedText(profile.model, '', 128);
  const gateway = boundedText(profile.gateway || profile.status, 'unknown', 32).toLowerCase();
  const displayName = boundedText(profile.displayName || profile.label || profile.alias, '', 128);
  return { name, model, gateway, ...(displayName ? { displayName } : {}) };
}

function parseJsonProfiles(output) {
  try {
    const value = JSON.parse(String(output || '').trim());
    const records = Array.isArray(value) ? value : Array.isArray(value?.profiles) ? value.profiles : [];
    if (!records.length) return [];
    return records.map(normalizeProfile).filter(Boolean).slice(0, 200);
  } catch {
    return [];
  }
}

export function parseHermesProfiles(output) {
  const jsonProfiles = parseJsonProfiles(output);
  if (jsonProfiles.length) return jsonProfiles;

  const profiles = [];
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    const line = rawLine
      .replace(/[│┃║]/g, ' ')
      .replace(/[◆◇]/g, '')
      .trim();
    if (!line || /^[-─—_]+$/.test(line) || /^profile\s+/i.test(line)) continue;
    const match = line.match(/^([A-Za-z0-9][A-Za-z0-9._-]{0,127})\s+(\S+)\s+(running|stopped|connected|offline|unknown)\b/i);
    if (!match) continue;
    const profile = normalizeProfile({ name: match[1], model: match[2], gateway: match[3] });
    if (profile) profiles.push(profile);
  }
  return profiles.slice(0, 200);
}

function parseProfilePath(output = '') {
  const match = String(output || '').match(/^Path:\s*(.+)$/im);
  return cleanText(match?.[1] || '');
}

function parseSoulDisplayName(content = '') {
  const patterns = [
    /^\s*You are\s+([^,\n.]{2,80})/im,
    /^\s*-?\s*Name:\s*([^,\n.]{2,80})/im,
    /^\s*#\s+([^#\n]{2,80})/m,
  ];
  for (const pattern of patterns) {
    const match = String(content || '').match(pattern);
    const displayName = boundedText(match?.[1] || '', '', 80).replace(/\s+/g, ' ').trim();
    if (displayName) return displayName;
  }
  return '';
}

function runExecFile(execFileFn, file, args) {
  return new Promise((resolve, reject) => {
    execFileFn(file, args, {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stderr = String(stderr || '').slice(0, 512);
        reject(error);
        return;
      }
      resolve(String(stdout || ''));
    });
  });
}

async function enrichHermesProfiles(profiles, { hermesBin, execFileFn, readFileFn }) {
  return await Promise.all(profiles.map(async (profile) => {
    if (profile.displayName) return profile;
    try {
      const details = await runExecFile(execFileFn, hermesBin, ['profile', 'show', profile.name]);
      const profilePath = parseProfilePath(details);
      if (!profilePath) return profile;
      const soul = await readFileFn(join(profilePath, 'SOUL.md'), 'utf8');
      const displayName = parseSoulDisplayName(soul);
      return displayName ? { ...profile, displayName } : profile;
    } catch {
      return profile;
    }
  }));
}

export async function detectHermesProfiles({ hermesBin = 'hermes', execFileFn = execFile, readFileFn = readFile } = {}) {
  const { stdout } = await new Promise((resolve, reject) => {
    execFileFn(hermesBin, ['profile', 'list'], {
      windowsHide: true,
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }, (error, output, stderr) => {
      if (error) {
        error.code = error.code || 'HERMES_UNAVAILABLE';
        error.stderr = String(stderr || '').slice(0, 512);
        reject(error);
        return;
      }
      resolve({ stdout: String(output || '') });
    });
  });
  return enrichHermesProfiles(parseHermesProfiles(stdout), {
    hermesBin,
    execFileFn,
    readFileFn,
  });
}

export function normalizeRelayDeviceUrl(input) {
  const raw = cleanText(input);
  if (!raw) throw new Error('A relay WebSocket URL is required.');
  let url;
  try { url = new URL(raw); } catch { throw new Error('Relay URL is invalid.'); }
  if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Relay URL must use ws or wss.');
  if (url.username || url.password) throw new Error('Relay credentials must not appear in the URL.');
  if (url.search || url.hash) throw new Error('Relay URL must not contain a query string or fragment.');
  const path = url.pathname.replace(/\/+$/g, '');
  if (!path || path === '/') url.pathname = '/relay/v1/device';
  else if (!path.endsWith('/relay/v1/device')) url.pathname = `${path}/relay/v1/device`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function sanitizeDeviceMetadata(device = {}) {
  const clean = {};
  for (const key of DEVICE_METADATA_KEYS) {
    if (device[key] === undefined || device[key] === null || device[key] === '') continue;
    clean[key] = boundedText(device[key], '', 120);
  }
  clean.name = clean.name || 'Command Center Windows Client';
  clean.platform = clean.platform || 'win32';
  clean.type = clean.type || 'desktop';
  clean.version = clean.version || RELAY_CLIENT_VERSION;
  return clean;
}

function profileStatus(profile) {
  return profile.gateway === 'running' || profile.gateway === 'connected' ? 'online' : 'offline';
}

const CHAT_REQUEST_KEYS = new Set(['providerId', 'agentId', 'providerSessionId', 'sessionId', 'message']);
const CHAT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function clientProtocolError(message, code = 'INVALID_SCHEMA') {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredChatText(value, field, maxBytes = 128) {
  if (typeof value !== 'string' || !value) throw clientProtocolError(`Invalid ${field}.`);
  if (Buffer.byteLength(value, 'utf8') > maxBytes) throw clientProtocolError(`${field} is too large.`, 'PAYLOAD_TOO_LARGE');
  return value;
}

function optionalChatId(value, field) {
  if (value === undefined || value === null || value === '') return '';
  const result = requiredChatText(value, field, 128);
  if (!CHAT_ID_RE.test(result)) throw clientProtocolError(`Invalid ${field}.`);
  return result;
}

function validateServerChatRequest(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) throw clientProtocolError('Chat request envelope must be an object.');
  if (message.v !== RELAY_CLIENT_SCHEMA_VERSION || message.type !== 'relay.chat.request') throw clientProtocolError('Unsupported relay chat request.');
  if (!requiredChatText(message.id, 'id') || !CHAT_ID_RE.test(message.id) || Number.isNaN(Date.parse(String(message.timestamp || '')))) throw clientProtocolError('Invalid chat request envelope.');
  if (message.replyTo !== undefined) throw clientProtocolError('Chat requests cannot reply to another message.');
  const payload = message.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw clientProtocolError('Chat request payload must be an object.');
  for (const key of Object.keys(payload)) if (!CHAT_REQUEST_KEYS.has(key)) throw clientProtocolError('Unknown chat request field.', 'INVALID_SCHEMA');
  const providerId = requiredChatText(payload.providerId, 'providerId');
  if (providerId !== 'hermes') throw clientProtocolError('Only Hermes relay chat is supported.', 'UNSUPPORTED_TYPE');
  const agentId = requiredChatText(payload.agentId, 'agentId');
  if (!CHAT_ID_RE.test(agentId)) throw clientProtocolError('Invalid agentId.');
  const providerSessionId = optionalChatId(payload.providerSessionId, 'providerSessionId');
  if (!providerSessionId) throw clientProtocolError('Chat requests require providerSessionId.');
  const sessionId = optionalChatId(payload.sessionId, 'sessionId');
  const messageText = requiredChatText(payload.message, 'message', 48 * 1024);
  return { id: message.id, payload: { providerId, agentId, providerSessionId, ...(sessionId ? { sessionId } : {}), message: messageText } };
}

function parseHermesChatOutput(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/);
  let sessionId = '';
  const kept = [];
  for (const line of lines) {
    const match = line.match(/^session_id:\s*(.+?)\s*$/i);
    if (match) {
      sessionId = boundedText(match[1], '', 128);
      continue;
    }
    if (/^↻\s+Resumed session\b/i.test(line.trim())) continue;
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), sessionId };
}

function backendError(message, code = 'HERMES_BACKEND_UNAVAILABLE', recoverable = true) {
  const error = new Error(message);
  error.code = code;
  error.recoverable = recoverable;
  return error;
}

function backendProfileParams(profile = {}) {
  const name = cleanText(profile.name);
  return name && name !== 'default' ? { profile: name } : {};
}

function resolveHermesBackendCommand(hermesBin) {
  if (platform() === 'win32') {
    const pythonBin = join(dirname(String(hermesBin || '')), 'python.exe');
    if (existsSync(pythonBin) && existsSync(HERMES_BACKEND_LAUNCHER)) {
      return { file: pythonBin, prefix: ['-u', HERMES_BACKEND_LAUNCHER] };
    }
  }
  return { file: hermesBin, prefix: [] };
}

/**
 * Purpose-built persistent Hermes transport for authenticated relay chat.
 * Only session create/resume and prompt submit are exposed here; the relay
 * client is deliberately not a generic Hermes JSON-RPC proxy.
 */
export class HermesLocalBackend extends EventEmitter {
  constructor({
    hermesBin = 'hermes',
    spawnFn = spawn,
    WebSocketImpl = WebSocket,
    env = process.env,
    startTimeoutMs = HERMES_BACKEND_START_TIMEOUT_MS,
    rpcTimeoutMs = RELAY_CHAT_TIMEOUT_MS,
    backendArgs = null,
  } = {}) {
    super();
    this.hermesBin = hermesBin;
    this.spawnFn = spawnFn;
    this.WebSocketImpl = WebSocketImpl;
    this.env = env;
    this.startTimeoutMs = Math.max(5_000, Number(startTimeoutMs) || HERMES_BACKEND_START_TIMEOUT_MS);
    this.rpcTimeoutMs = Math.max(5_000, Number(rpcTimeoutMs) || RELAY_CHAT_TIMEOUT_MS);
    this.backendArgs = backendArgs;
    this.child = null;
    this.socket = null;
    this.startPromise = null;
    this.nextRequestId = 0;
    this.pending = new Map();
    this.sessions = new Map();
    this.stopping = false;
  }

  async start() {
    if (this.socket && this.socket.readyState === 1) return true;
    if (this.startPromise) return this.startPromise;
    this.stopping = false;
    this.startPromise = this.startInternal();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async startInternal() {
    const token = randomBytes(32).toString('hex');
    const command = resolveHermesBackendCommand(this.hermesBin);
    const file = this.backendArgs ? this.hermesBin : command.file;
    const args = this.backendArgs || [
      ...command.prefix,
      'serve',
      '--host', '127.0.0.1',
      '--port', '0',
      '--no-open',
      '--skip-build',
    ];
    const childEnv = {
      ...this.env,
      HERMES_DASHBOARD_SESSION_TOKEN: token,
      HERMES_SERVE_HEADLESS: '1',
      HERMES_PARENT_PID: String(process.pid),
    };
    let child;
    try {
      child = this.spawnFn(file, args, {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      throw backendError('Hermes backend could not start.', 'HERMES_BACKEND_START_FAILED');
    }
    this.child = child;

    const port = await new Promise((resolve, reject) => {
      let settled = false;
      let buffer = '';
      const finishResolve = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      };
      const timer = setTimeout(() => {
        finishReject(backendError('Hermes backend startup timed out.', 'HERMES_BACKEND_TIMEOUT'));
      }, this.startTimeoutMs);
      const inspect = (chunk) => {
        buffer += String(chunk || '');
        const match = buffer.match(/HERMES_BACKEND_READY\s+port=(\d+)/);
        if (match) finishResolve(Number(match[1]));
        if (buffer.length > 8_192) buffer = buffer.slice(-4_096);
      };
      child.stdout?.on?.('data', inspect);
      // Consume diagnostics but never forward them. Hermes startup output can
      // contain provider or filesystem details that do not belong in relay logs.
      child.stderr?.on?.('data', () => {});
      child.once?.('error', () => finishReject(backendError('Hermes backend process failed to start.', 'HERMES_BACKEND_START_FAILED')));
      child.once?.('exit', () => {
        if (!settled) finishReject(backendError('Hermes backend exited during startup.', 'HERMES_BACKEND_EXITED'));
        else this.handleChildExit();
      });
    }).catch((error) => {
      this.stopChild();
      throw error;
    });

    await this.connectSocket(port, token);
    return true;
  }

  async connectSocket(port, token) {
    // This URL is loopback-only and is never logged or emitted over the relay.
    const socketUrl = `ws://127.0.0.1:${port}/api/ws?token=${encodeURIComponent(token)}`;
    let socket;
    try {
      socket = new this.WebSocketImpl(socketUrl);
    } catch {
      throw backendError('Hermes backend WebSocket could not start.', 'HERMES_BACKEND_CONNECT_FAILED');
    }
    this.socket = socket;
    return await new Promise((resolve, reject) => {
      let settled = false;
      const finishResolve = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const finishReject = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.socket === socket) this.socket = null;
        try { socket.close(); } catch {}
        reject(error);
      };
      const timer = setTimeout(() => {
        finishReject(backendError('Hermes backend WebSocket timed out.', 'HERMES_BACKEND_CONNECT_FAILED'));
      }, this.startTimeoutMs);
      socket.on?.('open', finishResolve);
      socket.on?.('message', (raw) => this.handleSocketMessage(raw));
      socket.on?.('error', () => {
        if (!settled) finishReject(backendError('Hermes backend WebSocket failed.', 'HERMES_BACKEND_CONNECT_FAILED'));
      });
      socket.on?.('close', () => {
        if (!settled) finishReject(backendError('Hermes backend WebSocket closed during startup.', 'HERMES_BACKEND_CONNECT_FAILED'));
        else this.handleSocketClose(socket);
      });
    }).catch((error) => {
      this.stopChild();
      throw error;
    });
  }

  handleSocketMessage(raw) {
    let frame;
    try { frame = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '')); } catch { return; }
    if (frame?.id !== undefined && frame?.id !== null) {
      const pending = this.pending.get(String(frame.id));
      if (!pending) return;
      this.pending.delete(String(frame.id));
      clearTimeout(pending.timer);
      if (frame.error) {
        const error = backendError(String(frame.error.message || 'Hermes RPC failed').slice(0, 1024), 'HERMES_BACKEND_RPC_FAILED', false);
        error.rpcCode = frame.error.code;
        pending.reject(error);
      } else {
        pending.resolve(frame.result);
      }
      return;
    }
    if (frame?.method === 'event' && frame.params?.type) this.emit('event', frame.params);
  }

  rpc(method, params = {}) {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return Promise.reject(backendError('Hermes backend is not connected.', 'HERMES_BACKEND_UNAVAILABLE'));
    const id = `cc_backend_${++this.nextRequestId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(backendError(`Hermes backend request timed out: ${method}`, 'HERMES_BACKEND_RPC_TIMEOUT', false));
      }, this.rpcTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(backendError('Hermes backend request could not be sent.', 'HERMES_BACKEND_UNAVAILABLE'));
      }
    });
  }

  async getOrCreateSession(profile, payload) {
    const providerSessionId = payload.providerSessionId;
    const profileParams = backendProfileParams(profile);
    let record = this.sessions.get(providerSessionId);
    const requestedSessionId = cleanText(payload.sessionId);
    if (record && requestedSessionId && record.storedSessionId !== requestedSessionId) record = null;
    if (record) return record;

    let result;
    if (requestedSessionId) {
      try {
        result = await this.rpc('session.resume', {
          session_id: requestedSessionId,
          source: 'commandcenter',
          ...profileParams,
        });
      } catch (error) {
        if (!/session not found/i.test(String(error?.message || ''))) throw error;
      }
    }
    if (!result) {
      result = await this.rpc('session.create', {
        source: 'commandcenter',
        ...profileParams,
      });
    }
    const liveSessionId = cleanText(result?.session_id);
    const storedSessionId = cleanText(result?.stored_session_id || result?.session_key || requestedSessionId || liveSessionId);
    if (!liveSessionId || !storedSessionId) throw backendError('Hermes backend returned an invalid session.', 'HERMES_BACKEND_INVALID_RESPONSE', false);
    record = { liveSessionId, storedSessionId, profileName: cleanText(profile?.name) };
    this.sessions.set(providerSessionId, record);
    while (this.sessions.size > 200) this.sessions.delete(this.sessions.keys().next().value);
    return record;
  }

  async chat(profile, payload) {
    await this.start();
    const record = await this.getOrCreateSession(profile, payload);
    const liveSessionId = record.liveSessionId;
    let responseText = '';
    let onEvent;
    const completion = new Promise((resolve, reject) => {
      onEvent = (event = {}) => {
        if (cleanText(event.session_id) !== liveSessionId) return;
        const eventPayload = event.payload && typeof event.payload === 'object' ? event.payload : {};
        if (event.type === 'session.info' && cleanText(eventPayload.stored_session_id)) {
          record.storedSessionId = cleanText(eventPayload.stored_session_id);
        }
        if (event.type === 'message.delta') responseText += String(eventPayload.text || '');
        if (event.type === 'message.complete') {
          this.off('event', onEvent);
          const text = cleanText(eventPayload.text || responseText);
          if (eventPayload.status === 'error') {
            const error = new Error(text || 'Hermes chat failed.');
            error.code = 'HERMES_CHAT_FAILED';
            reject(error);
            return;
          }
          if (!text) {
            reject(backendError('Hermes returned an empty response.', 'EMPTY_RESPONSE', false));
            return;
          }
          resolve({ text, sessionId: record.storedSessionId });
        }
        if (event.type === 'error') {
          this.off('event', onEvent);
          const error = new Error(String(eventPayload.message || 'Hermes chat failed.').slice(0, 1024));
          error.code = 'HERMES_CHAT_FAILED';
          reject(error);
        }
      };
      this.on('event', onEvent);
    });
    try {
      await this.rpc('prompt.submit', { session_id: liveSessionId, text: payload.message });
      return await completion;
    } catch (error) {
      if (onEvent) this.off('event', onEvent);
      throw error;
    }
  }

  handleSocketClose(socket) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.sessions.clear();
    const error = backendError('Hermes backend disconnected.', 'HERMES_BACKEND_UNAVAILABLE');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (!this.stopping) this.stopChild();
    this.emit('disconnected');
  }

  handleChildExit() {
    const socket = this.socket;
    this.child = null;
    if (socket) {
      try { socket.close(); } catch {}
      this.handleSocketClose(socket);
    }
  }

  stopChild() {
    const child = this.child;
    this.child = null;
    if (!child) return;
    try { child.kill(); } catch {}
  }

  stop() {
    this.stopping = true;
    const socket = this.socket;
    this.socket = null;
    this.sessions.clear();
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(backendError('Hermes backend stopped.', 'HERMES_BACKEND_STOPPED', false));
    }
    this.pending.clear();
    if (socket) {
      try { socket.close(); } catch {}
    }
    this.stopChild();
  }
}

export function buildHermesChatArgs({ profile, message, sessionId = '' } = {}) {
  const profileName = cleanText(profile?.name);
  if (!profileName) throw new Error('Hermes profile is required.');
  return [
    '--profile', profileName,
    'chat',
    '-q', message,
    '-Q',
    '--source', 'commandcenter',
    ...(sessionId ? ['--resume', sessionId] : []),
  ];
}

export function buildHermesStatusFrames({ device = {}, profiles = [] } = {}) {
  const metadata = sanitizeDeviceMetadata(device);
  const agents = profiles.slice(0, 200).map((profile) => ({
    id: `hermes:${profile.name}`,
    label: profile.displayName || profile.name,
    name: profile.displayName || profile.name,
    model: profile.model || undefined,
    status: profileStatus(profile),
  }));
  const provider = {
    id: 'hermes',
    kind: 'hermes',
    name: 'Hermes',
    ...(profiles[0]?.model ? { model: boundedText(profiles[0].model, '', 128) } : {}),
    agents,
  };
  return [
    {
      type: 'device.state.snapshot',
      payload: {
        device: metadata,
        activeProviderId: 'hermes',
        providers: [provider],
      },
    },
    {
      type: 'agent.roster.snapshot',
      payload: {
        activeProviderId: 'hermes',
        agents,
      },
    },
  ];
}

function validateCredentialRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const deviceId = cleanText(record.deviceId);
  const credential = cleanText(record.credential);
  const relayUrl = cleanText(record.relayUrl);
  if (!deviceId || !credential || !relayUrl) return null;
  if (SECRET_PREFIX_RE.test(credential) === false) return null;
  return { deviceId, credential, relayUrl };
}

export class MemoryCredentialStore {
  constructor(initial = null) {
    this.record = validateCredentialRecord(initial);
  }

  async load() { return this.record ? { ...this.record } : null; }

  async save(record) {
    const normalized = validateCredentialRecord(record);
    if (!normalized) throw new Error('Invalid relay credential record.');
    this.record = normalized;
  }

  async clear() { this.record = null; }
}

function runWindowsDpapi(mode, value) {
  if (platform() !== 'win32') throw new Error('Windows DPAPI is only available on Windows.');
  const script = mode === 'protect'
    ? '$raw = [Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes = [Text.Encoding]::UTF8.GetBytes($raw); $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($protected)'
    : '$raw = [Console]::In.ReadToEnd(); Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String($raw.Trim()); $plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($plain)';
  const result = execFileSync('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    script,
  ], { input: String(value), encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 });
  return String(result || '').trim();
}

export function defaultCredentialPath(env = process.env) {
  const localAppData = cleanText(env.LOCALAPPDATA);
  if (localAppData) return join(localAppData, 'CommandCenter', 'relay-device.json');
  return join(homedir(), '.command-center', 'relay-device.json');
}

export class FileCredentialStore {
  constructor(filePath = defaultCredentialPath()) {
    this.filePath = filePath;
  }

  async load() {
    if (!existsSync(this.filePath)) return null;
    let parsed;
    try { parsed = JSON.parse(await readFile(this.filePath, 'utf8')); } catch { return null; }
    if (parsed?.schemaVersion !== RELAY_CLIENT_SCHEMA_VERSION || !parsed?.credentialProtected) return null;
    const credential = runWindowsDpapi('unprotect', parsed.credentialProtected);
    return validateCredentialRecord({ deviceId: parsed.deviceId, relayUrl: parsed.relayUrl, credential });
  }

  async save(record) {
    const normalized = validateCredentialRecord(record);
    if (!normalized) throw new Error('Invalid relay credential record.');
    const credentialProtected = runWindowsDpapi('protect', normalized.credential);
    await mkdir(dirname(this.filePath), { recursive: true });
    const persisted = JSON.stringify({
      schemaVersion: RELAY_CLIENT_SCHEMA_VERSION,
      deviceId: normalized.deviceId,
      relayUrl: normalized.relayUrl,
      credentialProtected,
      savedAt: new Date().toISOString(),
    }, null, 2);
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, persisted, { encoding: 'utf8' });
    await rm(this.filePath, { force: true });
    await writeFile(this.filePath, persisted, { encoding: 'utf8' });
    await rm(temporary, { force: true });
  }

  async clear() { await rm(this.filePath, { force: true }); }
}

function makeEnvelope(type, payload) {
  return {
    v: 1,
    id: nextEnvelopeId('ccw'),
    type,
    timestamp: new Date().toISOString(),
    payload,
  };
}

export class CommandCenterRelayClient extends EventEmitter {
  constructor({
    url,
    device = {},
    credentialStore = new FileCredentialStore(),
    WebSocketImpl = WebSocket,
    detectProfiles = detectHermesProfiles,
    execFileFn = execFile,
    hermesBin = 'hermes',
    hermesBackend = null,
    persistentHermes = true,
    heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS,
    reconnectDelayMs = DEFAULT_RECONNECT_DELAY_MS,
    maxReconnectDelayMs = MAX_RECONNECT_DELAY_MS,
  } = {}) {
    super();
    this.url = normalizeRelayDeviceUrl(url);
    this.device = sanitizeDeviceMetadata(device);
    this.credentialStore = credentialStore;
    this.WebSocketImpl = WebSocketImpl;
    this.detectProfiles = detectProfiles;
    this.execFileFn = execFileFn;
    this.hermesBin = hermesBin;
    this.hermesBackend = hermesBackend || (
      persistentHermes && execFileFn === execFile
        ? new HermesLocalBackend({ hermesBin: this.hermesBin, WebSocketImpl: this.WebSocketImpl })
        : null
    );
    this.hermesBackendStart = null;
    this.heartbeatIntervalMs = Math.max(1_000, Number(heartbeatIntervalMs) || DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.reconnectDelayMs = Math.max(250, Number(reconnectDelayMs) || DEFAULT_RECONNECT_DELAY_MS);
    this.maxReconnectDelayMs = Math.max(this.reconnectDelayMs, Number(maxReconnectDelayMs) || MAX_RECONNECT_DELAY_MS);
    this.currentReconnectDelay = this.reconnectDelayMs;
    this.ws = null;
    this.running = false;
    this.authenticated = false;
    this.authMethod = '';
    this.deviceId = '';
    this.ownerId = '';
    this.sequence = 0;
    this.credentials = null;
    this.pairingSecret = '';
    this.profiles = [];
    this.statusFrames = [];
    this.chatSessions = new Map();
    this.chatRequestIds = new Set();
    this.chatInFlight = new Map();
    this.heartbeatTimer = null;
    this.reconnectTimer = null;
    this.onceMode = false;
    this.onceTimer = null;
  }

  async start({ pairingSecret = '', once = false } = {}) {
    if (this.running) return this.getStatus();
    this.running = true;
    this.onceMode = once === true;
    this.pairingSecret = cleanText(pairingSecret);
    this.credentials = await this.credentialStore.load();
    if (!this.credentials && !this.pairingSecret) {
      this.running = false;
      throw new Error('No relay credential found. Supply the one-time pairing secret on stdin.');
    }
    try {
      this.profiles = await this.detectProfiles({ hermesBin: this.hermesBin });
    } catch (error) {
      this.profiles = [];
      this.emit('hermes-error', { code: error.code || 'HERMES_UNAVAILABLE' });
    }
    if (this.hermesBackend?.start) {
      this.hermesBackendStart = this.hermesBackend.start().catch((error) => {
        this.emit('hermes-error', { code: error?.code || 'HERMES_BACKEND_UNAVAILABLE' });
        return error;
      });
    }
    this.statusFrames = buildHermesStatusFrames({ device: this.device, profiles: this.profiles });
    this.connect();
    return this.getStatus();
  }

  stop() {
    this.running = false;
    this.pairingSecret = '';
    clearTimeout(this.reconnectTimer);
    clearTimeout(this.onceTimer);
    this.reconnectTimer = null;
    this.onceTimer = null;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    const socket = this.ws;
    this.ws = null;
    if (socket) {
      if (this.authenticated && socket.readyState === 1) {
        this.sendEnvelope('relay.presence', { state: 'offline' }, socket);
      }
      try { socket.close(1000, 'Client stopped'); } catch {}
    }
    try { this.hermesBackend?.stop?.(); } catch {}
    this.hermesBackendStart = null;
    this.authenticated = false;
    this.emit('stopped', this.getStatus());
  }

  getStatus() {
    return {
      connected: Boolean(this.ws && this.ws.readyState === 1),
      authenticated: this.authenticated,
      deviceId: this.deviceId,
      ownerId: this.ownerId,
      hermesProfiles: this.profiles.map((profile) => profile.displayName || profile.name),
      relayUrl: this.url,
    };
  }

  connect() {
    if (!this.running || this.ws) return;
    const socket = new this.WebSocketImpl(this.url);
    this.ws = socket;
    this.authenticated = false;
    this.authMethod = '';
    this.sequence = 0;
    this.chatRequestIds.clear();
    socket.on('open', () => { this.sendAuth(socket).catch((error) => this.failSocket(socket, error)); });
    socket.on('message', (raw) => { this.handleMessage(socket, raw).catch((error) => this.failSocket(socket, error)); });
    socket.on('error', () => {});
    socket.on('close', (code) => this.handleClose(socket, code));
  }

  async sendAuth(socket) {
    if (!this.running || socket !== this.ws || socket.readyState !== 1) return;
    const auth = this.credentials
      ? { method: 'credential', secret: this.credentials.credential, deviceId: this.credentials.deviceId }
      : { method: 'pairing', secret: this.pairingSecret, device: this.device };
    this.authMethod = auth.method;
    this.sendEnvelope('relay.auth', auth, socket);
  }

  async handleMessage(socket, raw) {
    if (socket !== this.ws) return;
    let message;
    try { message = JSON.parse(String(raw || '')); } catch { return this.failSocket(socket, new Error('Relay returned malformed JSON.')); }
    if (message.type === 'relay.auth.error') {
      const error = new Error('Relay authentication failed.');
      error.code = message.payload?.code || 'AUTH_FAILED';
      this.emit('auth-error', { code: error.code });
      try { socket.close(4001, 'Authentication failed'); } catch {}
      return;
    }
    if (message.type === 'relay.chat.request') {
      if (!this.authenticated) return this.failSocket(socket, clientProtocolError('Chat request received before authentication.', 'AUTH_REQUIRED'));
      return this.handleChatRequest(socket, message);
    }
    if (message.type !== 'relay.auth.ok' || this.authenticated) return;
    const payload = message.payload && typeof message.payload === 'object' ? message.payload : {};
    const deviceId = cleanText(payload.deviceId);
    const ownerId = cleanText(payload.ownerId);
    if (!deviceId || !ownerId) return this.failSocket(socket, new Error('Relay authentication response was invalid.'));
    if (this.authMethod === 'pairing') {
      const credential = cleanText(payload.credential);
      if (!credential) return this.failSocket(socket, new Error('Relay enrollment did not return a credential.'));
      await this.credentialStore.save({ deviceId, relayUrl: this.url, credential });
      this.credentials = { deviceId, relayUrl: this.url, credential };
      this.pairingSecret = '';
    }
    this.deviceId = deviceId;
    this.ownerId = ownerId;
    this.authenticated = true;
    this.currentReconnectDelay = this.reconnectDelayMs;
    this.emit('authenticated', { deviceId, ownerId, method: this.authMethod, profiles: this.profiles.map((profile) => profile.displayName || profile.name) });
    this.sendEnvelope('relay.presence', { state: 'online' }, socket);
    for (const frame of this.statusFrames) this.sendEnvelope(frame.type, frame.payload, socket);
    this.sendHeartbeat(socket);
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.sendHeartbeat(socket), this.heartbeatIntervalMs);
    if (this.onceMode) this.onceTimer = setTimeout(() => this.stop(), 350);
  }

  findHermesProfile(agentId = '') {
    const id = cleanText(agentId);
    const profileName = id.startsWith('hermes:') ? id.slice('hermes:'.length) : id;
    return this.profiles.find((profile) => profile.name === profileName || profile.displayName === profileName) || null;
  }

  sendChatResponse(socket, requestId, payload) {
    return this.sendEnvelope('relay.chat.response', payload, socket, { replyTo: requestId });
  }

  async executeHermesChat(profile, payload) {
    if (this.hermesBackend) {
      try {
        if (this.hermesBackendStart) {
          const startup = await this.hermesBackendStart;
          this.hermesBackendStart = null;
          if (startup instanceof Error) throw startup;
        } else {
          await this.hermesBackend.start?.();
        }
        const result = await this.hermesBackend.chat(profile, payload);
        if (!result?.text) {
          const failure = new Error('Hermes returned an empty response.');
          failure.code = 'EMPTY_RESPONSE';
          throw failure;
        }
        return result;
      } catch (error) {
        if (!error?.recoverable) throw error;
        this.emit('hermes-backend-fallback', { code: error.code || 'HERMES_BACKEND_UNAVAILABLE' });
      }
    }
    const resumeSessionId = cleanText(payload.sessionId) || this.chatSessions.get(payload.providerSessionId) || '';
    const args = buildHermesChatArgs({ profile, message: payload.message, sessionId: resumeSessionId });
    const result = await new Promise((resolve, reject) => {
      this.execFileFn(this.hermesBin, args, {
        windowsHide: true,
        timeout: RELAY_CHAT_TIMEOUT_MS,
        maxBuffer: 1024 * 1024 * 8,
      }, (error, stdout, stderr) => {
        if (error) {
          const failure = new Error(error.killed ? 'Hermes chat timed out.' : 'Hermes chat execution failed.');
          failure.code = error.killed ? 'HERMES_CHAT_TIMEOUT' : 'HERMES_CHAT_FAILED';
          reject(failure);
          return;
        }
        resolve(parseHermesChatOutput(`${String(stdout || '')}\n${String(stderr || '')}`));
      });
    });
    if (!result.text) {
      const failure = new Error('Hermes returned an empty response.');
      failure.code = 'EMPTY_RESPONSE';
      throw failure;
    }
    if (result.sessionId) {
      this.chatSessions.set(payload.providerSessionId, result.sessionId);
      while (this.chatSessions.size > 200) this.chatSessions.delete(this.chatSessions.keys().next().value);
    }
    return result;
  }

  async handleChatRequest(socket, message) {
    const request = validateServerChatRequest(message);
    if (this.chatRequestIds.has(request.id)) throw clientProtocolError('Replayed chat request.', 'REPLAYED_MESSAGE');
    this.chatRequestIds.add(request.id);
    while (this.chatRequestIds.size > 256) this.chatRequestIds.delete(this.chatRequestIds.values().next().value);
    if (this.chatInFlight.size >= RELAY_CHAT_MAX_IN_FLIGHT) {
      this.sendChatResponse(socket, request.id, { ok: false, errorCode: 'CHAT_BUSY', errorMessage: 'Relay chat is busy.' });
      return;
    }
    const profile = this.findHermesProfile(request.payload.agentId);
    if (!profile) {
      this.sendChatResponse(socket, request.id, { ok: false, errorCode: 'UNKNOWN_AGENT', errorMessage: 'Requested Hermes agent is unavailable.' });
      return;
    }
    this.chatInFlight.set(request.id, true);
    try {
      const result = await this.executeHermesChat(profile, request.payload);
      this.sendChatResponse(socket, request.id, {
        ok: true,
        text: result.text,
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        providerSessionId: request.payload.providerSessionId,
        ...(profile.model ? { model: profile.model } : {}),
      });
    } catch (error) {
      this.sendChatResponse(socket, request.id, {
        ok: false,
        errorCode: /^[A-Za-z0-9_.:-]{1,64}$/.test(String(error?.code || '')) ? error.code : 'HERMES_CHAT_FAILED',
        errorMessage: String(error?.message || 'Hermes chat failed.').slice(0, 1024),
        providerSessionId: request.payload.providerSessionId,
      });
    } finally {
      this.chatInFlight.delete(request.id);
    }
  }

  sendHeartbeat(socket = this.ws) {
    if (!this.authenticated || socket !== this.ws || socket?.readyState !== 1) return false;
    const sequence = this.sequence;
    this.sequence += 1;
    return this.sendEnvelope('relay.heartbeat', { sequence }, socket);
  }

  sendEnvelope(type, payload, socket = this.ws, extra = {}) {
    if (!socket || socket.readyState !== 1) return false;
    socket.send(JSON.stringify({ ...makeEnvelope(type, payload), ...extra }));
    return true;
  }

  failSocket(socket, error) {
    if (socket !== this.ws) return;
    this.emit('error', error instanceof Error ? error : new Error(String(error || 'Relay client error')));
    try { socket.close(4008, 'Relay client error'); } catch {}
  }

  handleClose(socket, code) {
    if (socket !== this.ws) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.ws = null;
    const wasAuthenticated = this.authenticated;
    this.authenticated = false;
    this.emit('disconnected', { code, wasAuthenticated, deviceId: this.deviceId });
    if (!this.running) return;
    if (!wasAuthenticated && [4001, 4008].includes(code)) {
      this.running = false;
      this.emit('auth-error', { code: code === 4001 ? 'AUTH_FAILED' : 'INVALID_MESSAGE' });
      return;
    }
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.currentReconnectDelay);
    this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 2, this.maxReconnectDelayMs);
  }
}
