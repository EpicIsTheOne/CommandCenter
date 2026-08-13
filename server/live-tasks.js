import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { getHermesAgent } from './agents.js';
import { runApiChatTurn } from './api-chat-runner.js';
import relayAgentSource from './relay-agent-source.js';
import { ControlPlaneError, controlPlane, initializeControlPlane, projectLegacyTask } from './control-plane.js';

const activeExecutions = new Map();
const CANCEL_ACK_TIMEOUT_MS = 15_000;

function nowIso() {
  return new Date().toISOString();
}

function legacyPatchToControlPatch(patch = {}) {
  const next = { ...patch };
  if (next.status && !next.state) next.state = next.status === 'working' ? 'running' : next.status === 'needs_input' ? 'blocked' : next.status;
  delete next.status;
  delete next.created_at;
  delete next.updated_at;
  delete next.id;
  return next;
}

export async function listLiveTasks() {
  await initializeControlPlane();
  return (await controlPlane.listTasks()).map(projectLegacyTask);
}

export async function getLiveTask(taskId) {
  await initializeControlPlane();
  const task = await controlPlane.getTask(taskId);
  return task ? projectLegacyTask(task) : null;
}

export async function createLiveTask({ title, summary, prompt, agent = 'orchestrator', runtime = '', threadId = '', parentTaskId = '', operationId = '', capabilities = [] } = {}) {
  const result = await controlPlane.createTask({
    id: `live-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`,
    title,
    summary,
    prompt,
    agent,
    runtime,
    threadId,
    parentTaskId,
    capabilities,
    autoQueue: true,
    operationId: operationId || `legacy:create:${randomUUID()}`,
  });
  return projectLegacyTask(result.task);
}

export async function updateLiveTask(taskId, patch) {
  try {
    const result = await controlPlane.updateTask(taskId, legacyPatchToControlPatch(patch), {
      operationId: `legacy:update:${taskId}:${randomUUID()}`,
      expectedAttemptId: patch?.attemptId || patch?.attempt_id || '',
      expectedProgressSequence: patch?.runtimeProgressSequence,
      actor: 'legacy-live-task-runner',
      source: 'legacy-live-task',
    });
    return projectLegacyTask(result.task);
  } catch (error) {
    if (error instanceof ControlPlaneError && ['TASK_NOT_FOUND', 'INVALID_TRANSITION', 'TASK_TERMINAL', 'STALE_REVISION', 'STALE_ATTEMPT', 'STALE_EVENT'].includes(error.code)) {
      const current = await controlPlane.getTask(taskId);
      return current ? projectLegacyTask(current) : null;
    }
    throw error;
  }
}

export function canSteerLiveTask(taskId) {
  const execution = activeExecutions.get(String(taskId || ''));
  return !execution || execution.steerSupported === true;
}

export async function steerLiveTask(taskId, guidance = '') {
  const execution = activeExecutions.get(String(taskId || ''));
  if (!execution?.steer) return false;
  return execution.steer(guidance);
}

export async function requestLiveTaskCancel(taskId) {
  const execution = activeExecutions.get(String(taskId || ''));
  if (!execution?.cancel) return false;
  return execution.cancel();
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

function relayRuntimeLabel(agent = {}) {
  const provider = String(agent.relayProviderLabel || agent.relayProviderId || 'Relay').trim();
  const device = String(agent.relayDeviceName || agent.relayDeviceId || '').trim();
  return `${provider} relay${device ? ` on ${device}` : ''}`;
}

function runRelayLiveTask(task, { broadcast } = {}) {
  const target = String(task.agent || '').trim();
  const relayAgent = relayAgentSource.getAgent(target);
  const useControlProtocol = relayAgent?.relayTransport === 'device' && typeof relayAgentSource.runRelayControlTask === 'function';
  const runtimeLabel = relayRuntimeLabel(relayAgent || {});
  const startedAt = Date.now();
  let finished = false;
  let heartbeatTimer = null;
  let killTimer = null;

  function publish(updated) {
    if (updated) broadcast?.({ type: 'live_task:update', data: updated });
  }

  function summarize(stage = 'working', extra = '') {
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const elapsedText = elapsed < 2 ? 'just started' : `${elapsed}s elapsed`;
    return `${runtimeLabel} ${stage}${extra ? ` - ${extra}` : ''} - ${elapsedText}`.slice(0, 280);
  }

  async function pushUpdate(patch = {}) {
    const updated = await updateLiveTask(task.id, { ...patch, attemptId: task.attemptId });
    publish(updated);
    return updated;
  }

  const clearExecution = () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (killTimer) clearTimeout(killTimer);
    activeExecutions.delete(String(task.id || ''));
  };

  if (!relayAgent) {
    pushUpdate({
      status: 'failed',
      runtime: 'relay',
      summary: 'Relay agent is no longer available.',
      error: `Relay target ${target || '(missing)'} is not currently connected.`,
    }).catch(() => {});
    return;
  }

  const relayFields = {
    runtime: 'relay',
    relayDeviceId: relayAgent.relayDeviceId,
    relayDeviceName: relayAgent.relayDeviceName,
    relayProviderId: relayAgent.relayProviderId,
    relayProviderLabel: relayAgent.relayProviderLabel,
    relayAgentId: relayAgent.relayAgentId,
  };
  pushUpdate({
    ...relayFields,
    status: 'working',
    summary: summarize('routing', 'sending the request to the remote agent'),
    error: '',
  }).catch(() => {});

  heartbeatTimer = setInterval(() => {
    if (finished) return;
    pushUpdate({
      ...relayFields,
      status: 'working',
      summary: summarize('working', 'waiting for the remote response'),
    }).catch(() => {});
  }, 6000);
  killTimer = setTimeout(() => {
    if (finished) return;
    finished = true;
    clearExecution();
    const timeoutPatch = {
      ...relayFields,
      status: 'failed',
      summary: summarize('timed out'),
      error: 'Relay task timed out while waiting for the remote agent.',
    };
    pushUpdate(timeoutPatch).catch(() => {});
  }, 20 * 60 * 1000);

  activeExecutions.set(String(task.id || ''), {
    steerSupported: useControlProtocol && relayAgent?.steerSupported === true,
    steer: useControlProtocol && relayAgent?.steerSupported === true
      ? async (guidance) => {
        await relayAgentSource.steerRelayTask({ session, task, guidance });
        return true;
      }
      : null,
    cancel: async () => {
      if (finished) return true;
      let settle;
      const terminal = new Promise((resolve) => { settle = resolve; });
      const cancelTimer = setTimeout(() => settle('timeout'), CANCEL_ACK_TIMEOUT_MS);
      let outcome = '';
      try {
        const response = useControlProtocol
          ? await relayAgentSource.cancelRelayTask({
            session,
            task,
            onEvent: (event) => {
              const state = String(event?.data?.state || '').trim();
              if (state === 'cancelled' || state === 'failed') settle(state);
            },
          })
          : null;
        if (response?.state === 'cancelled' || response?.state === 'failed') outcome = response.state;
        else outcome = await terminal;
      } catch {
        outcome = 'failed';
      }
      clearTimeout(cancelTimer);
      if (finished) return outcome === 'cancelled';
      finished = true;
      clearExecution();
      await pushUpdate(outcome === 'cancelled' ? {
        ...relayFields,
        status: 'cancelled',
        summary: `${runtimeLabel} task cancelled.`,
        error: '',
      } : {
        ...relayFields,
        status: 'failed',
        summary: `${runtimeLabel} cancellation failed.`.slice(0, 280),
        error: 'CANCEL_FAILED',
      });
      return outcome === 'cancelled';
    },
  });

  const session = {
    id: `fairy_relay_${String(task.id || '').replace(/[^a-z0-9_-]/gi, '_')}`,
    agent: target,
    mode: 'agent',
    metadata: {
      ...relayAgentSource.buildSessionMetadata(target),
      skipBackchannel: true,
      source: 'fairy-live-task',
    },
    messages: [],
  };

  const onEvent = (event = {}) => {
    const data = event.data || {};
    if (event.type !== 'thinking' && !String(event.type || '').startsWith('agent:')) return;
    const activity = String(data.message || data.status || data.tool || 'processing').replace(/\s+/g, ' ').trim();
    pushUpdate({
      ...relayFields,
      status: 'working',
      summary: summarize('working', activity || 'processing'),
      relayActivity: {
        status: String(data.status || '').slice(0, 80),
        message: String(data.message || '').slice(0, 240),
        tool: String(data.tool || '').slice(0, 120),
        updatedAt: nowIso(),
      },
    }).catch(() => {});
  };
  const relayPromise = useControlProtocol
    ? relayAgentSource.runRelayControlTask({ session, task, onEvent })
    : runApiChatTurn({ session, latestMessage: task.prompt, onEvent });
  relayPromise.then(async (result = {}) => {
    if (finished) return;
    finished = true;
    clearExecution();
    const text = String(result.text || '').trim();
    const needsInputMatch = text.match(/(?:^|\n)NEEDS_INPUT\s*:\s*([\s\S]+)/i);
    const patch = {
      ...relayFields,
      status: needsInputMatch ? 'needs_input' : 'completed',
      summary: (needsInputMatch ? String(needsInputMatch[1] || '').trim() : text).slice(0, 280)
        || (needsInputMatch ? 'Remote agent needs more input.' : `${runtimeLabel} background task completed.`),
      result: text.slice(0, 12000),
      error: '',
      relayProviderSessionId: String(result.providerSessionId || '').slice(0, 240),
      relayRemoteSessionId: String(result.sessionId || '').slice(0, 240),
    };
    await pushUpdate(patch);
  }).catch(async (error) => {
    if (finished) return;
    finished = true;
    clearExecution();
    await pushUpdate({
      ...relayFields,
      status: 'failed',
      summary: `${runtimeLabel} task failed.`.slice(0, 280),
      error: String(error?.message || error || 'Relay task failed').slice(0, 4000),
    });
  });
}

export function runLiveTask(task, { broadcast, roster }) {
  const openclawBin = process.env.OPENCLAW_BIN || 'openclaw';
  const hermesBin = process.env.HERMES_BIN || 'hermes';
  const target = task.agent || roster?.primaryAgentId || 'orchestrator';
  if (String(task.runtime || '').trim() === 'relay' || relayAgentSource.getAgent(target)) {
    return runRelayLiveTask(task, { broadcast, roster });
  }
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
  let cancelRequested = false;
  let cancelTimer = null;

  function summarizeWorking(stageLabel = 'working', extra = '') {
    const elapsedSec = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const elapsedText = elapsedSec < 2 ? 'just started' : `${elapsedSec}s elapsed`;
    return `${runtimeLabel} ${stageLabel}${extra ? ` · ${extra}` : ''} · ${elapsedText}`.slice(0, 280);
  }

  async function pushUpdate(patch = {}) {
    const updated = await updateLiveTask(task.id, { ...patch, attemptId: task.attemptId });
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
    clearTimeout(cancelTimer);
  }

  function clearExecution() {
    clearTimers();
    activeExecutions.delete(String(task.id || ''));
  }

  activeExecutions.set(String(task.id || ''), {
    steerSupported: false,
    cancel: async () => {
      if (finished) return true;
      cancelRequested = true;
      try { child.kill('SIGTERM'); } catch {}
      if (!cancelTimer) {
        cancelTimer = setTimeout(async () => {
          if (finished) return;
          finished = true;
          clearExecution();
          const failed = await updateLiveTask(task.id, {
            status: 'failed',
            summary: `${runtimeLabel} cancellation failed.`.slice(0, 280),
            error: 'CANCEL_FAILED',
            attemptId: task.attemptId,
          });
          if (failed) broadcast({ type: 'live_task:update', data: failed });
        }, CANCEL_ACK_TIMEOUT_MS);
      }
      return true;
    },
  });

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
    clearExecution();
    if (cancelRequested) {
      const cancelled = await updateLiveTask(task.id, {
        status: 'cancelled',
        summary: `${runtimeLabel} task cancelled.`,
        error: '',
        attemptId: task.attemptId,
      });
      if (cancelled) broadcast({ type: 'live_task:update', data: cancelled });
      return;
    }
    const failed = await updateLiveTask(task.id, {
      status: 'failed',
      summary: `${runtimeLabel} task failed to launch.`.slice(0, 280),
      error: String(err?.message || 'Task failed').slice(0, 4000),
      result: '',
      attemptId: task.attemptId,
    });
    if (failed) broadcast({ type: 'live_task:update', data: failed });
  });

  child.on('close', async (code, signal) => {
    if (finished) return;
    finished = true;
    clearExecution();

    const combinedErr = String(stderr || '').trim();
    const timedOut = signal === 'SIGTERM';
    if (cancelRequested) {
      const cancelled = await updateLiveTask(task.id, {
        status: 'cancelled',
        summary: `${runtimeLabel} task cancelled.`,
        error: '',
        attemptId: task.attemptId,
      });
      if (cancelled) broadcast({ type: 'live_task:update', data: cancelled });
      return;
    }
    if ((code && code !== 0) || timedOut) {
      const failed = await updateLiveTask(task.id, {
        status: 'failed',
        summary: timedOut ? `${runtimeLabel} task timed out.` : `${runtimeLabel} task failed.`,
        error: String(combinedErr || `Task exited with code ${code || 0}`).slice(0, 4000),
        attemptId: task.attemptId,
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
        attemptId: task.attemptId,
      });
      if (needsInput) broadcast({ type: 'live_task:update', data: needsInput });
      return;
    }

    const completed = await updateLiveTask(task.id, {
      status: 'completed',
      summary: result.slice(0, 280) || `${runtimeLabel} background task completed.`,
      result: result.slice(0, 12000),
      error: '',
      attemptId: task.attemptId,
    });
    if (completed) broadcast({ type: 'live_task:update', data: completed });
  });
}
