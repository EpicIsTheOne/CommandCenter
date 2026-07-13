import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
let cachedPython;

export function pythonCandidates({ platform = process.platform, env = process.env, root = ROOT } = {}) {
  const candidates = [];
  if (String(env.PYTHON_BIN || '').trim()) candidates.push({ command: String(env.PYTHON_BIN).trim(), args: [], source: 'PYTHON_BIN' });
  const venv = platform === 'win32' ? join(root, '.venv', 'Scripts', 'python.exe') : join(root, '.venv', 'bin', 'python');
  if (existsSync(venv)) candidates.push({ command: venv, args: [], source: 'project-venv' });
  if (platform === 'win32') candidates.push({ command: 'py', args: ['-3'], source: 'py-launcher' });
  candidates.push({ command: 'python3', args: [], source: 'python3' });
  candidates.push({ command: 'python', args: [], source: 'python' });
  return candidates;
}

function probe(candidate) {
  return new Promise((resolve) => {
    execFile(candidate.command, [...candidate.args, '--version'], { timeout: 4000, windowsHide: true }, (err) => resolve(err ? null : candidate));
  });
}

export async function resolvePython(options = {}) {
  if (!options.refresh && cachedPython !== undefined) return cachedPython;
  for (const candidate of pythonCandidates(options)) {
    const found = await probe(candidate);
    if (found) {
      cachedPython = found;
      return found;
    }
  }
  cachedPython = null;
  return null;
}

export function updaterCapability({ platform = process.platform } = {}) {
  return platform === 'linux'
    ? { supported: true, platform, reason: '' }
    : { supported: false, platform, reason: 'Update application is supported only on Linux; checking for updates remains available.' };
}

export async function getPlatformCapabilities() {
  const python = await resolvePython();
  return {
    platform: process.platform,
    python: { available: !!python, source: python?.source || '', command: python?.command || '' },
    updater: updaterCapability(),
  };
}
