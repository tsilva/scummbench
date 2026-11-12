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
  client = new McpClient(process.execPath, [path.join(root, 'src/cli.js'), 'mcp', '--no-wandb', '--scummweb',
    path.join(root, 'test/fixtures/backend'), '--', '--base-url', 'http://success.invalid'],
  { env: { SCUMMBENCH_RUNS_DIR: store, SCUMMBENCH_WANDB_CONFIG: path.join(directory, 'missing-config.json') } });
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

test('interactive gateway automatically publishes each new session to its canonical game project without grading it', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-gateway-wandb-'));
  const store = path.join(directory, 'runs');
  const client = new McpClient(process.execPath, [path.join(root, 'test/fixtures/wandb-gateway.js'), directory,
    '--scummweb', path.join(root, 'test/fixtures/backend'), '--', '--base-url', 'http://success.invalid'],
  { env: { SCUMMBENCH_RUNS_DIR: store } });
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect();
  const ids = [];
  for (let i = 0; i < 2; i++) {
    await client.call('session', { operation: 'start', game: ['flight-of-the-amazon-queen', 'beneath-a-steel-sky'][i] });
    const status = textResult(await client.call('status')).scummbench;
    ids.push(status.run_id);
    await client.call('observe');
    await client.call('session', { operation: 'close' });
    const receipt = JSON.parse(await readFile(path.join(status.run_directory, 'wandb.json')));
    assert.equal(receipt.state, 'synced');
    assert.equal(receipt.run_id, status.run_id);
    assert.equal(receipt.entity, 'tsilva');
    assert.equal(receipt.project, ['scummbench-queen', 'scummbench-sky'][i]);
    const manifest = JSON.parse(await readFile(path.join(status.run_directory, 'run.json')));
    assert.equal(manifest.usage.observations, 1);
  }
  assert.notEqual(ids[0], ids[1]);
  const posts = (await readFile(path.join(directory, 'wire.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(posts.filter(post => post.endpoint === '/graphql').map(post => post.body.variables.name), ids);
  assert.equal(posts.filter(post => post.body?.complete).length, 2);
  assert.ok(posts.some(post => post.body?.files?.['wandb-history.jsonl']));
  assert.doesNotMatch(JSON.stringify(posts), /"success"|iVBOR|screenshots|sessionId|native_receipt|run_directory/);
  assert.ok(posts.filter(post => post.event === 'worker').every(post => !post.credential_present && !post.proxy_present));
});
