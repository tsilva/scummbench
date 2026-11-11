import { validateResults, selectBenchmark, actionsToFinish, shortDate } from './results-model.js';
import { ProgressChart } from './chart.js';

const $ = id => document.getElementById(id);
const parameters = new URLSearchParams(location.search);
const state = { data: { schema_version: 1, games: [] }, game: parameters.get('game'), benchmark: parameters.get('benchmark'), demo: parameters.get('demo') === '1' };
let loadRevision = 0;
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
  $('data-source').textContent = state.demo ? 'Sample data' : 'Recorded results';
  $('data-source').title = state.demo ? 'Switch to recorded results' : 'Explore sample data';
  $('chart-wrap').hidden = !runs.length; $('empty').hidden = !!runs.length;
  $('accessible-data').hidden = !runs.length;
  $('accessible-data').open = false;
  $('empty-title').textContent = benchmark ? 'No runs for this version yet' : 'No results yet';
  $('empty-description').textContent = benchmark ? 'Choose another game or benchmark version to explore its results. Different versions stay separate.' : 'Recorded runs will appear here when they include a benchmark version and verified progress.';
  $('sample-button').hidden = state.demo;
  $('sample-button').textContent = 'Explore sample runs';
  $('sample-button').onclick = () => load(true);
  $('announcement').textContent = `${state.demo ? 'Sample data. ' : ''}${game?.label ?? 'No games'}, ${benchmark?.label ?? 'no versions'}, ${runs.length} runs.`;
  $('results').setAttribute('aria-busy', 'false');
  $('data-rows').replaceChildren();
  for (const run of runs) for (const point of run.points) {
    const row = document.createElement('tr');
    for (const value of [run.label, run.date, point.actions.toLocaleString(), `${point.progress}%`]) row.append(Object.assign(document.createElement('td'), { textContent: value }));
    $('data-rows').append(row);
  }
  chart.update(runs);
  syncUrl();
}
async function load(demo) {
  const revision = ++loadRevision;
  $('results').setAttribute('aria-busy', 'true');
  try {
    let data;
    if (demo) data = (await import('./sample-data.js')).sampleResults;
    else {
      const response = await fetch('./results.json', { cache: 'no-store' });
      if (!response.ok) throw new Error('Results could not be loaded.');
      data = await response.json();
    }
    if (revision !== loadRevision) return;
    state.data = validateResults(data); state.demo = demo;
    render();
  } catch {
    if (revision !== loadRevision) return;
    // Clear the previous chart rather than showing stale or mislabelled results.
    state.data = { schema_version: 1, games: [] }; state.demo = demo;
    render();
    $('empty-title').textContent = 'Results are unavailable';
    $('empty-description').textContent = 'The results file could not be read or contains an invalid benchmark or milestone. Fix the export, then try again.';
    $('sample-button').hidden = false; $('sample-button').textContent = 'Try again';
    $('sample-button').onclick = () => load(demo);
    $('announcement').textContent = 'Results could not be loaded.';
  }
}
function showRun(run) {
  const { game, benchmark } = selectBenchmark(state.data, state.game, state.benchmark);
  $('run-title').textContent = run.label;
  $('run-subtitle').textContent = `${game.label} · ${shortDate(run.date)} ${run.date.slice(0, 4)}${state.demo ? ' · Sample run' : ''}`;
  $('run-facts').replaceChildren();
  const facts = [
    ['Benchmark version', benchmark.label], ['Outcome', run.completion_verified ? 'Verified completion' : run.outcome.replaceAll('_', ' ')],
    ['Game progress', `${run.points.at(-1).progress}%`], ['Submitted actions', run.actions.toLocaleString()],
    ['Actions to finish', actionsToFinish(run)?.toLocaleString() ?? 'Not completed'],
    ['Starting conditions', benchmark.contract.start], ['Track', benchmark.contract.track],
    ['Game edition', benchmark.contract.game_edition], ['Progress revision', benchmark.contract.progress_revision],
    ['Action definition', benchmark.contract.action_revision], ['Completion rule', benchmark.contract.completion_revision],
    ['Toolset revision', benchmark.contract.toolset_revision],
  ];
  for (const [name, value] of facts) $('run-facts').append(Object.assign(document.createElement('dt'), { textContent: name }), Object.assign(document.createElement('dd'), { textContent: value }));
  $('run-points').replaceChildren();
  for (const point of run.points) {
    const row = document.createElement('tr');
    for (const value of [point.milestone ?? 'Verified milestone', point.actions.toLocaleString(), `${point.progress}%`]) row.append(Object.assign(document.createElement('td'), { textContent: value }));
    $('run-points').append(row);
  }
  $('run-dialog').showModal();
}
$('game').addEventListener('change', () => { state.game = $('game').value; state.benchmark = null; render(); });
$('benchmark').addEventListener('change', () => { state.benchmark = $('benchmark').value; render(); });
$('data-source').addEventListener('click', () => load(!state.demo));
$('about-button').addEventListener('click', () => $('about-dialog').showModal());
$('recorded-button').addEventListener('click', () => { $('about-dialog').close(); load(false); });
document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
for (const dialog of document.querySelectorAll('dialog')) dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
await load(state.demo);
document.fonts.ready.then(() => chart.draw());
