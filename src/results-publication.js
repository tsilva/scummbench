import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { root } from './contracts.js';

// Best-effort wakeup after authoritative local evidence is final. A periodic
// publisher retries offline failures independently of gameplay and grading.
export async function requestResultsPublication() {
  try {
    const file = path.join(root, 'local/results-publication.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) return;
    const child = spawn(process.execPath, [path.join(root, 'scripts/results-sync.js'), '--once'], {
      cwd: root, detached: true, stdio: 'ignore', env: { HOME: process.env.HOME, PATH: process.env.PATH },
    });
    child.on('error', () => {}); child.unref();
  } catch { /* Local results remain authoritative; the retry job records delivery failures. */ }
}
