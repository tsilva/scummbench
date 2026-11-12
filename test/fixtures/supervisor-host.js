import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { supervise, RuntimeError } from '../../src/mcp-runtime.js';
import { McpClient } from '../../src/process.js';

const directory = process.argv[2];
await supervise(process.argv.slice(3), {
  makeClient: args => new McpClient(process.execPath, [path.join(import.meta.dirname, 'supervisor-worker.js'), directory, ...args]),
  checkReload: async () => {
    const config = JSON.parse(await readFile(path.join(directory, 'config.json')));
    if (config.dirty) throw new RuntimeError('Commit all pending ScummBench and ScummWEB changes before reloading.');
    return { gateway: { commit_id: config.gateway_commit }, backbone: { commit_id: config.backbone_commit } };
  },
});
