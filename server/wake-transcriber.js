import { spawn, execFile } from 'node:child_process';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';

const ROOT = process.cwd();
const PYTHONPATH = join(ROOT, '.pydeps');
const WHISPER_CACHE_DIR = join(ROOT, '.cache', 'whisper');

let worker = null;
let rl = null;
const pending = [];

async function ensureDirs() {
  await mkdir(WHISPER_CACHE_DIR, { recursive: true });
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr || err.message));
      else resolve({ stdout, stderr });
    });
  });
}

export async function warmWakeTranscriber() {
  await ensureDirs();
  if (worker && !worker.killed) return;

  worker = spawn('python3', [join(ROOT, 'server', 'wake_transcriber.py')], {
    env: {
      ...process.env,
      PYTHONPATH,
      WHISPER_CACHE_DIR,
      WAKE_WHISPER_MODEL: process.env.WAKE_WHISPER_MODEL || 'tiny.en',
      WAKE_WHISPER_COMPUTE_TYPE: process.env.WAKE_WHISPER_COMPUTE_TYPE || 'int8',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  rl = readline.createInterface({ input: worker.stdout });
  rl.on('line', (line) => {
    const job = pending.shift();
    if (!job) return;
    try {
      const msg = JSON.parse(line);
      if (!msg.ok) job.reject(new Error(msg.error || 'Wake transcription failed'));
      else job.resolve(msg.text || '');
    } catch (err) {
      job.reject(err);
    }
  });

  worker.stderr.on('data', (buf) => {
    const text = buf.toString();
    if (text.trim()) console.error('[wake-worker]', text.trim());
  });

  worker.on('exit', () => {
    while (pending.length) {
      pending.shift().reject(new Error('Wake transcriber exited'));
    }
    worker = null;
    rl = null;
  });
}

async function toWavFile(audioBuffer, filename = 'wake.webm') {
  const id = crypto.randomBytes(8).toString('hex');
  const inFile = join(tmpdir(), `wake-${id}-${filename.replace(/[^a-zA-Z0-9_.-]/g, '_')}`);
  const wavFile = join(tmpdir(), `wake-${id}.wav`);
  await writeFile(inFile, audioBuffer);
  try {
    await run('ffmpeg', ['-y', '-i', inFile, '-ac', '1', '-ar', '16000', wavFile], { maxBuffer: 20 * 1024 * 1024 });
    return { inFile, wavFile };
  } catch (err) {
    await unlink(inFile).catch(() => {});
    throw err;
  }
}

export async function transcribeWakeAudio(audioBuffer, filename = 'wake.webm') {
  await warmWakeTranscriber();
  const { inFile, wavFile } = await toWavFile(audioBuffer, filename);
  try {
    const text = await new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      worker.stdin.write(JSON.stringify({ audio: wavFile }) + '\n');
    });
    return text;
  } finally {
    await unlink(inFile).catch(() => {});
    await unlink(wavFile).catch(() => {});
  }
}
