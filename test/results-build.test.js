import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Exercise the real publisher in an isolated checkout with no private artifacts.
test('public build preserves unknown metrics and rejects extra output or linked assets', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'scummbench-public-build-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    await cp(new URL('../scripts/build-results.js', import.meta.url), path.join(root, 'scripts/build-results.js'));
    await cp(new URL('../web/', import.meta.url), path.join(root, 'web'), { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{"type":"module"}');
    await mkdir(path.join(root, 'runs'));
    await writeFile(path.join(root, 'runs/private.json'), 'private evidence');
    const build = () => execFileSync(process.execPath, ['scripts/build-results.js'], {
      cwd: root, env: { ...process.env, VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) }, stdio: 'pipe',
    });
    build();
    const source = JSON.parse(await readFile(path.join(root, 'web/results.json')));
    const published = JSON.parse(await readFile(path.join(root, 'dist/results.json')));
    assert.deepEqual(published, source);
    assert.equal(JSON.parse(await readFile(path.join(root, 'dist/build-info.json'))).commit, 'a'.repeat(40));
    await assert.rejects(readFile(path.join(root, 'dist/runs/private.json')), { code: 'ENOENT' });
    await writeFile(path.join(root, 'dist/unexpected.json'), 'private evidence');
    assert.throws(build, /Unexpected build output/);
    await rm(path.join(root, 'dist/unexpected.json'));
    await symlink(path.join(root, 'runs/private.json'), path.join(root, 'web/fonts/private'));
    assert.throws(build, /Linked public asset/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
