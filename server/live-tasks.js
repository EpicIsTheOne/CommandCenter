import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

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

export async function createLiveTask({ title, summary, prompt, agent = 'orchestrator' }) {
  const store = await readStore();
  const now = nowIso();
  const task = {
    id: `live-${Date.now().toString(36)}`,
    title: String(title || 'Background task').slice(0, 160),
    prompt: String(prompt || '').slice(0, 6000),
    agent,
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
  ];
  return needles.some((needle) => input.includes(needle));
}

export function runLiveTask(task, { broadcast, roster }) {
  const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
  const target = task.agent || roster?.primaryAgentId || 'orchestrator';

  updateLiveTask(task.id, { status: 'working', summary: 'Working on it in the background.' }).then((updated) => {
    if (updated) {
      broadcast({ type: 'live_task:update', data: updated });
    }
  }).catch(() => {});

  execFile(openclawBin, [
    'agent', '--agent', target,
    '--thinking', 'low',
    '--message', task.prompt,
  ], {
    timeout: 20 * 60 * 1000,
    env: { ...process.env, PATH: process.env.HOME + '/.local/bin:' + process.env.PATH },
    maxBuffer: 5 * 1024 * 1024,
  }, async (err, stdout, stderr) => {
    if (err) {
      const failed = await updateLiveTask(task.id, {
        status: 'failed',
        summary: err.message || 'Background task failed.',
        error: String(stderr || err.message || 'Task failed').slice(0, 4000),
      });
      if (failed) {
        broadcast({ type: 'live_task:update', data: failed });
      }
      return;
    }

    const result = String(stdout || '').trim();
    const needsInputMatch = result.match(/(?:^|\n)NEEDS_INPUT\s*:\s*([\s\S]+)/i);
    if (needsInputMatch) {
      const prompt = String(needsInputMatch[1] || '').trim();
      const needsInput = await updateLiveTask(task.id, {
        status: 'needs_input',
        summary: (prompt || 'Task needs more input from you.').slice(0, 280),
        result: result.slice(0, 12000),
        error: '',
      });
      if (needsInput) {
        broadcast({ type: 'live_task:update', data: needsInput });
      }
      return;
    }

    const completed = await updateLiveTask(task.id, {
      status: 'completed',
      summary: result.slice(0, 280) || 'Background task completed.',
      result: result.slice(0, 12000),
      error: '',
    });
    if (completed) {
      broadcast({ type: 'live_task:update', data: completed });
    }
  });
}
