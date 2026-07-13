import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readJsonStore, updateJsonStore, writeJsonStore } from '../server/json-store.js';

test('atomic JSON store serializes concurrent read-modify-write operations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-json-'));
  const path = join(dir, 'store.json');
  await writeJsonStore(path, { count: 0 });
  await Promise.all(Array.from({ length: 30 }, () => updateJsonStore(path, { defaultValue: { count: 0 } }, async (value) => ({ count: value.count + 1 }))));
  assert.deepEqual(await readJsonStore(path), { count: 30 });
  JSON.parse(await readFile(path, 'utf8'));
});

test('corrupt primary recovers from last-known-good backup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-json-backup-'));
  const path = join(dir, 'store.json');
  await writeJsonStore(path, { value: 1 });
  await writeJsonStore(path, { value: 2 });
  await writeFile(path, '{broken');
  assert.deepEqual(await readJsonStore(path), { value: 1 });
});
