// Shared Hermes CLI/python resolution — Windows-first, POSIX fallback.
// The legacy code assumed a POSIX PATH with ~/.local/bin prepended; on
// Windows the Hermes venv lives under %LOCALAPPDATA%\hermes\hermes-agent\venv
// and bare 'python3'/'hermes' only resolve via WindowsApps aliases at best.
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const WIN = platform() === 'win32';

export function hermesVenvRoot() {
  return join(
    process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'),
    'hermes', 'hermes-agent', 'venv',
  );
}

export function hermesBinCandidates() {
  const list = [process.env.HERMES_BIN].filter(Boolean);
  if (WIN) {
    list.push(join(hermesVenvRoot(), 'Scripts', 'hermes.exe'), 'hermes.cmd', 'hermes');
  } else {
    list.push('hermes');
  }
  return list;
}

export function hermesPythonCandidates() {
  const list = [];
  if (WIN) list.push(join(hermesVenvRoot(), 'Scripts', 'python.exe'));
  list.push('python3', 'python');
  return list;
}

// First runnable candidate: absolute paths must exist; bare names are handed
// to PATH resolution as a last resort.
export function firstRunnable(candidates = []) {
  for (const candidate of candidates) {
    const value = String(candidate || '').trim();
    if (!value) continue;
    const isPath = /^[a-zA-Z]:[\\/]/.test(value) || value.includes('/') || value.includes('\\');
    if (isPath) {
      if (existsSync(value)) return value;
    } else {
      return value;
    }
  }
  return '';
}

export function resolveHermesBin() {
  return firstRunnable(hermesBinCandidates());
}

export function resolveHermesPython() {
  return firstRunnable(hermesPythonCandidates());
}

export function hermesStateDbPath(home = '') {
  const base = String(home || '').trim().replace(/[\\/]+$/, '');
  if (!base) return '';
  return join(base, 'state.db');
}
