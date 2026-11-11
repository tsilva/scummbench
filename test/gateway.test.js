import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpClient, textResult } from '../src/process.js';
import { root } from '../src/contracts.js';

test('interactive gateway mediates concurrent calls and owns a private externalized journal', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-gateway-'));
  let client;
  t.after(async () => { await client?.close(); await rm(directory, { recursive: true, force: true }); });
  const store = path.join(directory, 'runs');
  client = new McpClient(process.execPath, [path.join(root, 'src/cli.js'), 'mcp', '--agentscumm',
    path.join(root, 'test/fixtures/backend'), '--', '--base-url', 'http://success.invalid'], { env: { SCUMMBENCH_RUNS_DIR: store } });
  await client.connect();
  const status = textResult(await client.call('status'));
  assert.equal(status.scummbench.mediated, true);
  assert.equal(status.scummbench.results_owner, 'scummbench');
  assert.equal(status.scummbench.run_id, null);
  await client.call('session', { operation: 'start', game: 'flight-of-the-amazon-queen' });
  const results = await Promise.all([client.call('status'), client.call('status')]);
  assert.equal(textResult(results[0]).scummbench.run_id, textResult(results[1]).scummbench.run_id);
  await client.call('observe');
  const current = textResult(await client.call('status')).scummbench;
  await client.call('session', { operation: 'close' });
  const manifest = JSON.parse(await readFile(path.join(current.run_directory, 'run.json'), 'utf8'));
  assert.equal(manifest.status, 'stopped');
  assert.equal(manifest.official_eligible, false);
  assert.equal(manifest.results_owner, 'scummbench');
  const trajectory = await readFile(path.join(current.run_directory, 'trajectory.jsonl'), 'utf8');
  assert.ok(trajectory.includes('screenshots/'));
  assert.ok(!trajectory.includes('iVBOR'));
  assert.equal((await readdir(path.join(current.run_directory, 'screenshots'))).length, 1);
});
