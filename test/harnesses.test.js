import assert from 'node:assert/strict';
import test from 'node:test';
import { parseProfilesTable, parseProfileShow } from '../server/harnesses.js';
import { hermesBinCandidates, hermesPythonCandidates, hermesStateDbPath, firstRunnable } from '../server/hermes-bin.js';

const PROFILE_LIST_FIXTURE = [
  'Profile      Model                Gateway   ',
  '\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
  '\u25c6 default     stealth/ox-alpha     running   ',
  '  velvet      z-ai/glm-5.2-free    stopped   ',
  '  goal-supervisor  gpt-5.6-luna               ',
].join('\r\n');

test('parseProfilesTable reads the default marker, multi-word models, and gateway column', () => {
  const profiles = parseProfilesTable(PROFILE_LIST_FIXTURE);
  assert.equal(profiles.length, 3);
  assert.deepEqual(profiles[0], { profile: 'default', model: 'stealth/ox-alpha', gateway: 'running' });
  assert.deepEqual(profiles[1], { profile: 'velvet', model: 'z-ai/glm-5.2-free', gateway: 'stopped' });
  assert.deepEqual(profiles[2], { profile: 'goal-supervisor', model: 'gpt-5.6-luna', gateway: '' });
});

test('parseProfilesTable tolerates empty and malformed output', () => {
  assert.deepEqual(parseProfilesTable(''), []);
  assert.deepEqual(parseProfilesTable('Profile   Model\n'), []);
  assert.deepEqual(parseProfilesTable(null), []);
});

test('parseProfileShow extracts path/model/gateway detail lines', () => {
  const details = parseProfileShow([
    'Profile: default',
    'Path: C:\\Users\\Epic\\AppData\\Local\\hermes',
    'Model: stealth/ox-alpha',
    'Gateway: running',
    'Random line without colon',
    '',
  ].join('\n'));
  assert.equal(details.path, 'C:\\Users\\Epic\\AppData\\Local\\hermes');
  assert.equal(details.model, 'stealth/ox-alpha');
  assert.equal(details.gateway, 'running');
  assert.deepEqual(Object.keys(details).sort(), ['gateway', 'model', 'path', 'profile']);
});

test('hermesStateDbPath joins state.db and trims trailing slashes', () => {
  assert.equal(hermesStateDbPath('C:\\hermes\\home\\'), hermesStateDbPath('C:\\hermes\\home'));
  assert.ok(hermesStateDbPath('C:\\hermes\\home').endsWith('state.db'));
  assert.equal(hermesStateDbPath(''), '');
});

test('firstRunnable prefers existing absolute candidates and falls back to bare names', () => {
  const existing = firstRunnable(['Z:\\definitely\\missing.exe', process.execPath, 'fallback-name']);
  assert.equal(existing, process.execPath);
  assert.equal(firstRunnable(['bare-fallback']), 'bare-fallback');
  assert.equal(firstRunnable(['Z:\\definitely\\missing.exe']), '');
  assert.equal(firstRunnable([]), '');
});

test('candidate lists put the Windows venv binaries first on win32', () => {
  const bins = hermesBinCandidates();
  const pythons = hermesPythonCandidates();
  assert.ok(bins.length >= 1);
  assert.ok(pythons.length >= 2);
  if (process.platform === 'win32') {
    assert.ok(bins.length >= 3);
    assert.ok(pythons.length >= 3);
    assert.match(bins[0], /hermes-agent[\\/]venv[\\/]Scripts[\\/]hermes\.exe$/);
    assert.match(pythons[0], /venv[\\/]Scripts[\\/]python\.exe$/);
  }
});
