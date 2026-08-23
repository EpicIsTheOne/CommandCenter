// Command Center ops surface: Spaces, harnesses, machines, overview, search.
// Mounted under the UI-session-protected /api/* namespace (same as control
// plane routes). All data is real: harness detection runs actual CLIs, machine
// metrics come from the OS, and unknown values stay null.
import { getSpacesStore } from './spaces.js';
import * as harnessRegistry from './harnesses.js';
import * as machineRegistry from './machines.js';
import { loadAgentRoster } from './agents.js';
import { controlPlane } from './control-plane.js';

function ok(res, payload) {
  res.json({ ok: true, ...payload });
}

function fail(res, status, message, code = 'OPS_ERROR', details = {}) {
  res.status(status).json({ ok: false, error: String(message || 'Request failed'), code, details });
}

function cleanId(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120);
}

function registerOpsRoutes(app, { basePath = '', broadcast = () => {}, getAgentActivity = () => new Map(), deps = {} } = {}) {
  const spaces = getSpacesStore();
  // Injectable for tests; production uses the real registries.
  const impl = {
    listHarnesses: deps.listHarnesses || harnessRegistry.listHarnesses,
    getHarness: deps.getHarness || harnessRegistry.getHarness,
    listMachines: deps.listMachines || machineRegistry.listMachines,
    getMachineHistory: deps.getMachineHistory || machineRegistry.getMachineHistory,
    loadAgentRoster: deps.loadAgentRoster || loadAgentRoster,
    controlPlane: deps.controlPlane || controlPlane,
  };

  // ---- Spaces ----
  app.get(`${basePath}/api/spaces`, async (req, res) => {
    try {
      const items = await spaces.list({ includeArchived: String(req.query.includeArchived || '') === 'true' });
      const tasks = await impl.controlPlane.listTasks();
      const counts = {};
      for (const task of tasks) {
        const key = String(task.spaceId || '');
        if (!key) continue;
        counts[key] = (counts[key] || 0) + 1;
      }
      ok(res, { spaces: items, taskCounts: counts });
      return;
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not list Spaces');
    }
  });

  app.post(`${basePath}/api/spaces`, async (req, res) => {
    try {
      const space = await spaces.create(req.body || {});
      broadcast({ type: 'spaces:changed', data: { action: 'created', id: space.id } });
      ok(res, { space });
    } catch (error) {
      const status = error?.code === 'SPACE_EXISTS' ? 409 : 500;
      return fail(res, status, error?.message || 'Could not create Space', error?.code || 'SPACE_ERROR');
    }
  });

  app.get(`${basePath}/api/spaces/:id`, async (req, res) => {
    try {
      const space = await spaces.get(req.params.id);
      if (!space) return fail(res, 404, `Space not found: ${req.params.id}`, 'SPACE_NOT_FOUND');
      ok(res, { space });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not read Space');
    }
  });

  app.post(`${basePath}/api/spaces/:id`, async (req, res) => {
    try {
      const space = await spaces.update(req.params.id, req.body || {});
      if (!space) return fail(res, 404, `Space not found: ${req.params.id}`, 'SPACE_NOT_FOUND');
      broadcast({ type: 'spaces:changed', data: { action: 'updated', id: space.id } });
      ok(res, { space });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not update Space');
    }
  });

  app.delete(`${basePath}/api/spaces/:id`, async (req, res) => {
    try {
      const removed = await spaces.delete(req.params.id);
      if (!removed) return fail(res, 404, `Space not found: ${req.params.id}`, 'SPACE_NOT_FOUND');
      broadcast({ type: 'spaces:current', data: {} });
      broadcast({ type: 'spaces:changed', data: { action: 'deleted', id: req.params.id } });
      ok(res, { removed: true });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not delete Space');
    }
  });

  app.post(`${basePath}/api/spaces/:id/members/:kind`, async (req, res) => {
    try {
      const space = await spaces.attach(req.params.kind, req.params.id, req.body?.ids || []);
      if (!space) return fail(res, 404, `Space not found: ${req.params.id}`, 'SPACE_NOT_FOUND');
      broadcast({ type: 'spaces:changed', data: { action: 'members', id: space.id, kind: req.params.kind } });
      ok(res, { space });
    } catch (error) {
      const status = error?.code === 'SPACE_BAD_KIND' ? 400 : 500;
      return fail(res, status, error?.message || 'Could not attach member', error?.code || 'SPACE_ERROR');
    }
  });

  app.delete(`${basePath}/api/spaces/:id/members/:kind`, async (req, res) => {
    try {
      const space = await spaces.detach(req.params.kind, req.params.id, req.body?.ids || []);
      if (!space) return fail(res, 404, `Space not found: ${req.params.id}`, 'SPACE_NOT_FOUND');
      broadcast({ type: 'spaces:changed', data: { action: 'members', id: space.id, kind: req.params.kind } });
      ok(res, { space });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not detach member');
    }
  });

  // ---- Harnesses ----
  app.get(`${basePath}/api/harnesses`, async (req, res) => {
    try {
      const force = String(req.query.refresh || '') === 'true';
      const harnesses = await impl.listHarnesses({ force });
      ok(res, { harnesses });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not enumerate harnesses');
    }
  });

  app.get(`${basePath}/api/harnesses/:id`, async (req, res) => {
    try {
      const harness = await impl.getHarness(req.params.id);
      if (!harness) return fail(res, 404, `Harness not found: ${req.params.id}`, 'HARNESS_NOT_FOUND');
      ok(res, { harness });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not read harness');
    }
  });

  // ---- Machines ----
  app.get(`${basePath}/api/machines`, async (req, res) => {
    try {
      const machines = await impl.listMachines();
      ok(res, { machines });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not enumerate machines');
    }
  });

  app.get(`${basePath}/api/machines/local/history`, async (req, res) => {
    try {
      ok(res, { history: impl.getMachineHistory('local') });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not read machine history');
    }
  });

  // ---- Overview (one call powering the 2D dashboard + 3D scene) ----
  app.get(`${basePath}/api/overview`, async (req, res) => {
    try {
      const [spacesList, harnesses, machines, tasks, roster] = await Promise.all([
        getSpacesStore().list(),
        impl.listHarnesses(),
        impl.listMachines(),
        impl.controlPlane.listTasks(),
        Promise.resolve().then(() => impl.loadAgentRoster()),
      ]);
      const activityMap = getAgentActivity();
      const seen = new Set();
      const agents = [];
      const pushAgent = (agent) => {
        if (!agent?.id || seen.has(agent.id) || agents.length >= 64) return;
        seen.add(agent.id);
        agents.push({
          id: String(agent.id),
          label: String(agent.label || agent.name || agent.id),
          source: String(agent.source || 'hermes'),
          harnessId: String(agent.harnessId || 'hermes'),
          model: String(agent.model || ''),
          isBoss: Boolean(agent.isBoss),
          profile: String(agent.profile || ''),
          stateDbPresent: Boolean(agent.stateDbPresent),
          gatewayState: String(agent.gatewayState || ''),
          online: Boolean(agent.online),
          state: String(activityMap.get(agent.id)?.state || (agent.online === false ? 'disconnected' : 'idle')),
          lastActiveAt: Number(activityMap.get(agent.id)?.at || 0) || null,
        });
      };
      for (const harness of harnesses) {
        for (const agent of harness.agents || []) pushAgent({ ...agent, source: harness.kind, harnessId: harness.id, online: agent.online !== false && (harness.connected || agent.stateDbPresent) });
      }
      for (const agent of roster.agents || []) {
        pushAgent({
          id: agent.id,
          label: agent.label || agent.name,
          source: agent.source || agent.bridge || 'unknown',
          harnessId: agent.source === 'relay' ? 'relay' : (agent.source === 'hermes' ? 'hermes' : (agent.source === 'openclaw' ? 'openclaw' : 'unknown')),
          model: agent.model || '',
          isBoss: agent.isBoss,
          profile: agent.hermesProfile || '',
          online: true,
        });
      }
      const activeTasks = tasks.filter((task) => !['completed', 'cancelled', 'failed'].includes(String(task.state || '')));
      ok(res, {
        spaces: spacesList,
        harnesses,
        machines,
        agents,
        tasks: tasks.slice(0, 100).map((task) => ({
          id: task.id, title: task.title, state: task.state, agent: task.agent,
          spaceId: task.spaceId || '', projectId: task.projectId || '', machineId: task.machineId || '',
          updatedAt: task.updatedAt, summary: String(task.summary || '').slice(0, 240),
        })),
        counts: {
          spaces: spacesList.length,
          harnesses: harnesses.length,
          machines: machines.length,
          agents: agents.length,
          tasks: tasks.length,
          activeTasks: activeTasks.length,
        },
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not build overview');
    }
  });

  // ---- Unified search ----
  app.get(`${basePath}/api/search`, async (req, res) => {
    const query = String(req.query.q || '').trim().toLowerCase();
    if (query.length < 2) return ok(res, { query, groups: [] });
    try {
      const [spacesList, harnesses, machines, tasks, roster] = await Promise.all([
        getSpacesStore().list({ includeArchived: true }),
        impl.listHarnesses(),
        impl.listMachines(),
        impl.controlPlane.listTasks(),
        Promise.resolve().then(() => impl.loadAgentRoster()),
      ]);
      const groups = [];
      const match = (value) => String(value || '').toLowerCase().includes(query);
      const spaceHits = spacesList.filter((space) => match(space.name) || match(space.summary)).slice(0, 6)
        .map((space) => ({ id: space.id, label: space.name, sub: space.summary || `${Object.values(space.members).reduce((sum, m) => sum + m.ids.length, 0)} members`, kind: 'space' }));
      const agentHits = (roster.agents || []).filter((agent) => match(agent.id) || match(agent.label) || match(agent.name) || match(agent.hermesProfile)).slice(0, 6)
        .map((agent) => ({ id: agent.id, label: agent.label || agent.name, sub: `${agent.source || 'agent'}${agent.hermesProfile ? ' · ' + agent.hermesProfile : ''}`, kind: 'agent' }));
      const taskHits = tasks.filter((task) => match(task.title) || match(task.summary)).slice(0, 8)
        .map((task) => ({ id: task.id, label: task.title, sub: `${task.state || 'unknown'} · ${task.agent || ''}`, kind: 'task' }));
      const machineHits = machines.filter((machine) => match(machine.label) || match(machine.hostname)).slice(0, 4)
        .map((machine) => ({ id: machine.id, label: machine.label, sub: machine.platformOs || machine.kind, kind: 'machine' }));
      const harnessHits = harnesses.filter((harness) => match(harness.label) || match(harness.id)).slice(0, 4)
        .map((harness) => ({ id: harness.id, label: harness.label, sub: harness.detail || harness.kind, kind: 'harness' }));
      for (const [label, hits] of [['Spaces', spaceHits], ['Agents', agentHits], ['Tasks', taskHits], ['Machines', machineHits], ['Harnesses', harnessHits]]) {
        if (hits.length) groups.push({ label, hits });
      }
      ok(res, { query, groups });
    } catch (error) {
      return fail(res, 500, error?.message || 'Search failed');
    }
  });

  // ---- Agent state ingest (external harnesses can report state) ----
  app.post(`${basePath}/api/agent-state`, async (req, res) => {
    try {
      const agentId = cleanId(req.body?.agent || req.body?.agentId);
      const state = String(req.body?.state || '').trim().toLowerCase().slice(0, 40);
      if (!agentId) return fail(res, 400, 'agent is required', 'BAD_REQUEST');
      if (!state) return fail(res, 400, 'state is required', 'BAD_REQUEST');
      const map = getAgentActivity();
      map.set(agentId, { state, at: Date.now() });
      broadcast({ type: 'agent_state:updated', data: { agent: agentId, state } });
      ok(res, { recorded: true });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not record agent state');
    }
  });

  // ---- Current Space (per browser, mirrored server-side for voice/actions) ----
  app.post(`${basePath}/api/spaces/current`, async (req, res) => {
    try {
      const id = cleanId(req.body?.id);
      if (!id) return fail(res, 400, 'id is required', 'BAD_REQUEST');
      const space = await spaces.get(id);
      if (!space) return fail(res, 404, `Space not found: ${id}`, 'SPACE_NOT_FOUND');
      currentSpaceId = space.id;
      broadcast({ type: 'spaces:current', data: { id: space.id } });
      ok(res, { id: space.id });
    } catch (error) {
      return fail(res, 500, error?.message || 'Could not set current Space');
    }
  });
}

let currentSpaceId = '';

export function getCurrentSpaceId() {
  return currentSpaceId;
}

export { registerOpsRoutes };
