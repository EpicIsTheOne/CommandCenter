import { spawn, execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { resolvePython } from './platform-capabilities.js';

const ROOT = process.cwd();
let worker = null;
let rl = null;
const pending = [];
let unavailableReason = '';

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

async function ensureWorker() {
  await mkdir(join(ROOT, '.cache'), { recursive: true });
  if (worker && !worker.killed) return;

  const python = await resolvePython();
  if (!python) {
    unavailableReason = 'Python 3 is not available.';
    throw new Error(unavailableReason);
  }
  worker = spawn(python.command, [...python.args, join(ROOT, 'server', 'wake_keyword_detector.py')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  worker.once('error', (err) => {
    unavailableReason = `Wake keyword detector unavailable: ${err.message}`;
    while (pending.length) pending.shift().reject(new Error(unavailableReason));
    worker = null;
    rl?.close();
    rl = null;
  });

  rl = readline.createInterface({ input: worker.stdout });
  rl.on('line', (line) => {
    const job = pending.shift();
    if (!job) return;
    try {
      const msg = JSON.parse(line);
      if (!msg.ok) job.reject(new Error(msg.error || 'Keyword detection failed'));
      else job.resolve(msg.match || null);
    } catch (err) {
      job.reject(err);
    }
  });

  worker.stderr.on('data', (buf) => {
    const text = buf.toString();
    if (text.trim()) console.error('[wake-keyword]', text.trim());
  });

  worker.on('exit', () => {
    while (pending.length) pending.shift().reject(new Error('Keyword detector exited'));
    worker = null;
    rl = null;
  });
}

async function toWavFile(audioBuffer, filename = 'wake.webm') {
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = join(tmpdir(), `wakek-${id}-${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
  const wavFile = join(tmpdir(), `wakek-${id}.wav`);
  await writeFile(inFile, audioBuffer);
  try {
    await run('ffmpeg', ['-y', '-i', inFile, '-ac', '1', '-ar', '16000', wavFile], { maxBuffer: 20 * 1024 * 1024 });
    return { inFile, wavFile };
  } catch (err) {
    await unlink(inFile).catch(() => {});
    throw err;
  }
}

export async function warmWakeKeywordDetector() {
  await ensureWorker();
}

export function getWakeKeywordDetectorStatus() {
  return { available: !!worker && !worker.killed, reason: unavailableReason };
}

export async function detectWakeKeyword(audioBuffer, filename = 'wake.webm') {
  await ensureWorker();
  const { inFile, wavFile } = await toWavFile(audioBuffer, filename);
  try {
    return await new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      if (!worker?.stdin?.writable) return reject(new Error(unavailableReason || 'Wake keyword detector is unavailable'));
      worker.stdin.write(JSON.stringify({ audio: wavFile }) + '\n');
    });
  } finally {
    await unlink(inFile).catch(() => {});
    await unlink(wavFile).catch(() => {});
  }
}
