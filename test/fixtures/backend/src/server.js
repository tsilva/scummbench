// Synthetic game transport. No commercial assets, browser, or solution recipe.
import { createInterface } from 'node:readline';
import { writeFile, appendFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: {
  'no-viewer': { type: 'boolean' }, 'base-url': { type: 'string' }, 'data-dir': { type: 'string' },
  width: { type: 'string' }, height: { type: 'string' }, 'evaluation-log': { type: 'string' },
  'result-file': { type: 'string' }, 'stop-condition': { type: 'string' },
} });
const mode = new URL(values['base-url']).hostname.split('.')[0];
const revision = { commit_id: 'a'.repeat(40), dirty: false };
let ready = false, captured = false;
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const text = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const image = { type: 'image', mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=' };
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'synthetic', version: '1' } });
  if (method === 'tools/list') reply(id, { tools: ['session', 'status', 'act', 'observe'].map(name => ({ name })) });
  if (method !== 'tools/call') continue;
  if (params.name === 'status') reply(id, text({ phase: ready ? (mode === 'startup' ? 'loading' : 'ready') : 'idle', game: 'flight-of-the-amazon-queen',
    dimensions: { width: mode === 'dimensions' || (mode === 'transient' && !captured) ? 960 : 651, height: 490 }, sourceRevision: revision }));
  if (params.name === 'session') { ready = true; reply(id, text({ sessionId: 'synthetic-session' })); }
  if (params.name === 'observe') { captured = true; reply(id, { content: [image] }); }
  if (params.name === 'act') {
    if (mode === 'exit') process.exit(0);
    if (mode === 'reject') { reply(id, { isError: true, content: [] }); continue; }
    const condition = JSON.parse(values['stop-condition']);
    const receipt = { event: 'success', success: true, reason: 'stop_condition', game: 'flight-of-the-amazon-queen',
      session_id: 'synthetic-session', source_revision: revision, condition,
      detected_at: new Date().toISOString(), elapsed_ms: 1,
      variables: { engine_id: mode === 'corrupt' ? 'wrong' : 'queen', room_id: 71, room_ready: true, native_time_ms: 1 } };
    await writeFile(values['result-file'], JSON.stringify(receipt));
    await appendFile(values['evaluation-log'], JSON.stringify(receipt) + '\n');
    process.exit(0); // Success can close MCP before its final response.
  }
}
