// Synthetic publication transport for the real gateway; no network or keys.
import { appendFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '../../src/gateway.js';
import { WandbPublisher } from '../../src/wandb.js';

const [directory, ...argv] = process.argv.slice(2);
await serve(argv, { reporting: details => new WandbPublisher({
  entity: 'fixture', project: 'tests', api_key_placeholder: 'test_placeholder',
}, { ...details, flushMs: 5, transport: async (endpoint, body) => {
  await appendFile(path.join(directory, 'wire.jsonl'), JSON.stringify({ endpoint, body }) + '\n');
  return endpoint === '/graphql' ? { data: { upsertBucket: { bucket: { name: body.variables.name } } } } : {};
} }) });
