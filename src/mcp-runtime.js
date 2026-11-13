import { createInterface } from 'node:readline';
import path from 'node:path';
import { McpClient, textResult } from './process.js';
import { root } from './contracts.js';
import { gitRevision } from './backend.js';

export class RuntimeError extends Error {}
function requireThat(condition, message) { if (!condition) throw new RuntimeError(message); }

export function gatewayEnvironment(env = process.env) {
  return Object.fromEntries(['SCUMMWEB_DIR', 'SCUMMBENCH_RUNS_DIR', 'SCUMMBENCH_WANDB_CONFIG',
    'SCUMMBENCH_WANDB_WORKER_COMMAND', 'SCUMMBENCH_RESULTS_UPLOADER_COMMAND',
    'WANDB_API_KEY', 'BLOB_READ_WRITE_TOKEN', 'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy',
    'NO_PROXY', 'no_proxy', 'INFISICAL_AGENT_VAULT_URL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED']
    .filter(key => env[key] !== undefined).map(key => [key, env[key]]));
}

const runtimeTool = {
  name: 'mcp_runtime',
  description: 'Inspect or reload this connection’s ScummBench gateway and ScummWEB backbone without disconnecting the MCP client. Reload requires clean committed checkouts and an idle game. Before reloading an active game, save with act, record its run_id, and close that session. Then Continue with the same run_id and load the saved slot. Never replay uncertain actions after a crash. Changes to tool schemas require a new host connection.',
  inputSchema: { type: 'object', properties: { operation: { type: 'string', enum: ['status', 'reload'] } }, required: ['operation'], additionalProperties: false },
  annotations: { destructiveHint: false, openWorldHint: false },
};
const content = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const canonical = value => JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);
const contract = catalog => canonical(catalog.tools.map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema })).sort((a, b) => a.name.localeCompare(b.name)));

export function committedRevisions(status) {
  const gateway = gitRevision(root);
  const backbone = gitRevision(status.scummbench.backbone_directory);
  requireThat(gateway.commit_id && gateway.dirty === false && backbone.commit_id && backbone.dirty === false,
    'Commit all pending ScummBench and ScummWEB changes before reloading.');
  return { gateway, backbone };
}

function pinDirectory(argv, directory) {
  const result = [...argv];
  let separator = result.indexOf('--');
  if (separator < 0) { separator = result.length; result.push('--'); }
  // ScummWEB rejects --instance together with --data-dir. Named instances
  // already resolve a persistent directory; verify that resolution on reload.
  if (result.some((arg, i) => i > separator && (arg === '--instance' || arg.startsWith('--instance=')))) return result;
  const index = result.findIndex((value, i) => i > separator && (value === '--data-dir' || value.startsWith('--data-dir=')));
  if (index < 0) result.push('--data-dir', directory);
  else if (result[index] === '--data-dir') result[index + 1] = directory;
  else result[index] = `--data-dir=${directory}`;
  return result;
}

// The host-facing process survives child exits. All gameplay still goes through
// a fresh ScummBench gateway; no controls or puzzle logic live in this wrapper.
export async function supervise(argv, { input = process.stdin, output = process.stdout,
  checkReload = committedRevisions,
  makeClient = args => new McpClient(process.execPath, [path.join(root, 'src/cli.js'), 'mcp-worker', ...args], {
    cwd: process.cwd(), env: gatewayEnvironment(),
  }),
} = {}) {
  let client, handshake, catalog, lastStatus, profile, generation = 0, reloading = false, closing = false, initialized = false;
  const pending = new Map();
  const operations = new Set();
  const retiring = new WeakMap();
  const stop = selected => {
    if (!selected) return Promise.resolve();
    if (!retiring.has(selected)) retiring.set(selected, Promise.resolve().then(() => selected.close()));
    return retiring.get(selected);
  };
  const send = message => output.write(JSON.stringify(message) + '\n');
  const snapshot = () => ({ pid: process.pid, gateway_pid: client?.process.child.pid ?? null, generation, backend_available: Boolean(client && !client.failure),
    reloading, data_directory: profile ?? null, recovery: 'No action replay; inspect status and restore an explicit save after a restart.' });
  const running = async () => {
    const status = textResult(await client.call('status'));
    requireThat(status.scummbench?.mediated === true && status.scummbench?.results_owner === 'scummbench', 'ScummBench mediation is required.');
    lastStatus = status;
    return status;
  };
  const start = async expected => {
    const next = makeClient(profile ? pinDirectory(argv, profile) : argv);
    try {
      const nextHandshake = await next.connect();
      const nextCatalog = await next.request('tools/list');
      const nextStatus = textResult(await next.call('status'));
      requireThat(nextStatus.scummbench?.mediated === true && nextStatus.scummbench?.results_owner === 'scummbench', 'ScummBench mediation is required.');
      requireThat(!nextCatalog.tools.some(tool => tool.name === runtimeTool.name), 'Backend tool collides with the supervisor control.');
      requireThat(!nextCatalog.nextCursor, 'Paginated tool discovery requires a new host connection.');
      if (catalog) requireThat(contract(catalog) === contract(nextCatalog) && handshake.protocolVersion === nextHandshake.protocolVersion,
        'MCP tool schemas or protocol changed; reconnect this server through the host.');
      if (profile) requireThat(nextStatus.dataDir === profile, 'Replacement profile directory does not match.');
      if (expected) {
        requireThat(nextStatus.scummbench.source_revision?.commit_id === expected.gateway.commit_id
          && nextStatus.scummbench.source_revision?.dirty === false
          && nextStatus.sourceRevision?.repository === 'scummweb'
          && nextStatus.sourceRevision?.commit_id === expected.backbone.commit_id && nextStatus.sourceRevision?.dirty === false,
        'Replacement startup revisions do not match the clean checkouts.');
      }
      client = next; handshake = nextHandshake; catalog = nextCatalog; lastStatus = nextStatus;
      profile ??= typeof nextStatus.dataDir === 'string' && path.isAbsolute(nextStatus.dataDir) ? nextStatus.dataDir : undefined;
      generation++;
      // Reap the owned worker group immediately on a crash, rather than keeping
      // an old PID to kill later. Supervised backbones share that worker group.
      next.process.closed.then(() => { if (client === next) void stop(next).catch(() => {}); });
      return nextStatus;
    } catch (error) { await stop(next); throw error; }
  };
  const reload = async () => {
    requireThat(!reloading && pending.size === 0, 'Wait for all outstanding MCP requests before reloading.');
    requireThat(profile, 'Profile directory is unknown; reconnect through the host.');
    requireThat(!argv.some(arg => ['--stop-condition', '--evaluation-log', '--result-file', '--legacy-sky-slot', '--import-games']
      .some(flag => arg === flag || arg.startsWith(flag + '='))), 'This startup import or evaluator scope requires a host reconnect.');
    reloading = true;
    try {
      const status = client && !client.failure ? await running() : lastStatus;
      // Unknown state must not be treated as an idle game. A crashed child is
      // already lost, so only that case can recover without an idle receipt.
      if (client && !client.failure) requireThat(status.phase === 'idle' && !status.sessionId && !status.scummbench.run_id,
        'Game is active. Save progress, record run_id, and close the session before reloading.');
      const expected = await checkReload(status);
      const previous = client;
      client = undefined;
      await stop(previous);
      const replacement = await start(expected);
      return { ...replacement, mcp_runtime: { ...snapshot(), reloading: false } };
    } finally { reloading = false; }
  };
  const handle = async request => {
    if (request.method === 'notifications/cancelled') {
      const id = pending.get(request.params?.requestId);
      if (id !== undefined) client?.cancel(id);
      return;
    }
    if (request.id === undefined) return;
    try {
      let result;
      if (request.method === 'initialize') {
        requireThat(!initialized, 'Connection is already initialized.');
        initialized = true;
        result = handshake;
      } else {
        requireThat(initialized && !closing, 'Connection is not initialized.');
        const { name, arguments: parameters = {} } = request.params ?? {};
        if (request.method === 'ping') result = {};
        else if (request.method === 'tools/list') result = { ...catalog, tools: [...catalog.tools, runtimeTool] };
        else if (request.method === 'tools/call' && name === runtimeTool.name) {
          requireThat(Object.keys(parameters).length === 1 && ['status', 'reload'].includes(parameters.operation), 'Use operation=status or operation=reload.');
          result = content(parameters.operation === 'reload' ? await reload() : snapshot());
        } else {
          requireThat(!reloading, 'Runtime is reloading; wait for its receipt before issuing another request.');
          // Only a status call may recover a crashed child. Mutating requests
          // are never implicitly retried, including calls whose reply was lost.
          if ((!client || client.failure) && request.method === 'tools/call' && name === 'status') await reload();
          requireThat(client && !client.failure, 'Gateway unavailable. Use mcp_runtime status or reload; do not replay uncertain actions.');
          pending.set(request.id, undefined);
          try {
            result = await client.request(request.method, request.params, 60000, id => pending.set(request.id, id));
            if (request.method === 'tools/call' && name === 'status' && !result.isError) {
              const status = textResult(result);
              lastStatus = status;
              result = { ...result, content: result.content.map(block => block.type === 'text'
                ? { ...block, text: JSON.stringify({ ...JSON.parse(block.text), mcp_runtime: snapshot() }) } : block) };
            }
          } finally { pending.delete(request.id); }
        }
      }
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch (error) {
      // Only supervisor checks are suitable for display. Child diagnostics can
      // contain private configuration; the stdio client's failures stay generic.
      const message = error instanceof RuntimeError ? error.message
        : 'Gateway connection lost. Inspect mcp_runtime status; no action was replayed.';
      if (request.method === 'tools/call') send({ jsonrpc: '2.0', id: request.id, result: { ...content({ error: message, mcp_runtime: snapshot() }), isError: true } });
      else send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message } });
    }
  };
  await start();
  const lines = createInterface({ input });
  const shutdown = () => { closing = true; lines.close(); input.destroy(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  lines.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    const task = handle(request).finally(() => operations.delete(task));
    operations.add(task);
  });
  try { await new Promise(resolve => lines.once('close', resolve)); await Promise.allSettled([...operations]); }
  finally {
    closing = true;
    process.removeListener('SIGTERM', shutdown); process.removeListener('SIGINT', shutdown);
    await stop(client);
  }
}
