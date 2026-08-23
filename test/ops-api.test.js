import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// The ops-api module graph builds the control-plane singleton from env at
// import time — point it at a temp dir BEFORE the first import.
const controlDataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-control-'));
process.env.COMMANDCENTER_CONTROL_DATA_DIR = controlDataDir;

const { registerOpsRoutes } = await import('../server/ops-api.js');
const { getSpacesStore, resetSpacesStoreForTests } = await import('../server/spaces.js');
const { ControlPlane } = await import('../server/control-plane.js');

const FAKE_HARNESS = {
  id: 'fake',
  kind: 'fake',
  label: 'Fake Harness',
  connected: true,
  capabilities: { launchSession: true, monitorSessions: true, listSessions: true, steer: false },
  agents: [{ id: 'agent-x', label: 'Agent X', harnessId: 'fake', profile: 'primary', online: true, stateDbPresent: true }],
  detail: 'fixture harness',
  lastCheckMs: 1,
};

const fakeDeps = {
  listHarnesses: async () => [structuredClone(FAKE_HARNESS)],
  getHarness: async (id) => (String(id).toLowerCase() === 'fake' ? structuredClone(FAKE_HARNESS) : null),
  listMachines: async () => [{
    id: 'local', kind: 'local', label: 'TestBox', hostname: 'testbox', platformOs: 'Test OS 1.0', arch: 'x64',
    cpuPercent: 42, memPercent: 50, disk: { available: false, drives: [] }, online: true, source: 'fixture',
  }],
  getMachineHistory: () => [{ at: new Date().toISOString(), cpuPercent: 42, memPercent: 50 }],
  loadAgentRoster: () => ({ agents: [{ id: 'agent-x', label: 'Agent X', source: 'fake', bridge: 'fake' }], primaryAgentId: 'agent-x' }),
  controlPlane: { listTasks: async () => [{
    id: 'task-1', title: 'Fixture task', state: 'running', agent: 'agent-x',
    spaceId: '', projectId: '', machineId: '', updatedAt: '2026-01-01T00:00:00.000Z', summary: 'fixture summary',
  }] },
};

async function makeServer() {
  const express = (await import('express')).default;
  const app = express();
  app.use(express.json());
  const broadcasts = [];
  registerOpsRoutes(app, {
    broadcast: (event) => broadcasts.push(event),
    getAgentActivity: () => globalThis.__ccTestActivity,
    deps: fakeDeps,
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    broadcasts,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function activityMap() {
  globalThis.__ccTestActivity = globalThis.__ccTestActivity || new Map();
  return globalThis.__ccTestActivity;
}

test('ops spaces CRUD over HTTP with 404s and bad-kind rejection', async (t) => {
  const spacesDataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-spaces-'));
  t.after(async () => {
    await server.close();
    await rm(spacesDataDir, { recursive: true, force: true });
    await rm(controlDataDir, { recursive: true, force: true });
    resetSpacesStoreForTests();
  });
  resetSpacesStoreForTests();
  getSpacesStore({ dataDir: spacesDataDir, forceNew: true });
  const server = await makeServer();
  const base = server.base;

  const created = await fetch(`${base}/api/spaces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'QA Space', summary: 'http test' }) });
  assert.equal(created.status, 200);
  const { space } = await created.json();
  assert.ok(space.id);
  assert.equal(space.name, 'QA Space');
  assert.ok(server.broadcasts.some((event) => event.type === 'spaces:changed' && event.data.action === 'created'));

  const got = await fetch(`${base}/api/spaces/${space.id}`);
  assert.equal(got.status, 200);
  assert.equal((await got.json()).space.summary, 'http test');

  const missing = await fetch(`${base}/api/spaces/space-nope`);
  assert.equal(missing.status, 404);

  const badKind = await fetch(`${base}/api/spaces/${space.id}/members/not-a-kind`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['x'] }) });
  assert.equal(badKind.status, 400);
  assert.equal((await badKind.json()).code, 'SPACE_BAD_KIND');

  const attached = await fetch(`${base}/api/spaces/${space.id}/members/agents`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [{ id: 'agent-x', label: 'Agent X' }] }) });
  assert.equal(attached.status, 200);
  assert.deepEqual((await attached.json()).space.members.agents.ids, ['agent-x']);

  const detached = await fetch(`${base}/api/spaces/${space.id}/members/agents`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: ['agent-x'] }) });
  assert.equal(detached.status, 200);
  assert.deepEqual((await detached.json()).space.members.agents.ids, []);

  const updated = await fetch(`${base}/api/spaces/${space.id}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'patched via http' }) });
  assert.equal(updated.status, 200);
  const updatedSpace = await updated.json();
  assert.equal(updatedSpace.space.summary, 'patched via http');
  assert.equal(updatedSpace.space.createdAt, space.createdAt);

  const removed = await fetch(`${base}/api/spaces/${space.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), { ok: true, removed: true });

  const gone = await fetch(`${base}/api/spaces/${space.id}`);
  assert.equal(gone.status, 404);
});

test('ops overview aggregates fakes into the documented shape', async (t) => {
  const spacesDataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-overview-'));
  t.after(async () => {
    await server.close();
    await rm(spacesDataDir, { recursive: true, force: true });
    resetSpacesStoreForTests();
  });
  resetSpacesStoreForTests();
  getSpacesStore({ dataDir: spacesDataDir, forceNew: true });
  const server = await makeServer();

  activityMap().set('agent-x', { state: 'thinking', at: 12345 });
  const res = await fetch(`${server.base}/api/overview`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  for (const key of ['spaces', 'harnesses', 'machines', 'agents', 'tasks', 'counts', 'generatedAt']) {
    assert.ok(key in body, `overview missing ${key}`);
  }
  const agent = body.agents.find((entry) => entry.id === 'agent-x');
  assert.ok(agent, 'fixture agent missing from overview');
  assert.equal(agent.state, 'thinking', 'activity map state must win');
  assert.equal(agent.lastActiveAt, 12345);
  assert.equal(agent.harnessId, 'fake');
  assert.equal(body.counts.machines, 1);
  assert.equal(body.counts.activeTasks, 1);
  assert.equal(body.tasks[0].spaceId, '');
  assert.equal(body.tasks[0].summary, 'fixture summary');
  assert.equal(body.machines[0].cpuPercent, 42);
});

test('ops search groups results and short queries return no groups', async (t) => {
  const spacesDataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-search-'));
  t.after(async () => {
    await server.close();
    await rm(spacesDataDir, { recursive: true, force: true });
    resetSpacesStoreForTests();
  });
  resetSpacesStoreForTests();
  const store = getSpacesStore({ dataDir: spacesDataDir, forceNew: true });
  await store.create({ name: 'Aurora Ops', summary: 'northern lights workspace' });
  const server = await makeServer();

  const empty = await fetch(`${server.base}/api/search?q=a`);
  assert.equal(empty.status, 200);
  assert.deepEqual((await empty.json()).groups, []);

  const bySpace = await fetch(`${server.base}/api/search?q=aurora`);
  const spaceBody = await bySpace.json();
  const spaceGroup = spaceBody.groups.find((group) => group.label === 'Spaces');
  assert.ok(spaceGroup, 'space hit missing');
  assert.equal(spaceGroup.hits[0].label, 'Aurora Ops');

  const byAgent = await fetch(`${server.base}/api/search?q=agent%20x`);
  const agentBody = await byAgent.json();
  const agentGroup = agentBody.groups.find((group) => group.label === 'Agents');
  assert.ok(agentGroup, 'agent hit missing');
  assert.equal(agentGroup.hits[0].id, 'agent-x');

  const byTask = await fetch(`${server.base}/api/search?q=fixture%20task`);
  const taskBody = await byTask.json();
  assert.ok(taskBody.groups.some((group) => group.label === 'Tasks'), 'task hit missing');

  const byMachine = await fetch(`${server.base}/api/search?q=testbox`);
  const machineBody = await byMachine.json();
  assert.ok(machineBody.groups.some((group) => group.label === 'Machines'), 'machine hit missing');

  const byHarness = await fetch(`${server.base}/api/search?q=fake%20harness`);
  const harnessBody = await byHarness.json();
  assert.ok(harnessBody.groups.some((group) => group.label === 'Harnesses'), 'harness hit missing');
});

test('ops agent-state ingest validates input and records activity', async (t) => {
  const spacesDataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-state-'));
  t.after(async () => {
    await server.close();
    await rm(spacesDataDir, { recursive: true, force: true });
    resetSpacesStoreForTests();
  });
  resetSpacesStoreForTests();
  getSpacesStore({ dataDir: spacesDataDir, forceNew: true });
  const server = await makeServer();

  const missingAgent = await fetch(`${server.base}/api/agent-state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: 'idle' }) });
  assert.equal(missingAgent.status, 400);
  const missingState = await fetch(`${server.base}/api/agent-state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'agent-x' }) });
  assert.equal(missingState.status, 400);

  const ok = await fetch(`${server.base}/api/agent-state`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent: 'Agent X!', state: 'RUNNING' }) });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, recorded: true });
  assert.equal(activityMap().get('agent-x').state, 'running');
  assert.ok(server.broadcasts.some((event) => event.type === 'agent_state:updated'));
});

test('real ControlPlane stores and patches space fields on tasks', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commandcenter-ops-api-plane-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const plane = new ControlPlane({ dataDir });
  await plane.initialize();

  const created = await plane.createTask({ id: 'task-spacey', title: 'Space fields', prompt: 'work', spaceId: 'space-abc', projectId: 'proj-1', machineId: 'local', operationId: 'op-spacey-create' });
  assert.equal(created.task.spaceId, 'space-abc');
  assert.equal(created.task.projectId, 'proj-1');
  assert.equal(created.task.machineId, 'local');

  const patched = await plane.updateTask(created.task.id, { spaceId: 'space-xyz', machineId: 'relay:box' }, { operationId: 'op-spacey-patch', expectedTaskRevision: created.task.revision });
  assert.equal(patched.task.spaceId, 'space-xyz');
  assert.equal(patched.task.machineId, 'relay:box');
  assert.equal(patched.task.projectId, 'proj-1', 'unpatched field must survive');

  const projected = (await import('../server/control-plane.js')).projectLegacyTask(patched.task);
  assert.equal(projected.spaceId, 'space-xyz');
  assert.equal(projected.projectId, 'proj-1');
  assert.equal(projected.machineId, 'relay:box');

  const fresh = new ControlPlane({ dataDir });
  await fresh.initialize();
  const reloaded = await fresh.getTask(created.task.id);
  assert.equal(reloaded.spaceId, 'space-xyz');
});
