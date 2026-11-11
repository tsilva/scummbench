import { mkdir, readFile, writeFile, rename, lstat, rm } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { root } from '../src/contracts.js';
import { createResultsFeed } from '../src/results-feed.js';
import { validateResults } from '../web/results-model.js';

if (process.argv.slice(2).join(' ') !== '--once') throw new Error('Use --once.');
const directory = path.join(root, '.internal/publication');
const configFile = path.join(root, 'local/results-publication.json');
async function config() {
  const info = await lstat(configFile);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('Invalid publication configuration');
  const value = JSON.parse(await readFile(configFile, 'utf8'));
  if (value.version !== 1 || value.enabled !== true || value.launcher !== 'scripts/results-agent-vault.py') throw new Error('Invalid publication configuration');
  return value;
}
async function atomic(name, value) {
  const pending = path.join(directory, `${name}.${process.pid}.pending`);
  await writeFile(pending, JSON.stringify(value) + '\n', { mode: 0o600, flag: 'wx' });
  await rename(pending, path.join(directory, name));
}
async function run() {
  await config();
  for (const item of [path.join(root, '.internal'), directory]) {
    try { if ((await lstat(item)).isSymbolicLink()) throw new Error('Linked publication state'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, 'sync.lock');
  try { await mkdir(lock); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Reclaim only a lock with a recorded, absent owner process.
    let owner;
    try { owner = JSON.parse(await readFile(path.join(lock, 'owner.json'), 'utf8')); } catch { return; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) return;
    try { process.kill(owner.pid, 0); return; } catch (failure) { if (failure.code !== 'ESRCH') return; }
    await rm(lock, { recursive: true }); await mkdir(lock);
  }
  try {
    await writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid }), { flag: 'wx', mode: 0o600 });
    const data = validateResults(await createResultsFeed({ verifyArchiveManifests: true })());
    let receipt;
    try { receipt = JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')); } catch { /* First publication. */ }
    if (receipt?.revision === data.revision && receipt.status === 'published') return;
    await atomic('outbox.json', data);
    const status = await new Promise(resolve => {
      const child = spawn('python3', ['-I', '-B', path.join(root, 'scripts/results-agent-vault.py')], {
        cwd: root, stdio: 'ignore', env: { HOME: process.env.HOME, PATH: process.env.PATH },
      });
      child.once('error', () => resolve(1)); child.once('close', code => resolve(code));
    });
    if (status !== 0) await atomic('status.json', { status: 'pending', revision: data.revision, reason: 'Publication unavailable; retrying automatically', checked_at: new Date().toISOString() });
    else await atomic('status.json', { status: 'published', revision: data.revision, checked_at: new Date().toISOString() });
  } finally { await rm(lock, { recursive: true }); }
}
try { await run(); } catch { process.exitCode = 1; }
