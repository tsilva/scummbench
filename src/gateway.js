import { createInterface } from 'node:readline';
import { mkdir, appendFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { McpClient, cleanEnv } from './process.js';
import { root, json, requireThat } from './contracts.js';
import { archiveContent } from './runner.js';
import { gitRevision } from './backend.js';

// Interactive gateway: transparent AgentSCUMM mechanics, with ScummBench-owned
// evidence. It makes no controlled-task or success-rate claim for free play.
export async function serve(argv) {
  const separator = argv.indexOf('--');
  const { values } = parseArgs({ args: separator < 0 ? argv : argv.slice(0, separator), options: { agentscumm: { type: 'string' } } });
  requireThat(values.agentscumm && path.isAbsolute(values.agentscumm), 'Absolute agentscumm checkout required');
  const args = separator < 0 ? [] : argv.slice(separator + 1);
  if (args.includes('--import-only')) {
    const child = spawn(process.execPath, [path.join(values.agentscumm, 'src/server.js'), ...args],
      { cwd: process.cwd(), env: { ...cleanEnv(), SCUMMBENCH_MANAGED: '1' }, stdio: 'inherit' });
    process.exitCode = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', code => resolve(code ?? 1)); });
    return;
  }
  const store = path.resolve(process.env.SCUMMBENCH_RUNS_DIR ?? path.join(root, 'runs/interactive'));
  const client = new McpClient(process.execPath, [path.join(values.agentscumm, 'src/server.js'), ...args],
    { cwd: process.cwd(), env: { SCUMMBENCH_MANAGED: '1' } });
  const version = (await json(path.join(root, 'package.json'))).version;
  let run, tail = Promise.resolve(), closing = false;
  const write = event => {
    if (!run) return Promise.resolve();
    const selected = run;
    tail = tail.then(async () => {
      const normalized = structuredClone(event);
      if (normalized.result?.content) normalized.result.content = await archiveContent(normalized.result.content, selected.directory);
      await appendFile(path.join(selected.directory, 'trajectory.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), ...normalized }) + '\n', { mode: 0o600 });
    });
    return tail;
  };
  const finishRun = async reason => {
    if (!run) return;
    await tail;
    await writeFile(path.join(run.directory, 'run.json'), JSON.stringify({ ...run, status: 'stopped', reason,
      finished_at: new Date().toISOString() }, null, 2) + '\n', { mode: 0o600 });
    run = undefined;
  };
  const metadata = () => ({ mediated: true, version, source_revision: gitRevision(root),
    run_id: run?.run_id ?? null, run_directory: run?.directory ?? null, results_owner: 'scummbench' });
  const send = value => process.stdout.write(JSON.stringify(value) + '\n');
  const close = async (reason, code = 0) => {
    if (closing) return;
    closing = true;
    try { await finishRun(reason); await client.close(); }
    catch { code = 1; }
    process.exitCode = code;
    input.close(); process.stdin.destroy();
  };
  const handshake = await client.connect();
  const input = createInterface({ input: process.stdin });
  const operations = new Set();
  const inFlight = new Map(), cancelled = new Set();
  client.process.closed.then(() => close('backend_closed', client.process.exitCode ?? 1));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void close(signal); });
  const handle = async request => {
    if (request.method === 'notifications/cancelled') {
      const id = request.params?.requestId;
      if (inFlight.has(id)) client.cancel(inFlight.get(id));
      else cancelled.add(id);
      await write({ type: 'mcp_cancellation', request_id: id });
      return;
    }
    if (request.id === undefined) return;
    try {
      let result;
      if (request.method === 'initialize') result = { ...handshake,
        instructions: `${handshake.instructions ?? ''} All gameplay is mediated and recorded by ScummBench. Require status.scummbench.mediated=true.` };
      else if (request.method === 'ping') result = {};
      else if (['tools/list', 'tools/call'].includes(request.method)) {
        await tail; // A failed evidence writer must block later game inputs.
        const { name, arguments: parameters = {} } = request.params ?? {};
        if (request.method === 'tools/call' && name === 'session' && parameters.operation === 'start') {
          await finishRun('new_session');
          const runId = randomUUID(), directory = path.join(store, runId);
          await mkdir(path.join(directory, 'screenshots'), { recursive: true, mode: 0o700 });
          run = { schema_version: 1, kind: 'interactive_mcp', run_id: runId, directory,
            game_id: parameters.game ?? 'flight-of-the-amazon-queen', started_at: new Date().toISOString(),
            status: 'in_progress', official_eligible: false, track: 'unspecified', results_owner: 'scummbench',
            scummbench: gitRevision(root), agentscumm: gitRevision(values.agentscumm) };
          await writeFile(path.join(directory, 'run.json'), JSON.stringify(run, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        }
        await write({ type: 'mcp_request', method: request.method, params: request.params });
        if (cancelled.has(request.id)) throw new Error('Request was cancelled before dispatch');
        result = await client.request(request.method, request.params, 60000, id => inFlight.set(request.id, id));
        if (request.method === 'tools/call') result = { isError: false, ...result };
        if (request.method === 'tools/call' && name === 'status' && !result.isError) {
          result = { ...result, content: result.content.map(block => {
            if (block.type !== 'text') return block;
            return { ...block, text: JSON.stringify({ ...JSON.parse(block.text), scummbench: metadata() }) };
          }) };
        }
        await write({ type: 'mcp', method: request.method, params: request.params, result });
        if (request.method === 'tools/call' && name === 'session' && parameters.operation === 'close') await finishRun('session_closed');
      } else {
        send({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Unsupported MCP method' } }); return;
      }
      send({ jsonrpc: '2.0', id: request.id, result });
    } catch {
      send({ jsonrpc: '2.0', id: request.id, error: { code: -32603, message: 'ScummBench gateway failed; direct backend fallback is disabled.' } });
    } finally {
      inFlight.delete(request.id); cancelled.delete(request.id);
    }
  };
  input.on('line', line => {
    let request;
    try { request = JSON.parse(line); } catch { send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid JSON' } }); return; }
    const operation = handle(request).catch(() => close('gateway_failed', 1)).finally(() => operations.delete(operation));
    operations.add(operation);
  });
  await new Promise(resolve => input.once('close', resolve));
  await Promise.allSettled([...operations]);
  await close('client_disconnected');
}
