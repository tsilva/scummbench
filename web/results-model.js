// Public-safe display schema; source verification stays in the local reader.
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
        if (run.finished_at !== undefined) require(typeof run.finished_at === 'string'
          && !Number.isNaN(Date.parse(run.finished_at)) && new Date(run.finished_at).toISOString().slice(0, 10) === run.date, 'Invalid finish timestamp.');
        require(Number.isSafeInteger(run.actions) && run.actions >= 0, 'Invalid action count.');
        const countsOnly = run.evidence_status === 'actions_only';
        require(Array.isArray(run.points) && (countsOnly ? run.points.length === 0 : run.points.length > 0), 'No verified milestone samples.');
        require(!countsOnly || (!run.completion_verified && run.completion_actions == null), 'Counts alone cannot establish completion.');
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
        const finish = run.completion_actions ?? run.actions;
        require(run.completion_actions == null || run.completion_verified, 'Unfinished runs cannot claim actions to finish.');
        require(!run.completion_verified || (Number.isSafeInteger(finish) && finish >= 0 && finish <= run.actions && actions === finish),
          'Completed run must stop at its verified ending.');
      }
    }
  }
  return data;
}

export function selectBenchmark(data, gameId, benchmarkId) {
  const useful = benchmark => benchmark.runs.some(run => run.points.some(point => point.progress > 0));
  const game = data.games.find(item => item.id === gameId)
    ?? data.games.find(item => item.benchmarks.some(useful)) ?? data.games[0];
  const benchmark = game?.benchmarks.find(item => item.id === benchmarkId)
    ?? game?.benchmarks.find(useful) ?? game?.benchmarks[0];
  return { game, benchmark, runs: [...(benchmark?.runs ?? [])].sort((a, b) => (b.finished_at ?? b.date).localeCompare(a.finished_at ?? a.date) || a.id.localeCompare(b.id)) };
}

export function stepVertices(run) {
  const vertices = [];
  if (!run.points.length) return vertices;
  for (const point of run.points) {
    if (vertices.length) vertices.push({ actions: point.actions, progress: vertices.at(-1).progress });
    vertices.push({ actions: point.actions, progress: point.progress });
  }
  if (!run.completion_verified && vertices.at(-1).actions < run.actions) vertices.push({ actions: run.actions, progress: vertices.at(-1).progress });
  return vertices;
}

export function actionsToFinish(run) {
  return run.completion_verified ? run.completion_actions ?? run.actions : null;
}

export const shortDate = date => new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(date));
