import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { root, loadTask } from '../src/contracts.js';
import { resolveBackbone } from '../src/backbone.js';
import { loadBackend, ScummWebBackend } from '../src/backend.js';

test('backbone resolution targets ScummWEB and rejects an AgentSCUMM checkout', async t => {
  const fixture = path.join(root, 'test/fixtures/backend');
  assert.equal((await resolveBackbone(fixture)).server, path.join(fixture, 'agent-backbone/src/server.js'));
  await assert.rejects(resolveBackbone('relative'), /Absolute ScummWEB/);
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-old-backend-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'package.json'), '{"name":"agentscumm"}');
  await assert.rejects(resolveBackbone(directory), /Not a ScummWEB checkout/);
  const file = path.join(directory, 'backend.json');
  await writeFile(file, JSON.stringify({ schema_version: 1, agentscumm_dir: directory,
    agentscumm_revision: 'a'.repeat(40), base_url: 'https://fixture.invalid', scummweb_revision: null, asset_files: [] }));
  await assert.rejects(loadBackend(file), /Unknown backend configuration field/);
});

test('old gameplay CLI cannot launch the retired AgentSCUMM backend', { timeout: 20000 }, () => {
  const result = spawnSync(process.execPath, [path.join(root, 'src/cli.js'), 'mcp', '--agentscumm', root],
    { encoding: 'utf8', timeout: 15000 });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('matching commit IDs do not make an AgentSCUMM server a ScummWEB backbone', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-source-'));
  const { task } = await loadTask(path.join(root, 'tasks/queen/hotel-laundry.v1.json'));
  const backend = new ScummWebBackend({ scummweb_dir: path.join(root, 'test/fixtures/backend'),
    scummweb_revision: 'a'.repeat(40), base_url: 'http://old-backend.invalid' }, directory, task);
  t.after(async () => { await backend.close(); await rm(directory, { recursive: true, force: true }); });
  await assert.rejects(backend.connect(), /revision does not match/);
});
