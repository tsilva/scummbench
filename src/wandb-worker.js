import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createWandbTransport, defaultWandbConfig, wandbUpsert } from './wandb.js';
import { scummvmGameIds } from './game-ids.js';
import { requireThat } from './contracts.js';

export function validateWorkerPost(endpoint, body, runId) {
  const projects = scummvmGameIds.map(id => `scummbench-${id}`);
  if (endpoint === '/graphql') {
    const vars = body?.variables;
    requireThat(body.query === wandbUpsert && Object.keys(body).sort().join(',') === 'query,variables'
      && vars.entity === 'tsilva' && projects.includes(vars.project) && vars.name === runId
      && Object.keys(vars).sort().join(',') === 'config,entity,name,project', 'Unreviewed W&B mutation');
    const config = JSON.parse(vars.config);
    requireThat(config.run_id?.value === runId && config.official_eligible?.value === false
      && config.scummvm_game_id?.value === vars.project.slice('scummbench-'.length), 'W&B run metadata mismatch');
    const allowed = ['run_id', 'official_eligible', 'scummvm_game_id', 'kind', 'suite', 'task_id', 'task_sha256',
      'game', 'track', 'category', 'agent_label', 'agent_config_sha256', 'scummbench_commit', 'backend_commit',
      'scummbench_dirty', 'backend_dirty'];
    requireThat(Object.entries(config).every(([key, entry]) => allowed.includes(key)
      && entry && Object.keys(entry).join(',') === 'value'
      && (typeof entry.value === 'boolean' || (typeof entry.value === 'string' && entry.value.length <= 200))),
    'Unexpected W&B configuration data');
    return;
  }
  requireThat(projects.some(project => endpoint === `/files/tsilva/${project}/${runId}/file_stream`), 'Unreviewed W&B upload destination');
  if (body.complete === true) {
    requireThat(Object.keys(body).sort().join(',') === 'complete,exitcode' && [0, 1].includes(body.exitcode), 'Invalid W&B completion');
    return;
  }
  requireThat(Object.keys(body).join(',') === 'files'
    && Object.keys(body.files).sort().join(',') === 'wandb-history.jsonl,wandb-summary.json', 'Unexpected W&B upload files');
  for (const [name, chunk] of Object.entries(body.files)) {
    requireThat(Object.keys(chunk).sort().join(',') === 'content,offset'
      && Number.isSafeInteger(chunk.offset) && chunk.offset >= 0 && Array.isArray(chunk.content)
      && chunk.content.length > 0 && chunk.content.length <= 64, 'Invalid W&B file chunk');
    if (name === 'wandb-summary.json') requireThat(chunk.offset === 0 && chunk.content.length === 1, 'Invalid W&B summary');
    for (const line of chunk.content) {
      requireThat(typeof line === 'string', 'Invalid W&B metric row');
      const row = JSON.parse(line);
      const numeric = ['_step', '_timestamp', '_runtime', 'elapsed_ms', 'success',
        ...['decisions', 'submitted_actions', 'action_sequences', 'observations', 'requested_wait_ticks',
          'requested_wait_ms', 'tool_calls', 'tool_errors'].map(key => `usage/${key}`)];
      requireThat(Object.entries(row).every(([key, value]) =>
        (numeric.includes(key) && ((key === 'success' && value === null) || (Number.isFinite(value) && value >= 0)))
        || (key === 'status' && ['in_progress', 'success', 'failure', 'budget_exhausted', 'invalid_agent', 'infrastructure_error', 'stopped'].includes(value))
        || (key === 'reason' && typeof value === 'string' && /^[a-z_]{1,80}$/.test(value))), 'Unexpected W&B metric data');
    }
  }
}

export async function serveWandbWorker(runId, { transport } = {}) {
  requireThat(/^[a-f0-9-]{36}$/.test(runId), 'Invalid worker run ID');
  transport ??= createWandbTransport(defaultWandbConfig);
  const input = createInterface({ input: process.stdin });
  const active = new Map();
  const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  for await (const line of input) {
    let request;
    try { requireThat(line.length <= 1024 * 1024, 'Worker message limit'); request = JSON.parse(line); }
    catch { continue; }
    if (request.method === 'notifications/cancelled') { active.get(request.params?.requestId)?.controller.abort(); continue; }
    if (request.id === undefined) continue;
    if (request.method === 'initialize') {
      send(request.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'scummbench-wandb-worker', version: '1' } });
      continue;
    }
    const controller = new AbortController();
    const pending = { controller };
    active.set(request.id, pending);
    pending.promise = (async () => {
      let valid = false;
      try {
        requireThat(request.method === 'wandb/post', 'Unsupported W&B worker operation');
        validateWorkerPost(request.params?.endpoint, request.params?.body, runId);
        valid = true;
        const value = await transport(request.params.endpoint, request.params.body, controller.signal);
        send(request.id, { ok: true, value });
      } catch (error) { send(request.id, { ok: false, retryable: valid && error.retryable !== false }); }
      finally { active.delete(request.id); }
    })();
  }
  for (const pending of active.values()) pending.controller.abort();
  await Promise.allSettled([...active.values()].map(item => item.promise));
  await transport.close?.();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { 'run-id': { type: 'string' } } });
  serveWandbWorker(values['run-id']).catch(() => { process.exitCode = 1; });
}
