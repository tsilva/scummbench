import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { root, loadTask } from '../src/contracts.js';

async function check(directory) {
  for (const name of await readdir(directory)) {
    const file = path.join(directory, name);
    if ((await stat(file)).isDirectory()) await check(file);
    else if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    else if (file.endsWith('.json')) JSON.parse(await readFile(file, 'utf8'));
  }
}
for (const directory of ['src', 'scripts', 'test', 'examples', 'schemas', 'tasks', 'web']) await check(path.join(root, directory));
await loadTask(path.join(root, 'tasks/queen/hotel-laundry.v1.json'));
console.log('Syntax, JSON, and task contract checks passed.');
