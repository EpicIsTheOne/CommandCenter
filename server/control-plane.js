import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonStore, writeJsonStore } from './json-store.js';

export const CONTROL_TASK_STATES = Object.freeze([
  'created',
  'queued',
  'running',
  'waiting_for_approval',
  'blocked',
  'cancelling',
  'cancelled',
  'failed',
  'retrying',
  'completed',
]);

export const CONTROL_TASK_TRANSITIONS = Object.freeze({
  created: Object.freeze(['queued', 'waiting_for_approval', 'cancelling']),
  queued: Object.freeze(['running', 'waiting_for_approval', 'cancelling', 'failed']),
  running: Object.freeze(['waiting_for_approval', 'blocked', 'cancelling', 'failed', 'completed']),
  waiting_for_approval: Object.freeze(['queued', 'blocked', 'cancelling']),
  blocked: Object.freeze(['queued', 'waiting_for_approval', 'cancelling', 'failed']),
  cancelling: Object.freeze(['cancelled', 'failed']),
  cancelled: Object.freeze([]),
  failed: Object.freeze(['retrying']),
  retrying: Object.freeze(['queued', 'cancelling', 'failed']),
  completed: Object.freeze([]),
});

export const CONTROL_TERMINAL_STATES = Object.freeze(['cancelled', 'completed']);

const LEGACY_STATUS_TO_STATE = Object.freeze({
  created: 'created',
  queued: 'queued',
  working: 'running',
  running: 'running',
  waiting_for_approval: 'waiting_for_approval',
  blocked: 'blocked',
  needs_input: 'blocked',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  failed: 'failed',
  retrying: 'retrying',
  completed: 'completed',
});

const STATE_TO_LEGACY_STATUS = Object.freeze({
  created: 'created',
  queued: 'queued',
  running: 'working',
  waiting_for_approval: 'needs_input',
  blocked: 'needs_input',
  cancelling: 'cancelling',
  cancelled: 'cancelled',
  failed: 'failed',
  retrying: 'queued',
  completed: 'completed',
});

const TASK_EVENT_TYPES = new Set([
  'task.created',
  'task.queued',
  'task.started',
  'task.progress',
  'task.blocked',
  'approval.requested',
  'approval.approved',
  'approval.denied',
  'task.steered',
  'task.cancel_requested',
  'task.cancelled',
  'task.failed',
  'task.completed',
  'task.retrying',
]);

const RISKY_TASK_CAPABILITIES = new Set([
  'file.write',
  'command.execute',
  'network.request',
  'deployment.execute',
  'external.communication',
  'settings.change',
  'device.control',
]);

const DEFAULT_SNAPSHOT = Object.freeze({
  version: 1,
  lastEventSequence: 0,
  checkpointSequence: 0,
  tasks: {},
  threads: {},
  goals: {},
  plans: {},
  approvals: {},
  notifications: {},
  operations: {},
  migrations: {},
});

const MAX_TEXT = 16000;

function nowIso() {
  return new Date().toISOString();
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function cleanText(value = '', max = MAX_TEXT) {
  return String(value ?? '').trim().slice(0, max);
}

function boundedArray(value, max = 32) {
  return Array.isArray(value) ? value.slice(0, max) : [];
}

function safeMap(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function safeIso(value, fallback = nowIso()) {
  const text = cleanText(value, 80);
  return text && !Number.isNaN(Date.parse(text)) ? text : fallback;
}

function hashRequest(value) {
  return createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
}

function operationId(value = '') {
  const text = cleanText(value, 160);
  return text || `op_${randomUUID()}`;
}

function taskId(value = '') {
  const text = cleanText(value, 160);
  return text || `task-${randomUUID()}`;
}

function threadId(value = '') {
  const text = cleanText(value, 160);
  return text || `thread-${randomUUID()}`;
}

function attemptId(value = '') {
  const text = cleanText(value, 160);
  return text || `attempt-${randomUUID()}`;
}

function approvalId(value = '') {
  const text = cleanText(value, 160);
  return text || `approval-${randomUUID()}`;
}

function redactText(value = '') {
  return cleanText(value)
    .replace(/(api[_ -]?key|password|passwd|token|secret|cookie|credential|authorization)\s*[:=]\s*[^\s,;]+/ig, '$1: [redacted]');
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? redactText(value) : value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/(api[_-]?key|password|passwd|token|secret|cookie|credential|authorization)/i.test(key)) out[key] = '[redacted]';
    else out[key] = redactValue(item);
  }
  return out;
}

function normalizeCapabilities(value) {
  return Array.from(new Set(boundedArray(value, 64).map((item) => cleanText(item, 96)).filter(Boolean)));
}

function normalizeSnapshot(value = {}) {
  return {
    ...clone(DEFAULT_SNAPSHOT),
    ...(value && typeof value === 'object' ? value : {}),
    tasks: safeMap(value?.tasks),
    threads: safeMap(value?.threads),
    goals: safeMap(value?.goals),
    plans: safeMap(value?.plans),
    approvals: safeMap(value?.approvals),
    notifications: safeMap(value?.notifications),
    operations: safeMap(value?.operations),
    migrations: safeMap(value?.migrations),
    lastEventSequence: Number(value?.lastEventSequence || 0) || 0,
    checkpointSequence: Number(value?.checkpointSequence || 0) || 0,
    version: 1,
  };
}

function taskStateFromLegacy(status = '') {
  return LEGACY_STATUS_TO_STATE[cleanText(status, 80).toLowerCase()] || 'blocked';
}

function legacyStatusForTask(task = {}) {
  return STATE_TO_LEGACY_STATUS[cleanText(task.state, 80)] || 'blocked';
}

function eventTypeForState(state = '', priorState = '') {
  if (state === 'queued') return 'task.queued';
  if (state === 'running' && priorState !== 'running') return 'task.started';
  if (state === 'blocked') return 'task.blocked';
  if (state === 'cancelling') return 'task.cancel_requested';
  if (state === 'cancelled') return 'task.cancelled';
  if (state === 'failed') return 'task.failed';
  if (state === 'completed') return 'task.completed';
  if (state === 'retrying') return 'task.retrying';
  return 'task.progress';
}

function isTaskEvent(type = '') {
  return TASK_EVENT_TYPES.has(type);
}

function safeTaskSnapshot(task = {}) {
  return redactValue({
    ...task,
    prompt: redactText(task.prompt),
    result: redactText(task.result),
    error: redactText(task.error),
  });
}

function safeThreadSnapshot(thread = {}) {
  return redactValue(thread);
}

function safeGoalSnapshot(goal = {}) {
  return redactValue(goal);
}

function safePlanSnapshot(plan = {}) {
  return redactValue(plan);
}

function safeApprovalSnapshot(approval = {}) {
  return redactValue(approval);
}

function safeNotificationSnapshot(notification = {}) {
  return redactValue(notification);
}

export class ControlPlaneError extends Error {
  constructor(message, code = 'CONTROL_PLANE_ERROR', statusCode = 409, details = {}) {
    super(message);
    this.name = 'ControlPlaneError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function canTransitionTask(fromState = '', toState = '') {
  if (!CONTROL_TASK_STATES.includes(fromState) || !CONTROL_TASK_STATES.includes(toState)) return false;
  return CONTROL_TASK_TRANSITIONS[fromState]?.includes(toState) === true;
}

export function projectLegacyTask(task = {}) {
  const state = cleanText(task.state, 80) || taskStateFromLegacy(task.status);
  return {
    ...clone(task),
    state,
    status: legacyStatusForTask({ ...task, state }),
    created_at: task.createdAt || task.created_at || nowIso(),
    updated_at: task.updatedAt || task.updated_at || task.createdAt || nowIso(),
    thread_id: task.threadId || '',
    parent_task_id: task.parentTaskId || '',
    goal_id: task.goalId || '',
    plan_id: task.planId || '',
    attempt_id: task.attemptId || '',
    progress_sequence: Number(task.progressSequence || 0) || 0,
    task_sequence: Number(task.taskSequence || 0) || 0,
  };
}

export class ControlPlane extends EventEmitter {
  constructor({ dataDir = process.env.COMMANDCENTER_CONTROL_DATA_DIR || process.env.COMMANDCENTER_DATA_DIR || join(process.cwd(), 'data'), legacyFile = '' } = {}) {
    super();
    this.dataDir = dataDir;
    this.snapshotFile = join(dataDir, 'control-plane.v1.json');
    this.journalFile = join(dataDir, 'control-plane-events.v1.jsonl');
    this.migrationFile = join(dataDir, 'control-plane-migration.v1.json');
    this.legacyFile = legacyFile || join(dataDir, 'live-tasks.v1.json');
    this.snapshot = normalizeSnapshot();
    this.events = [];
    this.ready = false;
    this.initializing = null;
    this.mutationQueue = Promise.resolve();
  }

  async initialize() {
    if (this.ready) return this;
    if (this.initializing) return this.initializing;
    this.initializing = this._load();
    try {
      await this.initializing;
      this.ready = true;
      return this;
    } finally {
      this.initializing = null;
    }
  }

  async _load() {
    await mkdir(this.dataDir, { recursive: true });
    this.snapshot = normalizeSnapshot(await readJsonStore(this.snapshotFile, { defaultValue: DEFAULT_SNAPSHOT }));
    this.events = [];
    if (existsSync(this.journalFile)) {
      const raw = await readFile(this.journalFile, 'utf8');
      for (const line of String(raw || '').split(/\r?\n/).filter(Boolean)) {
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          throw new ControlPlaneError(`Control-plane journal is corrupt: ${error.message}`, 'CONTROL_JOURNAL_CORRUPT', 500);
        }
        if (!Number.isSafeInteger(Number(event?.eventSequence))) continue;
        this.events.push(event);
      }
    }
    this.events.sort((a, b) => Number(a.eventSequence || 0) - Number(b.eventSequence || 0));
    const checkpoint = Number(this.snapshot.checkpointSequence || 0) || 0;
    for (const event of this.events) {
      if (Number(event.eventSequence || 0) <= checkpoint) continue;
      this._applyEvent(this.snapshot, event);
    }
    this.snapshot.lastEventSequence = Math.max(
      Number(this.snapshot.lastEventSequence || 0) || 0,
      this.events.reduce((max, event) => Math.max(max, Number(event.eventSequence || 0) || 0), 0),
    );
    await this._migrateLegacyTasks();
  }

  _applyEvent(snapshot, event) {
    const type = cleanText(event?.type, 120);
    const resourceType = cleanText(event?.resourceType, 40);
    const resourceId = cleanText(event?.resourceId, 200);
    const resourceSnapshot = event?.resourceSnapshot;
    if (!resourceId || !resourceSnapshot) return;
    if (resourceType === 'task') snapshot.tasks[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'thread') snapshot.threads[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'goal') snapshot.goals[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'plan') snapshot.plans[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'approval') snapshot.approvals[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'notification') snapshot.notifications[resourceId] = clone(resourceSnapshot);
    else if (resourceType === 'operation') snapshot.operations[resourceId] = clone(resourceSnapshot);
    if (type === 'notification.deleted') delete snapshot.notifications[resourceId];
    snapshot.lastEventSequence = Math.max(Number(snapshot.lastEventSequence || 0) || 0, Number(event.eventSequence || 0) || 0);
  }

  async _migrateLegacyTasks() {
    if (!existsSync(this.legacyFile)) return;
    if (this.snapshot.migrations.liveTasksV1?.completed === true) return;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.legacyFile, 'utf8'));
    } catch (error) {
      throw new ControlPlaneError(`Legacy live-task store is corrupt: ${error.message}`, 'LEGACY_TASKS_CORRUPT', 500);
    }
    const legacyTasks = Array.isArray(parsed?.tasks) ? parsed.tasks : [];
    if (!legacyTasks.length) {
      this.snapshot.migrations.liveTasksV1 = { completed: true, count: 0, source: this.legacyFile, completedAt: nowIso() };
      await writeJsonStore(this.snapshotFile, this.snapshot);
      return;
    }
    const candidate = clone(this.snapshot);
    const migrationEvents = [];
    const sourceHash = hashRequest(legacyTasks);
    for (const legacy of legacyTasks) {
      const id = taskId(legacy.id);
      if (candidate.tasks[id]) continue;
      const state = taskStateFromLegacy(legacy.status);
      const thread = this._buildThread({
        id: `thread:legacy-live:${id}`,
        kind: 'task',
        title: legacy.title || 'Migrated live task',
        parentThreadId: '',
        source: 'legacy-live-task',
      });
      candidate.threads[thread.id] = thread;
      migrationEvents.push(this._buildEvent(candidate, {
        type: 'thread.created',
        resourceType: 'thread',
        resourceId: thread.id,
        resourceSnapshot: safeThreadSnapshot(thread),
        operationId: `migration:live-task:${id}:thread`,
        actor: 'migration',
      }));
      const legacyCapabilities = normalizeCapabilities(legacy.capabilities || legacy.requiredCapabilities);
      const task = this._buildTask({
        ...legacy,
        id,
        threadId: thread.id,
        state,
        attemptId: `legacy-attempt:${id}`,
        revision: 1,
        taskSequence: 1,
        progressSequence: 0,
        capabilities: legacyCapabilities,
        legacySource: { file: this.legacyFile, rawStatus: cleanText(legacy.status, 80) },
        blocker: state === 'blocked' ? { type: cleanText(legacy.status, 80) === 'needs_input' ? 'legacy_needs_input' : 'migration_review', message: legacy.summary || legacy.error || 'Migrated task requires review.' } : null,
      });
      candidate.tasks[task.id] = task;
      migrationEvents.push(this._buildEvent(candidate, {
        type: 'task.created',
        resourceType: 'task',
        resourceId: task.id,
        resourceSnapshot: safeTaskSnapshot(task),
        operationId: `migration:live-task:${id}:task`,
        actor: 'migration',
        payload: { migrated: true, legacyStatus: cleanText(legacy.status, 80) },
      }));
    }
    candidate.migrations.liveTasksV1 = {
      completed: true,
      count: legacyTasks.length,
      migratedCount: legacyTasks.filter((legacy) => Boolean(candidate.tasks[taskId(legacy.id)])).length,
      source: this.legacyFile,
      sourceHash,
      completedAt: nowIso(),
    };
    await this._commit(candidate, migrationEvents);
    await writeJsonStore(this.migrationFile, candidate.migrations.liveTasksV1);
  }

  _buildThread({ id = '', kind = 'main', title = '', parentThreadId = '', source = 'command-center', goalId = '' } = {}) {
    const now = nowIso();
    return {
      id: threadId(id),
      kind: cleanText(kind, 40) || 'main',
      title: cleanText(title, 200) || 'Command Center thread',
      parentThreadId: cleanText(parentThreadId, 160),
      goalId: cleanText(goalId, 160),
      source: cleanText(source, 80) || 'command-center',
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
      messages: [],
      contextSummary: '',
      compactVersion: 0,
      archived: false,
    };
  }

  _buildTask(input = {}) {
    const state = CONTROL_TASK_STATES.includes(cleanText(input.state, 80))
      ? cleanText(input.state, 80)
      : taskStateFromLegacy(input.status);
    const now = nowIso();
    const currentAttemptId = attemptId(input.attemptId || input.attempt_id);
    const currentAttemptNumber = Math.max(1, Number(input.attemptNumber || 1) || 1);
    return {
      id: taskId(input.id),
      threadId: threadId(input.threadId),
      parentTaskId: cleanText(input.parentTaskId || input.parent_task_id, 160),
      goalId: cleanText(input.goalId || input.goal_id, 160),
      planId: cleanText(input.planId || input.plan_id, 160),
      title: cleanText(input.title, 200) || 'Background task',
      prompt: cleanText(input.prompt, 12000),
      agent: cleanText(input.agent, 160) || 'orchestrator',
      runtime: cleanText(input.runtime, 80),
      target: input.target && typeof input.target === 'object' ? clone(input.target) : {},
      state,
      revision: Math.max(0, Number(input.revision || 0) || 0),
      attemptId: currentAttemptId,
      attemptNumber: currentAttemptNumber,
      attempts: Array.isArray(input.attempts) && input.attempts.length
        ? clone(input.attempts).slice(-32)
        : [{
          id: currentAttemptId,
          number: currentAttemptNumber,
          state,
          createdAt: safeIso(input.createdAt || input.created_at, now),
          startedAt: null,
          finishedAt: null,
          result: redactText(input.result).slice(0, 4000),
          error: redactText(input.error).slice(0, 1200),
        }],
      taskSequence: Math.max(0, Number(input.taskSequence || 0) || 0),
      progressSequence: Math.max(0, Number(input.progressSequence || 0) || 0),
      summary: redactText(input.summary || (state === 'queued' ? 'Queued' : 'Created')).slice(0, 1200),
      blocker: input.blocker && typeof input.blocker === 'object' ? clone(input.blocker) : null,
      result: redactText(input.result).slice(0, 16000),
      error: redactText(input.error).slice(0, 4000),
      requiredCapabilities: normalizeCapabilities(input.requiredCapabilities || input.capabilities),
      approvalIds: boundedArray(input.approvalIds, 32).map((item) => cleanText(item, 160)).filter(Boolean),
      latestSteer: redactText(input.latestSteer).slice(0, 4000),
      relay: input.relay && typeof input.relay === 'object' ? clone(input.relay) : {},
      review: input.review && typeof input.review === 'object' ? clone(input.review) : null,
      createdAt: safeIso(input.createdAt || input.created_at, now),
      updatedAt: safeIso(input.updatedAt || input.updated_at, now),
      startedAt: safeIso(input.startedAt, '') || null,
      finishedAt: safeIso(input.finishedAt, '') || null,
      legacySource: input.legacySource && typeof input.legacySource === 'object' ? clone(input.legacySource) : null,
      lastOperationId: cleanText(input.lastOperationId, 160),
    };
  }

  _buildEvent(snapshot, { type, resourceType, resourceId, resourceSnapshot, operationId: opId = '', actor = 'operator', payload = {}, taskSequence = 0 } = {}) {
    const sequence = (Number(snapshot.lastEventSequence || 0) || 0) + 1;
    snapshot.lastEventSequence = sequence;
    const safePayload = redactValue(payload);
    const safeResourceSnapshot = redactValue(resourceSnapshot);
    const task = resourceType === 'task' ? safeResourceSnapshot : null;
    const approval = resourceType === 'approval' ? safeResourceSnapshot : null;
    return {
      eventId: `event-${randomUUID()}`,
      eventSequence: sequence,
      taskSequence: taskSequence || undefined,
      type: cleanText(type, 120),
      resourceType: cleanText(resourceType, 40),
      resourceId: cleanText(resourceId, 200),
      operationId: cleanText(opId, 160),
      taskId: task?.id || safePayload?.taskId || '',
      threadId: task?.threadId || approval?.threadId || safePayload?.threadId || '',
      attemptId: task?.attemptId || approval?.attemptId || safePayload?.attemptId || '',
      approvalId: approval?.id || safePayload?.approvalId || '',
      actor: cleanText(actor, 120) || 'operator',
      timestamp: nowIso(),
      payload: safePayload,
      resourceSnapshot: safeResourceSnapshot,
    };
  }

  async _commit(candidate, events = []) {
    const next = normalizeSnapshot(candidate);
    next.checkpointSequence = next.lastEventSequence;
    if (events.length) {
      await appendFile(this.journalFile, `${events.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf8');
      this.events.push(...clone(events));
    }
    try {
      await writeJsonStore(this.snapshotFile, next);
    } catch (error) {
      await this._reloadFromDisk().catch(() => {});
      throw error;
    }
    this.snapshot = next;
    for (const event of events) this.emit('event', clone(event));
    return next;
  }

  async _reloadFromDisk() {
    this.ready = false;
    this.snapshot = normalizeSnapshot(await readJsonStore(this.snapshotFile, { defaultValue: DEFAULT_SNAPSHOT }));
    this.events = [];
    if (existsSync(this.journalFile)) {
      const raw = await readFile(this.journalFile, 'utf8');
      this.events = String(raw || '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
    }
    const checkpoint = Number(this.snapshot.checkpointSequence || 0) || 0;
    for (const event of this.events) if (Number(event.eventSequence || 0) > checkpoint) this._applyEvent(this.snapshot, event);
    this.ready = true;
  }

  _withMutation(operation) {
    const next = this.mutationQueue.catch(() => {}).then(async () => {
      await this.initialize();
      return operation();
    });
    this.mutationQueue = next.catch(() => {});
    return next;
  }

  _getOperation(snapshot, opId, request) {
    const existing = snapshot.operations[opId];
    if (!existing) return null;
    const requestHash = hashRequest(request);
    if (existing.requestHash !== requestHash) {
      throw new ControlPlaneError('Operation ID was already used for a different request.', 'IDEMPOTENCY_CONFLICT', 409, { operationId: opId });
    }
    return clone(existing.result);
  }

  _recordOperation(candidate, { opId, kind, targetId, request, result }) {
    const record = {
      id: opId,
      kind: cleanText(kind, 80),
      targetId: cleanText(targetId, 200),
      requestHash: hashRequest(request),
      result: clone(result),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    candidate.operations[opId] = record;
    return record;
  }

  _assertRevision(task, expectedTaskRevision) {
    if (expectedTaskRevision === undefined || expectedTaskRevision === null || expectedTaskRevision === '') return;
    const expected = Number(expectedTaskRevision);
    if (!Number.isSafeInteger(expected) || expected !== Number(task.revision || 0)) {
      throw new ControlPlaneError('Task revision is stale.', 'STALE_REVISION', 409, {
        task: clone(task),
        expectedTaskRevision,
        currentTaskRevision: task.revision,
        afterEventSequence: this.snapshot.lastEventSequence,
      });
    }
  }

  _assertApprovalRevision(approval, expectedApprovalRevision) {
    if (expectedApprovalRevision === undefined || expectedApprovalRevision === null || expectedApprovalRevision === '') return;
    const expected = Number(expectedApprovalRevision);
    if (!Number.isSafeInteger(expected) || expected !== Number(approval.revision || 0)) {
      throw new ControlPlaneError('Approval revision is stale.', 'STALE_APPROVAL_REVISION', 409, {
        approval: clone(approval),
        expectedApprovalRevision,
        currentApprovalRevision: approval.revision,
      });
    }
  }

  _getTaskOrThrow(snapshot, id) {
    const task = snapshot.tasks[cleanText(id, 200)];
    if (!task) throw new ControlPlaneError('Task not found.', 'TASK_NOT_FOUND', 404);
    return task;
  }

  _transitionTask(task, nextState) {
    const from = cleanText(task.state, 80);
    const to = cleanText(nextState, 80);
    if (from === to) return;
    if (!canTransitionTask(from, to)) {
      throw new ControlPlaneError(`Invalid task transition: ${from} -> ${to}.`, 'INVALID_TRANSITION', 409, { from, to, task: clone(task) });
    }
    task.state = to;
  }

  _touchTask(task, { operationId: opId = '', progress = false } = {}) {
    task.revision = Math.max(0, Number(task.revision || 0) || 0) + 1;
    task.taskSequence = Math.max(0, Number(task.taskSequence || 0) || 0) + 1;
    if (progress) task.progressSequence = Math.max(0, Number(task.progressSequence || 0) || 0) + 1;
    task.updatedAt = nowIso();
    if (opId) task.lastOperationId = opId;
    if (task.state === 'running' && !task.startedAt) task.startedAt = task.updatedAt;
    if (['completed', 'cancelled'].includes(task.state)) task.finishedAt = task.updatedAt;
    const attempts = Array.isArray(task.attempts) ? task.attempts : [];
    const currentAttempt = attempts.find((attempt) => attempt.id === task.attemptId);
    if (currentAttempt && task.state !== 'retrying') {
      currentAttempt.state = task.state;
      if (task.state === 'running' && !currentAttempt.startedAt) currentAttempt.startedAt = task.updatedAt;
      if (['completed', 'cancelled', 'failed'].includes(task.state)) currentAttempt.finishedAt = task.updatedAt;
      currentAttempt.result = redactText(task.result).slice(0, 4000);
      currentAttempt.error = redactText(task.error).slice(0, 1200);
    }
  }

  _appendTaskEvent(candidate, events, task, { type = '', operationId: opId = '', actor = 'operator', payload = {}, progress = false } = {}) {
    this._touchTask(task, { operationId: opId, progress });
    candidate.tasks[task.id] = task;
    events.push(this._buildEvent(candidate, {
      type: type || eventTypeForState(task.state),
      resourceType: 'task',
      resourceId: task.id,
      resourceSnapshot: safeTaskSnapshot(task),
      operationId: opId,
      actor,
      payload,
      taskSequence: task.taskSequence,
    }));
    return task;
  }

  _appendNotification(candidate, events, { task, eventType, title, body, kind = 'task' } = {}) {
    if (!task || !['task.completed', 'task.failed', 'task.blocked', 'approval.requested'].includes(eventType)) return;
    const notification = {
      id: `notification-${randomUUID()}`,
      kind,
      taskId: task.id,
      threadId: task.threadId,
      eventType,
      title: redactText(title).slice(0, 180),
      body: redactText(body).slice(0, 1200),
      read: false,
      createdAt: nowIso(),
      sourceEventSequence: candidate.lastEventSequence,
    };
    candidate.notifications[notification.id] = notification;
    events.push(this._buildEvent(candidate, {
      type: 'notification.created',
      resourceType: 'notification',
      resourceId: notification.id,
      resourceSnapshot: safeNotificationSnapshot(notification),
      operationId: task.lastOperationId,
      actor: 'control-plane',
      payload: { taskId: task.id, eventType },
    }));
  }

  async createThread({ id = '', kind = 'main', title = '', parentThreadId = '', source = 'command-center', goalId = '', operationId: op = '' } = {}) {
    const opId = operationId(op);
    const request = { id, kind, title, parentThreadId, source, goalId };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const thread = this._buildThread({ id: id || threadId(), kind, title, parentThreadId, source, goalId });
      if (candidate.threads[thread.id]) throw new ControlPlaneError('Thread already exists.', 'THREAD_EXISTS', 409);
      const event = this._buildEvent(candidate, {
        type: 'thread.created',
        resourceType: 'thread',
        resourceId: thread.id,
        resourceSnapshot: safeThreadSnapshot(thread),
        operationId: opId,
        actor: 'operator',
      });
      candidate.threads[thread.id] = thread;
      const result = { ok: true, thread: clone(thread), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'thread.create', targetId: thread.id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async getThread(id) {
    await this.initialize();
    return clone(this.snapshot.threads[cleanText(id, 200)] || null);
  }

  async listThreads({ parentThreadId = '', kind = '', limit = 100 } = {}) {
    await this.initialize();
    return Object.values(this.snapshot.threads)
      .filter((thread) => (!parentThreadId || thread.parentThreadId === parentThreadId) && (!kind || thread.kind === kind))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async appendThreadMessage(threadIdValue, { role = 'user', text = '', meta = {}, operationId: op = '' } = {}) {
    const id = cleanText(threadIdValue, 200);
    const opId = operationId(op);
    const request = { threadId: id, role, text, meta };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const thread = candidate.threads[id];
      if (!thread) throw new ControlPlaneError('Thread not found.', 'THREAD_NOT_FOUND', 404);
      const message = {
        id: `thread-message-${randomUUID()}`,
        role: cleanText(role, 32) || 'user',
        text: redactText(text).slice(0, MAX_TEXT),
        meta: redactValue(meta && typeof meta === 'object' ? meta : {}),
        createdAt: nowIso(),
      };
      thread.messages = [...(Array.isArray(thread.messages) ? thread.messages : []), message].slice(-400);
      thread.messageCount = thread.messages.length;
      thread.updatedAt = message.createdAt;
      const event = this._buildEvent(candidate, {
        type: 'thread.message',
        resourceType: 'thread',
        resourceId: thread.id,
        resourceSnapshot: safeThreadSnapshot(thread),
        operationId: opId,
        actor: 'operator',
        payload: { messageId: message.id, role: message.role },
      });
      candidate.threads[id] = thread;
      const result = { ok: true, thread: clone(thread), message: clone(message), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'thread.message', targetId: id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async forkThread(parentIdValue, { messageId = '', title = '', operationId: op = '' } = {}) {
    const parentId = cleanText(parentIdValue, 200);
    const opId = operationId(op);
    const request = { parentThreadId: parentId, messageId, title };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const parent = candidate.threads[parentId];
      if (!parent) throw new ControlPlaneError('Thread not found.', 'THREAD_NOT_FOUND', 404);
      const index = messageId ? parent.messages.findIndex((item) => item.id === messageId) : parent.messages.length - 1;
      if (messageId && index < 0) throw new ControlPlaneError('Thread message not found.', 'MESSAGE_NOT_FOUND', 404);
      const thread = this._buildThread({
        kind: 'fork',
        title: title || `Fork of ${parent.title}`,
        parentThreadId: parent.id,
        source: 'control-plane.fork',
        goalId: parent.goalId,
      });
      thread.messages = clone((parent.messages || []).slice(0, Math.max(0, index + 1)));
      thread.messageCount = thread.messages.length;
      candidate.threads[thread.id] = thread;
      const event = this._buildEvent(candidate, {
        type: 'thread.forked',
        resourceType: 'thread',
        resourceId: thread.id,
        resourceSnapshot: safeThreadSnapshot(thread),
        operationId: opId,
        actor: 'operator',
        payload: { parentThreadId: parent.id, messageId },
      });
      const result = { ok: true, thread: clone(thread), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'thread.fork', targetId: thread.id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async compactThread(threadIdValue, { summary = '', operationId: op = '' } = {}) {
    const id = cleanText(threadIdValue, 200);
    const opId = operationId(op);
    const request = { threadId: id, summary };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const thread = candidate.threads[id];
      if (!thread) throw new ControlPlaneError('Thread not found.', 'THREAD_NOT_FOUND', 404);
      thread.contextSummary = redactText(summary).slice(0, 12000);
      thread.compactVersion = Number(thread.compactVersion || 0) + 1;
      thread.updatedAt = nowIso();
      const event = this._buildEvent(candidate, {
        type: 'thread.compacted',
        resourceType: 'thread',
        resourceId: thread.id,
        resourceSnapshot: safeThreadSnapshot(thread),
        operationId: opId,
        actor: 'operator',
        payload: { compactVersion: thread.compactVersion },
      });
      candidate.threads[id] = thread;
      const result = { ok: true, thread: clone(thread), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'thread.compact', targetId: id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  _buildGoal({ id = '', title = '', prompt = '', state = 'active', owner = 'operator', threadId: requestedThreadId = '' } = {}) {
    const now = nowIso();
    return {
      id: cleanText(id, 160) || `goal-${randomUUID()}`,
      title: cleanText(title, 200) || 'Command Center goal',
      prompt: redactText(prompt).slice(0, 12000),
      state: ['active', 'paused', 'completed', 'cancelled'].includes(cleanText(state, 40)) ? cleanText(state, 40) : 'active',
      owner: cleanText(owner, 120) || 'operator',
      threadId: cleanText(requestedThreadId, 160),
      taskIds: [],
      createdAt: now,
      updatedAt: now,
    };
  }

  _buildPlan({ id = '', title = '', goalId = '', threadId: requestedThreadId = '', steps = [] } = {}) {
    const now = nowIso();
    return {
      id: cleanText(id, 160) || `plan-${randomUUID()}`,
      title: cleanText(title, 200) || 'Command Center plan',
      goalId: cleanText(goalId, 160),
      threadId: cleanText(requestedThreadId, 160),
      state: 'draft',
      steps: boundedArray(steps, 64).map((step, index) => ({
        id: cleanText(step?.id, 160) || `step-${index + 1}`,
        title: cleanText(step?.title || step, 240),
        state: cleanText(step?.state, 40) || 'pending',
        taskId: cleanText(step?.taskId, 160),
      })),
      createdAt: now,
      updatedAt: now,
    };
  }

  async createGoal({ id = '', title = '', prompt = '', state = 'active', owner = 'operator', threadId: requestedThreadId = '', operationId: op = '' } = {}) {
    const opId = operationId(op);
    const request = { id, title, prompt, state, owner, threadId: requestedThreadId };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const goal = this._buildGoal({ id, title, prompt, state, owner, threadId: requestedThreadId });
      if (candidate.goals[goal.id]) throw new ControlPlaneError('Goal already exists.', 'GOAL_EXISTS', 409);
      candidate.goals[goal.id] = goal;
      const event = this._buildEvent(candidate, {
        type: 'goal.created',
        resourceType: 'goal',
        resourceId: goal.id,
        resourceSnapshot: safeGoalSnapshot(goal),
        operationId: opId,
        actor: owner,
      });
      const result = { ok: true, goal: clone(goal), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'goal.create', targetId: goal.id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId],
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async listGoals({ state = '', limit = 100 } = {}) {
    await this.initialize();
    return Object.values(this.snapshot.goals)
      .filter((goal) => !state || goal.state === state)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async createPlan({ id = '', title = '', goalId = '', threadId: requestedThreadId = '', steps = [], operationId: op = '' } = {}) {
    const opId = operationId(op);
    const request = { id, title, goalId, threadId: requestedThreadId, steps };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const plan = this._buildPlan({ id, title, goalId, threadId: requestedThreadId, steps });
      if (candidate.plans[plan.id]) throw new ControlPlaneError('Plan already exists.', 'PLAN_EXISTS', 409);
      candidate.plans[plan.id] = plan;
      const event = this._buildEvent(candidate, {
        type: 'plan.created',
        resourceType: 'plan',
        resourceId: plan.id,
        resourceSnapshot: safePlanSnapshot(plan),
        operationId: opId,
        actor: 'operator',
      });
      const result = { ok: true, plan: clone(plan), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'plan.create', targetId: plan.id, request, result });
      const operationEvent = this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId],
        operationId: opId,
        actor: 'control-plane',
      });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async listPlans({ goalId = '', limit = 100 } = {}) {
    await this.initialize();
    return Object.values(this.snapshot.plans)
      .filter((plan) => !goalId || plan.goalId === goalId)
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async createTask({ id = '', threadId: requestedThreadId = '', title = '', prompt = '', summary = '', agent = 'orchestrator', runtime = '', parentTaskId = '', goalId = '', planId = '', target = {}, capabilities = [], requiredCapabilities = [], autoQueue = true, operationId: op = '', legacySource = null } = {}) {
    const opId = operationId(op);
    const request = { id, threadId: requestedThreadId, title, prompt, summary, agent, runtime, parentTaskId, goalId, planId, target, capabilities, requiredCapabilities, autoQueue, legacySource };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const taskIdentifier = taskId(id);
      if (candidate.tasks[taskIdentifier]) throw new ControlPlaneError('Task already exists.', 'TASK_EXISTS', 409);
      const events = [];
      const requestedThread = cleanText(requestedThreadId, 200);
      const thread = candidate.threads[requestedThread] || this._buildThread({
        id: requestedThread || `thread:task:${taskIdentifier}`,
        kind: 'task',
        title: title || 'Task thread',
        source: 'control-plane.task',
        goalId,
      });
      if (!candidate.threads[thread.id]) {
        candidate.threads[thread.id] = thread;
        events.push(this._buildEvent(candidate, {
          type: 'thread.created',
          resourceType: 'thread',
          resourceId: thread.id,
          resourceSnapshot: safeThreadSnapshot(thread),
          operationId: opId,
          actor: 'operator',
        }));
      }
      const taskCapabilities = normalizeCapabilities([...capabilities, ...requiredCapabilities]);
      const approvalCapability = taskCapabilities.find((capability) => RISKY_TASK_CAPABILITIES.has(capability));
      const task = this._buildTask({
        id: taskIdentifier,
        threadId: thread.id,
        title,
        prompt,
        summary: summary || 'Created',
        agent,
        runtime,
        parentTaskId,
        goalId,
        planId,
        target,
        capabilities: taskCapabilities,
        state: 'created',
        attemptNumber: 1,
        legacySource,
      });
      this._appendTaskEvent(candidate, events, task, { type: 'task.created', operationId: opId, actor: 'operator', payload: { source: 'control-plane' } });
      let createdApproval = null;
      if (approvalCapability) {
        const approval = {
          id: approvalId(),
          taskId: task.id,
          threadId: task.threadId,
          attemptId: task.attemptId,
          capability: approvalCapability,
          summary: `Approval required before using ${approvalCapability}.`,
          state: 'pending',
          revision: 1,
          createdAt: nowIso(),
          expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          decidedAt: null,
          decidedBy: '',
          operationId: opId,
        };
        createdApproval = approval;
        candidate.approvals[approval.id] = approval;
        task.approvalIds = [approval.id];
        this._transitionTask(task, 'waiting_for_approval');
        this._appendTaskEvent(candidate, events, task, { type: 'approval.requested', operationId: opId, actor: 'operator', payload: { approvalId: approval.id, capability: approvalCapability } });
        events.push(this._buildEvent(candidate, { type: 'approval.requested', resourceType: 'approval', resourceId: approval.id, resourceSnapshot: safeApprovalSnapshot(approval), operationId: opId, actor: 'operator', payload: { taskId: task.id } }));
        this._appendNotification(candidate, events, { task, eventType: 'approval.requested', title: `Approval needed: ${approvalCapability}`, body: approval.summary, kind: 'approval' });
      } else if (autoQueue) {
        this._transitionTask(task, 'queued');
        this._appendTaskEvent(candidate, events, task, { type: 'task.queued', operationId: opId, actor: 'operator', payload: { source: 'control-plane' } });
      }
      candidate.tasks[task.id] = task;
      const result = { ok: true, task: clone(task), ...(createdApproval ? { approval: clone(createdApproval) } : {}), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.create', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async getTask(id) {
    await this.initialize();
    return clone(this.snapshot.tasks[cleanText(id, 200)] || null);
  }

  async listTasks({ threadId: requestedThreadId = '', agent = '', state = '', limit = 100 } = {}) {
    await this.initialize();
    return Object.values(this.snapshot.tasks)
      .filter((task) => (!requestedThreadId || task.threadId === requestedThreadId) && (!agent || task.agent === agent) && (!state || task.state === state))
      .sort((a, b) => Date.parse(b.updatedAt || 0) - Date.parse(a.updatedAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async updateTask(id, patch = {}, { operationId: op = '', expectedTaskRevision, expectedAttemptId = '', expectedProgressSequence, actor = 'runtime', source = 'runtime' } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, patch, expectedTaskRevision, expectedAttemptId, expectedProgressSequence, source };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      if (CONTROL_TERMINAL_STATES.includes(task.state)) {
        throw new ControlPlaneError('Terminal task snapshots are immutable.', 'TASK_TERMINAL', 409, { task: clone(task) });
      }
      this._assertRevision(task, expectedTaskRevision);
      if (expectedAttemptId && cleanText(expectedAttemptId, 160) !== cleanText(task.attemptId, 160)) {
        throw new ControlPlaneError('Runtime callback belongs to a stale attempt.', 'STALE_ATTEMPT', 409, { task: clone(task), expectedAttemptId, currentAttemptId: task.attemptId });
      }
      if (expectedProgressSequence !== undefined && Number(expectedProgressSequence) <= Number(task.progressSequence || 0)) {
        throw new ControlPlaneError('Runtime progress event is stale or duplicated.', 'STALE_EVENT', 409, { task: clone(task), expectedProgressSequence, currentProgressSequence: task.progressSequence });
      }
      const priorState = task.state;
      const requestedState = patch.state || (patch.status ? taskStateFromLegacy(patch.status) : '');
      if (requestedState && requestedState !== priorState) this._transitionTask(task, requestedState);
      const allowed = ['title', 'prompt', 'summary', 'result', 'error', 'runtime', 'agent', 'target', 'blocker', 'relay', 'review', 'latestSteer', 'requiredCapabilities', 'approvalIds'];
      for (const key of allowed) {
        if (patch[key] === undefined) continue;
        if (key === 'requiredCapabilities' || key === 'approvalIds') task[key] = key === 'requiredCapabilities' ? normalizeCapabilities(patch[key]) : boundedArray(patch[key], 32).map((item) => cleanText(item, 160)).filter(Boolean);
        else if (['summary', 'result', 'error', 'prompt', 'latestSteer'].includes(key)) task[key] = redactText(patch[key]).slice(0, key === 'error' ? 4000 : 16000);
        else task[key] = clone(patch[key]);
      }
      if (task.state === 'blocked' && patch.blocker === undefined && patch.status === 'needs_input') {
        task.blocker = { type: 'needs_input', message: task.summary || 'Task needs more input.' };
      }
      const eventType = requestedState && requestedState !== priorState ? eventTypeForState(task.state, priorState) : 'task.progress';
      const eventPayload = { source, fields: Object.keys(patch).filter((key) => key !== 'prompt' && key !== 'result') };
      const events = [];
      this._appendTaskEvent(candidate, events, task, { type: eventType, operationId: opId, actor, payload: eventPayload, progress: eventType === 'task.progress' });
      candidate.tasks[task.id] = task;
      this._appendNotification(candidate, events, { task, eventType, title: task.title, body: task.summary || task.error || task.result });
      const result = { ok: true, task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.update', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, {
        type: 'operation.accepted',
        resourceType: 'operation',
        resourceId: opId,
        resourceSnapshot: candidate.operations[opId] || { id: opId },
        operationId: opId,
        actor: 'control-plane',
      }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async queueTask(id, { title = '', prompt = '', followUp = false, operationId: op = '', expectedTaskRevision, agent = '', runtime = '' } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, title, prompt, followUp, agent, runtime, expectedTaskRevision };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const parent = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(parent, expectedTaskRevision);
      const events = [];
      if (followUp || parent.state === 'running') {
        const child = this._buildTask({
          title: title || 'Queued follow-up',
          prompt: prompt || 'Continue the task with the latest direction.',
          summary: 'Queued behind the active task.',
          agent: agent || parent.agent,
          runtime: runtime || parent.runtime,
          threadId: parent.threadId,
          parentTaskId: parent.id,
          goalId: parent.goalId,
          planId: parent.planId,
          target: parent.target,
          state: 'created',
          attemptNumber: 1,
        });
        this._appendTaskEvent(candidate, events, child, { type: 'task.created', operationId: opId, actor: 'operator', payload: { queuedBehind: parent.id } });
        this._transitionTask(child, 'queued');
        this._appendTaskEvent(candidate, events, child, { type: 'task.queued', operationId: opId, actor: 'operator', payload: { queuedBehind: parent.id } });
        candidate.tasks[child.id] = child;
        const result = { ok: true, task: clone(parent), childTask: clone(child), eventSequence: candidate.lastEventSequence };
        this._recordOperation(candidate, { opId, kind: 'task.queue.follow-up', targetId: parent.id, request, result });
        events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
        await this._commit(candidate, events);
        return result;
      }
      if (!['created', 'blocked', 'retrying'].includes(parent.state)) {
        throw new ControlPlaneError('Task cannot be queued in its current state.', 'INVALID_TRANSITION', 409, { task: clone(parent) });
      }
      this._transitionTask(parent, 'queued');
      this._appendTaskEvent(candidate, events, parent, { type: 'task.queued', operationId: opId, actor: 'operator', payload: { source: 'queue' } });
      candidate.tasks[parent.id] = parent;
      const result = { ok: true, task: clone(parent), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.queue', targetId: parent.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async steerTask(id, guidance, { operationId: op = '', expectedTaskRevision, actor = 'operator', runtimeAccepted = true } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const text = redactText(guidance).slice(0, 4000);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, guidance: text, expectedTaskRevision };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(task, expectedTaskRevision);
      if (!['queued', 'running', 'waiting_for_approval', 'blocked'].includes(task.state)) {
        throw new ControlPlaneError('Task cannot be steered in its current state.', 'INVALID_TRANSITION', 409, { task: clone(task) });
      }
      if (!runtimeAccepted && task.state === 'running') throw new ControlPlaneError('The active runtime does not support steering.', 'STEER_UNSUPPORTED', 409, { task: clone(task) });
      task.latestSteer = text;
      task.summary = `Steered: ${text}`.slice(0, 1200);
      const events = [];
      this._appendTaskEvent(candidate, events, task, { type: 'task.steered', operationId: opId, actor, payload: { guidance: text } });
      candidate.tasks[task.id] = task;
      const result = { ok: true, task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.steer', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async requestCancel(id, { operationId: op = '', expectedTaskRevision, actor = 'operator', immediate = false } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, expectedTaskRevision, immediate };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(task, expectedTaskRevision);
      if (['completed', 'cancelled'].includes(task.state)) throw new ControlPlaneError('Task is already terminal.', 'TASK_TERMINAL', 409, { task: clone(task) });
      const priorState = task.state;
      const events = [];
      if (task.state !== 'cancelling') {
        this._transitionTask(task, 'cancelling');
        this._appendTaskEvent(candidate, events, task, { type: 'task.cancel_requested', operationId: opId, actor, payload: { immediate } });
      }
      if (immediate || ['created', 'queued', 'waiting_for_approval', 'blocked', 'retrying'].includes(priorState)) {
        this._transitionTask(task, 'cancelled');
        this._appendTaskEvent(candidate, events, task, { type: 'task.cancelled', operationId: opId, actor, payload: { immediate: true } });
      }
      candidate.tasks[task.id] = task;
      this._appendNotification(candidate, events, { task, eventType: task.state === 'cancelled' ? 'task.cancelled' : 'task.cancel_requested', title: task.title, body: 'Cancellation requested.' });
      const result = { ok: true, task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.cancel', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async acknowledgeCancel(id, { operationId: op = '', actor = 'runtime', expectedTaskRevision } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const opId = operationId(op || `cancel-ack:${taskIdentifier}`);
    const request = { taskId: taskIdentifier, expectedTaskRevision };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(task, expectedTaskRevision);
      if (task.state === 'cancelled') return { ok: true, task: clone(task), alreadyCancelled: true, eventSequence: candidate.lastEventSequence };
      if (task.state !== 'cancelling') throw new ControlPlaneError('Task is not cancelling.', 'INVALID_TRANSITION', 409, { task: clone(task) });
      const events = [];
      this._transitionTask(task, 'cancelled');
      this._appendTaskEvent(candidate, events, task, { type: 'task.cancelled', operationId: opId, actor, payload: { acknowledged: true } });
      candidate.tasks[task.id] = task;
      const result = { ok: true, task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.cancel.ack', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async retryTask(id, { operationId: op = '', expectedTaskRevision, actor = 'operator' } = {}) {
    const taskIdentifier = cleanText(id, 200);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, expectedTaskRevision };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(task, expectedTaskRevision);
      if (task.state !== 'failed') throw new ControlPlaneError('Only failed tasks can be retried.', 'INVALID_TRANSITION', 409, { task: clone(task) });
      const events = [];
      const previousAttemptId = task.attemptId;
      this._transitionTask(task, 'retrying');
      task.attemptNumber = Number(task.attemptNumber || 0) + 1;
      task.attemptId = attemptId();
      task.error = '';
      task.result = '';
      task.blocker = null;
      task.attempts = [...(Array.isArray(task.attempts) ? task.attempts : []), {
        id: task.attemptId,
        number: task.attemptNumber,
        state: 'retrying',
        createdAt: nowIso(),
        startedAt: null,
        finishedAt: null,
        result: '',
        error: '',
      }].slice(-32);
      this._appendTaskEvent(candidate, events, task, { type: 'task.retrying', operationId: opId, actor, payload: { previousAttemptId } });
      this._transitionTask(task, 'queued');
      this._appendTaskEvent(candidate, events, task, { type: 'task.queued', operationId: opId, actor, payload: { retry: true } });
      candidate.tasks[task.id] = task;
      const result = { ok: true, task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'task.retry', targetId: task.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async requestApproval(taskIdValue, { capability = '', summary = '', expiresAt = '', operationId: op = '', actor = 'runtime', expectedTaskRevision } = {}) {
    const taskIdentifier = cleanText(taskIdValue, 200);
    const opId = operationId(op);
    const request = { taskId: taskIdentifier, capability, summary, expiresAt, expectedTaskRevision };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const task = this._getTaskOrThrow(candidate, taskIdentifier);
      this._assertRevision(task, expectedTaskRevision);
      if (!['created', 'queued', 'running', 'blocked'].includes(task.state)) throw new ControlPlaneError('Task cannot request approval in its current state.', 'TASK_NOT_APPROVABLE', 409, { task: clone(task) });
      const approval = {
        id: approvalId(),
        taskId: task.id,
        threadId: task.threadId,
        attemptId: task.attemptId,
        capability: cleanText(capability, 120),
        summary: redactText(summary).slice(0, 1200),
        state: 'pending',
        revision: 1,
        createdAt: nowIso(),
        expiresAt: safeIso(expiresAt, new Date(Date.now() + 5 * 60 * 1000).toISOString()),
        decidedAt: null,
        decidedBy: '',
        operationId: opId,
      };
      const events = [];
      candidate.approvals[approval.id] = approval;
      if (task.state !== 'waiting_for_approval') this._transitionTask(task, 'waiting_for_approval');
      task.approvalIds = Array.from(new Set([...(task.approvalIds || []), approval.id]));
      this._appendTaskEvent(candidate, events, task, { type: 'approval.requested', operationId: opId, actor, payload: { approvalId: approval.id, capability: approval.capability } });
      events.push(this._buildEvent(candidate, { type: 'approval.requested', resourceType: 'approval', resourceId: approval.id, resourceSnapshot: safeApprovalSnapshot(approval), operationId: opId, actor, payload: { taskId: task.id } }));
      candidate.tasks[task.id] = task;
      this._appendNotification(candidate, events, { task, eventType: 'approval.requested', title: `Approval needed: ${approval.capability}`, body: approval.summary, kind: 'approval' });
      const result = { ok: true, task: clone(task), approval: clone(approval), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: 'approval.request', targetId: approval.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async decideApproval(id, decision, { operationId: op = '', expectedApprovalRevision, actor = 'operator', allowExpired = false } = {}) {
    const approvalIdentifier = cleanText(id, 200);
    const normalizedDecision = cleanText(decision, 32).toLowerCase();
    const opId = operationId(op);
    const request = { approvalId: approvalIdentifier, decision: normalizedDecision, expectedApprovalRevision, allowExpired };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const approval = candidate.approvals[approvalIdentifier];
      if (!approval) throw new ControlPlaneError('Approval not found.', 'APPROVAL_NOT_FOUND', 404);
      this._assertApprovalRevision(approval, expectedApprovalRevision);
      if (!['approved', 'denied'].includes(normalizedDecision)) throw new ControlPlaneError('Approval decision must be approved or denied.', 'INVALID_APPROVAL_DECISION', 400);
      if (approval.state !== 'pending') throw new ControlPlaneError('Approval has already been decided.', 'APPROVAL_ALREADY_DECIDED', 409, { approval: clone(approval) });
      const expired = Date.parse(approval.expiresAt || '') <= Date.now();
      if (expired && !allowExpired) throw new ControlPlaneError('Approval has expired.', 'APPROVAL_EXPIRED', 409, { approval: clone(approval) });
      const task = this._getTaskOrThrow(candidate, approval.taskId);
      if (['completed', 'cancelled', 'cancelling'].includes(task.state)) throw new ControlPlaneError('Task is no longer approvable.', 'TASK_NOT_APPROVABLE', 409, { task: clone(task), approval: clone(approval) });
      const events = [];
      approval.state = expired ? 'expired' : normalizedDecision;
      approval.revision = Number(approval.revision || 0) + 1;
      approval.decidedAt = nowIso();
      approval.decidedBy = cleanText(actor, 120);
      candidate.approvals[approval.id] = approval;
      const nextState = normalizedDecision === 'approved' ? 'queued' : 'blocked';
      this._transitionTask(task, nextState);
      task.blocker = normalizedDecision === 'denied' ? { type: expired ? 'approval_expired' : 'approval_denied', approvalId: approval.id, message: approval.summary } : null;
      this._appendTaskEvent(candidate, events, task, { type: `approval.${normalizedDecision}`, operationId: opId, actor, payload: { approvalId: approval.id, capability: approval.capability, expired } });
      events.push(this._buildEvent(candidate, { type: `approval.${normalizedDecision}`, resourceType: 'approval', resourceId: approval.id, resourceSnapshot: safeApprovalSnapshot(approval), operationId: opId, actor, payload: { taskId: task.id, expired } }));
      candidate.tasks[task.id] = task;
      const result = { ok: true, approval: clone(approval), task: clone(task), eventSequence: candidate.lastEventSequence };
      this._recordOperation(candidate, { opId, kind: `approval.${normalizedDecision}`, targetId: approval.id, request, result });
      events.push(this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' }));
      await this._commit(candidate, events);
      return result;
    });
  }

  async expireApprovals() {
    await this.initialize();
    const pending = Object.values(this.snapshot.approvals).filter((approval) => approval.state === 'pending' && Date.parse(approval.expiresAt || '') <= Date.now());
    const results = [];
    for (const approval of pending) {
      try { results.push(await this.decideApproval(approval.id, 'denied', { operationId: `approval-expire:${approval.id}:${approval.revision}`, actor: 'control-plane-expiry', allowExpired: true })); } catch {}
    }
    return results;
  }

  async listApprovals({ state = '', taskId: requestedTaskId = '', limit = 100 } = {}) {
    await this.initialize();
    return Object.values(this.snapshot.approvals)
      .filter((approval) => (!state || approval.state === state) && (!requestedTaskId || approval.taskId === requestedTaskId))
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async updateTaskReview(id, review = {}, { operationId: op = '', expectedTaskRevision, actor = 'operator' } = {}) {
    return this.updateTask(id, { review: clone(review) }, { operationId: op, expectedTaskRevision, actor, source: 'review' });
  }

  async listEvents({ afterEventSequence = 0, taskId: requestedTaskId = '', threadId: requestedThreadId = '', limit = 500 } = {}) {
    await this.initialize();
    const after = Number(afterEventSequence || 0) || 0;
    return this.events
      .filter((event) => Number(event.eventSequence || 0) > after)
      .filter((event) => (!requestedTaskId || event.resourceId === requestedTaskId || event.payload?.taskId === requestedTaskId) && (!requestedThreadId || event.resourceSnapshot?.threadId === requestedThreadId || event.payload?.threadId === requestedThreadId))
      .slice(0, Math.max(1, Math.min(2000, Number(limit) || 500)))
      .map(clone);
  }

  async listNotifications({ unreadOnly = false, afterEventSequence = 0, limit = 100 } = {}) {
    await this.initialize();
    const after = Number(afterEventSequence || 0) || 0;
    return Object.values(this.snapshot.notifications)
      .filter((notification) => (!unreadOnly || notification.read !== true) && (!after || Number(notification.sourceEventSequence || 0) > after))
      .sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0))
      .slice(0, Math.max(1, Math.min(500, Number(limit) || 100)))
      .map(clone);
  }

  async markNotificationRead(id, { operationId: op = '', actor = 'operator' } = {}) {
    const notificationIdentifier = cleanText(id, 200);
    const opId = operationId(op);
    const request = { notificationId: notificationIdentifier };
    return this._withMutation(async () => {
      const prior = this._getOperation(this.snapshot, opId, request);
      if (prior) return prior;
      const candidate = clone(this.snapshot);
      const notification = candidate.notifications[notificationIdentifier];
      if (!notification) throw new ControlPlaneError('Notification not found.', 'NOTIFICATION_NOT_FOUND', 404);
      notification.read = true;
      notification.readAt = nowIso();
      const event = this._buildEvent(candidate, { type: 'notification.read', resourceType: 'notification', resourceId: notification.id, resourceSnapshot: safeNotificationSnapshot(notification), operationId: opId, actor });
      candidate.notifications[notification.id] = notification;
      const result = { ok: true, notification: clone(notification), eventSequence: event.eventSequence };
      this._recordOperation(candidate, { opId, kind: 'notification.read', targetId: notification.id, request, result });
      const operationEvent = this._buildEvent(candidate, { type: 'operation.accepted', resourceType: 'operation', resourceId: opId, resourceSnapshot: candidate.operations[opId], operationId: opId, actor: 'control-plane' });
      await this._commit(candidate, [event, operationEvent]);
      return result;
    });
  }

  async status() {
    await this.initialize();
    const tasks = Object.values(this.snapshot.tasks);
    return {
      ok: true,
      eventSequence: this.snapshot.lastEventSequence,
      taskCount: tasks.length,
      activeTaskCount: tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(task.state)).length,
      pendingApprovalCount: Object.values(this.snapshot.approvals).filter((approval) => approval.state === 'pending').length,
      unreadNotificationCount: Object.values(this.snapshot.notifications).filter((notification) => notification.read !== true).length,
      checkpointSequence: this.snapshot.checkpointSequence,
    };
  }
}

export const controlPlane = new ControlPlane();

export async function initializeControlPlane() {
  return controlPlane.initialize();
}

export { legacyStatusForTask, taskStateFromLegacy };
