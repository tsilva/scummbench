// A curated display export, not a replacement for native result verification.
export function validateResults(data) {
  const require = (ok, message) => { if (!ok) throw new Error(message); };
  const text = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 240;
  require(data?.schema_version === 1 && Array.isArray(data.games), 'Unsupported results format.');
  const gameIds = new Set();
  for (const game of data.games) {
    require(text(game.id) && text(game.label) && !gameIds.has(game.id), 'Invalid or duplicate game.');
    gameIds.add(game.id);
    require(Array.isArray(game.benchmarks), 'Missing benchmark versions.');
    const versionIds = new Set();
    for (const benchmark of game.benchmarks) {
      require(text(benchmark.id) && text(benchmark.label) && text(benchmark.context)
        && !versionIds.has(benchmark.id), 'Invalid or duplicate benchmark version.');
      versionIds.add(benchmark.id);
      for (const key of ['game_edition', 'start', 'track', 'progress_revision', 'action_revision', 'completion_revision', 'toolset_revision']) {
        require(text(benchmark.contract?.[key]), `Missing benchmark contract: ${key}.`);
      }
      require(Array.isArray(benchmark.runs), 'Missing run list.');
      const runIds = new Set();
      for (const run of benchmark.runs) {
        require(text(run.id) && text(run.label) && !runIds.has(run.id), 'Invalid or duplicate run.');
        runIds.add(run.id);
        require(typeof run.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(run.date)
          && !Number.isNaN(Date.parse(run.date)) && new Date(run.date).toISOString().slice(0, 10) === run.date, 'Invalid run date.');
        require(['completed', 'stopped', 'budget_exhausted', 'infrastructure_error', 'in_progress'].includes(run.outcome), 'Invalid run outcome.');
        require(typeof run.completion_verified === 'boolean', 'Missing completion verification.');
        require(Number.isSafeInteger(run.actions) && run.actions >= 0, 'Invalid action count.');
        require(Array.isArray(run.points) && run.points.length > 0, 'No verified milestone samples.');
        let actions = -1, progress = -1;
        for (const point of run.points) {
          require(Number.isSafeInteger(point.actions) && point.actions >= 0 && point.actions >= actions
            && point.actions <= run.actions, 'Milestone actions must be ordered and within the run.');
          require(Number.isFinite(point.progress) && point.progress >= 0 && point.progress <= 100
            && point.progress >= progress, 'Progress must be verified high-water percentages from 0 to 100.');
          require(point.milestone === undefined || text(point.milestone), 'Invalid milestone label.');
          actions = point.actions; progress = point.progress;
        }
        require((run.outcome === 'completed') === run.completion_verified, 'Completion outcome needs independent verification.');
        require((progress === 100) === run.completion_verified, '100% is reserved for verified completion.');
        require(!run.completion_verified || actions === run.actions, 'Completed run must stop at its verified ending.');
      }
    }
  }
  return data;
}

export function selectBenchmark(data, gameId, benchmarkId) {
  const game = data.games.find(item => item.id === gameId) ?? data.games[0];
  const benchmark = game?.benchmarks.find(item => item.id === benchmarkId) ?? game?.benchmarks[0];
  return { game, benchmark, runs: [...(benchmark?.runs ?? [])].sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)) };
}

export function stepVertices(run) {
  const vertices = [];
  for (const point of run.points) {
    if (vertices.length) vertices.push({ actions: point.actions, progress: vertices.at(-1).progress });
    vertices.push({ actions: point.actions, progress: point.progress });
  }
  if (vertices.at(-1).actions < run.actions) vertices.push({ actions: run.actions, progress: vertices.at(-1).progress });
  return vertices;
}

export function actionsToFinish(run) {
  return run.completion_verified ? run.actions : null;
}

export const shortDate = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date));
