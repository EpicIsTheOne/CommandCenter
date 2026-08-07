import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRetention, parseRetention } from '../server/retention.js';

const DAY = 24 * 60 * 60 * 1000;
function item(ageDays, id) {
  return { id, updated_at: new Date(Date.now() - ageDays * DAY).toISOString() };
}

test('retention keeps within maxCount and drops by age', () => {
  const items = [item(0, 'a'), item(1, 'b'), item(5, 'c'), item(40, 'd')];
  const kept = applyRetention(items, { maxCount: 3, maxAgeMs: 30 * DAY, getTimestamp: (i) => i.updated_at });
  const ids = kept.map((i) => i.id).sort();
  assert.deepEqual(ids, ['a', 'b', 'c'], '40-day-old item should be age-pruned; only 3 newest kept');
});

test('retention respects maxCount even when all are young', () => {
  const items = [item(0, 'a'), item(0, 'b'), item(0, 'c'), item(0, 'd')];
  const kept = applyRetention(items, { maxCount: 2, getTimestamp: (i) => i.updated_at });
  assert.equal(kept.length, 2, 'only the 2 newest should remain');
});

test('retention is a no-op when limits are absent', () => {
  const items = [item(0, 'a'), item(100, 'b')];
  const kept = applyRetention(items, { getTimestamp: (i) => i.updated_at });
  assert.equal(kept.length, 2);
});

test('parseRetention returns fallback for empty/invalid input', () => {
  assert.equal(parseRetention('', 10), 10);
  assert.equal(parseRetention('not-a-number', 10), 10);
  assert.equal(parseRetention('0', 10), 10);
  assert.equal(parseRetention('25', 10), 25);
});
