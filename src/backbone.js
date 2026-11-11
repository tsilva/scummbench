import path from 'node:path';
import { access, realpath } from 'node:fs/promises';
import { root, json, requireThat } from './contracts.js';

// Resolve ScummWEB itself, never an AgentSCUMM launcher or its old server.
// The sibling default supports editable checkouts; other layouts select an
// absolute checkout explicitly or through SCUMMWEB_DIR.
export async function resolveBackbone(directory = process.env.SCUMMWEB_DIR ?? path.resolve(root, '../scummweb')) {
  requireThat(typeof directory === 'string' && path.isAbsolute(directory), 'Absolute ScummWEB checkout required');
  const checkout = await realpath(directory);
  requireThat((await json(path.join(checkout, 'package.json'))).name === 'scummweb', 'Not a ScummWEB checkout');
  const server = path.join(checkout, 'agent-backbone/src/server.js');
  await access(server);
  return { directory: checkout, server };
}
