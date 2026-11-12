// A synthetic gateway/backbone pair, never a browser or live game.
import { createInterface } from 'node:readline';
import { readFile, appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const directory = process.argv[2], args = process.argv.slice(3);
const config = JSON.parse(await readFile(path.join(directory, 'config.json')));
const directoryIndex = args.indexOf('--data-dir');
const dataDir = directoryIndex >= 0 ? args[directoryIndex + 1] : path.join(directory, 'profile');
await mkdir(dataDir, { recursive: true });
await appendFile(path.join(directory, 'events.jsonl'), JSON.stringify({ event: 'started', pid: process.pid, args, dataDir }) + '\n');
let active = false;
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const status = () => ({ phase: active ? 'ready' : 'idle', sessionId: active ? 'session-fixture' : undefined,
  dataDir, serverPid: process.pid, marker: config.marker,
  sourceRevision: { repository: 'scummweb', commit_id: config.mismatch ? 'f'.repeat(40) : config.backbone_commit, dirty: false },
  scummbench: { mediated: true, results_owner: 'scummbench', backbone_directory: directory,
    source_revision: { commit_id: config.gateway_commit, dirty: false }, run_id: active ? 'run-fixture' : null } });
const lines = createInterface({ input: process.stdin });
lines.on('line', async line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') {
    if (config.fail_startup) process.exit(12);
    send(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: config.marker } });
  } else if (method === 'tools/list') send(id, { tools: ['status', 'session', 'act'].map(name => ({ name,
    inputSchema: { type: 'object', properties: name === 'act' ? { action: { type: config.schema_type ?? 'string' } } : {} } })) });
  else if (method === 'tools/call') {
    await appendFile(path.join(directory, 'events.jsonl'), JSON.stringify({ event: params.name, pid: process.pid, parameters: params.arguments }) + '\n');
    if (params.name === 'status') {
      if (params.arguments.wait_ms) await new Promise(resolve => setTimeout(resolve, params.arguments.wait_ms));
      send(id, text(status()));
    } else if (params.name === 'session') {
      active = params.arguments.operation !== 'close';
      send(id, text(status()));
    } else if (params.name === 'act') {
      if (params.arguments.action === 'save') await writeFile(path.join(dataDir, 'save-slot-1'), 'saved-progress');
      if (params.arguments.action === 'crash') process.exit(23);
      send(id, text({ accepted: true }));
    }
  }
});
