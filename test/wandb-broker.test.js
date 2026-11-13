import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { root } from '../src/contracts.js';
import { McpClient } from '../src/process.js';
import { loadWandb, wandbUpsert, defaultWandbConfig } from '../src/wandb.js';
import { suppliedWandbWorker, createBrokeredWandbTransport } from '../src/wandb-broker.js';
import { checkWandbAccess, validateWorkerPost } from '../src/wandb-worker.js';
import { fixtureWorkerEnvironment } from './fixtures/wandb-environment.js';

async function temporary(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-broker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const creation = runId => ({ query: wandbUpsert, variables: { entity: 'tsilva', project: 'scummbench-queen', name: runId,
  config: JSON.stringify({ run_id: { value: runId }, official_eligible: { value: false }, scummvm_game_id: { value: 'queen' } }) } });

test('identity verification sends only the read-only viewer query and emits no account data', async () => {
  let closed = false;
  const transport = async (endpoint, body) => {
    assert.equal(endpoint, '/graphql');
    assert.deepEqual(body, { query: 'query ScummBenchIdentityCheck { viewer { id } }' });
    return { data: { viewer: { id: 'synthetic-private-account-id' } } };
  };
  transport.close = () => { closed = true; };
  assert.deepEqual(await checkWandbAccess({ transport }), {
    ok: true, read_only: true, credential_mode: 'public-placeholder',
  });
  assert.equal(closed, true);
});

test('automatic defaults use only the explicit supplied worker command; offline mode needs none', async t => {
  const directory = await temporary(t), publishingEnv = fixtureWorkerEnvironment();
  assert.equal(await loadWandb(false, {}), undefined);
  await assert.rejects(loadWandb(undefined, {}), { code: 'WANDB_SETUP' });
  let selected;
  const reporting = await loadWandb(undefined, publishingEnv, { brokerTransport: (route, details) => {
    selected = { route, details }; return async () => ({});
  } });
  const report = reporting({ directory, runId: randomUUID() });
  assert.deepEqual(report.config, defaultWandbConfig);
  assert.equal(selected.route.command, process.execPath);
  assert.equal(selected.details.runId, report.runId);
  await report.start({ game: 'unknown', kind: 'interactive_mcp' });
  await report.finish({ status: 'stopped' });
  for (const command of ['not json', '[]', '["relative"]', JSON.stringify([process.execPath, 'bad\nargument']),
    JSON.stringify([process.execPath, 'x'.repeat(4097)]), JSON.stringify(Array(33).fill(process.execPath))]) {
    await assert.rejects(loadWandb(undefined, { SCUMMBENCH_WANDB_WORKER_COMMAND: command }), { code: 'WANDB_SETUP' });
  }
});

test('real stdio worker publishes before completion and renews its owned session without changing offsets', async t => {
  const directory = await temporary(t), publishingEnv = fixtureWorkerEnvironment();
  const route = await suppliedWandbWorker(publishingEnv), runId = randomUUID(), clients = [];
  const file = path.join(directory, 'wire.jsonl');
  const transport = createBrokeredWandbTransport(route, { runId, renewMs: 0, createClient: (command, args) => {
    assert.equal(command, route.command);
    assert.equal(args[0], '--run-id');
    assert.equal(args[1], runId);
    const client = new McpClient(process.execPath, [path.join(root, 'test/fixtures/wandb-worker.js'), file, ...args]);
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
  const transport = createBrokeredWandbTransport({ command: process.execPath, arguments: [] }, { runId, createClient: (_command, args) =>
    new McpClient(process.execPath, [path.join(root, 'test/fixtures/wandb-worker.js'), file, ...args, 'stall']) });
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


test('a missing publishing environment never discovers a local runner', async () => {
  await assert.rejects(loadWandb(undefined, {}), { code: 'WANDB_SETUP' });
});
