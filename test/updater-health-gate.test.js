import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Exercises the post-restart health gate + rollback without touching real git
// or the network: the update-state file + verify/rollback are injected.
async function withStateDir(mutate, fn) {
  const dir = await mkdtemp(join(tmpdir(), 'cc-upd-'));
  const dataDir = join(dir, 'data');
  await mkdir(dataDir, { recursive: true });
  const STATE_FILE = join(dataDir, 'update-state.json');
  const base = {
    status: 'applying', phase: 'manual-update', message: '',
    previousSha: 'abc123', targetSha: 'def456', localSha: 'def456',
    branch: 'main', runInstall: true,
  };
  await writeFile(STATE_FILE, JSON.stringify(mutate ? mutate(base) : base), 'utf8');
  process.env.COMMANDCENTER_DATA_DIR = dataDir;
  const mod = await import(`../server/updater.js?cb=${Date.now()}-${Math.random()}`);
  try { return await fn(mod, () => readFile(STATE_FILE, 'utf8')); }
  finally { delete process.env.COMMANDCENTER_DATA_DIR; await rm(dir, { recursive: true, force: true }); }
}

test('finalize marks ok when SHA matches and health check passes', async () => {
  await withStateDir(null, async (mod, readState) => {
    const getHead = async () => 'def456';
    const verify = async () => ({ ok: true, status: 200 });
    const rollback = async () => assert.fail('rollback must not run on success');
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(state.status, 'ok');
    const onDisk = JSON.parse(await readState());
    assert.equal(onDisk.status, 'ok');
  });
});

test('finalize rolls back when health check fails', async () => {
  await withStateDir(null, async (mod, readState) => {
    const getHead = async () => 'def456';
    const verify = async () => ({ ok: false, status: 500 });
    let rolledBack = null;
    const rollback = async ({ previousSha }) => { rolledBack = previousSha; return { ok: true, rolledBackTo: previousSha }; };
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(rolledBack, 'abc123', 'must roll back to previousSha');
    assert.equal(state.status, 'rolling-back');
    const onDisk = JSON.parse(await readState());
    assert.equal(onDisk.status, 'rolling-back');
    assert.equal(onDisk.localSha, 'abc123');
  });
});

test('finalize rolls back when SHA does not match target', async () => {
  await withStateDir((b) => ({ ...b, localSha: 'deadbeef', targetSha: 'def456' }), async (mod, readState) => {
    const getHead = async () => 'deadbeef';
    const verify = async () => assert.fail('verify should not run when SHA mismatches');
    let rolledBack = null;
    const rollback = async ({ previousSha }) => { rolledBack = previousSha; return { ok: true, rolledBackTo: previousSha }; };
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(rolledBack, 'abc123');
    assert.equal(state.status, 'rolling-back');
  });
});

test('finalize records error when unhealthy and no previous SHA', async () => {
  await withStateDir((b) => ({ ...b, previousSha: '' }), async (mod, readState) => {
    const getHead = async () => 'def456';
    const verify = async () => ({ ok: false, status: 500 });
    const rollback = async () => assert.fail('rollback must not run without previousSha');
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(state.status, 'error');
    assert.equal(state.phase, 'verification-failed');
  });
});

test('finalize records rollback-failed when rollback command errors', async () => {
  await withStateDir(null, async (mod, readState) => {
    const getHead = async () => 'def456';
    const verify = async () => ({ ok: false, status: 500 });
    const rollback = async () => ({ ok: false, reason: 'git reset failed' });
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(state.status, 'error');
    assert.equal(state.phase, 'rollback-failed');
  });
});

test('finalize no-ops when status is not applying', async () => {
  await withStateDir((b) => ({ ...b, status: 'idle' }), async (mod, readState) => {
    const getHead = async () => 'def456';
    const verify = async () => assert.fail('must not verify when not applying');
    const rollback = async () => assert.fail('must not rollback when not applying');
    const state = await mod.finalizePostRestartUpdateState({ getHead, verify, rollback, serverInfo: { port: 3000 } });
    assert.equal(state.status, 'idle');
  });
});

test('performRollback returns no-previous-sha without a target', async () => {
  const mod = await import('../server/updater.js');
  const res = await mod.performRollback({ previousSha: '' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'no-previous-sha');
});

test('verifyUpdateHealth polls until healthy then returns healthy', async () => {
  const mod = await import('../server/updater.js');
  let calls = 0;
  const check = async () => { calls += 1; return calls >= 3 ? { ok: true, status: 200 } : { ok: false, status: 503 }; };
  const res = await mod.verifyUpdateHealth({ timeoutMs: 5000, intervalMs: 5, check });
  assert.equal(res.healthy, true);
  assert.ok(calls >= 3);
});

test('verifyUpdateHealth returns unhealthy when probe never succeeds', async () => {
  const mod = await import('../server/updater.js');
  const check = async () => ({ ok: false, status: 503 });
  const res = await mod.verifyUpdateHealth({ timeoutMs: 200, intervalMs: 5, check });
  assert.equal(res.healthy, false);
});
