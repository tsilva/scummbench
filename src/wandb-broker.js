import { access, lstat, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { McpClient } from './process.js';
import { root, requireThat } from './contracts.js';

const source = { instance: 'https://app.infisical.com', project_id: 'cba79865-b229-4181-909b-0da11a052799',
  environment: 'prod', path: '/wandb', variable: 'WANDB_API_KEY' };

export async function loadWandbRoute(file = path.join(root, 'local/wandb-agent-vault.json')) {
  const info = await lstat(file);
  requireThat(info.isFile() && !info.isSymbolicLink() && !(info.mode & 0o077), 'W&B route must be an owner-only regular file');
  const route = JSON.parse(await readFile(file, 'utf8'));
  requireThat(Object.keys(route).sort().join(',') === 'bundle,launcher,source,version'
    && route.version === 1 && route.bundle === 'local-scummbench-wandb'
    && Object.keys(route.source ?? {}).length === Object.keys(source).length
    && Object.entries(source).every(([key, value]) => route.source[key] === value)
    && typeof route.launcher === 'string' && path.isAbsolute(route.launcher), 'Unreviewed W&B route');
  await access(route.launcher, constants.X_OK);
  return route;
}

// One worker per run. Its Agent Vault session and placeholder never enter the
// runner, player or game environments. Session renewal retrieves no source keys.
export function createBrokeredWandbTransport(route, { runId, startupMs = 15000, renewMs = 20 * 60 * 1000,
  createClient = (command, args) => new McpClient(command, args, { cwd: root }),
  worker = path.join(root, 'src/wandb-worker.js') } = {}) {
  requireThat(/^[a-f0-9-]{36}$/.test(runId), 'Invalid W&B worker run ID');
  let client, opening, openedAt = 0, closed = false;
  async function stopClient(selected) {
    if (!selected) return;
    // Let the worker exit normally so the owning CLI can revoke its session.
    selected.process.child.stdin.end();
    let timer;
    await Promise.race([selected.process.closed, new Promise(resolve => { timer = setTimeout(resolve, 2000); })]);
    clearTimeout(timer);
    await selected.close();
  }
  async function ready() {
    requireThat(!closed, 'W&B worker closed');
    if (opening) return opening;
    if (client && Date.now() - openedAt < renewMs) return;
    opening = (async () => {
      await stopClient(client); client = undefined;
      requireThat(!closed, 'W&B worker closed');
      const selected = createClient(route.launcher, [process.execPath, worker, '--run-id', runId]);
      client = selected;
      // A separate startup allowance keeps session creation outside HTTP's
      // short request deadline and outside the gameplay hot path.
      await selected.request('initialize', { protocolVersion: '2024-11-05' }, startupMs);
      requireThat(!closed, 'W&B worker closed');
      openedAt = Date.now();
    })().finally(() => { opening = undefined; });
    return opening;
  }
  const transport = async (endpoint, body, signal) => {
    await ready();
    if (signal.aborted) throw new Error('W&B request aborted');
    const selected = client;
    let requestId;
    const cancel = () => { try { if (requestId) selected.cancel(requestId); } catch { /* The request will reject on close. */ } };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const response = await selected.request('wandb/post', { endpoint, body }, 5000, id => {
        requestId = id; if (signal.aborted) cancel();
      });
      if (!response.ok) {
        const error = new Error('W&B worker request failed'); error.retryable = response.retryable === true; throw error;
      }
      return response.value;
    } finally { signal.removeEventListener('abort', cancel); }
  };
  transport.ready = ready;
  transport.close = async () => {
    closed = true;
    await stopClient(client);
    await opening?.catch(() => {});
    client = undefined;
  };
  return transport;
}
