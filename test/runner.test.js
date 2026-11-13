import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadTask, root, digest, visibleTask, validateDecision } from '../src/contracts.js';
import { gradeReceipt } from '../src/backend.js';
import { runAttempt, verifyRun } from '../src/runner.js';
import { aggregate, wilson } from '../src/aggregate.js';
import { loadWandb, WandbPublisher } from '../src/wandb.js';
import { fixtureWorkerEnvironment } from './fixtures/wandb-environment.js';

async function attempt(t, { mode = 'success', agent = 'click', budgets = {}, reporting = false, loadReporting } = {}) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scummbench-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const loaded = await loadTask(path.join(root, 'tasks/queen/hotel-laundry.v1.json'));
  Object.assign(loaded.task.budgets, { startup_ms: 5000, response_ms: 3000, wall_ms: 10000 }, budgets);
  loaded.source = Buffer.from(JSON.stringify(loaded.task)); loaded.sha256 = digest(loaded.source);
  const backendConfig = { scummweb_dir: path.join(root, 'test/fixtures/backend'),
    scummweb_revision: 'a'.repeat(40), base_url: `http://${mode}.invalid` };
  const agentConfig = { command: process.execPath, args: [path.join(root, 'test/fixtures/agent.js'), agent], label: `fixture-${agent}` };
  const output = path.join(temporary, 'run');
  const options = { loadedTask: loaded, backendConfig, provenance: { commit_id: 'a'.repeat(40), base_url: backendConfig.base_url }, agentConfig, output, reporting: loadReporting ? undefined : reporting, loadReporting };
  return { ...(await runAttempt(options)), options };
}

test('native success survives MCP exit; screenshots externalize and verify offline', async t => {
  const run = await attempt(t);
  assert.equal(run.result.status, 'success');
  assert.equal(run.result.official_eligible, false);
  assert.equal(run.result.usage.submitted_actions, 1);
  assert.equal((await verifyRun(run.directory)).run_id, run.result.run_id);
  const trajectory = await readFile(path.join(run.directory, 'trajectory.jsonl'), 'utf8');
  assert.ok(trajectory.includes('screenshots/'));
  assert.ok(!trajectory.includes('iVBOR'));
  await assert.rejects(runAttempt(run.options), { code: 'EEXIST' });
});

test('fixed tasks automatically select the canonical W&B project and retain grades if worker startup fails', async t => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'scummbench-auto-wandb-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const publishingEnv = fixtureWorkerEnvironment();
  for (const failed of [false, true]) {
    const posts = [];
    const run = await attempt(t, { loadReporting: file => {
      assert.equal(file, undefined);
      return loadWandb(file, publishingEnv, { brokerTransport: () => {
        const transport = async (endpoint, body) => {
          posts.push({ endpoint, body });
          return endpoint === '/graphql' ? { data: { upsertBucket: { bucket: { name: body.variables.name } } } } : {};
        };
        transport.ready = async () => { if (failed) throw new Error('private startup diagnostics'); };
        return transport;
      } });
    } });
    assert.equal(run.result.status, 'success');
    const receipt = JSON.parse(await readFile(path.join(run.directory, 'wandb.json'), 'utf8'));
    assert.equal(receipt.project, 'scummbench-queen');
    assert.equal(receipt.state, failed ? 'failed' : 'synced');
    assert.equal(posts.length > 0, !failed);
    assert.doesNotMatch(JSON.stringify(receipt), /private startup diagnostics/);
    await verifyRun(run.directory);
  }
});

test('agent finish is failure, not a success claim', async t => {
  const run = await attempt(t, { agent: 'finish' });
  assert.equal(run.result.status, 'failure');
  assert.equal(run.result.reason, 'agent_stopped');
  await verifyRun(run.directory);
});

test('corrupt native state and process exit without receipt cannot pass', async t => {
  for (const mode of ['corrupt', 'exit']) {
    const run = await attempt(t, { mode });
    assert.equal(run.result.status, 'infrastructure_error', mode);
  }
});

test('actual screenshot bounds must match the declared player coordinate space', async t => {
  const run = await attempt(t, { mode: 'dimensions' });
  assert.equal(run.result.status, 'infrastructure_error');
  assert.equal(run.result.usage.decisions, 0);
});

test('a ready server with no first frame is captured before checking crop bounds', async t => {
  const run = await attempt(t, { mode: 'transient' });
  assert.equal(run.result.status, 'success');
});

test('decision and primitive budgets stop before excess inputs are sent', async t => {
  const observe = await attempt(t, { agent: 'observe', budgets: { decisions: 2 } });
  assert.equal(observe.result.reason, 'decisions');
  assert.equal(observe.result.usage.decisions, 2);
  const inputs = await attempt(t, { agent: 'overflow', budgets: { primitive_actions: 1 } });
  assert.equal(inputs.result.reason, 'primitive_actions');
  assert.equal(inputs.result.usage.submitted_actions, 0);
});

test('agent response deadline and total wall deadline terminate waiting processes', async t => {
  const response = await attempt(t, { agent: 'timeout', budgets: { response_ms: 100 } });
  assert.equal(response.result.reason, 'agent_response_time');
  const wall = await attempt(t, { agent: 'timeout', budgets: { wall_ms: 300, response_ms: 5000 } });
  assert.equal(wall.result.reason, 'wall_time');
  assert.ok(wall.result.elapsed_ms < 4000);
});

test('startup deadline stops a backend that never reaches ready', async t => {
  const run = await attempt(t, { mode: 'startup', budgets: { startup_ms: 300 } });
  assert.equal(run.result.status, 'infrastructure_error');
  assert.equal(run.result.reason, 'startup_timeout');
  assert.equal(run.result.usage.decisions, 0);
});

test('malformed output, prohibited actions, and tool rejections are explicit', async t => {
  for (const agent of ['malformed', 'load', 'bad-input']) {
    assert.equal((await attempt(t, { agent })).result.status, 'invalid_agent');
  }
  assert.equal((await attempt(t, { mode: 'reject' })).result.status, 'invalid_agent');
});

test('visible task excludes grading state and starting saves', async () => {
  const { task } = await loadTask(path.join(root, 'tasks/queen/hotel-laundry.v1.json'));
  assert.doesNotMatch(JSON.stringify(visibleTask(task)), /room_id|condition|provenance|71|save/);
  assert.throws(() => validateDecision({ type: 'finish', success: true }, task));
});

test('grading rejects a wrong session, source, predicate, or native clock', async t => {
  const run = await attempt(t), receipt = run.result.native_receipt;
  for (const patch of [{ session_id: 'other' }, { source_revision: { commit_id: 'b'.repeat(40), dirty: false } },
    { condition: { all: [] } }, { variables: { ...receipt.variables, native_time_ms: -1 } }]) {
    assert.throws(() => gradeReceipt({ ...receipt, ...patch }, run.options.loadedTask.task, { sessionId: receipt.session_id, config: run.options.backendConfig }));
  }
});

test('offline verifier detects altered screenshot and task source', async t => {
  const run = await attempt(t);
  const events = (await readFile(path.join(run.directory, 'trajectory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  const image = events.flatMap(event => event.content ?? []).find(block => block.type === 'image');
  await writeFile(path.join(run.directory, image.path), 'tampered');
  await assert.rejects(verifyRun(run.directory), /Screenshot checksum/);
  await writeFile(path.join(run.directory, 'task-source.json'), '{}');
  await assert.rejects(verifyRun(run.directory), /Task checksum/);
});

test('aggregation retains outcome groups and prevents counting a run twice', async t => {
  const run = await attempt(t);
  const summary = await aggregate([run.directory]);
  assert.equal(summary.groups[0].success_rate_all_attempts, 1);
  assert.ok(summary.groups[0].wilson_95_valid_attempts[0] < 0.3);
  await assert.rejects(aggregate([run.directory, run.directory]), /Duplicate run ID/);
  assert.equal(wilson(0, 0), null);
});

test('W&B streams fixed-task counters and final grades without evaluator or player data', async t => {
  const posts = [];
  const reporting = details => new WandbPublisher({ entity: 'fixture', project: 'tests', api_key_placeholder: 'test_placeholder' }, {
    ...details, flushMs: 5,
    transport: async (endpoint, body) => {
      posts.push({ endpoint, body });
      return endpoint === '/graphql' ? { data: { upsertBucket: { bucket: { name: body.variables.name } } } } : {};
    },
  });
  const run = await attempt(t, { reporting });
  assert.equal(run.result.status, 'success');
  await verifyRun(run.directory);
  const receipt = JSON.parse(await readFile(path.join(run.directory, 'wandb.json')));
  assert.equal(receipt.run_id, run.result.run_id);
  assert.equal(receipt.state, 'synced');
  const rows = posts.flatMap(post => post.body.files?.['wandb-history.jsonl']?.content.map(JSON.parse) ?? []);
  assert.ok(rows.some(row => row.status === 'in_progress'));
  assert.equal(rows.at(-1).status, 'success');
  assert.equal(rows.at(-1).success, 1);
  assert.equal(rows.at(-1)['usage/submitted_actions'], 1);
  assert.doesNotMatch(JSON.stringify(posts), /room_id|native_receipt|screenshots|base_url|fixture\/backend|iVBOR/);
  const config = JSON.parse(posts.find(post => post.endpoint === '/graphql').body.variables.config);
  assert.equal(config.condition, undefined);
  assert.equal(config.official_eligible.value, false);
  assert.equal(posts.at(-1).body.complete, true);
});

test('W&B outage leaves authoritative grades and artifacts unchanged', async t => {
  const reporting = details => new WandbPublisher({ entity: 'fixture', project: 'tests', api_key_placeholder: 'test_placeholder' }, {
    ...details, transport: async () => { throw new Error('secret provider diagnostics'); },
  });
  const run = await attempt(t, { reporting, agent: 'finish' });
  assert.equal(run.result.status, 'failure');
  assert.equal(run.result.reason, 'agent_stopped');
  await verifyRun(run.directory);
  const receipt = await readFile(path.join(run.directory, 'wandb.json'), 'utf8');
  assert.equal(JSON.parse(receipt).state, 'failed');
  assert.doesNotMatch(receipt, /secret provider/);
});
