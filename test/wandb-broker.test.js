import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root } from '../src/contracts.js';
import { McpClient } from '../src/process.js';
import { loadWandb, wandbUpsert, defaultWandbConfig } from '../src/wandb.js';
import { loadWandbRoute, createBrokeredWandbTransport } from '../src/wandb-broker.js';
import { validateWorkerPost } from '../src/wandb-worker.js';
import { fixtureRoute } from './fixtures/wandb-route.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-broker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const creation = runId => ({ query: wandbUpsert, variables: { entity: 'tsilva', project: 'scummbench-queen', name: runId,
  config: JSON.stringify({ run_id: { value: runId }, official_eligible: { value: false }, scummvm_game_id: { value: 'queen' } }) } });

test('automatic defaults require the exact owner-only route; offline mode needs no route', async t => {
  const directory = await temporary(t), routeFile = await fixtureRoute(directory);
  assert.equal(await loadWandb(false, {}), undefined);
  await assert.rejects(loadWandb(undefined, {}, { routeFile: path.join(directory, 'missing') }), { code: 'WANDB_SETUP' });
  let selected;
  const reporting = await loadWandb(undefined, {}, { routeFile, brokerTransport: (route, details) => {
    selected = { route, details }; return async () => ({});
  } });
  const report = reporting({ directory, runId: randomUUID() });
  assert.deepEqual(report.config, defaultWandbConfig);
  assert.equal(selected.route.bundle, 'local-scummbench-wandb');
  assert.equal(selected.details.runId, report.runId);
  await report.start({ game: 'unknown', kind: 'interactive_mcp' });
  await report.finish({ status: 'stopped' });
  await chmod(routeFile, 0o644);
  await assert.rejects(loadWandbRoute(routeFile));
  await chmod(routeFile, 0o600);
  const binding = JSON.parse(await readFile(routeFile, 'utf8'));
  binding.source.path = '/another-service';
  await writeFile(routeFile, JSON.stringify(binding));
  await assert.rejects(loadWandb(undefined, {}, { routeFile }), { code: 'WANDB_SETUP' });
});

test('real stdio worker publishes before completion and renews its owned session without changing offsets', async t => {
  const directory = await temporary(t), routeFile = await fixtureRoute(directory);
  const route = await loadWandbRoute(routeFile), runId = randomUUID(), clients = [];
  const file = path.join(directory, 'wire.jsonl');
  const transport = createBrokeredWandbTransport(route, { runId, renewMs: 0, createClient: (command, args) => {
    assert.equal(command, route.launcher);
    assert.equal(args[0], process.execPath);
    assert.equal(args[1], path.join(root, 'src/wandb-worker.js'));
    const client = new McpClient(process.execPath, [path.join(root, 'test/fixtures/wandb-worker.js'), file, ...args.slice(2)]);
    clients.push(client); return client;
  } });
  t.after(() => transport.close());
  const signal = new AbortController().signal;
  const result = await transport('/graphql', creation(runId), signal);
  assert.equal(result.data.upsertBucket.bucket.name, runId);
  const endpoint = `/files/tsilva/scummbench-queen/${runId}/file_stream`;
  for (let offset = 0; offset < 2; offset++) await transport(endpoint, { files: {
    'wandb-history.jsonl': { offset, content: [JSON.stringify({ _step: offset, status: 'in_progress' })] },
    'wandb-summary.json': { offset: 0, content: [JSON.stringify({ status: 'in_progress' })] },
  } }, signal);
  let wire = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(wire.filter(row => row.event === 'worker').length, 3);
  assert.deepEqual(wire.filter(row => row.body?.files).map(row => row.body.files['wandb-history.jsonl'].offset), [0, 1]);
  assert.ok(wire.filter(row => row.event === 'worker').every(row => !row.credential_present && !row.proxy_present));
  assert.ok(!wire.some(row => row.body?.complete));
  await transport(endpoint, { complete: true, exitcode: 0 }, signal);
  await transport.close();
  assert.ok(clients.every(client => client.process.exitCode === 0));
  wire = (await readFile(file, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(wire.at(-1).body.complete, true);
});

test('worker cancellation aborts the upstream request and shutdown remains bounded', async t => {
  const directory = await temporary(t), file = path.join(directory, 'wire.jsonl'), runId = randomUUID();
  const transport = createBrokeredWandbTransport({ launcher: process.execPath }, { runId, createClient: (_command, args) =>
    new McpClient(process.execPath, [path.join(root, 'test/fixtures/wandb-worker.js'), file, ...args.slice(2), 'stall']) });
  t.after(() => transport.close());
  await transport.ready();
  const controller = new AbortController();
  const pending = transport('/graphql', creation(runId), controller.signal);
  const timer = setTimeout(() => controller.abort(), 30);
  try { await assert.rejects(pending, /worker request failed/); }
  finally { clearTimeout(timer); }
  await transport.close();
});

test('worker refuses other projects, mutations, run IDs, media and nested configuration', () => {
  const runId = randomUUID(), body = creation(runId);
  validateWorkerPost('/graphql', body, runId);
  for (const patch of [{ entity: 'other' }, { project: 'scummbench-madeup' }, { name: randomUUID() },
    { config: JSON.stringify({ ...JSON.parse(body.variables.config), game: { value: { private: true } } }) }]) {
    assert.throws(() => validateWorkerPost('/graphql', { ...body, variables: { ...body.variables, ...patch } }, runId));
  }
  assert.throws(() => validateWorkerPost('/graphql', { ...body, query: 'mutation anything' }, runId));
  for (const project of ['other-project', 'scummbench-queen-extra', '../scummbench-queen']) {
    assert.throws(() => validateWorkerPost(`/files/tsilva/${project}/${runId}/file_stream`, { complete: true, exitcode: 0 }, runId));
  }
  assert.throws(() => validateWorkerPost(`/files/tsilva/scummbench-queen/${runId}/file_stream`, { files: { screenshot: {} } }, runId));
});
