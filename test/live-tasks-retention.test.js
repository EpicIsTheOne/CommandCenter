import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const DAY = 24 * 60 * 60 * 1000;
function task(id, ageDays) {
  const iso = new Date(Date.now() - ageDays * DAY).toISOString();
  return { id, title: id, status: 'completed', created_at: iso, updated_at: iso };
}

test('pruneLiveTasks enforces retention age + count limits', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-livetasks-'));
  const file = join(dir, 'live-tasks.v1.json');
  const tasks = [
    task('a', 0), task('b', 1), task('c', 10),
    task('old1', 200), task('old2', 400), task('old3', 800),
  ];
  await writeFile(file, JSON.stringify({ tasks }), 'utf8');

  process.env.COMMANDCENTER_DATA_DIR = dir;
  process.env.LIVE_TASK_RETENTION_DAYS = '30';
  process.env.LIVE_TASK_MAX_COUNT = '3';
  const mod = await import(`../server/live-tasks.js?cachebust=${Date.now()}`);
  const pruned = await mod.pruneLiveTasks();
  assert.equal(pruned, 3, 'three 200+ day tasks should be pruned by age');

  const onDisk = JSON.parse(await readFile(file, 'utf8'));
  const ids = onDisk.tasks.map((t) => t.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c'], 'only the 3 newest (within age + count) should remain');

  delete process.env.COMMANDCENTER_DATA_DIR;
  delete process.env.LIVE_TASK_RETENTION_DAYS;
  delete process.env.LIVE_TASK_MAX_COUNT;
  await rm(dir, { recursive: true, force: true });
});
