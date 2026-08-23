import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  SPACES_SCHEMA_VERSION,
  SpacesStore,
  migrateSpacesDoc,
  normalizeSpace,
  getSpacesStore,
  resetSpacesStoreForTests,
} from '../server/spaces.js';

async function makeStore() {
  const dataDir = await mkdtemp(join(tmpdir(), 'commandcenter-spaces-test-'));
  return { store: new SpacesStore({ dataDir }), dataDir };
}

test('normalizeSpace cleans ids, text, accents, and member refs', () => {
  const space = normalizeSpace({
    id: '  My Space!! ',
    name: '  Lots   of    spaces  ',
    summary: 'x'.repeat(1000),
    accent: 'not-a-color',
    mode: 'bogus',
    agents: [{ id: 'Agent One!', label: 'Agent One' }, '  ', 'agent-one', { id: '', label: 'ignored' }],
    machines: ['DESKTOP-VG5E7UC'],
  });
  assert.equal(space.id, 'my-space');
  assert.equal(space.name, 'Lots of spaces');
  assert.equal(space.summary.length, 600);
  assert.equal(space.accent, '');
  assert.equal(space.mode, 'grid');
  assert.deepEqual(space.members.agents.ids, ['agent-one']);
  assert.equal(space.members.agents.labelHints['agent-one'], 'Agent One');
  assert.deepEqual(space.members.machines.ids, ['desktop-vg5e7uc']);
  for (const kind of ['projects', 'harnesses', 'tasks', 'terminals', 'services', 'artifacts']) {
    assert.deepEqual(space.members[kind].ids, []);
  }
});

test('normalizeSpace preserves accent, mode, and settings through updates', () => {
  const existing = normalizeSpace({ name: 'Ops', accent: '#36e0a8', mode: 'flow', settings: { defaultHarness: 'hermes', autoAttachNewTasks: false } });
  const updated = normalizeSpace({ name: 'Ops renamed' }, existing);
  assert.equal(updated.accent, '#36e0a8');
  assert.equal(updated.mode, 'flow');
  assert.equal(updated.settings.defaultHarness, 'hermes');
  assert.equal(updated.settings.autoAttachNewTasks, false);
  assert.equal(updated.createdAt, existing.createdAt);
});

test('space create/get/update/delete round-trips through the JSON store', async (t) => {
  const { store, dataDir } = await makeStore();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const created = await store.create({ name: 'Round Trip', summary: 'temp space' });
  assert.ok(created.id.startsWith('space-'));
  assert.equal(created.name, 'Round Trip');
  assert.equal(created.schemaVersion ?? SPACES_SCHEMA_VERSION, SPACES_SCHEMA_VERSION);

  const fresh = new SpacesStore({ dataDir });
  const loaded = await fresh.get(created.id);
  assert.equal(loaded.name, 'Round Trip');

  const updated = await store.update(created.id, { summary: 'patched' });
  assert.equal(updated.summary, 'patched');
  assert.equal(updated.createdAt, created.createdAt);

  assert.equal(await store.delete(created.id), true);
  assert.equal(await store.get(created.id), null);
  assert.equal(await store.delete(created.id), false);
});

test('member attach/detach merges ids and prunes labelHints', async (t) => {
  const { store, dataDir } = await makeStore();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const space = await store.create({ name: 'Members' });
  const attached = await store.attach('agents', space.id, [{ id: 'hermes', label: 'Hermes' }, 'hermes:velvet']);
  assert.deepEqual(attached.members.agents.ids, ['hermes', 'hermes:velvet']);
  assert.equal(attached.members.agents.labelHints.hermes, 'Hermes');

  const attachedAgain = await store.attach('agents', space.id, ['hermes']);
  assert.deepEqual(attachedAgain.members.agents.ids, ['hermes', 'hermes:velvet']);

  const detached = await store.detach('agents', space.id, ['hermes']);
  assert.deepEqual(detached.members.agents.ids, ['hermes:velvet']);
  assert.equal(detached.members.agents.labelHints.hermes, undefined);

  await assert.rejects(
    () => store.attach('not-a-kind', space.id, ['x']),
    (error) => error.code === 'SPACE_BAD_KIND',
  );
});

test('migrateSpacesDoc upgrades legacy docs and preserves labelHints', () => {
  const migrated = migrateSpacesDoc({
    spaces: [{
      id: 'legacy-1',
      name: 'Legacy',
      members: { agents: [{ id: 'hermes', label: 'Hermes' }] },
    }],
  });
  assert.equal(migrated.schemaVersion, SPACES_SCHEMA_VERSION);
  assert.equal(migrated.spaces.length, 1);
  assert.deepEqual(migrated.spaces[0].members.agents.ids, ['hermes']);
  assert.equal(migrated.spaces[0].members.agents.labelHints.hermes, 'Hermes');
  for (const kind of ['projects', 'harnesses', 'machines', 'tasks', 'terminals', 'services', 'artifacts']) {
    assert.ok(migrated.spaces[0].members[kind], `missing member kind ${kind}`);
  }
});

test('SpacesStore migrates a legacy on-disk doc on load', async (t) => {
  const { store, dataDir } = await makeStore();
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, 'spaces.v1.json'), JSON.stringify({ spaces: [{ id: 'old', name: 'Old Space' }] }), 'utf8');
  const spaces = await store.list();
  assert.equal(spaces.length, 1);
  assert.equal(spaces[0].id, 'old');
  const doc = JSON.parse(await readFile(join(dataDir, 'spaces.v1.json'), 'utf8'));
  assert.equal(doc.schemaVersion, SPACES_SCHEMA_VERSION);
});

test('ensureDefaultSpace creates only when empty and store singleton resets for tests', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'commandcenter-spaces-singleton-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  resetSpacesStoreForTests();
  const store = getSpacesStore({ dataDir, forceNew: true });
  const first = await store.ensureDefaultSpace();
  assert.equal(first.name, 'Command Center');
  const again = await store.ensureDefaultSpace();
  assert.equal(again.id, first.id);
  resetSpacesStoreForTests();
});
