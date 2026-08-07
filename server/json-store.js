import { constants as fsConstants } from 'node:fs';
import { copyFile, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { dirname, basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';

const queues = new Map();

export class JsonStoreCorruptionError extends Error {
  constructor(filePath, cause, backupError = null) {
    super(`JSON store is corrupt: ${filePath}`);
    this.name = 'JsonStoreCorruptionError';
    this.filePath = filePath;
    this.cause = cause;
    this.backupError = backupError;
  }
}

function backupPath(filePath) {
  return `${filePath}.bak`;
}

async function parseFile(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

export async function readJsonStore(filePath, { defaultValue, recoverBackup = true, version, migrations = {} } = {}) {
  let data;
  try {
    data = await parseFile(filePath);
  } catch (err) {
    if (err?.code === 'ENOENT') {
      return typeof defaultValue === 'function' ? defaultValue() : structuredClone(defaultValue);
    }
    if (recoverBackup) {
      try {
        const recovered = await parseFile(backupPath(filePath));
        console.error(`[json-store] Corruption detected in ${basename(filePath)}; using last-known-good backup.`);
        return recovered;
      } catch (backupError) {
        throw new JsonStoreCorruptionError(filePath, err, backupError);
      }
    }
    throw new JsonStoreCorruptionError(filePath, err);
  }
  // Optional schema migration: bring older on-disk shapes up to `version`.
  if (typeof version === 'number') {
    const current = typeof data?.version === 'number' ? data.version : 0;
    if (current !== version) {
      let migrated = data;
      for (let v = current + 1; v <= version; v += 1) {
        const step = migrations[v];
        if (typeof step === 'function') migrated = await step(migrated);
      }
      if (migrated?.version !== version) migrated = { ...migrated, version };
      // Persist the upgraded shape so subsequent reads are cheap and stable.
      try { await writeJsonStore(filePath, migrated); } catch (writeErr) {
        console.error(`[json-store] Migration of ${basename(filePath)} succeeded in memory but failed to persist: ${writeErr?.message || writeErr}`);
      }
      return migrated;
    }
  }
  return data;
}

async function atomicWrite(filePath, value, { mode = 0o600, backup = true } = {}) {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });
  const temp = join(dir, `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let handle;
  try {
    if (backup) {
      try {
        JSON.parse(await readFile(filePath, 'utf8'));
        await copyFile(filePath, backupPath(filePath), fsConstants.COPYFILE_FICLONE);
      } catch (err) {
        if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) throw err;
      }
    }
    handle = await open(temp, 'wx', mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temp, filePath);
  } finally {
    await handle?.close().catch(() => {});
    await unlink(temp).catch(() => {});
  }
  return value;
}

export function withJsonStoreLock(filePath, operation) {
  const prior = queues.get(filePath) || Promise.resolve();
  const next = prior.catch(() => {}).then(operation);
  const queued = next.finally(() => {
    if (queues.get(filePath) === queued) queues.delete(filePath);
  });
  queues.set(filePath, queued);
  return next;
}

export function writeJsonStore(filePath, value, options = {}) {
  return withJsonStoreLock(filePath, () => atomicWrite(filePath, value, options));
}

export function updateJsonStore(filePath, { defaultValue, normalize = (value) => value, ...options } = {}, mutate) {
  return withJsonStoreLock(filePath, async () => {
    const current = normalize(await readJsonStore(filePath, { defaultValue }));
    const next = await mutate(current);
    return atomicWrite(filePath, normalize(next), options);
  });
}
