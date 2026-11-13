import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { validateWandbConfig, createWandbTransport, WandbPublisher } from '../src/wandb.js';
import { root } from '../src/contracts.js';
import { cleanEnv } from '../src/process.js';

const config = { entity: 'fixture', project: 'scummbench-tests', api_key_placeholder: 'test_placeholder' };
const env = { WANDB_API_KEY: 'test_placeholder', HTTPS_PROXY: 'http://127.0.0.1:12345', NO_PROXY: '*' };

async function publisher(t, transport, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-wandb-'));
  const report = new WandbPublisher(config, { directory, runId: randomUUID(), transport, flushMs: 100000, ...options });
  t.after(async () => {
    await report.finish({ status: 'stopped', reason: 'session_closed' });
    await rm(directory, { recursive: true, force: true });
  });
  await report.start({ kind: 'interactive_mcp', game: 'synthetic', native_receipt: 'hidden', condition: 'hidden' });
  return report;
}

const reply = body => ({ data: { upsertBucket: { bucket: { name: body.variables.name } } } });

test('W&B rejects credential files, unsafe destinations and invalid protected keys', () => {
  for (const patch of [{ api_key: 'secret' }, { entity: '../other' }, { project: 'space/name' }, { api_key_placeholder: 'secret' }]) {
    assert.throws(() => validateWandbConfig({ ...config, ...patch }));
  }
  assert.throws(() => createWandbTransport(config, {}));
  assert.throws(() => createWandbTransport(config, { ...env, INFISICAL_AGENT_VAULT_URL: 'https://app.infisical.com', WANDB_API_KEY: 'raw-key' }));
  assert.throws(() => createWandbTransport(config, { WANDB_API_KEY: 'test_placeholder' }));
  assert.throws(() => createWandbTransport(config, { ...env, NODE_TLS_REJECT_UNAUTHORIZED: '0' }));
});

test('transport pins HTTPS destination, placeholder auth, private proxy agent and refuses redirects', async () => {
  let observed;
  const transport = createWandbTransport(config, env, (url, options, callback) => {
    observed = { url, options };
    const req = new EventEmitter();
    req.end = () => {
      const res = new EventEmitter(); res.statusCode = 302;
      callback(res); res.emit('data', Buffer.from('sensitive response')); res.emit('end');
    };
    return req;
  });
  try {
    await assert.rejects(transport('/graphql', {}, new AbortController().signal), /HTTP failure/);
    assert.equal(observed.url.href, 'https://api.wandb.ai/graphql');
    assert.equal(observed.options.method, 'POST');
    assert.equal(observed.options.headers.Authorization, `Basic ${Buffer.from('api:test_placeholder').toString('base64')}`);
    assert.ok(observed.options.agent);
  } finally { transport.close(); }
});

test('publishes while run is live; retries reuse offsets; interactive play has no success metric', async t => {
  const posts = []; let failOnce = true;
  const report = await publisher(t, async (endpoint, body) => {
    posts.push({ endpoint, body });
    if (endpoint === '/graphql') return reply(body);
    if (body.files && failOnce) { failOnce = false; throw new Error('transient'); }
    return {};
  });
  await report.log({ elapsed_ms: 12, usage: { tool_calls: 1, evaluator_state: 71 }, status: 'in_progress', native_receipt: 'hidden' });
  await report.pump(); await report.pump();
  assert.equal(report.state, 'running');
  const beforeFinish = posts.filter(post => post.body.files);
  assert.ok(beforeFinish.length >= 2);
  assert.deepEqual(beforeFinish[0], beforeFinish[1]);
  await report.finish({ elapsed_ms: 25, usage: { tool_calls: 2 }, status: 'stopped', reason: 'session_closed' });
  assert.equal(report.state, 'synced');
  const journal = await readFile(path.join(report.directory, 'wandb-events.jsonl'), 'utf8');
  assert.doesNotMatch(journal + JSON.stringify(posts), /evaluator_state|native_receipt|condition|hidden|"success"/);
  const rows = posts.flatMap(post => post.body.files?.['wandb-history.jsonl']?.content.map(JSON.parse) ?? []);
  assert.equal(rows.at(-1).status, 'stopped');
  assert.equal(posts.at(-1).body.complete, true);
});

test('bounded queue retains complete journal and newest summary under backpressure', async t => {
  const report = await publisher(t, async (endpoint, body) => endpoint === '/graphql' ? reply(body) : {});
  await report.pump();
  for (let i = 0; i < 300; i++) await report.log({ usage: { tool_calls: i } });
  assert.equal(report.queue.length, 256);
  assert.equal(report.queue.at(-1)['usage/tool_calls'], 299);
  const journal = (await readFile(path.join(report.directory, 'wandb-events.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(journal.length, 301);
  await report.finish({ status: 'stopped' });
  assert.equal(report.summary['usage/tool_calls'], 299);
});

test('request and shutdown deadlines bound a stalled service without leaking diagnostics', async t => {
  const report = await publisher(t, (endpoint, body, signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('secret diagnostics')), { once: true });
  }), { requestMs: 1000, finishMs: 30 });
  await report.finish({ status: 'stopped' });
  assert.equal(report.state, 'failed');
  assert.equal(report.reason, 'finish_timeout');
  assert.equal(report.controllers.size, 0);
  assert.doesNotMatch(await readFile(path.join(report.directory, 'wandb.json'), 'utf8'), /secret diagnostics/);
});

test('permanent HTTP failures are not retried; failed runs keep a local journal', async t => {
  let calls = 0;
  const report = await publisher(t, async () => { calls++; const error = new Error('401'); error.retryable = false; throw error; });
  await report.pump();
  await report.log({ usage: { tool_calls: 2 } });
  await report.finish({ status: 'stopped' });
  assert.equal(calls, 1);
  assert.equal(report.state, 'failed');
  assert.match(await readFile(path.join(report.directory, 'wandb-events.jsonl'), 'utf8'), /tool_calls/);
});

test('project templates use canonical ScummVM game IDs and reject unrecognized slugs', async t => {
  for (const [game, canonical] of [['flight-of-the-amazon-queen', 'queen'], ['queen', 'queen'],
    ['beneath-a-steel-sky', 'sky'], ['dreamweb', 'dreamweb'], ['the-secret-of-monkey-island-demo', 'monkey'],
    ['nippon-safes-inc', 'nippon'], ['../unsafe', null], ['synthetic', null]]) {
    const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-wandb-template-'));
    const posts = [];
    const report = new WandbPublisher({ ...config, project: 'scummbench-{gameid}' }, {
      directory, runId: randomUUID(), transport: async (endpoint, body) => {
        posts.push(body); return endpoint === '/graphql' ? reply(body) : {};
      },
    });
    t.after(() => rm(directory, { recursive: true, force: true }));
    await report.start({ game, kind: 'interactive_mcp' });
    await report.finish({ status: 'stopped' });
    if (!canonical) {
      assert.equal(report.reason, 'unknown_scummvm_game_id');
      assert.equal(posts.length, 0);
    } else {
      assert.equal(posts[0].variables.project, `scummbench-${canonical}`);
      assert.equal(JSON.parse(posts[0].variables.config).scummvm_game_id.value, canonical);
      assert.equal(report.state, 'synced');
    }
  }
});

test('MCP opt-in via CLI or environment fails clearly before starting an unconfigured service', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-wandb-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'wandb.json');
  await writeFile(file, JSON.stringify(config));
  for (const cli of [true, false]) {
    const args = [path.join(root, 'src/cli.js'), 'mcp', '--scummweb', path.join(root, 'test/fixtures/backend')];
    if (cli) args.push('--wandb', file);
    const result = spawnSync(process.execPath, args, {
      env: { ...cleanEnv(), ...(!cli && { SCUMMBENCH_WANDB_CONFIG: file }) },
      input: '', encoding: 'utf8', timeout: 15000,
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /W&B setup failed/);
    assert.equal(result.stdout, '');
  }
});


test('ordinary supplied W&B key uses fixed HTTPS without ambient proxy or cache', async () => {
  let observed;
  const transport = createWandbTransport(config, { WANDB_API_KEY: 'synthetic-user-key', HTTPS_PROXY: 'http://untrusted.invalid' }, (url, options, callback) => {
    observed = { url, options };
    const req = new EventEmitter();
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200;
      callback(res); res.emit('data', Buffer.from('{"data":{}}')); res.emit('end'); };
    return req;
  });
  try {
    await transport('/graphql', {}, new AbortController().signal);
    assert.equal(observed.url.href, 'https://api.wandb.ai/graphql');
    assert.equal(observed.options.headers.Authorization, `Basic ${Buffer.from('api:synthetic-user-key').toString('base64')}`);
    assert.deepEqual(observed.options.agent.options.proxyEnv, {});
  } finally { transport.close(); }
  for (const key of ['', ' ', 'bad\nkey', 'wrong_placeholder']) {
    assert.throws(() => createWandbTransport(config, { WANDB_API_KEY: key }));
  }
});
