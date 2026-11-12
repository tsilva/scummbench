// A real stdio backbone process with synthetic receipts and no game assets.
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const directory = path.resolve(import.meta.dirname, '../..');
const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
const revision = execFileSync('git', ['-C', directory, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const marker = await readFile(path.join(directory, 'marker.txt'), 'utf8');
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') send(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
  if (method === 'tools/list') send(id, { tools: ['status', 'act'].map(name => ({ name, inputSchema: { type: 'object' } })) });
  if (method === 'tools/call' && params.name === 'status') send(id, text({ phase: 'idle', serverPid: process.pid,
    dataDir: values['data-dir'], marker, sourceRevision: { repository: 'scummweb', commit_id: revision, dirty: false } }));
  if (method === 'tools/call' && params.name === 'act') process.exit(23);
}
