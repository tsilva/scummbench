import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { digest, root } from './contracts.js';
import { verifyRun } from './runner.js';
import { validateResults } from '../web/results-model.js';

const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
const time = value => { const result = Date.parse(value); if (!Number.isFinite(result)) throw new Error('Invalid timestamp'); return result; };
const number = value => Number.isSafeInteger(value) && value >= 0;
const stable = value => JSON.stringify(value, (_, item) => item && !Array.isArray(item) && typeof item === 'object'
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const title = id => ({ 'flight-of-the-amazon-queen': 'Flight of the Amazon Queen', 'beneath-a-steel-sky': 'Beneath a Steel Sky' }[id]
  ?? id.split('-').map(word => word[0]?.toUpperCase() + word.slice(1)).join(' '));
const label = (value, fallback) => typeof value === 'string' && value.length > 0 && value.length <= 120 && !/[\x00-\x1f/\\]/.test(value) ? value : fallback;
const read = async file => {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('Invalid result file');
  return readFile(file, 'utf8');
};
const json = async file => JSON.parse(await read(file));
const lines = async file => (await read(file)).split('\n').filter(Boolean).map(JSON.parse);

// Stop at a run boundary: never walk browser profiles, screenshots or symlinks.
async function discover(directory, depth = 0) {
  let entries;
  try { if ((await lstat(directory)).isSymbolicLink()) return []; entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (entries.some(e => e.isFile() && e.name === 'result.json')) return [{ directory, kind: 'fixed' }];
  if (entries.some(e => e.isFile() && e.name === 'run.json')) {
    // Portable archives enter through their verified registration receipt.
    try {
      const manifest = await json(path.join(directory, 'run.json'));
      if (manifest.trajectory) return [];
    } catch { /* Let the per-source reader report corrupt manifests. */ }
    return [{ directory, kind: 'interactive' }];
  }
  if (depth >= 4) return [];
  const found = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && !['runtime', 'screenshots'].includes(entry.name) && !entry.name.startsWith('.')) {
      found.push(...await discover(path.join(directory, entry.name), depth + 1));
    }
  }
  return found;
}

export function progressSeries({ game, session, started, finished, submissions, samples, totalActions }) {
  if (!number(totalActions)) throw new Error('invalid_evidence');
  const start = time(started), end = time(finished);
  if (end < start) throw new Error('invalid_evidence');
  const requests = submissions.map(item => ({ at: time(item.timestamp), count: item.count }));
  if (requests.some((item, index) => !number(item.count) || item.at < start || item.at > end
      || (index > 0 && item.at < requests[index - 1].at))
    || requests.reduce((sum, item) => sum + item.count, 0) !== totalActions) throw new Error('action_count_mismatch');
  const accepted = samples.filter(row => row.progress?.state === 'tracked');
  if (!accepted.length) throw new Error('missing_progress');
  if (accepted.some((row, index) => index > 0 && time(row.timestamp) < time(accepted[index - 1].timestamp))) throw new Error('invalid_evidence');
  const revisions = new Set(accepted.map(row => row.progress.map_revision));
  if (revisions.size !== 1 || !HASH.test([...revisions][0] ?? '')) throw new Error('mixed_or_missing_progress_revision');
  let highest = -1, index = 0, actions = 0, completionActions = null;
  const points = [];
  for (const row of accepted) {
    const p = row.progress, at = time(row.timestamp);
    if (at < start || at > end || p.game !== game || (row.session_id && row.session_id !== session)
      || !Number.isFinite(p.percent) || p.percent < 0 || p.percent > 100 || typeof p.won !== 'boolean'
      || !Number.isSafeInteger(p.total) || p.total < 1 || p.total > 100 || !number(p.completed) || p.completed > p.total
      || p.percent !== (p.won ? 100 : Math.floor(p.completed * 100 / p.total + .5))) throw new Error('invalid_progress');
    if (p.percent === 100 && !p.won) throw new Error('unverified_ending');
    while (index < requests.length && requests[index].at <= at) actions += requests[index++].count;
    if (p.percent > highest) {
      points.push({ actions, progress: p.percent }); highest = p.percent;
    }
    if (p.won) { completionActions = actions; break; }
  }
  if (!points.length) throw new Error('missing_progress');
  return { points, progressRevision: [...revisions][0], completionActions };
}

export function benchmarkVersion(source, series, identity) {
  const revisions = [identity.scummbench, identity.backend];
  // Dirty or unknown implementations cannot be presumed equivalent even when
  // their HEAD commits match. They get a stable, run-specific legacy group.
  const isolated = revisions.some(revision => !COMMIT.test(revision?.commit_id ?? '') || revision.dirty !== false)
    || !identity.edition || !identity.start || !identity.track || identity.track === 'unspecified';
  const version = { ...identity, progress: series.progressRevision, actions: 'submitted-records-v1', completion: 'native-won-v1' };
  if (isolated) version.isolated_run = source.id;
  const key = digest(stable(version));
  let starting = identity.start ?? 'Starting state unknown';
  if (starting.startsWith('{')) {
    const value = JSON.parse(starting);
    starting = value.kind === 'fresh_boot' ? 'Fresh start' : 'Recorded starting state';
  }
  return { id: key, label: `${isolated ? 'Legacy' : 'Benchmark'} · ${key.slice(0, 8)}`,
    context: `${source.category === 'short-task' ? 'Short task' : 'Interactive play'} · ${starting}`,
    contract: {
      game_edition: identity.edition ?? 'Unknown; isolated run', start: starting,
      track: identity.track ?? 'Unknown; isolated run', progress_revision: series.progressRevision,
      action_revision: 'submitted-records-v1', completion_revision: 'native-won-v1',
      toolset_revision: digest(stable({ scummbench: identity.scummbench, backend: identity.backend, tools: identity.tools ?? null })),
      scummbench_revision: COMMIT.test(identity.scummbench?.commit_id ?? '') ? identity.scummbench.commit_id : 'Unknown; isolated run',
      mechanics_revision: COMMIT.test(identity.backend?.commit_id ?? '') ? identity.backend.commit_id : 'Unknown; isolated run',
      runtime_revision: COMMIT.test(identity.runtime ?? '') ? identity.runtime : 'Unknown; isolated run',
    }, identity_sha256: key, isolated };
}

export async function fixedResult(directory) {
  const manifest = await verifyRun(directory);
  const task = await json(path.join(directory, 'task.json'));
  const events = await lines(path.join(directory, 'trajectory.jsonl'));
  const samples = await lines(path.join(directory, 'evaluation.jsonl'));
  const submissions = events.filter(event => event.type === 'action_submission').map(event => ({ timestamp: event.timestamp, count: event.actions.length }));
  const series = progressSeries({ game: manifest.game, session: manifest.session_id, started: manifest.started_at,
    finished: manifest.finished_at, totalActions: manifest.usage.submitted_actions, submissions,
    samples: samples.filter(row => row.timestamp && row.progress) });
  const source = { id: manifest.run_id, game: manifest.game, category: manifest.category };
  const version = benchmarkVersion(source, series, { kind: 'fixed_task', task: manifest.task_sha256, budgets: manifest.budgets,
    start: stable(task.start), track: manifest.track, category: manifest.category,
    viewport: task.viewport, observation: task.observation, controls: task.actions,
    runtime: manifest.backend.scummweb_revision_declared,
    scummbench: manifest.scummbench, backend: { commit_id: manifest.backend.commit_id, dirty: manifest.backend.dirty },
    edition: manifest.backend.served_assets_verified && manifest.backend.scummweb_revision_verified
      && COMMIT.test(manifest.backend.scummweb_revision_declared ?? '') && manifest.backend.asset_files_checked_locally?.length
      ? digest(stable(manifest.backend.asset_files_checked_locally)) : null });
  return { source, version, run: displayRun(source.id, label(manifest.agent.label, 'Agent'), manifest.finished_at,
    manifest.usage.submitted_actions, manifest.status === 'budget_exhausted' ? 'budget_exhausted'
      : manifest.status === 'infrastructure_error' ? 'infrastructure_error' : 'stopped', series,
    { task_succeeded: manifest.status === 'success', category: manifest.category, recorded_outcome: manifest.status }) };
}

function displayRun(id, name, finished, actions, outcome, series, extras = {}) {
  return { id, label: name, date: new Date(time(finished)).toISOString().slice(0, 10), finished_at: new Date(time(finished)).toISOString(), actions,
    outcome: series.completionActions !== null ? 'completed' : outcome,
    completion_verified: series.completionActions !== null, completion_actions: series.completionActions,
    points: series.points, ...extras };
}

export async function interactiveResult(directory) {
  const manifest = await json(path.join(directory, 'run.json'));
  if (manifest.kind !== 'interactive_mcp') throw new Error('unsupported_run');
  if (manifest.status === 'in_progress' || !manifest.finished_at) throw new Error('in_progress');
  if (manifest.progress_capture?.state !== 'available' || !HASH.test(manifest.progress_capture?.sha256 ?? '')) throw new Error('missing_progress');
  const progress = await read(path.join(directory, 'progress.jsonl'));
  if (digest(progress) !== manifest.progress_capture.sha256) throw new Error('invalid_evidence');
  const events = await lines(path.join(directory, 'trajectory.jsonl'));
  const submissions = events.filter(e => e.type === 'mcp_request' && e.params?.name === 'act')
    .map(e => ({ timestamp: e.timestamp, count: Array.isArray(e.params.arguments?.actions) ? e.params.arguments.actions.length : 0 }));
  const series = progressSeries({ game: manifest.game_id, session: manifest.mechanics_session_id,
    started: manifest.started_at, finished: manifest.finished_at, totalActions: manifest.usage?.submitted_actions,
    submissions, samples: progress.split('\n').filter(Boolean).map(JSON.parse) });
  const source = { id: manifest.run_id, game: manifest.game_id, category: 'interactive' };
  const launch = events.find(e => e.type === 'mcp_request' && e.params?.name === 'session' && e.params.arguments?.operation === 'start');
  const version = benchmarkVersion(source, series, { kind: 'interactive', start: launch?.params.arguments.mode === 'continue' ? 'Continued save' : 'Fresh session',
    track: manifest.track, scummbench: manifest.scummbench, backend: manifest.scummweb, edition: null });
  return { source, version, run: displayRun(source.id, `Run ${source.id.slice(0, 8)}`, manifest.finished_at,
    manifest.usage.submitted_actions, 'stopped', series, { recorded_outcome: manifest.status }) };
}

export function createResultsFeed({ runsDirectory, registryDirectory = path.join(root, '.internal/archive-registry'),
  readFixed = fixedResult, verifyArchiveManifests = false, archiveDirectory = path.join(root, 'runs/archives') } = {}) {
  const stores = runsDirectory ? [path.resolve(runsDirectory)] : [...new Set([path.join(root, 'runs'),
    ...(process.env.SCUMMBENCH_RUNS_DIR ? [path.resolve(process.env.SCUMMBENCH_RUNS_DIR)] : [])])];
  let pending;
  const collect = async () => {
    const diagnostics = { discovered: 0, plotted: 0, counts_only: 0, unavailable: {} }, games = new Map(), seen = new Set();
    const add = item => {
      if (seen.has(item.source.id)) return;
      if (!/^[a-z0-9][a-z0-9-]{0,120}$/.test(item.source.game)) throw new Error('invalid_evidence');
      validateResults({ schema_version: 1, games: [{ id: item.source.game, label: title(item.source.game), benchmarks: [{ ...item.version, runs: [item.run] }] }] });
      seen.add(item.source.id);
      if (!games.has(item.source.game)) games.set(item.source.game, { id: item.source.game, label: title(item.source.game), benchmarks: [] });
      const game = games.get(item.source.game);
      let version = game.benchmarks.find(v => v.id === item.version.id);
      if (!version) { version = { ...item.version, runs: [] }; game.benchmarks.push(version); }
      version.runs.push(item.run);
      if (!item.run.points.length) diagnostics.counts_only++;
      else diagnostics.plotted++;
    };
    const unavailable = error => {
      const reasons = ['in_progress', 'missing_progress', 'mixed_or_missing_progress_revision', 'unverified_ending', 'action_count_mismatch'];
      const reason = reasons.includes(error.message) ? error.message : 'invalid_or_incomplete_evidence';
      diagnostics.unavailable[reason] = (diagnostics.unavailable[reason] ?? 0) + 1;
    };
    const candidates = new Map();
    for (const store of stores) for (const candidate of await discover(store)) candidates.set(candidate.directory, candidate);
    for (const candidate of candidates.values()) {
      diagnostics.discovered++;
      try { add(await (candidate.kind === 'fixed' ? readFixed(candidate.directory) : interactiveResult(candidate.directory))); }
      catch (error) { unavailable(error); }
    }
    let receipts = [];
    try {
      if ((await lstat(registryDirectory)).isSymbolicLink()) throw new Error('Linked registry');
      receipts = await readdir(registryDirectory, { withFileTypes: true });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const entry of receipts.filter(e => e.isFile() && /^[a-f0-9]{64}\.json$/.test(e.name))) {
      diagnostics.discovered++;
      try {
        const receipt = await json(path.join(registryDirectory, entry.name));
        if (receipt.results_owner !== 'scummbench' || receipt.trajectory_sha256 !== entry.name.slice(0, -5)) throw new Error('invalid_evidence');
        if (verifyArchiveManifests) {
          const archive = path.resolve(receipt.archive ?? '');
          if (!archive.startsWith(path.resolve(archiveDirectory) + path.sep) || !HASH.test(receipt.archive_manifest_sha256 ?? '')) throw new Error('invalid_evidence');
          for (let item = archive; item !== path.dirname(item); item = path.dirname(item)) {
            if ((await lstat(item)).isSymbolicLink()) throw new Error('invalid_evidence');
          }
          if (digest(await read(path.join(archive, 'run.json'))) !== receipt.archive_manifest_sha256) throw new Error('invalid_evidence');
        }
        if (!receipt.display_result) throw new Error(receipt.display_unavailable_reason ?? 'missing_progress');
        const raw = receipt.display_result;
        const item = { source: { id: raw.source?.id, game: raw.source?.game }, version: {
          id: raw.version?.id, label: raw.version?.label, context: raw.version?.context, contract: Object.fromEntries(
            ['game_edition', 'start', 'track', 'progress_revision', 'action_revision', 'completion_revision', 'toolset_revision', 'scummbench_revision', 'mechanics_revision', 'runtime_revision']
              .map(key => [key, raw.version?.contract?.[key]])), isolated: raw.version?.isolated === true,
        }, run: Object.fromEntries(['id', 'label', 'date', 'finished_at', 'actions', 'outcome', 'completion_verified', 'completion_actions', 'recorded_outcome', 'evidence_status', 'agent_version', 'agent_commit', 'progress_percent', 'missing_data', 'screenshot_status']
          .map(key => [key, raw.run?.[key]])) };
        item.run.points = raw.run?.points?.map(point => ({ actions: point.actions, progress: point.progress }));
        if (!HASH.test(item.version.id ?? '') || item.run.id !== item.source.id
          || !/^(?:archive-)?[a-f0-9-]{36,64}$/.test(item.source.id ?? '')) throw new Error('invalid_evidence');
        // Validate the display projection before it can affect other runs.
        validateResults({ schema_version: 1, games: [{ id: item.source.game, label: title(item.source.game), benchmarks: [{ ...item.version, runs: [item.run] }] }] });
        add(item);
      } catch (error) { unavailable(error); }
    }
    const data = { schema_version: 1, games: [...games.values()].sort((a, b) => a.label.localeCompare(b.label)), diagnostics };
    for (const game of data.games) game.benchmarks.sort((a, b) => b.runs.map(r => r.finished_at ?? r.date).sort().at(-1).localeCompare(a.runs.map(r => r.finished_at ?? r.date).sort().at(-1)) || a.id.localeCompare(b.id));
    validateResults(data);
    return { ...data, revision: digest(stable(data)) };
  };
  return () => pending ??= collect().finally(() => { pending = null; });
}
