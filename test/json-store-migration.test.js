import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonStore, writeJsonStore } from '../server/json-store.js';

test('readJsonStore runs applicable migrations and persists the upgraded version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-migrate-'));
  const file = join(dir, 'store.json');
  // Legacy v1 shape: a flat list of items. Migration to v2 converts items->entries.
  await writeFile(file, JSON.stringify({ version: 1, items: [{ id: 'a' }] }), 'utf8');

  // migrations[v] transforms a store at version (v-1) into version v.
  const migrations = {
    2: (data) => ({ version: 2, entries: data.items, migrated: true }),
    3: (data) => ({ ...data, version: 3, migratedAgain: true }),
  };

  const loaded = await readJsonStore(file, { version: 3, migrations });
  assert.equal(loaded.version, 3);
  assert.deepEqual(loaded.entries, [{ id: 'a' }]);
  assert.equal(loaded.migrated, true);
  assert.equal(loaded.migratedAgain, true);

  // The upgraded shape should now be persisted on disk.
  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(onDisk.version, 3, 'migrated result must be written back');
  assert.deepEqual(onDisk.entries, [{ id: 'a' }]);
});

test('readJsonStore skips migrations when already at target version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-migrate-'));
  const file = join(dir, 'store.json');
  await writeFile(file, JSON.stringify({ version: 3, entries: [] }), 'utf8');
  let called = false;
  const migrations = { 1: () => { called = true; }, 2: () => { called = true; } };
  const loaded = await readJsonStore(file, { version: 3, migrations });
  assert.equal(loaded.version, 3);
  assert.equal(called, false, 'migrations must not run when already at target');
});

test('readJsonStore throws a corruption error on unparseable data with no backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-migrate-'));
  const file = join(dir, 'store.json');
  await writeFile(file, '{ this is not json', 'utf8');
  await assert.rejects(() => readJsonStore(file, { version: 1, migrations: {} }));
});

test('writeJsonStore and readJsonStore round-trip with a version', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-migrate-'));
  const file = join(dir, 'store.json');
  await writeJsonStore(file, { version: 2, name: 'cc' });
  const loaded = await readJsonStore(file, { version: 2, migrations: {} });
  assert.equal(loaded.name, 'cc');
  assert.equal(loaded.version, 2);
});
