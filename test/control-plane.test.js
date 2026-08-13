import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  CONTROL_TASK_TRANSITIONS,
  ControlPlane,
  ControlPlaneError,
  canTransitionTask,
} from '../server/control-plane.js';

async function makePlane({ legacy = null } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'commandcenter-control-test-'));
  const legacyFile = join(dataDir, 'live-tasks.v1.json');
  if (legacy) await writeFile(legacyFile, JSON.stringify(legacy), 'utf8');
  const plane = new ControlPlane({ dataDir, legacyFile });
  await plane.initialize();
  return { plane, dataDir };
}

async function expectCode(operation, code) {
  await assert.rejects(operation, (error) => error instanceof ControlPlaneError && error.code === code);
}

test('control task transition table accepts only legal transitions and terminal states are immutable', () => {
  for (const [from, nextStates] of Object.entries(CONTROL_TASK_TRANSITIONS)) {
    for (const to of Object.keys(CONTROL_TASK_TRANSITIONS)) assert.equal(canTransitionTask(from, to), nextStates.includes(to), `${from} -> ${to}`);
  }
  assert.equal(canTransitionTask('completed', 'running'), false);
  assert.equal(canTransitionTask('cancelled', 'completed'), false);
});

test('control mutations are idempotent, revision-aware, and operation-conflict safe', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await plane.createTask({ id: 'task-idempotent', title: 'Idempotent', prompt: 'work', operationId: 'op-create' });
  const duplicate = await plane.createTask({ id: 'task-idempotent', title: 'Idempotent', prompt: 'work', operationId: 'op-create' });
  assert.deepEqual(duplicate.task, created.task);
  await expectCode(() => plane.createTask({ id: 'other', title: 'Different', prompt: 'different', operationId: 'op-create' }), 'IDEMPOTENCY_CONFLICT');
  await expectCode(() => plane.updateTask(created.task.id, { summary: 'stale' }, { operationId: 'op-stale', expectedTaskRevision: created.task.revision - 1 }), 'STALE_REVISION');
  const updated = await plane.updateTask(created.task.id, { summary: 'fresh' }, { operationId: 'op-update', expectedTaskRevision: created.task.revision });
  assert.equal(updated.task.revision, created.task.revision + 1);
  const duplicateUpdate = await plane.updateTask(created.task.id, { summary: 'fresh' }, { operationId: 'op-update', expectedTaskRevision: created.task.revision });
  assert.deepEqual(duplicateUpdate.task, updated.task);
});

test('Queue, Steer, and Cancel races serialize without reviving a task', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await plane.createTask({ id: 'task-race', prompt: 'race', operationId: 'race-create' });
  const results = await Promise.allSettled([
    plane.steerTask(created.task.id, 'change direction', { operationId: 'race-steer', expectedTaskRevision: created.task.revision }),
    plane.requestCancel(created.task.id, { operationId: 'race-cancel', expectedTaskRevision: created.task.revision }),
  ]);
  const accepted = results.filter((result) => result.status === 'fulfilled');
  assert.equal(accepted.length, 1);
  const current = await plane.getTask(created.task.id);
  assert.ok(['queued', 'cancelling', 'cancelled'].includes(current.state));
  await expectCode(() => plane.updateTask(current.id, { state: 'completed' }, { operationId: 'race-late-complete', expectedTaskRevision: current.revision }), 'INVALID_TRANSITION');
});

test('cancellation acknowledgement timeout is represented as a failed task, never a silent resume', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await plane.createTask({ id: 'task-cancel-timeout', prompt: 'cancel timeout', operationId: 'cancel-timeout-create' });
  const running = await plane.updateTask(created.task.id, { state: 'running' }, { operationId: 'cancel-timeout-start', expectedTaskRevision: created.task.revision });
  const cancelling = await plane.requestCancel(created.task.id, { operationId: 'cancel-timeout-request', expectedTaskRevision: running.task.revision });
  assert.equal(cancelling.task.state, 'cancelling');
  const failed = await plane.updateTask(created.task.id, { state: 'failed', summary: 'Cancellation failed.', error: 'CANCEL_FAILED' }, { operationId: 'cancel-timeout-failed', expectedTaskRevision: cancelling.task.revision, expectedAttemptId: cancelling.task.attemptId });
  assert.equal(failed.task.state, 'failed');
  assert.equal(failed.task.error, 'CANCEL_FAILED');
});

test('approval responses after cancellation/completion are rejected and expiry blocks deterministically', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const cancelled = await plane.createTask({ id: 'task-approval-cancel', prompt: 'cancel', operationId: 'approval-cancel-create' });
  const approval = await plane.requestApproval(cancelled.task.id, { capability: 'file.write', summary: 'write a file', operationId: 'approval-cancel-request', expectedTaskRevision: cancelled.task.revision });
  const cancelledResult = await plane.requestCancel(cancelled.task.id, { operationId: 'approval-cancel', expectedTaskRevision: approval.task.revision });
  assert.equal(cancelledResult.task.state, 'cancelled');
  await expectCode(() => plane.decideApproval(approval.approval.id, 'approved', { operationId: 'approval-after-cancel' }), 'TASK_NOT_APPROVABLE');

  const completed = await plane.createTask({ id: 'task-approval-complete', prompt: 'complete', operationId: 'approval-complete-create' });
  const completedRunning = await plane.updateTask(completed.task.id, { state: 'running' }, { operationId: 'approval-complete-start', expectedTaskRevision: completed.task.revision });
  const completedResult = await plane.updateTask(completed.task.id, { state: 'completed', result: 'done' }, { operationId: 'approval-complete-finish', expectedTaskRevision: completedRunning.task.revision, expectedAttemptId: completedRunning.task.attemptId });
  await expectCode(() => plane.updateTask(completed.task.id, { summary: 'late mutation' }, { operationId: 'terminal-mutation', expectedTaskRevision: completedResult.task.revision }), 'TASK_TERMINAL');
  await expectCode(() => plane.requestApproval(completed.task.id, { capability: 'file.write', summary: 'late', operationId: 'approval-after-complete', expectedTaskRevision: completedResult.task.revision }), 'TASK_NOT_APPROVABLE');

  const expiring = await plane.createTask({ id: 'task-approval-expire', prompt: 'expire', operationId: 'approval-expire-create' });
  const expiringApproval = await plane.requestApproval(expiring.task.id, { capability: 'network.request', summary: 'network', expiresAt: new Date(Date.now() - 1000).toISOString(), operationId: 'approval-expire-request', expectedTaskRevision: expiring.task.revision });
  const expired = (await plane.expireApprovals()).find((result) => result.approval.id === expiringApproval.approval.id);
  assert.equal(expired.approval.state, 'expired');
  assert.equal(expired.task.state, 'blocked');
  await expectCode(() => plane.decideApproval(expiringApproval.approval.id, 'approved', { operationId: 'approval-expired-response' }), 'APPROVAL_ALREADY_DECIDED');
});

test('retry creates a new auditable attempt without duplicating the prior operation', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await plane.createTask({ id: 'task-retry', prompt: 'retry', operationId: 'retry-create' });
  const running = await plane.updateTask(created.task.id, { state: 'running' }, { operationId: 'retry-start', expectedTaskRevision: created.task.revision });
  const failed = await plane.updateTask(created.task.id, { state: 'failed', error: 'first attempt failed' }, { operationId: 'retry-fail', expectedTaskRevision: running.task.revision, expectedAttemptId: running.task.attemptId });
  const retried = await plane.retryTask(created.task.id, { operationId: 'retry-once', expectedTaskRevision: failed.task.revision });
  const duplicate = await plane.retryTask(created.task.id, { operationId: 'retry-once', expectedTaskRevision: failed.task.revision });
  assert.deepEqual(duplicate.task, retried.task);
  assert.notEqual(retried.task.attemptId, failed.task.attemptId);
  assert.equal(retried.task.attempts.length, 2);
  await expectCode(() => plane.updateTask(created.task.id, { state: 'completed' }, { operationId: 'retry-terminal-race', expectedTaskRevision: retried.task.revision, expectedAttemptId: failed.task.attemptId }), 'STALE_ATTEMPT');
});

test('journal replay preserves event ordering and reconstructs missed notifications', async (t) => {
  const { plane, dataDir } = await makePlane();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await plane.createTask({ id: 'task-journal', prompt: 'journal', operationId: 'journal-create' });
  const running = await plane.updateTask(created.task.id, { state: 'running' }, { operationId: 'journal-start', expectedTaskRevision: created.task.revision });
  await plane.updateTask(created.task.id, { state: 'completed', result: 'done' }, { operationId: 'journal-complete', expectedTaskRevision: running.task.revision, expectedAttemptId: running.task.attemptId });
  const all = await plane.listEvents({ afterEventSequence: 0 });
  assert.ok(all.length >= 5);
  assert.deepEqual(all.map((event) => event.eventSequence), [...all].sort((a, b) => a - b).map((event) => event.eventSequence));
  const cursor = all[1].eventSequence;
  const replay = await plane.listEvents({ afterEventSequence: cursor });
  assert.ok(replay.every((event) => event.eventSequence > cursor));
  const notifications = await plane.listNotifications({ afterEventSequence: cursor });
  assert.ok(notifications.some((notification) => notification.taskId === created.task.id));
  const recovered = new ControlPlane({ dataDir, legacyFile: join(dataDir, 'missing-live.json') });
  await recovered.initialize();
  assert.equal((await recovered.getTask(created.task.id)).state, 'completed');
  assert.equal((await recovered.status()).eventSequence, (await plane.status()).eventSequence);
});

test('legacy live-task migration is non-destructive and idempotent', async (t) => {
  const legacy = { tasks: [
    { id: 'live-queued', title: 'Queued', prompt: 'q', status: 'queued' },
    { id: 'live-working', title: 'Working', prompt: 'w', status: 'working' },
    { id: 'live-unknown', title: 'Unknown', prompt: 'u', status: 'mystery' },
  ] };
  const { plane, dataDir } = await makePlane({ legacy });
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  assert.equal((await plane.getTask('live-queued')).state, 'queued');
  assert.equal((await plane.getTask('live-working')).state, 'running');
  assert.equal((await plane.getTask('live-unknown')).blocker.type, 'migration_review');
  const second = new ControlPlane({ dataDir, legacyFile: join(dataDir, 'live-tasks.v1.json') });
  await second.initialize();
  assert.equal((await second.listTasks()).length, 3);
  assert.ok((await second.listEvents({ afterEventSequence: 0 })).some((event) => event.payload?.migrated === true));
});
