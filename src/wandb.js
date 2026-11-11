import { Agent, request } from 'node:https';
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { json, requireThat } from './contracts.js';
import { scummvmGameId } from './game-ids.js';

// Minimal scalar-only wire protocol used by wandb/wandb-js's InternalApi and
// FileStream. No SDK, implicit login, machine metadata, code, or media uploads.
const upsert = `mutation ScummBenchRun($name: String!, $project: String!, $entity: String!, $config: JSONString!) {
  upsertBucket(input: {name: $name, modelName: $project, entityName: $entity, config: $config, state: "running"}) {
    bucket { name }
  }
}`;
const counters = ['decisions', 'submitted_actions', 'action_sequences', 'observations',
  'requested_wait_ticks', 'requested_wait_ms', 'tool_calls', 'tool_errors'];
const metadataKeys = ['kind', 'suite', 'task_id', 'task_sha256', 'game', 'track', 'category', 'agent_label', 'agent_config_sha256'];

export function validateWandbConfig(config) {
  requireThat(config && Object.keys(config).every(key => ['entity', 'project', 'api_key_placeholder'].includes(key)), 'Invalid W&B configuration');
  for (const key of ['entity', 'project']) {
    const value = key === 'project' && typeof config[key] === 'string' ? config[key].replaceAll('{gameid}', 'gameid') : config[key];
    requireThat(typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value), 'Invalid W&B destination');
  }
  requireThat(typeof config.api_key_placeholder === 'string' && /^[a-zA-Z0-9_-]{1,180}_placeholder$/.test(config.api_key_placeholder), 'W&B requires a non-secret proxy placeholder');
  return config;
}

// Called before gameplay. Fail explicitly rather than fall back to cached keys
// or direct networking. Route provisioning/review belongs to the operator.
export async function loadWandb(file, env = process.env) {
  if (!file) return undefined;
  try {
    const config = validateWandbConfig(await json(file));
    // Validate routing now, but give every run its own transport resources.
    const transport = createWandbTransport(config, env);
    transport.close();
    return details => new WandbPublisher(config, { ...details, transport: createWandbTransport(config, env) });
  } catch {
    const error = new Error('W&B setup failed: require valid entity/project configuration, a matching proxy placeholder, an HTTPS proxy, verified TLS, and Node 22.21+ or 24.5+. No direct credential fallback is allowed.');
    error.code = 'WANDB_SETUP';
    throw error;
  }
}

export function createWandbTransport(config, env = process.env, send = request) {
  validateWandbConfig(config);
  requireThat(env.WANDB_API_KEY === config.api_key_placeholder, 'W&B proxy placeholder missing or mismatched');
  const proxy = env.https_proxy ?? env.HTTPS_PROXY;
  requireThat(typeof proxy === 'string' && ['http:', 'https:'].includes(new URL(proxy).protocol), 'W&B requires an HTTPS proxy route');
  const [major, minor] = process.versions.node.split('.').map(Number);
  requireThat((major === 22 && minor >= 21) || (major === 24 && minor >= 5) || major >= 25, 'W&B proxy support requires Node 22.21+ or 24.5+');
  requireThat(env.NODE_TLS_REJECT_UNAUTHORIZED !== '0', 'W&B requires TLS verification');
  // Deliberately exclude NO_PROXY so a brokered credential cannot bypass its
  // route. The dedicated agent changes no global Node or shell settings.
  const agent = new Agent({ proxyEnv: { HTTPS_PROXY: proxy }, keepAlive: true });
  const transport = (endpoint, body, signal) => new Promise((resolve, reject) => {
    requireThat(endpoint.startsWith('/') && !endpoint.startsWith('//'), 'Invalid W&B endpoint');
    const req = send(new URL(endpoint, 'https://api.wandb.ai'), {
      agent, method: 'POST', signal,
      headers: { 'Content-Type': 'application/json',
        Authorization: `Basic ${Buffer.from(`api:${env.WANDB_API_KEY}`).toString('base64')}` },
    }, res => {
      let bytes = 0, result = '';
      res.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > 1024 * 1024) req.destroy(new Error('W&B response limit'));
        else result += chunk;
      });
      res.on('error', reject);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const error = new Error('W&B HTTP failure');
          error.retryable = res.statusCode === 429 || res.statusCode >= 500;
          reject(error); return;
        }
        try {
          const value = JSON.parse(result);
          if (value.errors?.length) throw new Error('W&B GraphQL failure');
          resolve(value);
        } catch { reject(new Error('W&B response rejected')); }
      });
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
  transport.close = () => agent.destroy();
  return transport;
}

export class WandbPublisher {
  constructor(config, { directory, runId, transport, requestMs = 1500, flushMs = 1000, finishMs = 5000 }) {
    validateWandbConfig(config);
    requireThat(/^[a-f0-9-]{36}$/.test(runId), 'Invalid W&B run ID');
    this.config = config; this.directory = directory; this.runId = runId;
    this.transport = transport; this.requestMs = requestMs; this.finishMs = finishMs;
    this.queue = []; this.offset = 0; this.step = 0; this.summary = {};
    this.state = 'pending'; this.reason = null; this.controllers = new Set();
    this.timer = setInterval(() => { void this.pump(); }, flushMs);
    this.timer.unref();
  }

  async start(metadata) {
    const canonicalId = scummvmGameId(metadata.game);
    if (this.config.project.includes('{gameid}')) {
      const project = this.config.project.replaceAll('{gameid}', canonicalId ?? '');
      if (!canonicalId || project.length > 128) this.fail('unknown_scummvm_game_id');
      else this.config = { ...this.config, project };
    }
    this.metadata = { run_id: this.runId, official_eligible: false };
    if (canonicalId) this.metadata.scummvm_game_id = canonicalId;
    for (const key of metadataKeys) {
      if (typeof metadata[key] === 'string') this.metadata[key] = metadata[key].slice(0, 200);
    }
    for (const key of ['scummbench_commit', 'backend_commit']) {
      if (/^[a-f0-9]{40}$/.test(metadata[key])) this.metadata[key] = metadata[key];
    }
    for (const key of ['scummbench_dirty', 'backend_dirty']) {
      if (typeof metadata[key] === 'boolean') this.metadata[key] = metadata[key];
    }
    await this.journal({ type: 'start', config: this.metadata });
    await this.receipt();
    void this.pump();
  }

  async log({ elapsed_ms, usage = {}, status, reason }) {
    if (this.finished) return;
    const row = { _step: this.step++, _timestamp: Date.now() / 1000 };
    if (Number.isFinite(elapsed_ms) && elapsed_ms >= 0) {
      row.elapsed_ms = Math.round(elapsed_ms); row._runtime = elapsed_ms / 1000;
    }
    for (const key of counters) {
      if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) row[`usage/${key}`] = usage[key];
    }
    if (['in_progress', 'success', 'failure', 'budget_exhausted', 'invalid_agent', 'infrastructure_error', 'stopped'].includes(status)) {
      row.status = status;
      // Interactive play never implies an independently graded success/failure.
      if (this.metadata.kind === 'fixed_task') row.success = status === 'in_progress' ? null : Number(status === 'success');
    }
    if (typeof reason === 'string' && /^[a-z_]{1,80}$/.test(reason)) row.reason = reason;
    this.summary = { ...this.summary, ...row };
    await this.journal({ type: 'history', metrics: row });
    // Journal every point, bound network memory. Coalesce the newest point if
    // the service falls behind; the final summary is always retained.
    if (this.queue.length < 256) this.queue.push(row);
    else this.queue[this.queue.length - 1] = row;
  }

  async journal(event) {
    try { await appendFile(path.join(this.directory, 'wandb-events.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); }
    catch { this.fail('local_journal_failed'); }
  }

  fail(reason) { this.state = 'failed'; this.reason ??= reason; }

  async receipt() {
    const value = { schema_version: 1, entity: this.config.entity, project: this.config.project,
      run_id: this.runId, url: this.config.project.includes('{gameid}') ? null
        : `https://wandb.ai/${this.config.entity}/${this.config.project}/runs/${this.runId}`,
      state: this.state, reason: this.reason, uploaded_rows: this.offset };
    try { await writeFile(path.join(this.directory, 'wandb.json'), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 }); }
    catch { this.fail('local_receipt_failed'); }
  }

  async post(endpoint, body) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      this.controllers.add(controller);
      const timer = setTimeout(() => controller.abort(), this.requestMs);
      try {
        return await this.transport(endpoint, body, controller.signal);
      } catch (error) {
        if (this.expired || error.retryable === false || attempt === 1) throw new Error('W&B upload failed');
      } finally { clearTimeout(timer); this.controllers.delete(controller); }
    }
  }

  pump() {
    if (this.pending) return this.pending;
    if (this.state === 'failed' || this.finished) return Promise.resolve();
    this.pending = this.upload().catch(() => this.fail('upload_failed')).finally(async () => {
      await this.receipt(); this.pending = undefined;
    });
    return this.pending;
  }

  async upload() {
    if (this.state === 'pending') {
      const config = JSON.stringify(Object.fromEntries(Object.entries(this.metadata).map(([key, value]) => [key, { value }])));
      const result = await this.post('/graphql', { query: upsert,
        variables: { name: this.runId, project: this.config.project, entity: this.config.entity, config } });
      if (result.data?.upsertBucket?.bucket?.name !== this.runId) throw new Error('W&B run mismatch');
      if (this.state === 'failed' || this.expired) return;
      this.state = 'running';
    }
    while (this.queue.length && !this.expired && this.state !== 'failed') {
      const rows = this.queue.slice(0, 64);
      await this.post(this.endpoint(), { files: {
        'wandb-history.jsonl': { offset: this.offset, content: rows.map(row => JSON.stringify(row)) },
        'wandb-summary.json': { offset: 0, content: [JSON.stringify(this.summary)] },
      } });
      this.offset += rows.length; this.queue.splice(0, rows.length);
    }
  }

  endpoint() { return `/files/${this.config.entity}/${this.config.project}/${this.runId}/file_stream`; }

  async finish(final) {
    if (this.finishing) return this.finishing;
    this.finishing = this.finalize(final);
    return this.finishing;
  }

  async finalize(final) {
    clearInterval(this.timer);
    await this.log(final);
    let timer;
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => {
        this.expired = true; this.fail('finish_timeout');
        for (const controller of this.controllers) controller.abort();
        resolve();
      }, this.finishMs);
    });
    const flush = async () => {
      await this.pump();
      if (this.state === 'failed') return;
      // A pump already in progress may have observed an empty queue before the
      // final point was appended. Flush that point before marking complete.
      await this.pump();
      await this.post(this.endpoint(), { complete: true, exitcode: final.status === 'infrastructure_error' ? 1 : 0 });
      if (!this.expired && this.state !== 'failed') this.state = 'synced';
    };
    await Promise.race([flush().catch(() => this.fail('upload_failed')), timeout]);
    clearTimeout(timer); this.finished = true;
    // Transport resources are owned by this run, including timed-out sockets.
    this.transport.close?.();
    await this.receipt();
  }
}
