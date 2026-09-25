import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PROJECT_ROOT } from './runtime-paths.js';

const basePath = (process.env.BASE_PATH || '').trim().replace(/\/$/, '');

function booleanEnv(name, fallback = false) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function findGatewayToken(value) {
  if (!value || typeof value !== 'object') return '';
  const direct = String(value?.gateway?.auth?.token || value?.auth?.token || '').trim();
  if (direct) return direct;
  for (const child of Object.values(value)) {
    if (child && typeof child === 'object') {
      const nested = findGatewayToken(child);
      if (nested) return nested;
    }
  }
  return '';
}

function readLocalGatewayToken() {
  const configPath = join(homedir(), '.openclaw', 'openclaw.json');
  if (!existsSync(configPath)) return { token: '', source: 'missing-local-config' };
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const token = findGatewayToken(parsed);
    return { token, source: token ? 'openclaw.json' : 'missing-token-in-local-config' };
  } catch {
    return { token: '', source: 'local-config-read-failed' };
  }
}

const envGatewayToken = String(process.env.GATEWAY_TOKEN || '').trim();
const localGateway = envGatewayToken ? { token: '', source: 'env' } : readLocalGatewayToken();
const resolvedGatewayToken = envGatewayToken || localGateway.token || '';
const gatewayTokenSource = envGatewayToken ? 'env' : localGateway.source;
const reikaEmbedToken = String(process.env.REIKA_EMBED_TOKEN || '').trim();
const relayOnlyRequested = ['1', 'true', 'yes', 'on'].includes(String(process.env.COMMANDCENTER_RELAY_ONLY || process.env.RELAY_ONLY_MODE || '').trim().toLowerCase());
const reikaEmbeddedRuntime = String(process.env.NODE_ENV || '').trim().toLowerCase() === 'reika-embedded' || Boolean(reikaEmbedToken);

export default {
  host: String(process.env.HOST || '0.0.0.0').trim() || '0.0.0.0',
  port: boundedInteger(process.env.PORT, 3000, 1, 65535),
  localApiEnabled: booleanEnv('LOCAL_API_ENABLED', false),
  localApiHost: String(process.env.LOCAL_API_HOST || '127.0.0.1').trim() || '127.0.0.1',
  localApiPort: boundedInteger(process.env.LOCAL_API_PORT, 3001, 1, 65535),
  gatewayUrl: process.env.GATEWAY_URL || 'ws://127.0.0.1:18789',
  gatewayToken: resolvedGatewayToken,
  gatewayTokenSource,
  // Demo mode is opt-in: an honest command center must not simulate agent
  // activity unless the operator explicitly asked for it.
  demoMode: booleanEnv('DEMO_MODE', false),
  relayOnlyMode: relayOnlyRequested || reikaEmbeddedRuntime,
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  weatherLocation: process.env.WEATHER_LOCATION || 'Kingston,Ontario,Canada',
  apiKey: process.env.COMMANDCENTER_API_KEY || '',
  reikaEmbedToken,
  allowRemoteSetup: booleanEnv('COMMANDCENTER_ALLOW_REMOTE_SETUP', false),
  maxJsonBodyBytes: boundedInteger(process.env.COMMANDCENTER_MAX_JSON_BODY_BYTES, 1024 * 1024, 16 * 1024, 10 * 1024 * 1024),
  maxUploadBytes: boundedInteger(process.env.COMMANDCENTER_MAX_UPLOAD_BYTES, 128 * 1024 * 1024, 1024 * 1024, 256 * 1024 * 1024),
  projectRoot: PROJECT_ROOT,
  basePath,
};
