import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

function readEnv(path = '.env') {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const idx = trimmed.indexOf('=');
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    out[key] = value;
  }
  return out;
}

function argValue(name, fallback = '') {
  const prefix = `--${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

const env = { ...readEnv(join(process.cwd(), '.env')), ...process.env };
const port = env.PORT || '3001';
const basePath = (env.BASE_PATH || '/commandcenter').replace(/\/$/, '');
const baseUrl = argValue('base-url', `http://127.0.0.1:${port}${basePath}`);
const apiKey = argValue('api-key', env.COMMANDCENTER_API_KEY || '');

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

const body = {
  fromAgent: argValue('from', 'orchestrator'),
  toAgent: argValue('to', 'hermes'),
  topic: argValue('topic', ''),
};
const turns = argValue('turns', '');
if (turns) body.maxTurns = Number(turns);
const naturalStop = argValue('natural-stop', '');
if (naturalStop) body.naturalStop = naturalStop !== '0';

const result = await request('/api/agent-comms/start', {
  method: 'POST',
  body: JSON.stringify(body),
});

console.log(JSON.stringify({
  ok: true,
  topic: result.topic || '(agent-chosen)',
  turns: result.turns,
  turnCap: result.turnCap,
  naturalStop: result.naturalStop,
  threadId: result.threadId,
  transcript: (result.transcript || []).map((m) => ({ from: m.fromLabel || m.fromAgent, to: m.toLabel || m.toAgent, text: m.text })),
}, null, 2));
