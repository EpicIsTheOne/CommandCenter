import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPercent, recordMachineHistorySample, getMachineHistory, getLocalMachineSnapshot } from '../server/machines.js';

test('clampPercent clamps to 0..100 and rounds to one decimal; garbage becomes null', () => {
  assert.equal(clampPercent(42.44), 42.4);
  assert.equal(clampPercent(42.46), 42.5);
  assert.equal(clampPercent(-5), 0);
  assert.equal(clampPercent(150), 100);
  assert.equal(clampPercent(0), 0);
  assert.equal(clampPercent(100), 100);
  assert.equal(clampPercent('73.9'), 73.9);
  assert.equal(clampPercent('not-a-number'), null);
  assert.equal(clampPercent(undefined), null);
  assert.equal(clampPercent(Infinity), null);
});

test('machine history is bounded and only tracks local', () => {
  const base = Date.now();
  for (let i = 0; i < 130; i++) {
    recordMachineHistorySample({ sampledAt: new Date(base + i * 1000).toISOString(), cpuPercent: i % 101, memPercent: 50 });
  }
  const history = getMachineHistory('local');
  assert.equal(history.length, 120);
  assert.deepEqual(history[0], { at: new Date(base + 10 * 1000).toISOString(), cpuPercent: 10, memPercent: 50 });
  assert.deepEqual(history[119], { at: new Date(base + 129 * 1000).toISOString(), cpuPercent: 129 % 101, memPercent: 50 });

  recordMachineHistorySample({ sampledAt: new Date().toISOString(), cpuPercent: null, memPercent: null });
  assert.equal(getMachineHistory('local').length, 120, 'samples without metrics must be ignored');

  assert.deepEqual(getMachineHistory('relay:somewhere'), []);
});

test('local machine snapshot reports real OS telemetry with honest nulls', async () => {
  const snapshot = await getLocalMachineSnapshot();
  assert.equal(snapshot.id, 'local');
  assert.equal(snapshot.kind, 'local');
  assert.equal(snapshot.online, true);
  assert.equal(snapshot.source, 'local-os');
  assert.ok(snapshot.hostname.length > 0);
  assert.ok(snapshot.cpuCores >= 1);
  assert.ok(snapshot.memTotalBytes > 0);
  assert.ok(snapshot.memUsedBytes <= snapshot.memTotalBytes);
  assert.ok(snapshot.memPercent > 0 && snapshot.memPercent <= 100);
  if (snapshot.cpuPercent !== null) {
    assert.ok(snapshot.cpuPercent >= 0 && snapshot.cpuPercent <= 100);
  }
  assert.ok(Number.isFinite(snapshot.uptimeSeconds));
  assert.ok(typeof snapshot.sampledAt === 'string' && !Number.isNaN(Date.parse(snapshot.sampledAt)));
  assert.ok(snapshot.disk && Array.isArray(snapshot.disk.drives));
  if (process.platform === 'win32') {
    assert.equal(snapshot.loadAvg1, null, 'load average does not exist on Windows');
  }
});
