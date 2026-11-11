import { validateResults } from './results-model.js';

const contract = value => JSON.stringify(value, Object.keys(value).sort());
// Merge by immutable benchmark identity; labels and package versions never group runs.
export function mergeResults(previous, incoming) {
  validateResults(previous); validateResults(incoming);
  const games = new Map(), identities = new Map();
  for (const data of [previous, incoming]) for (const game of data.games) {
    let target = games.get(game.id);
    if (!target) { target = { id: game.id, label: game.label, benchmarks: [] }; games.set(game.id, target); }
    for (const version of game.benchmarks) {
      let benchmark = target.benchmarks.find(item => item.id === version.id);
      if (benchmark && (contract(benchmark.contract) !== contract(version.contract) || benchmark.isolated !== version.isolated)) throw new Error('Benchmark identity conflict');
      if (!benchmark) { benchmark = { ...version, runs: [] }; target.benchmarks.push(benchmark); }
      for (const run of version.runs) {
        const identity = `${game.id}/${version.id}`;
        if (identities.has(run.id) && identities.get(run.id) !== identity) throw new Error('Run identity conflict');
        identities.set(run.id, identity);
        const index = benchmark.runs.findIndex(item => item.id === run.id);
        if (index < 0) benchmark.runs.push(run); else benchmark.runs[index] = run;
      }
      benchmark.runs.sort((a, b) => (b.finished_at ?? b.date).localeCompare(a.finished_at ?? a.date) || a.id.localeCompare(b.id));
    }
    target.benchmarks.sort((a, b) => (b.runs[0]?.finished_at ?? b.runs[0]?.date ?? '').localeCompare(a.runs[0]?.finished_at ?? a.runs[0]?.date ?? '') || a.id.localeCompare(b.id));
  }
  const result = { schema_version: 1, games: [...games.values()].sort((a, b) => a.label.localeCompare(b.label)) };
  const runs = result.games.flatMap(game => game.benchmarks.flatMap(version => version.runs));
  result.diagnostics = { discovered: runs.length, plotted: runs.filter(run => run.points.length).length,
    counts_only: runs.filter(run => !run.points.length).length, unavailable: {} };
  return validateResults(result);
}
