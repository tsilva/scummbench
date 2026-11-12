import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, cp, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { McpClient, textResult } from '../src/process.js';

async function fixture(t, args = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-supervisor-'));
  const config = { marker: 'before', gateway_commit: 'b'.repeat(40), backbone_commit: 'a'.repeat(40) };
  const configure = async change => {
    Object.assign(config, change);
    await writeFile(path.join(directory, 'config.json'), JSON.stringify(config));
  };
  await configure({});
  const client = new McpClient(process.execPath, [path.join(import.meta.dirname, 'fixtures/supervisor-host.js'), directory, ...args]);
  t.after(async () => { await client.close(); await rm(directory, { recursive: true, force: true }); });
  await client.connect();
  const call = async (operation = 'status') => client.call('mcp_runtime', { operation });
  const status = async () => textResult(await client.call('status'));
  const events = async () => (await readFile(path.join(directory, 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  return { directory, client, configure, call, status, events };
}

test('reload reads updated workers while preserving the host transport and save profile', async t => {
  const { client, configure, status, call, events } = await fixture(t);
  assert.ok((await client.request('tools/list')).tools.some(tool => tool.name === 'mcp_runtime'));
  const first = await status();
  await client.call('act', { action: 'save' });
  await configure({ marker: 'after', gateway_commit: 'c'.repeat(40), backbone_commit: 'd'.repeat(40) });
  const reloaded = textResult(await call('reload'));
  assert.equal(reloaded.marker, 'after');
  assert.equal(reloaded.mcp_runtime.pid, first.mcp_runtime.pid);
  assert.equal(reloaded.mcp_runtime.generation, 2);
  assert.equal(reloaded.mcp_runtime.reloading, false);
  assert.notEqual(reloaded.serverPid, first.serverPid);
  assert.equal(reloaded.dataDir, first.dataDir);
  assert.equal(await readFile(path.join(reloaded.dataDir, 'save-slot-1'), 'utf8'), 'saved-progress');
  assert.equal((await status()).marker, 'after');
  const starts = (await events()).filter(event => event.event === 'started');
  assert.ok(starts[1].args.includes('--data-dir'));
});

test('named instances preserve their flags without conflicting with --data-dir', async t => {
  const { call, events } = await fixture(t, ['--', '--instance', 'named-fixture']);
  textResult(await call('reload'));
  const starts = (await events()).filter(event => event.event === 'started');
  assert.deepEqual(starts[1].args, ['--', '--instance', 'named-fixture']);
});

test('reload refuses active sessions and dirty checkouts without killing the existing worker', async t => {
  const { client, call, configure, status } = await fixture(t);
  const before = await status();
  await client.call('session', { operation: 'start' });
  const active = await call('reload');
  assert.equal(active.isError, true);
  assert.match(JSON.parse(active.content[0].text).error, /Game is active/);
  assert.equal((await status()).serverPid, before.serverPid);
  await client.call('session', { operation: 'close' });
  await configure({ dirty: true });
  const dirty = await call('reload');
  assert.equal(dirty.isError, true);
  assert.match(JSON.parse(dirty.content[0].text).error, /Commit all pending/);
  assert.equal((await status()).serverPid, before.serverPid);
});

test('a lost action reply is never replayed; the next status recovers on the same transport', async t => {
  const { client, call, events, status } = await fixture(t);
  const first = await status();
  const crash = await client.call('act', { action: 'crash' });
  assert.equal(crash.isError, true);
  assert.equal(textResult(await call()).backend_available, false);
  const second = await status();
  assert.equal(second.mcp_runtime.pid, first.mcp_runtime.pid);
  assert.equal(second.mcp_runtime.generation, 2);
  assert.equal(second.dataDir, first.dataDir);
  assert.notEqual(second.serverPid, first.serverPid);
  assert.equal((await events()).filter(event => event.event === 'act').length, 1);
});

test('reload refuses outstanding requests and does not race their receipts', async t => {
  const { client, call, status } = await fixture(t);
  const first = await status();
  const waiting = client.call('status', { wait_ms: 300 });
  const refused = await call('reload');
  assert.equal(refused.isError, true);
  assert.match(JSON.parse(refused.content[0].text).error, /outstanding MCP requests/);
  assert.equal(textResult(await waiting).serverPid, first.serverPid);
});

for (const [name, change, error] of [
  ['schema change', { schema_type: 'number' }, /schemas or protocol changed/],
  ['startup revision mismatch', { mismatch: true }, /startup revisions/],
  ['startup crash', { fail_startup: true }, /Process closed|connection lost/],
]) test(`${name} leaves the supervisor reachable for a corrected reload`, async t => {
  const { call, configure, status } = await fixture(t);
  const before = await status();
  await configure(change);
  const failed = await call('reload');
  assert.equal(failed.isError, true);
  assert.match(JSON.parse(failed.content[0].text).error, error);
  assert.equal(textResult(await call()).backend_available, false);
  await configure({ schema_type: 'string', mismatch: false, fail_startup: false });
  const restored = textResult(await call('reload'));
  assert.equal(restored.mcp_runtime.pid, before.mcp_runtime.pid);
  assert.equal(restored.dataDir, before.dataDir);
});

test('one connection reload leaves a parallel connection unchanged', async t => {
  const a = await fixture(t), b = await fixture(t);
  const before = await b.status();
  textResult(await a.call('reload'));
  const after = await b.status();
  assert.equal(after.serverPid, before.serverPid);
  assert.equal(after.mcp_runtime.generation, 1);
});

test('production supervisor reloads clean source and survives actual gateway and backbone exits', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-reload-chain-'));
  const bench = path.join(directory, 'bench'), web = path.join(directory, 'web');
  const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const commit = cwd => {
    git(cwd, 'add', '--all');
    git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'synthetic fixture');
  };
  let client;
  t.after(async () => { await client?.close(); await rm(directory, { recursive: true, force: true }); });
  await cp(path.join(import.meta.dirname, '../src'), path.join(bench, 'src'), { recursive: true });
  await writeFile(path.join(bench, 'package.json'), JSON.stringify({ name: 'scummbench', version: '0.1.0', type: 'module' }));
  await mkdir(path.join(web, 'agent-backbone/src'), { recursive: true });
  await cp(path.join(import.meta.dirname, 'fixtures/reload-backbone.js'), path.join(web, 'agent-backbone/src/server.js'));
  await writeFile(path.join(web, 'package.json'), JSON.stringify({ name: 'scummweb', type: 'module' }));
  await writeFile(path.join(web, 'marker.txt'), 'before');
  for (const cwd of [bench, web]) { git(cwd, 'init'); commit(cwd); }
  client = new McpClient(process.execPath, [path.join(bench, 'src/cli.js'), 'mcp', '--no-wandb', '--scummweb', web,
    '--', '--data-dir', path.join(directory, 'profile')]);
  await client.connect();
  const status = async () => textResult(await client.call('status'));
  const runtime = async operation => client.call('mcp_runtime', { operation });
  const before = await status();
  await writeFile(path.join(web, 'marker.txt'), 'after');
  const dirty = await runtime('reload');
  assert.equal(dirty.isError, true);
  assert.equal((await status()).serverPid, before.serverPid);
  commit(web);
  const after = textResult(await runtime('reload'));
  assert.equal(after.marker, 'after');
  assert.equal(after.sourceRevision.commit_id, git(web, 'rev-parse', 'HEAD'));
  assert.equal(after.scummbench.source_revision.commit_id, git(bench, 'rev-parse', 'HEAD'));
  assert.equal(after.mcp_runtime.pid, before.mcp_runtime.pid);
  assert.notEqual(after.serverPid, before.serverPid);
  assert.notEqual(after.mcp_runtime.gateway_pid, before.mcp_runtime.gateway_pid);
  assert.equal(after.dataDir, before.dataDir);
  const failed = await client.call('act', {});
  assert.equal(failed.isError, true);
  for (let i = 0; i < 40 && textResult(await runtime('status')).backend_available; i++) await new Promise(resolve => setTimeout(resolve, 50));
  const recovered = await status();
  assert.equal(recovered.mcp_runtime.generation, 3);
  // Abrupt gateway death must also reap its owned backbone process group.
  process.kill(recovered.mcp_runtime.gateway_pid, 'SIGKILL');
  const gone = pid => { try { process.kill(pid, 0); return false; } catch (error) { if (error.code === 'ESRCH') return true; throw error; } };
  for (let i = 0; i < 40 && !gone(recovered.serverPid); i++) await new Promise(resolve => setTimeout(resolve, 50));
  assert.ok(gone(recovered.serverPid), 'the previous backbone must be reaped after gateway death');
  const recoveredAgain = await status();
  assert.equal(recoveredAgain.mcp_runtime.pid, before.mcp_runtime.pid);
  assert.equal(recoveredAgain.mcp_runtime.generation, 4);
  assert.equal(recoveredAgain.dataDir, before.dataDir);
});
