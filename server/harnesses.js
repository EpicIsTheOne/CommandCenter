// Harness registry: normalizes every agent runtime (Hermes profiles, relay
// agents, OpenClaw rosters, local CLIs) behind one capability-truthful shape.
// Nothing here fakes a capability: if a harness cannot launch tasks, the
// record says so and the UI renders that honestly.
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { hermesBinCandidates, hermesStateDbPath } from './hermes-bin.js';

function runFirst(candidates, args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const attempts = candidates.slice();
    const tryNext = () => {
      const bin = attempts.shift();
      if (!bin || settled) return resolve({ ok: false, error: 'no candidate succeeded' });
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (settled) return;
        if (err && !stdout) {
          tryNext();
          return;
        }
        settled = true;
        resolve({ ok: !err, stdout: String(stdout || ''), stderr: String(stderr || ''), bin });
      });
    };
    tryNext();
  });
}

export function parseProfilesTable(stdout = '') {
  const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trimEnd());
  const profiles = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Profile') || trimmed.startsWith('─')) continue;
    const clean = trimmed.replace(/^◆\s*/, '').trim();
    const cols = clean.split(/\s{2,}/).map((col) => col.trim()).filter(Boolean);
    const profile = cols[0] || '';
    if (!profile) continue;
    const gatewayIdx = cols.findIndex((col) => ['running', 'stopped'].includes(String(col).toLowerCase()));
    profiles.push({
      profile,
      model: gatewayIdx > 0 ? cols.slice(1, gatewayIdx).join(' ') : (cols[1] || ''),
      gateway: gatewayIdx >= 0 ? String(cols[gatewayIdx]).toLowerCase() : '',
    });
  }
  return profiles;
}

export function parseProfileShow(stdout = '') {
  const details = {};
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(/^([^:]+):\s+(.*)$/);
    if (!match) continue;
    details[String(match[1] || '').trim().toLowerCase()] = String(match[2] || '').trim();
  }
  return details;
}

async function detectHermesHarness() {
  const started = Date.now();
  try {
    const listed = await runFirst(hermesBinCandidates(), ['profile', 'list']);
    if (!listed.stdout) {
      return {
        id: 'hermes',
        kind: 'hermes',
        label: 'Hermes',
        available: false,
        connected: false,
        capabilities: { launchSession: false, monitorSessions: false, listSessions: false, steer: false },
        agents: [],
        detail: `Hermes CLI not found (tried: ${hermesBinCandidates().join(', ')})`,
        lastCheckMs: Date.now() - started,
      };
    }
    const profiles = parseProfilesTable(listed.stdout);
    // Profile details resolve in parallel — each CLI invocation costs seconds
    // of Python startup, and serial calls compound badly.
    const detailed = await Promise.all(profiles.slice(0, 24).map(async (record) => {
      let path = '';
      try {
        const shown = await runFirst([listed.bin], ['profile', 'show', record.profile], { timeoutMs: 10000 });
        path = parseProfileShow(shown.stdout).path || '';
      } catch {}
      return { record, path };
    }));
    const agents = [];
    for (const { record, path } of detailed) {
      const db = hermesStateDbPath(path);
      const dbLive = db && existsSync(db);
      agents.push({
        id: `hermes:${record.profile}`,
        label: record.profile === 'default' ? 'Hermes (default)' : `Hermes ${record.profile}`,
        harnessId: 'hermes',
        profile: record.profile,
        model: record.model || '',
        home: path,
        stateDb: db,
        stateDbPresent: Boolean(dbLive),
        gatewayState: record.gateway || '',
        online: record.gateway === 'running' || Boolean(dbLive),
      });
    }
    return {
      id: 'hermes',
      kind: 'hermes',
      label: 'Hermes',
      available: agents.length > 0,
      connected: agents.some((agent) => agent.online),
      capabilities: { launchSession: true, monitorSessions: true, listSessions: true, steer: false },
      agents,
      detail: `${agents.length} profile${agents.length === 1 ? '' : 's'} detected via ${listed.bin}`,
      lastCheckMs: Date.now() - started,
    };
  } catch (error) {
    return {
      id: 'hermes', kind: 'hermes', label: 'Hermes', available: false, connected: false,
      capabilities: { launchSession: false, monitorSessions: false, listSessions: false, steer: false },
      agents: [], detail: error?.message || 'Hermes detection failed', lastCheckMs: Date.now() - started,
    };
  }
}

function relaySnapshot() {
  // Lazy import avoids a cycle with relay-agent-source at module load.
  try {
    const source = globalThis.__ccRelayAgentSource;
    if (source && typeof source.getAgents === 'function') {
      const agents = source.getAgents();
      const status = source.getStatus();
      return {
        id: 'relay', kind: 'relay', label: 'Relay',
        available: Array.isArray(agents) && agents.length > 0,
        connected: Boolean(status.connected),
        capabilities: { launchSession: true, monitorSessions: true, listSessions: true, steer: status.steerSupported !== false },
        agents: (Array.isArray(agents) ? agents : []).slice(0, 64).map((agent) => ({
          id: String(agent.id || ''),
          label: String(agent.label || agent.name || agent.id || 'Relay agent'),
          harnessId: 'relay',
          machineHint: agent.machine || agent.host || '',
          online: agent.connected !== false,
        })),
        detail: status.enabled ? (status.connected ? 'Relay hub connected.' : 'Relay enabled but not connected.') : 'Relay disabled.',
        lastCheckMs: 0,
      };
    }
  } catch {}
  return null;
}

let cache = { at: 0, harnesses: [] };
const CACHE_MS = 20000;

export async function listHarnesses({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.at && now - cache.at < CACHE_MS) return cache.harnesses;

  const results = await Promise.all([detectHermesHarness()]);
  const harnesses = results.filter(Boolean);

  const relay = relaySnapshot();
  if (relay) harnesses.push(relay);

  cache = { at: now, harnesses };
  return harnesses.map((harness) => structuredClone(harness));
}

export function invalidateHarnessCache() {
  cache = { at: 0, harnesses: [] };
}

export async function getHarness(id = '') {
  const key = String(id || '').trim().toLowerCase();
  const harnesses = await listHarnesses();
  return harnesses.find((harness) => harness.id.toLowerCase() === key) || null;
}
