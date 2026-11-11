import { cp, mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateResults } from '../web/results-model.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
const data = validateResults(JSON.parse(await readFile(path.join(root, 'web/results.json'), 'utf8')));
if (data.publication?.mode !== 'snapshot') throw new Error('Export a verified public results snapshot before building.');
const files = ['index.html', 'styles.css', 'app.js', 'chart.js', 'results-model.js', 'live-results.js', 'sample-data.js', 'results.json', 'favicon.png', 'fonts'];
async function inventory(directory, prefix = '') {
  const result = [];
  for (const name of await readdir(directory)) {
    const relative = prefix + name, info = await lstat(path.join(directory, name));
    if (info.isSymbolicLink()) throw new Error('Linked public asset');
    if (info.isDirectory()) result.push(...await inventory(path.join(directory, name), relative + '/'));
    else if (info.isFile()) result.push(relative);
    else throw new Error('Unsupported public asset');
  }
  return result;
}
const allowed = new Set(['build-info.json']);
for (const name of files) {
  const info = await lstat(path.join(root, 'web', name));
  if (info.isSymbolicLink()) throw new Error('Linked public asset');
  for (const relative of info.isDirectory() ? await inventory(path.join(root, 'web', name), name + '/') : [name]) allowed.add(relative);
}
try { if ((await lstat(output)).isSymbolicLink()) throw new Error('Linked build output'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
await mkdir(output, { recursive: true });
if ((await inventory(output)).some(name => !allowed.has(name))) throw new Error('Unexpected build output; clean it before publishing.');
for (const name of files) await cp(path.join(root, 'web', name), path.join(output, name), { recursive: true });
const commit = process.env.VERCEL_GIT_COMMIT_SHA ?? execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Missing source commit identity');
await writeFile(path.join(output, 'build-info.json'), JSON.stringify({ commit, results_revision: data.revision, records: data.diagnostics.discovered }) + '\n');
console.log(`Built results page with ${data.diagnostics.discovered} published records.`);
