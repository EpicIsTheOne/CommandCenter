import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { getHermesAgent } from './agents.js';

const ROOT = process.cwd();
const DATA_DIR = join(ROOT, 'data');
const TASKS_FILE = join(DATA_DIR, 'live-tasks.v1.json');

function nowIso() {
  return new Date().toISOString();
}

async function readStore() {
  try {
    if (!existsSync(TASKS_FILE)) return { tasks: [] };
    const raw = await readFile(TASKS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { tasks: Array.isArray(parsed.tasks) ? parsed.tasks : [] };
  } catch {
    return { tasks: [] };
  }
}

async function writeStore(store) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TASKS_FILE, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
}

export async function listLiveTasks() {
  const store = await readStore();
  return store.tasks.sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime());
}

export async function getLiveTask(taskId) {
  const store = await readStore();
  return store.tasks.find((task) => task.id === taskId) || null;
}

export async function createLiveTask({ title, summary, prompt, agent = 'orchestrator', runtime = '' }) {
  const store = await readStore();
  const now = nowIso();
  const task = {
    id: `live-${Date.now().toString(36)}`,
    title: String(title || 'Background task').slice(0, 160),
    prompt: String(prompt || '').slice(0, 6000),
    agent,
    runtime: String(runtime || '').trim(),
    status: 'queued',
    created_at: now,
    updated_at: now,
    summary: String(summary || 'Queued').slice(0, 500),
    result: '',
    error: '',
  };
  store.tasks.push(task);
  await writeStore(store);
  return task;
}

export async function updateLiveTask(taskId, patch) {
  const store = await readStore();
  const index = store.tasks.findIndex((task) => task.id === taskId);
  if (index === -1) return null;
  store.tasks[index] = {
    ...store.tasks[index],
    ...patch,
    updated_at: nowIso(),
  };
  await writeStore(store);
  return store.tasks[index];
}

export function looksComplexRequest(text = '') {
  const input = String(text || '').toLowerCase();
  const needles = [
    'build', 'implement', 'fix', 'debug', 'refactor', 'release', 'deploy', 'commit', 'github', 'pull request', 'pr ',
    'code', 'repository', 'repo', 'android app', 'backend', 'workflow', 'automation', 'openclaw', 'mission control',
    'write a script', 'edit files', 'change settings', 'multi-step', 'schedule', 'investigate', 'analyze the codebase',
    'send a message', 'message ', 'text ', 'email ', 'dm ', 'notify ', 'contact ', 'reach out', 'tell ', 'say hi to',
  ];
  if (needles.some((needle) => input.includes(needle))) return true;
  const likelyExternalAction = /(send|text|message|email|dm|notify|contact|tell|remind|invite|call)\s+.+\s+(to|about|that)/.test(input);
  const saySomethingToSomeone = /(say\s+(hi|hello|hey|thanks|thank you|sorry)\s+to\s+)/.test(input);
  return likelyExternalAction || saySomethingToSomeone;
}

function parseHermesTaskOutput(raw = '') {
  const text = String(raw || '');
  const lines = text.split(/\r?\n/);
  let hermesSessionId = '';
  const kept = [];
  for (const line of lines) {
    const match = line.match(/^session_id:\s*(.+?)\s*$/i);
    if (match) {
      hermesSessionId = String(match[1] || '').trim();
      continue;
    }
    if (/^↻\s+Resumed session\b/i.test(line.trim())) continue;
    kept.push(line);
  }
  return { text: kept.join('\n').trim(), hermesSessionId };
}

export function runLiveTask(task, { broadcast, roster }) {
  const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  const target = task.agent || roster?.primaryAgentId || 'orchestrator';
  const hermesAgent = getHermesAgent(target, roster);
  const useHermes = String(task.runtime || '').trim() === 'hermes' || !!hermesAgent;
  const runtimeLabel = useHermes ? 'Hermes' : 'OpenClaw';
  const provider = String(process.env.HERMES_INFERENCE_PROVIDER || '').trim();
  const model = String(process.env.HERMES_INFERENCE_MODEL || hermesAgent?.model || process.env.HERMES_AGENT_MODEL || '').trim();
  const hermesProfile = String(hermesAgent?.hermesProfile || '').trim();
  const openClawSessionId = `commandcenter_live_${String(task.id || '').replace(/[^a-z0-9_-]/gi, '_')}`;
  const command = useHermes ? hermesBin : openclawBin;
  const args = useHermes
    ? [
        ...(hermesProfile ? ['--profile', hermesProfile] : []),
        'chat', '-q', task.prompt, '-Q', '--source', 'commandcenter',
        ...(model ? ['--model', model] : []),
        ...(provider ? ['--provider', provider] : []),
      ]
    : [
        'agent', '--agent', target,
        '--session-id', openClawSessionId,
        '--thinking', 'low',
        '--message', task.prompt,
      ];

  const env = { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH };
  const startedAt = Date.now();
  let stdout = '';
  let stderr = '';
  let heartbeats = 0;
  let stage = 'launching';
  let finished = false;

  function summarizeWorking(stageLabel = 'working', extra = '') {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const elapsedText = elapsedSec < 2 ? 'just started' : `${elapsedSec}s elapsed`;
    return `${runtimeLabel} ${stageLabel}${extra ? ` · ${extra}` : ''} · ${elapsedText}`.slice(0, 280);
  }

  async function pushUpdate(patch = {}) {
    const updated = await updateLiveTask(task.id, patch);
    if (updated) broadcast({ type: 'live_task:update', data: updated });
    return updated;
  }

  pushUpdate({
    status: 'working',
    summary: summarizeWorking('launching', useHermes ? 'starting background session' : 'starting agent session'),
    runtime: useHermes ? 'hermes' : 'openclaw',
  }).catch(() => {});

  const child = spawn(command, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const heartbeatTimer = setInterval(() => {
    if (finished) return;
    heartbeats += 1;
    const stageExtra = useHermes
      ? (hermesProfile ? `profile ${hermesProfile}` : 'awaiting result')
      : `session ${openClawSessionId}`;
    pushUpdate({
      status: 'working',
      summary: summarizeWorking(stage, stageExtra),
    }).catch(() => {});
  }, 6000);

  const killTimer = setTimeout(() => {
    if (finished) return;
    try { child.kill('SIGTERM'); } catch {}
  }, 20 * 60 * 1000);

  function clearTimers() {
    clearInterval(heartbeatTimer);
    clearTimeout(killTimer);
  }

  function maybePromoteStageFromStream(textChunk = '', source = 'stdout') {
    const chunk = String(textChunk || '');
    if (!chunk.trim()) return;
    if (useHermes) {
      const parsed = parseHermesTaskOutput(chunk);
      if (parsed.hermesSessionId) {
        stage = 'linked';
        pushUpdate({ status: 'working', summary: summarizeWorking('linked', `session ${parsed.hermesSessionId}`) }).catch(() => {});
        return;
      }
    } else if (source === 'stderr' || source === 'stdout') {
      stage = stage === 'launching' ? 'running' : stage;
    }
  }

  child.stdout?.on('data', (chunk) => {
    const text = String(chunk || '');
    stdout += text;
    maybePromoteStageFromStream(text, 'stdout');
  });

  child.stderr?.on('data', (chunk) => {
    const text = String(chunk || '');
    stderr += text;
    maybePromoteStageFromStream(text, 'stderr');
  });

  child.on('error', async (err) => {
    if (finished) return;
    finished = true;
    clearTimers();
    const failed = await updateLiveTask(task.id, {
      status: 'failed',
      summary: `${runtimeLabel} task failed to launch.`.slice(0, 280),
      error: String(err?.message || 'Task failed').slice(0, 4000),
      result: '',
    });
    if (failed) broadcast({ type: 'live_task:update', data: failed });
  });

  child.on('close', async (code, signal) => {
    if (finished) return;
    finished = true;
    clearTimers();

    const combinedErr = String(stderr || '').trim();
    const timedOut = signal === 'SIGTERM';
    if ((code && code !== 0) || timedOut) {
      const failed = await updateLiveTask(task.id, {
        status: 'failed',
        summary: timedOut ? `${runtimeLabel} task timed out.` : `${runtimeLabel} task failed.`,
        error: String(combinedErr || `Task exited with code ${code || 0}`).slice(0, 4000),
      });
      if (failed) broadcast({ type: 'live_task:update', data: failed });
      return;
    }

    const parsed = useHermes ? parseHermesTaskOutput(`${stdout}\n${stderr}`) : { text: String(stdout || '').trim(), hermesSessionId: '' };
    const result = parsed.text;
    const needsInputMatch = result.match(/(?:^|\n)NEEDS_INPUT\s*:\s*([\s\S]+)/i);
    if (needsInputMatch) {
      const prompt = String(needsInputMatch[1] || '').trim();
      const needsInput = await updateLiveTask(task.id, {
        status: 'needs_input',
        summary: (prompt || 'Task needs more input from you.').slice(0, 280),
        result: result.slice(0, 12000),
        error: '',
      });
      if (needsInput) broadcast({ type: 'live_task:update', data: needsInput });
      return;
    }

    const completed = await updateLiveTask(task.id, {
      status: 'completed',
      summary: result.slice(0, 280) || `${runtimeLabel} background task completed.`,
      result: result.slice(0, 12000),
      error: '',
    });
    if (completed) broadcast({ type: 'live_task:update', data: completed });
  });
}
