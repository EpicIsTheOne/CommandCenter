import test from 'node:test';
import assert from 'node:assert/strict';
import { pythonCandidates, updaterCapability } from '../server/platform-capabilities.js';
import { buildRestartScript } from '../server/updater.js';

test('Windows Python resolution order is explicit bin, venv, py, python3, python', () => {
  const candidates = pythonCandidates({ platform: 'win32', env: { PYTHON_BIN: 'C:\\Python\\python.exe' }, root: 'Z:\\missing-project' });
  assert.equal(candidates[0].source, 'PYTHON_BIN');
  assert.deepEqual(candidates.find((item) => item.source === 'py-launcher')?.args, ['-3']);
  assert.deepEqual(candidates.slice(-2).map((item) => item.source), ['python3', 'python']);
});

test('updater applies only on Linux', () => {
  assert.equal(updaterCapability({ platform: 'linux' }).supported, true);
  assert.equal(updaterCapability({ platform: 'win32' }).supported, false);
});

test('Linux updater script uses lockfile install and rollback SHA without touching checkout', () => {
  const script = buildRestartScript({ branch: 'main', remote: 'origin', currentPid: 42, runInstall: true, previousSha: 'abc123' });
  assert.match(script, /npm ci/);
  assert.match(script, /git reset --hard "abc123"/);
  assert.match(script, /git pull --ff-only/);
});
