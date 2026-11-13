// Synthetic publication transport for the real gateway; no network or keys.
import path from 'node:path';
import { serve } from '../../src/gateway.js';
import { loadWandb } from '../../src/wandb.js';
import { createBrokeredWandbTransport } from '../../src/wandb-broker.js';
import { McpClient } from '../../src/process.js';
import { fixtureWorkerEnvironment } from './wandb-environment.js';

const [directory, ...argv] = process.argv.slice(2);
const publishingEnv = fixtureWorkerEnvironment();
await serve(argv, { loadReporting: file => {
  if (file !== undefined) throw new Error('Expected automatic defaults without flags or environment configuration');
  return loadWandb(file, publishingEnv, { brokerTransport: (route, details) => createBrokeredWandbTransport(route, {
    ...details, createClient: (_command, args) => new McpClient(process.execPath,
      [path.join(import.meta.dirname, 'wandb-worker.js'), path.join(directory, 'wire.jsonl'), ...args]),
  }) });
} });
