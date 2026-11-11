const contract = revision => ({
  game_edition: 'Illustrative Queen edition', start: 'Fresh start', track: 'Development example',
  progress_revision: `sample-progress-${revision}`, action_revision: 'sample-submitted-records-1',
  completion_revision: 'sample-ending-1', toolset_revision: `sample-tools-${revision}`,
});
const run = (id, date, actions, percentages, completed = true) => ({
  id, label: `Player ${id}`, date, actions, outcome: completed ? 'completed' : 'stopped',
  completion_verified: completed,
  points: percentages.map(([actions, progress], index) => ({ actions, progress, milestone: index ? `Milestone ${index}` : 'Start' })),
});

// Entirely synthetic. These are not registered playthroughs or model claims.
export const sampleResults = { schema_version: 1, games: [{
  id: 'flight-of-the-amazon-queen', label: 'Flight of the Amazon Queen', benchmarks: [{
    id: 'sample-v2', label: 'Benchmark v2', context: 'Full game · Fresh start', contract: contract('2'), runs: [
      run('r3', '2026-11-09', 380, [[0, 0], [40, 15], [100, 35], [170, 60], [260, 85], [380, 100]]),
      run('r2', '2026-11-05', 540, [[0, 0], [100, 20], [200, 40], [300, 60], [430, 80], [540, 100]]),
      run('r1', '2026-11-01', 600, [[0, 0], [120, 15], [300, 30], [600, 45]], false),
    ],
  }, {
    id: 'sample-v1', label: 'Benchmark v1', context: 'Full game · Fresh start', contract: contract('1'), runs: [
      run('r0', '2026-10-28', 760, [[0, 0], [140, 15], [320, 30], [480, 55], [620, 80], [760, 100]]),
      run('early', '2026-10-24', 800, [[0, 0], [180, 10], [420, 25], [800, 40]], false),
    ],
  }] }, {
    id: 'beneath-a-steel-sky', label: 'Beneath a Steel Sky', benchmarks: [{
      id: 'sample-empty', label: 'Benchmark v1', context: 'Full game · Fresh start', contract: contract('sky-1'), runs: [],
    }],
  }] };
