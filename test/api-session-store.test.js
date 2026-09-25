import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);

test('API session store keeps index and session metadata consistent through create, save, and delete', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cc-api-sessions-'));
  const previous = process.env.COMMANDCENTER_DATA_DIR;
  process.env.COMMANDCENTER_DATA_DIR = directory;
  try {
    const script = [
      "import { appendApiSessionMessage, createApiSession, deleteApiSession, getApiSession, listApiSessions, saveApiSession } from './server/api-session-store.js';",
      "const created = await createApiSession({ agent: 'main', title: 'Regression' });",
      "const appended = await appendApiSessionMessage(created.id, { role: 'user', text: 'hello' });",
      "if (appended.message.text !== 'hello') throw new Error('message append failed');",
      "const updated = await saveApiSession({ ...appended.session, title: 'Updated' });",
      "if ((await getApiSession(updated.id)).title !== 'Updated') throw new Error('session read failed');",
      "if ((await listApiSessions()).length !== 1) throw new Error('index read failed');",
      "if (!(await deleteApiSession(updated.id))) throw new Error('delete failed');",
      "if (await getApiSession(updated.id)) throw new Error('deleted session still exists');",
      "if ((await listApiSessions()).length !== 0) throw new Error('index delete failed');",
    ].join(';');
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, COMMANDCENTER_DATA_DIR: directory } });
  } finally {
    if (previous === undefined) delete process.env.COMMANDCENTER_DATA_DIR;
    else process.env.COMMANDCENTER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test('API session store rejects path traversal identifiers', async () => {
  const previous = process.env.COMMANDCENTER_DATA_DIR;
  const directory = await mkdtemp(join(tmpdir(), 'cc-api-sessions-'));
  process.env.COMMANDCENTER_DATA_DIR = directory;
  try {
    const script = [
      "import { deleteApiSession, getApiSession } from './server/api-session-store.js';",
      "if (await getApiSession('../escape') !== null) throw new Error('traversal read failed');",
      "if (await deleteApiSession('../escape') !== false) throw new Error('traversal delete failed');",
    ].join(';');
    await execFileAsync(process.execPath, ['--input-type=module', '-e', script], { cwd: process.cwd(), env: { ...process.env, COMMANDCENTER_DATA_DIR: directory } });
  } finally {
    if (previous === undefined) delete process.env.COMMANDCENTER_DATA_DIR;
    else process.env.COMMANDCENTER_DATA_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
