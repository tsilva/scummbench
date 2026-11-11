import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { request } from 'node:http';
import { createResultsFeed, progressSeries, benchmarkVersion } from '../src/results-feed.js';
import { runtimeDescriptor, captureProgress } from '../src/results-capture.js';
import { actionsToFinish, stepVertices } from '../web/results-model.js';
import { fixtureTime as at, fixtureProgress as progress, writeInteractive } from './fixtures/results.js';
import { sampleResults } from '../web/sample-data.js';

async function temporary(t) {
  const root = await mkdtemp(path.join(tmpdir(), 'scummbench-results-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('milestones count submitted batches and stop at native ending, not trailing actions', () => {
  const series = progressSeries({ game: 'flight-of-the-amazon-queen', session: 'session', started: at(0), finished: at(6), totalActions: 6,
    submissions: [{ timestamp: at(1), count: 2 }, { timestamp: at(3), count: 3 }, { timestamp: at(5), count: 1 }],
    samples: [{ timestamp: at(0), progress: progress(0) }, { timestamp: at(2), progress: progress(50) }, { timestamp: at(4), progress: progress(100, true) }] });
  assert.deepEqual(series.points, [{ actions: 0, progress: 0 }, { actions: 2, progress: 50 }, { actions: 5, progress: 100 }]);
  assert.equal(series.completionActions, 5);
  const run = { ...series, actions: 6, completion_actions: 5, completion_verified: true };
  assert.equal(actionsToFinish(run), 5);
  assert.equal(stepVertices(run).at(-1).actions, 5);
});

test('reject mixed map revisions, false endings, cross-session samples and action mismatches', () => {
  const base = { game: 'flight-of-the-amazon-queen', session: 'session', started: at(0), finished: at(6), totalActions: 1,
    submissions: [{ timestamp: at(1), count: 1 }], samples: [{ timestamp: at(0), progress: progress(0) }, { timestamp: at(2), progress: progress(50) }] };
  for (const change of [
    data => { data.samples[1].progress.map_revision = 'd'.repeat(64); },
    data => { data.samples[1].progress = progress(100, false); },
    data => { data.samples[1].session_id = 'another-session'; },
    data => { data.totalActions = 2; },
    data => { data.samples[0].timestamp = at(9); },
    data => { data.samples.reverse(); },
    data => { data.submissions.push({ timestamp: at(0), count: 0 }); },
  ]) { const data = structuredClone(base); change(data); assert.throws(() => progressSeries(data)); }
});

test('version identity separates scoring, controls, starting conditions, budgets and unknown provenance', () => {
  const source = { id: 'first', category: 'short-task' }, series = { progressRevision: 'a'.repeat(64) };
  const identity = { edition: 'edition-sha', start: 'Fresh start', track: 'closed-book', budgets: { actions: 600 },
    scummbench: { commit_id: 'b'.repeat(40), dirty: false }, backend: { commit_id: 'c'.repeat(40), dirty: false }, tools: ['click'] };
  const first = benchmarkVersion(source, series, identity);
  assert.equal(first.isolated, false);
  assert.equal(first.id, benchmarkVersion({ ...source, id: 'second' }, series, identity).id);
  for (const change of [
    data => { data.start = 'Continued save'; }, data => { data.track = 'assisted'; },
    data => { data.budgets.actions++; }, data => { data.tools.push('macro'); },
    data => { data.backend.commit_id = 'd'.repeat(40); },
  ]) { const data = structuredClone(identity); change(data); assert.notEqual(first.id, benchmarkVersion(source, series, data).id); }
  assert.notEqual(first.id, benchmarkVersion(source, { progressRevision: 'd'.repeat(64) }, identity).id);
  for (const patch of [{ edition: null }, { scummbench: { ...identity.scummbench, dirty: true } }]) {
    const uncertain = { ...identity, ...patch };
    assert.notEqual(benchmarkVersion(source, series, uncertain).id, benchmarkVersion({ ...source, id: 'second' }, series, uncertain).id);
  }
});

test('feed discovers newly finished runs, isolates legacy groups and never exposes raw evidence', async t => {
  const root = await temporary(t), runs = path.join(root, 'runs');
  const feed = createResultsFeed({ runsDirectory: runs, registryDirectory: path.join(root, 'registry') });
  assert.equal((await feed()).games.length, 0);
  await writeInteractive(runs, { active: true });
  const active = await feed(); assert.equal(active.diagnostics.unavailable.in_progress, 1); assert.equal(active.games.length, 0);
  await writeInteractive(runs);
  const first = await feed(); assert.equal(first.diagnostics.plotted, 1);
  assert.equal(first.games[0].benchmarks[0].runs[0].completion_actions, 2);
  assert.equal((await feed()).revision, first.revision);
  await writeInteractive(runs, { id: '22222222-2222-4222-8222-222222222222', won: false });
  const second = await feed(); assert.equal(second.games[0].benchmarks.length, 2);
  assert.notEqual(second.revision, first.revision);
  assert.ok(second.games[0].benchmarks.every(version => version.runs.length === 1 && version.isolated));
  assert.doesNotMatch(JSON.stringify(second), /never-public|trajectory|directory|screenshots|completion_note|latest_milestone/);
});

test('corrupt and linked artifacts are withheld without hiding other valid runs', async t => {
  const root = await temporary(t), runs = path.join(root, 'runs');
  const first = await writeInteractive(runs);
  const second = await writeInteractive(runs, { id: '22222222-2222-4222-8222-222222222222' });
  await writeFile(path.join(second.directory, 'progress.jsonl'), '{"tampered":true}');
  const malformed = path.join(runs, 'malformed');
  await mkdir(malformed);
  await writeFile(path.join(malformed, 'run.json'), '{broken');
  await symlink(first.directory, path.join(runs, 'linked-run'));
  const result = await createResultsFeed({ runsDirectory: runs, registryDirectory: path.join(root, 'registry') })();
  assert.equal(result.diagnostics.discovered, 3); assert.equal(result.diagnostics.plotted, 1);
  assert.equal(result.diagnostics.unavailable.invalid_or_incomplete_evidence, 2);
});

test('native capture projects only private progress and refuses sources outside the chosen store', async t => {
  const root = await temporary(t), native = path.join(root, 'native'), output = path.join(root, 'output');
  await mkdir(path.join(native, 'runs'), { recursive: true }); await mkdir(output);
  const result = { content: [{ type: 'text', text: JSON.stringify({ game: 'flight-of-the-amazon-queen', sessionId: 'session', dataDir: native }) }] };
  const descriptor = runtimeDescriptor(result, 'flight-of-the-amazon-queen', native);
  assert.ok(descriptor);
  assert.equal(runtimeDescriptor(result, 'flight-of-the-amazon-queen', path.join(root, 'elsewhere')), null);
  await writeFile(path.join(native, 'runs/session.jsonl'), JSON.stringify({ type: 'progress', sessionId: 'session', timestamp: at(1), progress: { ...progress(50), latest_milestone: 'private solution label' }, secret: 'never-copy' }) + '\n');
  const captured = await captureProgress(output, descriptor);
  assert.equal(captured.state, 'available');
  assert.doesNotMatch(await readFile(path.join(output, 'progress.jsonl'), 'utf8'), /private solution|never-copy|latest_milestone/);
  assert.equal((await stat(path.join(output, 'progress.jsonl'))).mode & 0o077, 0);
});

test('registered display receipts are version-separated and whitelist all output fields', async t => {
  const root = await temporary(t), registry = path.join(root, 'registry'); await mkdir(registry);
  const benchmark = structuredClone(sampleResults.games[0].benchmarks[0]);
  const checksum = 'd'.repeat(64), id = `archive-${checksum}`;
  benchmark.id = 'e'.repeat(64); benchmark.runs[0].id = id;
  await writeFile(path.join(registry, `${checksum}.json`), JSON.stringify({ results_owner: 'scummbench', trajectory_sha256: checksum,
    archive: '/private/path', display_result: { source: { id, game: 'flight-of-the-amazon-queen' }, version: { ...benchmark, runs: undefined, private: 'never-copy' },
      run: { ...benchmark.runs[0], private: 'never-copy', transcript: 'never-copy' } } }));
  const result = await createResultsFeed({ runsDirectory: path.join(root, 'runs'), registryDirectory: registry })();
  assert.equal(result.diagnostics.plotted, 1); assert.doesNotMatch(JSON.stringify(result), /never-copy|private\/path|transcript/);
});

test('HTTP feed sees a completed artifact without restarting its server', async t => {
  const root = await temporary(t), runs = path.join(root, 'runs');
  const child = spawn(process.execPath, ['scripts/results-dev.js', '--port', 'auto', '--runs', runs, '--registry', path.join(root, 'registry')], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const url = await new Promise((resolve, reject) => {
    let text = ''; const timer = setTimeout(() => reject(new Error('Server startup deadline')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => { text += chunk; const match = text.match(/ScummBench results: (http:\/\/[^\s]+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const before = await (await fetch(`${url}api/results`)).json(); assert.equal(before.games.length, 0);
  await writeInteractive(runs);
  const response = await fetch(`${url}api/results`), after = await response.json();
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(after.diagnostics.plotted, 1); assert.notEqual(after.revision, before.revision);
  assert.equal((await fetch(`${url}runs/11111111-1111-4111-8111-111111111111/run.json`)).status, 404);
  const foreignHostStatus = await new Promise((resolve, reject) => {
    const req = request(`${url}api/results`, { headers: { Host: 'external.invalid' } }, response => { response.resume(); resolve(response.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${url}api/results`, { headers: { Origin: 'https://external.invalid' } })).status, 403);
});
