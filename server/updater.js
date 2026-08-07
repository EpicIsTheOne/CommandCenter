import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import https from 'node:https';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadUpdateSettings, loadUpdateState, saveUpdateState } from './update-settings.js';
import { updaterCapability } from './platform-capabilities.js';

const execFileAsync = promisify(execFile);
const REPO_DIR = process.cwd();
const TMP_LOG = join(REPO_DIR, 'tmp-commandcenter.log');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactSecrets(value = '') {
  return String(value || '')
    .replace(/(https?:\/\/)[^/@\s]+@/gi, '$1[redacted]@')
    .replace(/([?&](?:token|key|secret|password)=)[^&\s]+/gi, '$1[redacted]');
}

function toIso(ts = 0) {
  return ts ? new Date(ts).toISOString() : '';
}

async function git(args = [], options = {}) {
  const res = await execFileAsync('git', args, {
    cwd: REPO_DIR,
    encoding: 'utf8',
    timeout: options.timeout || 30000,
    maxBuffer: 1024 * 1024 * 8,
    env: { ...process.env, ...(options.env || {}) },
  });
  return String(res.stdout || '').trim();
}

async function safeGit(args = [], options = {}) {
  try {
    return { ok: true, stdout: await git(args, options), error: '' };
  } catch (err) {
    return { ok: false, stdout: '', error: redactSecrets(err?.stderr || err?.message || 'git command failed') };
  }
}

function parseKeyValueBody(body = '') {
  const out = {};
  for (const line of String(body || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s*(.*)$/);
    if (!match) continue;
    out[String(match[1] || '').trim().toLowerCase()] = String(match[2] || '').trim();
  }
  return out;
}

function parseCommits(text = '') {
  return String(text || '').split('\u001e').map((chunk) => chunk.trim()).filter(Boolean).map((chunk) => {
    const [sha = '', subject = '', body = ''] = chunk.split('\u001f');
    return { sha: sha.trim(), shortSha: sha.trim().slice(0, 7), subject: subject.trim(), body: body.trim() };
  });
}

function parseNameStatus(text = '') {
  return String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [status = '', ...rest] = line.split(/\s+/);
    return { status, path: rest.join(' ').trim() };
  }).filter((row) => row.path);
}

function parseNumstat(text = '') {
  const map = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [adds = '0', dels = '0', ...rest] = line.split(/\t+/);
    const path = rest.join('\t').trim();
    if (!path) continue;
    map.set(path, {
      additions: adds === '-' ? null : Number(adds) || 0,
      deletions: dels === '-' ? null : Number(dels) || 0,
    });
  }
  return map;
}

async function getCurrentBranch() {
  const branch = await safeGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  return branch.ok ? (branch.stdout || 'main') : 'main';
}

async function getOriginName() {
  const remotes = await safeGit(['remote']);
  const names = remotes.ok ? remotes.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  return names.includes('origin') ? 'origin' : (names[0] || 'origin');
}

async function getRemoteUrl(remote = 'origin') {
  const url = await safeGit(['remote', 'get-url', remote]);
  return url.ok ? redactSecrets(url.stdout) : '';
}

async function fetchRemote(remote = 'origin', branch = 'main') {
  return await safeGit(['fetch', remote, branch, '--tags']);
}

async function getRepoMeta() {
  const branch = await getCurrentBranch();
  const remote = await getOriginName();
  const remoteUrl = await getRemoteUrl(remote);
  const localShaRes = await safeGit(['rev-parse', 'HEAD']);
  const localSha = localShaRes.ok ? localShaRes.stdout : '';
  return { branch, remote, remoteUrl, localSha };
}

async function getUpdateSummary({ refresh = true } = {}) {
  const repo = await getRepoMeta();
  const state = await loadUpdateState();
  const settings = await loadUpdateSettings();
  const fetchResult = refresh ? await fetchRemote(repo.remote, repo.branch) : { ok: true, stdout: '', error: '' };
  const remoteRef = `${repo.remote}/${repo.branch}`;
  const remoteShaRes = await safeGit(['rev-parse', remoteRef]);
  const remoteSha = remoteShaRes.ok ? remoteShaRes.stdout : '';
  const aheadBehindRes = (repo.localSha && remoteSha)
    ? await safeGit(['rev-list', '--left-right', '--count', `${repo.localSha}...${remoteSha}`])
    : { ok: false, stdout: '', error: '' };
  let behind = 0;
  let ahead = 0;
  if (aheadBehindRes.ok) {
    const [aheadRaw = '0', behindRaw = '0'] = aheadBehindRes.stdout.split(/\s+/);
    ahead = Number(aheadRaw) || 0;
    behind = Number(behindRaw) || 0;
  }
  const pending = behind > 0 && !!remoteSha && repo.localSha !== remoteSha;
  const dirtyRes = await safeGit(['status', '--porcelain']);
  const dirtyFiles = dirtyRes.ok ? parseNameStatus(dirtyRes.stdout) : [];
  const dirty = dirtyFiles.length > 0;

  const commitsRes = pending ? await safeGit(['log', '--format=%H\u001f%s\u001f%b\u001e', `${repo.localSha}..${remoteSha}`]) : { ok: true, stdout: '' };
  const commits = parseCommits(commitsRes.stdout);
  const latestCommit = commits[commits.length - 1] || null;

  const nameStatusRes = pending ? await safeGit(['diff', '--name-status', `${repo.localSha}..${remoteSha}`]) : { ok: true, stdout: '' };
  const numstatRes = pending ? await safeGit(['diff', '--numstat', `${repo.localSha}..${remoteSha}`]) : { ok: true, stdout: '' };
  const patchRes = pending ? await safeGit(['diff', '--unified=3', `${repo.localSha}..${remoteSha}`], { timeout: 60000 }) : { ok: true, stdout: '' };
  const numMap = parseNumstat(numstatRes.stdout);
  const changedFiles = parseNameStatus(nameStatusRes.stdout).map((item) => ({
    ...item,
    additions: numMap.get(item.path)?.additions ?? 0,
    deletions: numMap.get(item.path)?.deletions ?? 0,
  }));

  const patch = patchRes.ok ? patchRes.stdout.slice(0, 180000) : '';
  const currentCommitRes = repo.localSha ? await safeGit(['log', '-1', '--format=%H\u001f%s\u001f%b', repo.localSha]) : { ok: true, stdout: '' };
  const currentCommit = parseCommits(`${currentCommitRes.stdout}\u001e`)[0] || null;

  const checkedAt = Date.now();
  await saveUpdateState({
    ...state,
    lastCheckedAt: checkedAt,
    localSha: repo.localSha,
    targetSha: remoteSha,
    branch: repo.branch,
    message: pending ? `${behind} update${behind === 1 ? '' : 's'} available.` : 'Already up to date.',
    phase: state.phase || '',
  });

  return {
    ok: true,
    repo,
    settings,
    state: {
      ...state,
      lastCheckedAt: checkedAt,
      localSha: repo.localSha,
      targetSha: remoteSha,
      branch: repo.branch,
    },
    summary: {
      pending,
      dirty,
      dirtyFiles,
      ahead,
      behind,
      currentCommit,
      latestCommit,
      commits,
      changedFiles,
      patch,
      fetched: refresh,
      fetchError: fetchResult.ok ? '' : fetchResult.error,
      checkedAt,
      checkedAtIso: toIso(checkedAt),
      lastUpdatedAtIso: toIso(state.lastUpdatedAt),
    },
  };
}

export function buildRestartScript({ branch, remote, currentPid, runInstall, previousSha }) {
  const installStep = runInstall
    ? (existsSync(join(REPO_DIR, 'package-lock.json')) ? 'npm ci --no-fund --no-audit' : 'npm install --no-fund --no-audit')
    : `echo '[update] package install skipped'`;
  return `
set -e
cd ${JSON.stringify(REPO_DIR)}
echo "[update] fetching ${remote}/${branch}" >> ${JSON.stringify(TMP_LOG)}
git fetch ${JSON.stringify(remote)} ${JSON.stringify(branch)} --tags >> ${JSON.stringify(TMP_LOG)} 2>&1
echo "[update] pulling ${remote}/${branch}" >> ${JSON.stringify(TMP_LOG)}
git pull --ff-only ${JSON.stringify(remote)} ${JSON.stringify(branch)} >> ${JSON.stringify(TMP_LOG)} 2>&1
echo "[update] installing dependencies" >> ${JSON.stringify(TMP_LOG)}
if ! ${installStep} >> ${JSON.stringify(TMP_LOG)} 2>&1; then
  echo "[update] install failed; rolling back" >> ${JSON.stringify(TMP_LOG)}
  git reset --hard ${JSON.stringify(previousSha)} >> ${JSON.stringify(TMP_LOG)} 2>&1
  ${installStep} >> ${JSON.stringify(TMP_LOG)} 2>&1 || true
  exit 1
fi
sleep 1
kill ${Number(currentPid) || process.pid} >/dev/null 2>&1 || true
nohup npm start >> ${JSON.stringify(TMP_LOG)} 2>&1 &
`;
}

export async function applyUpdate({ requestedBy = 'manual' } = {}) {
  const capability = updaterCapability();
  if (!capability.supported) {
    const state = await saveUpdateState({ ...(await loadUpdateState()), status: 'blocked', phase: 'platform-gate', message: capability.reason, lastErrorAt: Date.now() });
    return { ok: false, applied: false, reason: 'unsupported-platform', capability, state };
  }
  const status = await getUpdateSummary({ refresh: true });
  const priorState = await loadUpdateState();
  const pendingCommits = Array.isArray(status.summary?.commits) ? status.summary.commits : [];
  if (!status.summary.pending) {
    await saveUpdateState({
      ...priorState,
      status: 'idle',
      phase: '',
      message: 'Already up to date.',
      localSha: status.repo.localSha,
      targetSha: status.repo.localSha,
      branch: status.repo.branch,
    });
    return { ok: true, applied: false, reason: 'up-to-date', status };
  }
  if (status.summary.dirty) {
    const state = await saveUpdateState({
      ...priorState,
      status: 'blocked',
      phase: 'preflight',
      message: 'Update blocked because local repo has uncommitted changes.',
      lastErrorAt: Date.now(),
      localSha: status.repo.localSha,
      targetSha: status.state.targetSha,
      branch: status.repo.branch,
      changedFiles: status.summary.dirtyFiles,
    });
    return { ok: false, applied: false, reason: 'dirty-working-tree', state, status };
  }

  const changedPaths = status.summary.changedFiles.map((file) => file.path);
  const runInstall = changedPaths.some((path) => ['package.json', 'package-lock.json', 'npm-shrinkwrap.json'].includes(path)) || !existsSync(join(REPO_DIR, 'node_modules'));
  const nextState = await saveUpdateState({
    ...priorState,
    status: 'applying',
    phase: requestedBy === 'auto' ? 'auto-update' : 'manual-update',
    message: `Applying ${pendingCommits.length || status.summary.behind} update${(pendingCommits.length || status.summary.behind) === 1 ? '' : 's'} from ${status.repo.remote}/${status.repo.branch}...`,
    localSha: status.repo.localSha,
    previousSha: status.repo.localSha,
    targetSha: status.state.targetSha,
    branch: status.repo.branch,
    runInstall,
    commitsApplied: pendingCommits,
    changedFiles: status.summary.changedFiles,
  });

  const script = buildRestartScript({
    branch: status.repo.branch,
    remote: status.repo.remote,
    currentPid: process.pid,
    runInstall,
    previousSha: status.repo.localSha,
  });
  const child = spawn('bash', ['-lc', script], {
    cwd: REPO_DIR,
    detached: true,
    stdio: 'ignore',
    env: { ...process.env },
  });
  child.unref();

  return {
    ok: true,
    applied: true,
    scheduled: true,
    requestedBy,
    restart: true,
    state: nextState,
    summary: {
      pendingCommits,
      changedFiles: status.summary.changedFiles,
      runInstall,
      targetSha: status.state.targetSha,
    },
  };
}

let autoUpdateTimer = null;
let autoUpdateRunning = false;

// Probe a local HTTP(S) endpoint until it returns a 2xx, or until timeout.
// `check` is injectable for testing without a live server.
export async function verifyUpdateHealth({
  port, host = '127.0.0.1', basePath = '', secure = false,
  path: healthPath = '/api/health', timeoutMs = 30000, intervalMs = 1000,
  check,
} = {}) {
  const deadline = Date.now() + Math.max(1000, timeoutMs);
  if (typeof check === 'function') {
    // eslint-disable-next-line no-await-in-loop
    while (Date.now() < deadline) {
      try {
        const res = await check();
        if (res && (res.ok || (res.status >= 200 && res.status < 400))) return { healthy: true, checkedAt: Date.now() };
      } catch { /* keep polling */ }
      // eslint-disable-next-line no-await-in-loop
      if (Date.now() < deadline) await sleep(intervalMs);
    }
    return { healthy: false, checkedAt: Date.now() };
  }
  const lib = secure ? https : http;
  const url = `${secure ? 'https' : 'http'}://${host}:${port}${basePath}${healthPath}`;
  while (Date.now() < deadline) {
    try {
      const ok = await new Promise((resolve) => {
        const req = lib.get(url, { timeout: Math.min(5000, intervalMs) }, (res) => {
          res.resume();
          resolve(res.statusCode >= 200 && res.statusCode < 400);
        });
        req.on('error', () => resolve(false));
        req.on('timeout', () => { req.destroy(); resolve(false); });
      });
      if (ok) return { healthy: true, checkedAt: Date.now() };
    } catch { /* keep polling */ }
    if (Date.now() < deadline) await sleep(intervalMs);
  }
  return { healthy: false, checkedAt: Date.now() };
}

// Revert the working tree to a known-good SHA and (optionally) reinstall deps.
// `runner` is injectable for testing; defaults to real git + npm.
export async function performRollback({ previousSha, runInstall = true, runner } = {}) {
  if (!previousSha) return { ok: false, reason: 'no-previous-sha' };
  const exec = typeof runner === 'function'
    ? runner
    : async (cmd, args) => { await execFileAsync(cmd, args, { cwd: REPO_DIR, timeout: 120000, maxBuffer: 1024 * 1024 * 8, env: { ...process.env } }); return true; };
  try {
    await exec('git', ['reset', '--hard', previousSha]);
    if (runInstall) {
      const installStep = existsSync(join(REPO_DIR, 'package-lock.json')) ? 'npm ci --no-fund --no-audit' : 'npm install --no-fund --no-audit';
      await exec('bash', ['-lc', installStep]);
    }
    return { ok: true, rolledBackTo: previousSha };
  } catch (err) {
    return { ok: false, reason: redactSecrets(err?.stderr || err?.message || 'rollback command failed') };
  }
}

export async function finalizePostRestartUpdateState({ verify = verifyUpdateHealth, rollback = performRollback, getHead, serverInfo } = {}) {
  const state = await loadUpdateState();
  if (state.status !== 'applying') return state;
  const headSha = typeof getHead === 'function' ? await getHead() : (await safeGit(['rev-parse', 'HEAD'])).stdout;
  const currentSha = String(headSha || '').trim();
  const shaMatches = !!currentSha && !!state.targetSha && currentSha === state.targetSha;

  // SHA check alone isn't enough: the new process must actually boot healthy.
  // Without this, a code change that crashes on startup leaves the server
  // permanently down with no recovery.
  let health = { healthy: true, checkedAt: Date.now() };
  if (shaMatches) {
    if (serverInfo?.port) {
      const probe = await verify({
        port: serverInfo.port, host: serverInfo.host || '127.0.0.1', basePath: serverInfo.basePath || '', secure: !!serverInfo.secure,
      });
      const healthy = !!(probe && (probe.healthy ?? probe.ok ?? (typeof probe.status === 'number' && probe.status >= 200 && probe.status < 400)));
      health = { healthy, checkedAt: Date.now() };
    } else {
      // No listening server info available (unit/scenario test) — treat SHA match as success.
      health = { healthy: true, checkedAt: Date.now() };
    }
  }

  if (shaMatches && health.healthy) {
    return await saveUpdateState({
      ...state,
      status: 'ok',
      phase: 'completed',
      message: 'CommandCenter updated successfully and restarted.',
      lastUpdatedAt: Date.now(),
      localSha: currentSha || state.localSha,
    });
  }

  // Boot failed (SHA mismatch or unhealthy) — roll back to the previous SHA.
  const target = state.previousSha;
  if (!target) {
    return await saveUpdateState({
      ...state,
      status: 'error',
      phase: 'verification-failed',
      message: `Update verification failed${health.healthy ? '' : ' (health check did not pass)'} and no previous SHA was recorded for rollback.`,
      lastErrorAt: Date.now(),
      localSha: currentSha || state.localSha,
    });
  }
  const result = await rollback({ previousSha: target, runInstall: state.runInstall !== false });
  if (!result.ok) {
    return await saveUpdateState({
      ...state,
      status: 'error',
      phase: 'rollback-failed',
      message: `Update verification failed and automatic rollback failed: ${result.reason}`,
      lastErrorAt: Date.now(),
      localSha: currentSha || state.localSha,
    });
  }
  // Record a pending restart-rollback so the next boot (old code) finalizes cleanly.
  return await saveUpdateState({
    ...state,
    status: 'rolling-back',
    phase: 'rollback',
    message: `Update verification failed (${health.healthy ? 'SHA mismatch' : 'health check did not pass'}); rolled back to ${target.slice(0, 7)} and restarting.`,
    lastErrorAt: Date.now(),
    localSha: target,
    targetSha: target,
  });
}

export async function runAutoUpdateCheck() {
  if (autoUpdateRunning) return { ok: false, skipped: true, reason: 'already-running' };
  autoUpdateRunning = true;
  try {
    const settings = await loadUpdateSettings();
    if (settings.autoUpdateEnabled === false) return { ok: true, skipped: true, reason: 'disabled' };
    const summary = await getUpdateSummary({ refresh: true });
    if (!summary.summary.pending) return { ok: true, skipped: true, reason: 'up-to-date', summary };
    if (summary.summary.dirty) {
      await saveUpdateState({
        ...(await loadUpdateState()),
        status: 'blocked',
        phase: 'auto-update',
        message: 'Auto-update skipped because local repo has uncommitted changes.',
        lastErrorAt: Date.now(),
        localSha: summary.repo.localSha,
        targetSha: summary.state.targetSha,
        branch: summary.repo.branch,
        changedFiles: summary.summary.dirtyFiles,
      });
      return { ok: false, skipped: true, reason: 'dirty-working-tree', summary };
    }
    return await applyUpdate({ requestedBy: 'auto' });
  } finally {
    autoUpdateRunning = false;
  }
}

export async function startAutoUpdateScheduler() {
  if (autoUpdateTimer) clearInterval(autoUpdateTimer);
  const settings = await loadUpdateSettings();
  const intervalMs = Math.max(60 * 60 * 1000, Number(settings.checkIntervalHours || 6) * 60 * 60 * 1000);
  setTimeout(() => { runAutoUpdateCheck().catch((err) => console.error('[update] initial auto-update check failed:', err.message)); }, 90 * 1000);
  autoUpdateTimer = setInterval(() => {
    runAutoUpdateCheck().catch((err) => console.error('[update] scheduled auto-update check failed:', err.message));
  }, intervalMs);
  return { intervalMs, settings };
}

export async function getUpdatePayload({ refresh = true } = {}) {
  const settings = await loadUpdateSettings();
  const state = await loadUpdateState();
  const summary = await getUpdateSummary({ refresh });
  return {
    ok: true,
    settings,
    state: await loadUpdateState(),
    repo: summary.repo,
    update: summary.summary,
    capability: updaterCapability(),
  };
}
