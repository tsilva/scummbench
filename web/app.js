import { validateResults, selectBenchmark, actionsToFinish, shortDate } from './results-model.js';
import { ProgressChart } from './chart.js';
import { LiveResults } from './live-results.js';

const $ = id => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
const state = { data: { schema_version: 1, games: [] }, game: parameters.get('game'), benchmark: parameters.get('benchmark'), demo: parameters.get('demo') === '1' };
let loadRevision = 0;
let pendingData, feedStale = false;
async function fetchResults(signal) {
  const bounded = AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]);
  const response = await fetch('./api/results', { cache: 'no-store', signal: bounded });
  if (!response.ok) throw new Error('Results could not be loaded.');
  return validateResults(await response.json());
}
const sourceLabel = data => data.publication?.mode === 'snapshot' ? 'Published results' : 'Live results';
const sourceHelp = data => data.publication?.mode === 'snapshot' ? 'Checks for newly published results every 5 seconds. Switch to sample data.' : 'Refreshes every 5 seconds. Switch to sample data.';
function markFresh(data) {
  if (feedStale) $('announcement').textContent = 'Results connection restored.';
  feedStale = false;
  $('data-source').textContent = sourceLabel(data);
  $('data-source').title = sourceHelp(data);
}
function acceptUpdate(data) {
  if (state.demo) return;
  markFresh(data);
  if (state.data.revision === data.revision) return;
  if (document.activeElement?.matches('select')) { pendingData = data; return; }
  const open = $('accessible-data').open;
  state.data = data; render(); $('accessible-data').open = open;
}
const live = new LiveResults({ fetchResults, onData: acceptUpdate,
  onError: () => {
    feedStale = true; $('data-source').textContent = 'Results · retrying';
    $('data-source').title = 'Showing the last successful results. Click to retry now.';
    $('announcement').textContent = 'Results could not refresh. Showing the last successful data; retrying automatically.';
  }, visible: () => !document.hidden });
const chart = new ProgressChart({ canvas: $('chart'), labels: $('run-labels'), tooltip: $('tooltip'), onSelect: showRun });
const option = (value, label) => Object.assign(document.createElement('option'), { value, textContent: label });
function setOptions(select, values, selected, empty) {
  select.replaceChildren(...(values.length ? values.map(value => option(value.id, value.label)) : [option('', empty)]));
  select.disabled = !values.length;
  if (selected) select.value = selected;
}
function syncUrl() {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries({ demo: state.demo ? '1' : null, game: state.game, benchmark: state.benchmark })) {
    if (value) url.searchParams.set(key, value); else url.searchParams.delete(key);
  }
  history.replaceState(null, '', url);
}
function render() {
  const { game, benchmark, runs } = selectBenchmark(state.data, state.game, state.benchmark);
  state.game = game?.id; state.benchmark = benchmark?.id;
  setOptions($('game'), state.data.games, game?.id, 'Game results');
  $('game').title = game?.label ?? 'Game results';
  setOptions($('benchmark'), game?.benchmarks ?? [], benchmark?.id, 'No benchmark versions');
  $('context').textContent = benchmark?.context ?? 'Adventure-game agent evaluation';
  $('data-source').textContent = state.demo ? 'Sample data' : feedStale ? 'Results · retrying' : sourceLabel(state.data);
  $('data-source').title = state.demo ? 'Switch to recorded results' : sourceHelp(state.data);
  const charted = runs.filter(run => run.points.length);
  $('chart-wrap').hidden = !charted.length; $('empty').hidden = !!charted.length;
  $('accessible-data').hidden = !runs.length;
  $('accessible-data').open = !!runs.length && !charted.length;
  $('empty-title').textContent = runs.length ? 'Recovered measurements' : benchmark ? 'No runs for this version yet' : 'No results yet';
  $('empty-description').textContent = runs.length ? 'Available action totals and native progress are shown below. Missing measurements stay unavailable; no trajectory is drawn without verified action alignment.' : benchmark ? 'Choose another game or benchmark version to explore its results. Different versions stay separate.' : 'Recorded runs will appear here when they include a benchmark version and verified progress.';
  $('sample-button').hidden = state.demo || !!runs.length;
  $('sample-button').textContent = 'Explore sample runs';
  $('sample-button').onclick = () => load(true);
  $('announcement').textContent = `${state.demo ? 'Sample data. ' : ''}${game?.label ?? 'No games'}, ${benchmark?.label ?? 'no versions'}, ${runs.length} ${runs.length === 1 ? 'run' : 'runs'}.`;
  $('results').setAttribute('aria-busy', 'false');
  $('data-rows').replaceChildren();
  for (const run of runs) for (const point of run.points.length ? run.points : [{ actions: run.actions, progress: run.progress_percent ?? null, snapshot: true }]) {
    const row = document.createElement('tr');
    const name = document.createElement('td'), button = document.createElement('button');
    button.className = 'text-button'; button.textContent = run.label; button.onclick = () => showRun(run); name.append(button); row.append(name);
    for (const value of [run.date, point.actions?.toLocaleString() ?? 'Unavailable', point.progress === null ? 'Unavailable' : `${point.progress}%${point.snapshot ? ' (snapshot)' : ''}`]) row.append(Object.assign(document.createElement('td'), { textContent: value }));
    $('data-rows').append(row);
  }
  chart.update(charted);
  syncUrl();
}
async function load(demo) {
  live.stop(); pendingData = null; feedStale = false;
  const revision = ++loadRevision;
  $('results').setAttribute('aria-busy', 'true');
  try {
    let data;
    if (demo) data = (await import('./sample-data.js')).sampleResults;
    else {
      data = await fetchResults();
    }
    if (revision !== loadRevision) return;
    state.data = validateResults(data); state.demo = demo;
    render();
    if (!demo) live.start();
  } catch {
    if (revision !== loadRevision) return;
    // Clear the previous chart rather than showing stale or mislabelled results.
    state.data = { schema_version: 1, games: [] }; state.demo = demo;
    render();
    $('empty-title').textContent = 'Results are unavailable';
    $('empty-description').textContent = 'The results could not be read. Please try again.';
    $('sample-button').hidden = false; $('sample-button').textContent = 'Try again';
    $('sample-button').onclick = () => load(demo);
    $('announcement').textContent = 'Results could not be loaded.';
    if (!demo) live.start();
  }
}
function showRun(run) {
  const { game, benchmark } = selectBenchmark(state.data, state.game, state.benchmark);
  $('run-title').textContent = run.label;
  $('run-subtitle').textContent = `${game.label} · ${shortDate(run.date)} ${run.date.slice(0, 4)}${state.demo ? ' · Sample run' : ''}`;
  $('run-facts').replaceChildren();
  const facts = [
    ...(run.finished_at ? [['Recorded through (UTC)', run.finished_at.replace('T', ' ').replace('Z', '')]] : []),
    ['Benchmark version', benchmark.label], ['Outcome', run.completion_verified ? 'Verified completion' : run.task_succeeded ? 'Task succeeded; game unfinished' : run.outcome.replaceAll('_', ' ')],
    ['Game progress', run.points.length ? `${run.points.at(-1).progress}%` : run.progress_percent != null ? `${run.progress_percent}% (snapshot)` : 'Unavailable'], ['Submitted actions', run.actions?.toLocaleString() ?? 'Unavailable'],
    ['Actions to finish', actionsToFinish(run)?.toLocaleString() ?? (!run.points.length ? 'Unavailable' : 'Not completed')],
    ...(run.screenshot_status ? [['Screenshots', run.screenshot_status]] : []),
    ...(run.missing_data?.length ? [['Missing evidence', run.missing_data.join('; ')]] : []),
    ['AgentSCUMM version', run.agent_version ?? 'Unknown'], ['AgentSCUMM commit', run.agent_commit ?? 'Unknown'],
    ['Starting conditions', benchmark.contract.start], ['Track', benchmark.contract.track],
    ['Game edition', benchmark.contract.game_edition], ['Progress revision', benchmark.contract.progress_revision],
    ['Action definition', benchmark.contract.action_revision], ['Completion rule', benchmark.contract.completion_revision],
    ['Toolset revision', benchmark.contract.toolset_revision],
    ...(run.recorded_outcome ? [['Recorded outcome', run.recorded_outcome.replaceAll('_', ' ')]] : []),
    ...['scummbench_revision', 'mechanics_revision', 'runtime_revision'].filter(key => benchmark.contract[key])
      .map(key => [key.replaceAll('_', ' '), benchmark.contract[key]]),
  ];
  for (const [name, value] of facts) $('run-facts').append(Object.assign(document.createElement('dt'), { textContent: name }), Object.assign(document.createElement('dd'), { textContent: value }));
  $('run-points').replaceChildren();
  for (const point of run.points) {
    const row = document.createElement('tr');
    for (const value of [point.milestone ?? 'Verified milestone', point.actions?.toLocaleString() ?? 'Unavailable', `${point.progress}%`]) row.append(Object.assign(document.createElement('td'), { textContent: value }));
    $('run-points').append(row);
  }
  $('run-dialog').showModal();
}
$('game').addEventListener('change', () => { state.game = $('game').value; state.benchmark = null; render(); });
$('benchmark').addEventListener('change', () => { state.benchmark = $('benchmark').value; render(); });
$('data-source').addEventListener('click', () => load(feedStale ? false : !state.demo));
$('about-button').addEventListener('click', () => {
  const diagnostics = state.data.diagnostics;
  const counts = Object.entries(diagnostics?.unavailable ?? {}).map(([name, count]) => `${count} ${name.replaceAll('_', ' ')}`);
  const freshness = state.data.publication?.mode === 'snapshot'
    ? `Published snapshot from ${new Date(state.data.publication.generated_at).toLocaleString()}. Checks for newly published results every 5 seconds.`
    : 'Live results refresh every 5 seconds.';
  $('feed-diagnostics').textContent = state.demo ? 'Sample data is illustrative and does not refresh.'
    : `${diagnostics?.plotted ?? 0} charted ${diagnostics?.plotted === 1 ? 'run' : 'runs'}. ${diagnostics?.counts_only ?? 0} legacy runs without an aligned trajectory.${counts.length ? ` Not charted: ${counts.join('; ')}.` : ''} ${freshness} Legacy versions isolate runs whose comparison provenance is incomplete.`;
  $('about-dialog').showModal();
});
$('recorded-button').addEventListener('click', () => { $('about-dialog').close(); load(false); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
await load(state.demo);
document.fonts.ready.then(() => chart.draw());
document.addEventListener('visibilitychange', () => { if (!document.hidden) live.refresh(); });
document.addEventListener('focusout', () => queueMicrotask(() => {
  if (pendingData && !state.demo && !document.activeElement?.matches('select')) {
    const data = pendingData; pendingData = null; acceptUpdate(data);
  }
}));
window.addEventListener('pagehide', () => live.stop());
window.addEventListener('pageshow', event => { if (event.persisted && !state.demo) live.start({ immediate: true }); });
