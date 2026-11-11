import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { validateResults, selectBenchmark, stepVertices, actionsToFinish } from '../web/results-model.js';
import { chartGeometry } from '../web/chart.js';
import { sampleResults } from '../web/sample-data.js';

const fixture = () => structuredClone(sampleResults);

test('the selected benchmark never includes another version or game', () => {
  const data = validateResults(fixture());
  const current = selectBenchmark(data, 'flight-of-the-amazon-queen', 'sample-v2');
  assert.deepEqual(current.runs.map(run => run.id), ['r3', 'r2', 'r1']);
  const previous = selectBenchmark(data, current.game.id, 'sample-v1');
  assert.deepEqual(previous.runs.map(run => run.id), ['r0', 'early']);
  assert.equal(previous.benchmark.contract.progress_revision, 'sample-progress-1');
  assert.deepEqual(selectBenchmark(data, 'beneath-a-steel-sky').runs, []);
  assert.deepEqual(selectBenchmark({ games: [] }).runs, []);
});

test('steps hold the earlier progress until the next observed action count', () => {
  const run = { actions: 80, points: [{ actions: 10, progress: 15 }, { actions: 50, progress: 40 }] };
  assert.deepEqual(stepVertices(run), [
    { actions: 10, progress: 15 }, { actions: 50, progress: 15 },
    { actions: 50, progress: 40 }, { actions: 80, progress: 40 },
  ]);
  // No invented (0, 0) baseline or projected completion for missing evidence.
  assert.equal(stepVertices(run)[0].actions, 10);
  assert.equal(stepVertices(run).at(-1).progress, 40);
});

test('unfinished action totals never become actions to finish', () => {
  const runs = selectBenchmark(fixture(), 'flight-of-the-amazon-queen', 'sample-v2').runs;
  assert.equal(actionsToFinish(runs[0]), 380);
  assert.equal(actionsToFinish(runs[2]), null);
});

test('counts-only legacy evidence never invents milestone geometry or completion', () => {
  const data = fixture(), run = data.games[0].benchmarks[0].runs[0];
  run.evidence_status = 'actions_only'; run.points = []; run.outcome = 'stopped';
  run.completion_verified = false; run.completion_actions = null;
  validateResults(data);
  assert.deepEqual(stepVertices(run), []);
  assert.equal(actionsToFinish(run), null);
  run.completion_verified = true;
  assert.throws(() => validateResults(data));
});

test('reject mixed or missing version contracts, duplicate IDs and malformed dates', () => {
  for (const change of [
    data => { delete data.games[0].benchmarks[0].contract.progress_revision; },
    data => { data.games[0].benchmarks[1].id = data.games[0].benchmarks[0].id; },
    data => { data.games[0].benchmarks[0].runs[1].id = 'r3'; },
    data => { data.games[0].benchmarks[0].runs[0].date = '2026-02-30'; },
  ]) {
    const data = fixture(); change(data); assert.throws(() => validateResults(data));
  }
});

test('reject unverified 100%, false completion, regressions and action overflow', () => {
  for (const change of [
    run => { run.completion_verified = false; },
    run => { run.points.at(-1).progress = 99; },
    run => { run.points[1].progress = 101; },
    run => { run.points[2].progress = 5; },
    run => { run.points[2].actions = 1; },
    run => { run.actions = 100; },
    run => { run.actions = 400; },
  ]) {
    const data = fixture(); change(data.games[0].benchmarks[0].runs[0]);
    assert.throws(() => validateResults(data));
  }
});

test('chart domain fits zero-action and long runs without mixing progress and action units', () => {
  for (const width of [350, 1280]) {
    const runs = selectBenchmark(fixture()).runs;
    const geometry = chartGeometry(width, 380, runs);
    assert.ok(geometry.xMax >= 600);
    assert.equal(geometry.y(100), geometry.plot.top);
    assert.equal(geometry.y(0), geometry.plot.bottom);
    assert.ok(geometry.x(380) < geometry.x(540));
    assert.ok(Number.isFinite(chartGeometry(width, 380, [{ actions: 0 }]).x(0)));
    assert.ok(chartGeometry(width, 380, [{ actions: 0 }]).unit >= 1);
  }
});

test('preview serves only the public display files and refuses writes', async t => {
  const child = spawn(process.execPath, ['scripts/results-dev.js', '--port', 'auto'], { cwd: new URL('..', import.meta.url), stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, 'exit'); } });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Preview did not start')), 5000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', chunk => {
      output += chunk;
      const match = output.match(/ScummBench results: (http:\/\/[^\s]+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Progress vs actions/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.deepEqual(await (await fetch(`${url}results.json`)).json(), { schema_version: 1, games: [] });
  for (const route of ['package.json', 'runs/private/result.json', '%2e%2e%2fREADME.md']) assert.equal((await fetch(`${url}${route}`)).status, 404);
  assert.equal((await fetch(url, { method: 'POST', body: 'test' })).status, 405);
});
