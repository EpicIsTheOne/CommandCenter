import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

test('ui-auth migrates a legacy (no version) store to v1 on load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-uiauth-'));
  const AUTH = join(dir, 'ui-auth.json');
  // Legacy shape: just a passwordHash, no version field.
  await writeFile(AUTH, JSON.stringify({ passwordHash: 'abc:def' }), 'utf8');
  // ui-auth resolves its data dir from COMMANDCENTER_DATA_DIR at import time.
  process.env.COMMANDCENTER_DATA_DIR = dir;
  const { loadUiAuthConfig } = await import('../server/ui-auth.js');
  const cfg = await loadUiAuthConfig();
  assert.equal(cfg.enabled, true);
  // On-disk shape should now carry the version field.
  const onDisk = JSON.parse(await readFile(AUTH, 'utf8'));
  assert.equal(onDisk.version, 1, 'legacy ui-auth.json must be migrated to v1 on disk');
  assert.equal(typeof onDisk.passwordHash, 'string');
  await rm(dir, { recursive: true, force: true });
  delete process.env.COMMANDCENTER_DATA_DIR;
});
