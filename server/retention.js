import test from 'node:test';
import assert from 'node:assert/strict';

// Generic retention policy: keep the most recent `maxCount` items and drop any
// item whose timestamp is older than `maxAgeMs`. Items are compared by a
// caller-supplied timestamp getter. Pure + tested so it can be reused across
// recordings, chat, calls, and tasks.
export function applyRetention(items = [], { maxCount, maxAgeMs, getTimestamp } = {}) {
  const list = Array.isArray(items) ? items.slice() : [];
  const ts = typeof getTimestamp === 'function' ? getTimestamp : (item) => item?.updated_at || item?.created_at || item?.timestamp;
  let kept = list;
  if (typeof maxAgeMs === 'number' && maxAgeMs > 0) {
    const cutoff = Date.now() - maxAgeMs;
    kept = kept.filter((item) => {
      const t = typeof ts(item) === 'string' ? Date.parse(ts(item)) : Number(ts(item) || 0);
      return Number.isFinite(t) && t >= cutoff;
    });
  }
  if (typeof maxCount === 'number' && maxCount >= 0) {
    const sorted = kept.slice().sort((a, b) => {
      const ta = typeof ts(a) === 'string' ? Date.parse(ts(a)) : Number(ts(a) || 0);
      const tb = typeof ts(b) === 'string' ? Date.parse(ts(b)) : Number(ts(b) || 0);
      return tb - ta; // newest first
    });
    kept = sorted.slice(0, maxCount);
  }
  return kept;
}

export function parseRetention(envValue, fallback) {
  const raw = String(envValue || '').trim();
  if (!raw) return fallback;
  const asNum = Number(raw);
  return Number.isFinite(asNum) && asNum > 0 ? asNum : fallback;
}
