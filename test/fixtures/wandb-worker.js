// Exercise the production worker protocol with a synthetic upstream only.
import { appendFile } from 'node:fs/promises';
import { serveWandbWorker } from '../../src/wandb-worker.js';

const [file, , runId, mode] = process.argv.slice(2);
await appendFile(file, JSON.stringify({ event: 'worker', pid: process.pid,
  credential_present: process.env.WANDB_API_KEY !== undefined, proxy_present: process.env.HTTPS_PROXY !== undefined }) + '\n');
await serveWandbWorker(runId, { transport: async (endpoint, body, signal) => {
  await appendFile(file, JSON.stringify({ endpoint, body }) + '\n');
  if (mode === 'stall') await new Promise((resolve, reject) => {
    if (signal.aborted) reject(new Error('cancelled'));
    else signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  return endpoint === '/graphql' ? { data: { upsertBucket: { bucket: { name: body.variables.name } } } } : {};
} });
