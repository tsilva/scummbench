import { execFileSync } from 'node:child_process';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { McpClient, textResult } from './process.js';
import { json, requireThat, digest } from './contracts.js';
import { resolveBackbone } from './backbone.js';

export function gitRevision(directory) {
  try {
    const git = (...args) => execFileSync('git', ['-C', directory, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { commit_id: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain', '--untracked-files=normal')) };
  } catch { return { commit_id: null, dirty: null }; }
}

export async function loadBackend(file) {
  const config = await json(file);
  const allowed = ['schema_version', 'scummweb_dir', 'scummweb_revision', 'base_url', 'runtime_revision', 'asset_files'];
  requireThat(config && typeof config === 'object' && Object.keys(config).every(key => allowed.includes(key)), 'Unknown backend configuration field');
  requireThat(config.schema_version === 2, 'Unsupported backend schema');
  requireThat(typeof config.scummweb_dir === 'string' && path.isAbsolute(config.scummweb_dir), 'scummweb_dir must be absolute');
  config.scummweb_dir = await realpath(config.scummweb_dir);
  requireThat(/^[a-f0-9]{40}$/.test(config.scummweb_revision), 'Expected a full ScummWEB commit');
  const url = new URL(config.base_url);
  requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Invalid base_url');
  requireThat(config.runtime_revision === null || /^[a-f0-9]{40}$/.test(config.runtime_revision), 'Invalid declared ScummWEB revision');
  requireThat(Array.isArray(config.asset_files), 'asset_files must be an array');
  const assets = [];
  for (const item of config.asset_files) {
    requireThat(item && Object.keys(item).sort().join() === 'path,sha256' && path.isAbsolute(item.path)
      && /^[a-f0-9]{64}$/.test(item.sha256), 'Invalid asset file declaration');
    requireThat((await stat(item.path)).isFile(), 'Asset must be a regular file');
    requireThat(digest(await readFile(item.path)) === item.sha256, 'Asset checksum mismatch');
    assets.push({ sha256: item.sha256, name: path.basename(item.path) });
  }
  const revision = gitRevision(config.scummweb_dir);
  requireThat(revision.commit_id === config.scummweb_revision && revision.dirty === false, 'ScummWEB checkout must match the pinned clean revision');
  await resolveBackbone(config.scummweb_dir);
  return { config, provenance: { ...revision, base_url: config.base_url,
    scummweb_revision_declared: config.runtime_revision, scummweb_revision_verified: false,
    asset_files_checked_locally: assets, served_assets_verified: false } };
}

export class ScummWebBackend {
  constructor(config, directory, task) {
    this.config = config;
    this.receiptFile = path.join(directory, 'evaluator-result.json');
    this.client = new McpClient(process.execPath, [path.join(config.scummweb_dir, 'agent-backbone/src/server.js'),
      '--no-viewer', '--base-url', config.base_url, '--data-dir', path.join(directory, 'runtime'),
      '--width', String(task.viewport.width), '--height', String(task.viewport.height),
      '--evaluation-log', path.join(directory, 'evaluation.jsonl'), '--result-file', this.receiptFile,
      '--stop-condition', JSON.stringify(task.evaluator.condition)], { cwd: config.scummweb_dir, env: { SCUMMBENCH_MANAGED: '1' } });
  }
  async connect() {
    this.handshake = await this.client.connect();
    this.tools = (await this.client.request('tools/list')).tools;
    requireThat(['session', 'status', 'act', 'observe'].every(name => this.tools.some(tool => tool.name === name)), 'Missing required MCP tools');
    requireThat(!this.tools.some(tool => tool.name === 'telemetry'), 'Player backend must not expose telemetry tools');
    const status = textResult(await this.client.call('status'));
    requireThat(status.sourceRevision?.repository === 'scummweb'
      && status.sourceRevision?.commit_id === this.config.scummweb_revision && status.sourceRevision?.dirty === false,
      'MCP server revision does not match pinned clean source');
    this.revision = status.sourceRevision;
  }
  async start(task) {
    const session = textResult(await this.client.call('session', { operation: 'start', game: task.game }));
    this.sessionId = session.sessionId;
    requireThat(typeof this.sessionId === 'string' && this.sessionId.length > 0, 'Missing game session ID');
    const deadline = Date.now() + task.budgets.startup_ms;
    for (;;) {
      requireThat(Date.now() < deadline, 'Game startup timed out');
      const status = textResult(await this.client.call('status', { wait_ms: 1000 }));
      if (status.phase === 'ready') {
        requireThat(status.game === task.game, 'Wrong game started');
        // The server can report ready just before its first cropped capture.
        // Explicitly capture before reading dimensions; an empty frame history
        // otherwise reports the outer viewport rather than screenshot bounds.
        this.initialObservation = await this.observe();
        requireThat(!this.initialObservation.isError, 'Initial observation failed');
        const captured = textResult(await this.client.call('status'));
        requireThat(captured.phase === 'ready' && captured.dimensions?.width === task.observation.width && captured.dimensions?.height === task.observation.height,
          'Actual screenshot dimensions differ from task observation contract');
        this.readyStatus = captured;
        return;
      }
      requireThat(status.phase === 'loading', 'Game failed to enter ready state');
    }
  }
  observe() { return this.client.call('observe', { source: 'fresh' }); }
  act(actions, requestId) { return this.client.call('act', { session_id: this.sessionId, request_id: requestId, actions }); }
  async receipt() {
    try {
      const text = await readFile(this.receiptFile, 'utf8');
      if (!text.trim()) return null;
      try { return JSON.parse(text); } catch { return null; } // Writer may still be completing a receipt.
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  close() { return this.client.close(); }
}

export function gradeReceipt(receipt, task, backend) {
  requireThat(receipt && receipt.success === true && receipt.event === 'success' && receipt.reason === 'stop_condition', 'No verified native success');
  requireThat(receipt.game === task.game && receipt.session_id === backend.sessionId, 'Receipt belongs to another game/session');
  requireThat(receipt.source_revision?.commit_id === backend.config.scummweb_revision && receipt.source_revision?.dirty === false, 'Receipt source revision mismatch');
  requireThat(JSON.stringify(receipt.condition) === JSON.stringify(task.evaluator.condition), 'Receipt condition mismatch');
  requireThat(task.evaluator.condition.all.every(({ variable, equals }) => receipt.variables?.[variable] === equals), 'Receipt variables do not satisfy condition');
  requireThat(Number.isFinite(receipt.variables.native_time_ms) && receipt.variables.native_time_ms >= 0, 'Missing native event time');
  requireThat(Number.isFinite(receipt.elapsed_ms) && receipt.elapsed_ms >= 0 && Number.isFinite(Date.parse(receipt.detected_at)), 'Invalid success timestamps');
  return true;
}
