// Machines: first-class representation of hosts that run work.
// Local machine metrics come from the OS directly; remote machines appear
// through the relay when they connect. No fabricated values: if a metric is
// unavailable on this platform, it is reported as null and the UI shows that.
import os from 'node:os';
import { platform } from 'node:process';

const HISTORY_LIMIT = 120; // ~10 minutes at 5s samples

export function clampPercent(value) {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(0, Math.min(100, Math.round(num * 10) / 10)) : null;
}

const pct = clampPercent;

function cpuTimes() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

const history = [];

function sampleCpuPercent() {
  const first = cpuTimes();
  return new Promise((resolve) => {
    const before = { ...first };
    setTimeout(() => {
      const second = cpuTimes();
      const idleDelta = second.idle - before.idle;
      const totalDelta = second.total - before.total;
      resolve(totalDelta > 0 ? pct((1 - idleDelta / totalDelta) * 100) : null);
    }, 220);
  });
}

export async function getLocalMachineSnapshot() {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const load = os.loadavg(); // zeroes on Windows
  const disk = await safeDisk();
  return {
    id: 'local',
    kind: 'local',
    label: process.env.COMMANDCENTER_LOCAL_MACHINE_LABEL || os.hostname(),
    hostname: os.hostname(),
    platformOs: `${os.type()} ${os.release()}`,
    arch: os.arch(),
    cpuModel: os.cpus()[0]?.model || '',
    cpuCores: os.cpus().length,
    cpuPercent: await sampleCpuPercent(),
    memTotalBytes: totalMem,
    memFreeBytes: freeMem,
    memUsedBytes: totalMem - freeMem,
    memPercent: totalMem > 0 ? pct(((totalMem - freeMem) / totalMem) * 100) : null,
    uptimeSeconds: Math.round(os.uptime()),
    loadAvg1: platform === 'win32' ? null : Number(load[0].toFixed(2)),
    disk: disk,
    online: true,
    source: 'local-os',
    sampledAt: new Date().toISOString(),
  };
}

async function safeDisk() {
  // Best-effort disk for the drive hosting the app; unavailable -> null.
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    if (platform === 'win32') {
      const { stdout } = await run('wmic', ['logicaldisk', 'get', 'size,freespace,caption'], { timeout: 5000, windowsHide: true });
      const lines = String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const rows = [];
      for (const line of lines) {
        const cols = line.split(/\s+/);
        const caption = cols.find((col) => /^[A-Z]:$/.test(col));
        const size = cols.find((col) => /^\d+$/.test(col));
        if (!caption || !size) continue;
        rows.push({ caption, sizeBytes: Number(size) });
      }
      // wmic column order varies; pair freespace by position fallback
      const numbers = lines.flatMap((line) => line.match(/\d+/g) || []);
      if (rows.length && numbers.length >= rows.length * 2) {
        // Build from raw pairs where possible
        for (const line of lines.slice(1)) {
          const cols = line.split(/\s+/).filter(Boolean);
          if (cols.length >= 3) {
            const caption = cols.find((col) => /^[A-Z]:$/.test(col));
            const freespace = cols.find((col) => /^\d+$/.test(col));
            const size = [...cols].reverse().find((col) => /^\d+$/.test(col) && col !== freespace);
            const row = rows.find((entry) => entry.caption === caption);
            if (row && size && !row.freeBytes) {
              row.freeBytes = Number(freespace);
              row.sizeBytes = Number(size);
            }
          }
        }
      }
      return {
        available: rows.length > 0,
        drives: rows.map((row) => ({
          caption: row.caption,
          sizeBytes: row.sizeBytes || null,
          freeBytes: row.freeBytes ?? null,
          usedPercent: row.sizeBytes && row.freeBytes != null
            ? pct(((row.sizeBytes - row.freeBytes) / row.sizeBytes) * 100)
            : null,
        })).slice(0, 8),
      };
    }
    const { stdout } = await run('df', ['-k', '-P', process.cwd()], { timeout: 5000 });
    const line = String(stdout || '').trim().split(/\r?\n/)[1];
    if (!line) return { available: false, drives: [] };
    const cols = line.split(/\s+/);
    const [, , , avail] = cols;
    return { available: true, drives: [{ caption: cols[0], sizeBytes: Number(cols[1]) * 1024, freeBytes: Number(avail) * 1024 }] };
  } catch {
    return { available: false, drives: [] };
  }
}

export function recordMachineHistorySample(snapshot) {
  if (!snapshot?.cpuPercent && !snapshot?.memPercent) return;
  history.push({ at: snapshot.sampledAt, cpuPercent: snapshot.cpuPercent, memPercent: snapshot.memPercent });
  if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
}

export function getMachineHistory(machineId = 'local') {
  return machineId === 'local' ? history.slice(-HISTORY_LIMIT) : [];
}

let cached = null;
let cachedAt = 0;

export async function listMachines() {
  const now = Date.now();
  if (cached && now - cachedAt < 4000) return cached;
  const local = await getLocalMachineSnapshot();
  const relayAgents = globalThis.__ccRelayAgentSource;
  const remote = [];
  if (relayAgents && typeof relayAgents.getAgents === 'function') {
    try {
      for (const agent of relayAgents.getAgents().slice(0, 32)) {
        const hint = agent.machine || agent.host || '';
        if (!hint) continue;
        const id = `relay:${String(agent.id || hint)}`;
        if (remote.some((machine) => machine.id === id)) continue;
        remote.push({
          id,
          kind: 'remote-relay',
          label: String(hint),
          hostname: String(hint),
          platformOs: '',
          arch: '',
          cpuModel: '',
          cpuCores: null,
          cpuPercent: null,
          memTotalBytes: null,
          memFreeBytes: null,
          memUsedBytes: null,
          memPercent: null,
          uptimeSeconds: null,
          loadAvg1: null,
          disk: { available: false, drives: [] },
          online: agent.connected !== false,
          source: 'relay',
          sampledAt: new Date().toISOString(),
          note: 'Remote machine details arrive only if its relay client reports them.',
        });
      }
    } catch {}
  }
  cached = [local, ...remote];
  cachedAt = now;
  return cached.map((machine) => structuredClone(machine));
}
