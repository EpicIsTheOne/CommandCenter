import 'dotenv/config';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const basePath = (process.env.BASE_PATH || '').trim().replace(/\/$/, '');

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

export default {
  port: parseInt(process.env.PORT || '3000', 10),
  gatewayUrl: process.env.GATEWAY_URL || 'ws://127.0.0.1:18789',
  gatewayToken: resolvedGatewayToken,
  gatewayTokenSource,
  demoMode: process.env.DEMO_MODE !== 'false',
  openaiApiKey: process.env.OPENAI_API_KEY || '',
  weatherLocation: process.env.WEATHER_LOCATION || 'Kingston,Ontario,Canada',
  apiKey: process.env.COMMANDCENTER_API_KEY || '',
  basePath,
};
