import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { McpClient, commandArguments } from './process.js';
import { root, requireThat } from './contracts.js';

// Explicit operator interface: a nonsecret JSON argv array. No shell parsing,
// profile discovery or credential bootstrap. The caller owns its session scope.
export async function suppliedWandbWorker(env = process.env) {
  if (env.SCUMMBENCH_WANDB_WORKER_COMMAND === undefined) return undefined;
  const argv = commandArguments(env.SCUMMBENCH_WANDB_WORKER_COMMAND);
  const route = { command: argv[0], arguments: argv.slice(1) };
  await access(route.command, constants.X_OK);
  return route;
}

// One worker per run. Its Agent Vault session and placeholder never enter the
// runner, player or game environments. Session renewal retrieves no source keys.
export function createBrokeredWandbTransport(route, { runId, startupMs = 15000, renewMs = 20 * 60 * 1000,
  createClient = (command, args) => new McpClient(command, args, { cwd: root }),
  } = {}) {
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
      const selected = createClient(route.command, [...route.arguments, '--run-id', runId]);
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
