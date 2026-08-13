import { ControlPlaneError, controlPlane, projectLegacyTask } from './control-plane.js';
import { buildCapabilityRegistry } from './control-capabilities.js';
import {
  canSteerLiveTask,
  requestLiveTaskCancel,
  runLiveTask,
  steerLiveTask,
} from './live-tasks.js';

function clean(value, max = 200) {
  return String(value ?? '').trim().slice(0, max);
}

function sendControlError(res, error) {
  const controlError = error instanceof ControlPlaneError
    ? error
    : new ControlPlaneError(error?.message || 'Control-plane request failed.', 'CONTROL_PLANE_ERROR', 500);
  return res.status(controlError.statusCode || 500).json({
    ok: false,
    error: controlError.message,
    code: controlError.code,
    details: controlError.details || {},
  });
}

function requestOperationId(req, body = {}) {
  return clean(body.operationId || req.headers['x-operation-id'] || '', 160);
}

function taskMutationOptions(req, body = {}, actor = 'operator') {
  return {
    operationId: requestOperationId(req, body),
    expectedTaskRevision: body.expectedTaskRevision,
    actor,
  };
}

function approvalMutationOptions(req, body = {}, actor = 'operator') {
  return {
    operationId: requestOperationId(req, body),
    expectedApprovalRevision: body.expectedApprovalRevision,
    actor,
  };
}

function startTaskIfReady(task, { broadcast, getRoster }) {
  if (!task || task.state !== 'queued') return;
  const legacyTask = projectLegacyTask(task);
  try {
    runLiveTask(legacyTask, { broadcast, roster: getRoster() });
  } catch (error) {
    controlPlane.updateTask(task.id, {
      state: 'failed',
      summary: 'Task failed to start.',
      error: clean(error?.message || 'Task failed to start.', 4000),
    }, {
      operationId: `runtime:start-failed:${task.id}:${task.revision}`,
      actor: 'control-plane',
      source: 'runtime-start',
    }).catch(() => {});
  }
}

function registerControlRouteSet(app, prefix, { broadcast, getRoster, relayAgentSource }) {
  app.get(`${prefix}/status`, async (_req, res) => {
    try {
      const status = await controlPlane.status();
      return res.json({ ...status, capabilities: buildCapabilityRegistry({ roster: getRoster(), relayAgents: relayAgentSource?.getAgents?.() || [] }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/events`, async (req, res) => {
    try {
      const events = await controlPlane.listEvents({
        afterEventSequence: req.query?.afterEventSequence,
        taskId: req.query?.taskId,
        threadId: req.query?.threadId,
        limit: req.query?.limit,
      });
      return res.json({ ok: true, events, nextEventSequence: events.at(-1)?.eventSequence || Number(req.query?.afterEventSequence || 0) || 0 });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/notifications`, async (req, res) => {
    try {
      const notifications = await controlPlane.listNotifications({
        unreadOnly: String(req.query?.unreadOnly || '') === 'true',
        afterEventSequence: req.query?.afterEventSequence,
        limit: req.query?.limit,
      });
      return res.json({ ok: true, notifications });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/goals`, async (req, res) => {
    try {
      return res.json({ ok: true, goals: await controlPlane.listGoals({ state: req.query?.state, limit: req.query?.limit }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/goals`, async (req, res) => {
    try {
      return res.status(201).json(await controlPlane.createGoal({ ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/plans`, async (req, res) => {
    try {
      return res.json({ ok: true, plans: await controlPlane.listPlans({ goalId: req.query?.goalId, limit: req.query?.limit }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/plans`, async (req, res) => {
    try {
      return res.status(201).json(await controlPlane.createPlan({ ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/notifications/:id/read`, async (req, res) => {
    try {
      return res.json(await controlPlane.markNotificationRead(req.params.id, { operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/agents/capabilities`, async (_req, res) => {
    try {
      return res.json({ ok: true, agents: buildCapabilityRegistry({ roster: getRoster(), relayAgents: relayAgentSource?.getAgents?.() || [] }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/tasks`, async (req, res) => {
    try {
      const tasks = await controlPlane.listTasks({
        threadId: req.query?.threadId,
        agent: req.query?.agent,
        state: req.query?.state,
        limit: req.query?.limit,
      });
      return res.json({ ok: true, tasks });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/tasks/:id`, async (req, res) => {
    try {
      const task = await controlPlane.getTask(req.params.id);
      if (!task) return res.status(404).json({ ok: false, error: 'Task not found.', code: 'TASK_NOT_FOUND' });
      const events = String(req.query?.includeEvents || '') === 'true'
        ? await controlPlane.listEvents({ taskId: task.id, limit: req.query?.limit || 500 })
        : [];
      return res.json({ ok: true, task, events });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks`, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await controlPlane.createTask({
        id: body.id,
        threadId: body.threadId,
        title: body.title,
        prompt: body.prompt || body.text,
        summary: body.summary,
        agent: body.agent || getRoster()?.primaryAgentId || 'orchestrator',
        runtime: body.runtime,
        parentTaskId: body.parentTaskId,
        goalId: body.goalId,
        planId: body.planId,
        target: body.target,
        capabilities: body.capabilities,
        requiredCapabilities: body.requiredCapabilities,
        autoQueue: body.autoQueue !== false,
        operationId: requestOperationId(req, body),
      });
      if (body.autoStart !== false) startTaskIfReady(result.task, { broadcast, getRoster });
      return res.status(201).json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/queue`, async (req, res) => {
    try {
      const body = req.body || {};
      const current = await controlPlane.getTask(req.params.id);
      if (!current) return res.status(404).json({ ok: false, error: 'Task not found.', code: 'TASK_NOT_FOUND' });
      const followUp = body.followUp === true || (current.state === 'running' && Boolean(body.prompt || body.title));
      const result = await controlPlane.queueTask(req.params.id, {
        title: body.title,
        prompt: body.prompt || body.text,
        followUp,
        agent: body.agent,
        runtime: body.runtime,
        ...taskMutationOptions(req, body),
      });
      if (!result.childTask) startTaskIfReady(result.task, { broadcast, getRoster });
      return res.json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/steer`, async (req, res) => {
    try {
      const body = req.body || {};
      const runtimeAccepted = canSteerLiveTask(req.params.id);
      const result = await controlPlane.steerTask(req.params.id, body.guidance || body.text, {
        ...taskMutationOptions(req, body),
        runtimeAccepted,
      });
      if (runtimeAccepted) await steerLiveTask(req.params.id, body.guidance || body.text);
      return res.json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/cancel`, async (req, res) => {
    try {
      const body = req.body || {};
      const result = await controlPlane.requestCancel(req.params.id, {
        ...taskMutationOptions(req, body),
        immediate: body.immediate === true,
      });
      if (result.task?.state === 'cancelling') await requestLiveTaskCancel(req.params.id);
      return res.json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/retry`, async (req, res) => {
    try {
      const result = await controlPlane.retryTask(req.params.id, taskMutationOptions(req, req.body || {}));
      if (result.task?.state === 'queued') startTaskIfReady(result.task, { broadcast, getRoster });
      return res.json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/approvals`, async (req, res) => {
    try {
      const body = req.body || {};
      return res.status(201).json(await controlPlane.requestApproval(req.params.id, {
        capability: body.capability,
        summary: body.summary,
        expiresAt: body.expiresAt,
        operationId: requestOperationId(req, body),
        actor: body.actor || 'runtime',
        expectedTaskRevision: body.expectedTaskRevision,
      }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/approvals`, async (req, res) => {
    try {
      return res.json({ ok: true, approvals: await controlPlane.listApprovals({ state: req.query?.state, taskId: req.query?.taskId, limit: req.query?.limit }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/approvals/:id/approve`, async (req, res) => {
    try {
      const result = await controlPlane.decideApproval(req.params.id, 'approved', approvalMutationOptions(req, req.body || {}));
      if (result.task?.state === 'queued') startTaskIfReady(result.task, { broadcast, getRoster });
      return res.json(result);
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/approvals/:id/deny`, async (req, res) => {
    try {
      return res.json(await controlPlane.decideApproval(req.params.id, 'denied', approvalMutationOptions(req, req.body || {})));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/approvals/expire`, async (_req, res) => {
    try {
      return res.json({ ok: true, results: await controlPlane.expireApprovals() });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/threads`, async (req, res) => {
    try {
      return res.json({ ok: true, threads: await controlPlane.listThreads({ parentThreadId: req.query?.parentThreadId, kind: req.query?.kind, limit: req.query?.limit }) });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.get(`${prefix}/threads/:id`, async (req, res) => {
    try {
      const thread = await controlPlane.getThread(req.params.id);
      if (!thread) return res.status(404).json({ ok: false, error: 'Thread not found.', code: 'THREAD_NOT_FOUND' });
      return res.json({ ok: true, thread });
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/threads`, async (req, res) => {
    try {
      return res.status(201).json(await controlPlane.createThread({ ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/threads/:id/messages`, async (req, res) => {
    try {
      return res.status(201).json(await controlPlane.appendThreadMessage(req.params.id, { ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/threads/:id/fork`, async (req, res) => {
    try {
      return res.status(201).json(await controlPlane.forkThread(req.params.id, { ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/threads/:id/compact`, async (req, res) => {
    try {
      return res.json(await controlPlane.compactThread(req.params.id, { ...(req.body || {}), operationId: requestOperationId(req, req.body || {}) }));
    } catch (error) {
      return sendControlError(res, error);
    }
  });

  app.post(`${prefix}/tasks/:id/review`, async (req, res) => {
    try {
      return res.json(await controlPlane.updateTaskReview(req.params.id, req.body?.review || req.body || {}, taskMutationOptions(req, req.body || {})));
    } catch (error) {
      return sendControlError(res, error);
    }
  });
}

export function registerControlRoutes(app, { basePath = '', broadcast = () => {}, getRoster = () => ({}), relayAgentSource = null } = {}) {
  const prefixes = [...new Set([`${basePath}/api/control`, `${basePath}/api/v1/control`])];
  for (const prefix of prefixes) registerControlRouteSet(app, prefix, { broadcast, getRoster, relayAgentSource });
  return prefixes;
}

export { startTaskIfReady };
