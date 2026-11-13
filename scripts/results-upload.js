import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { root } from '../src/contracts.js';
import { blobTransport, syncResults } from '../src/blob-results.js';

const directory = path.join(root, '.internal/publication');

export async function uploadResultsOutbox({ stateDirectory = directory,
  configFile = path.join(root, 'local/results-publication.json'),
  transport = blobTransport } = {}) {
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  const incoming = JSON.parse(await readFile(path.join(stateDirectory, 'outbox.json'), 'utf8'));
  const send = transport();
  try {
    const result = await syncResults(incoming, { url: config.url, send });
    const file = path.join(stateDirectory, `receipt.${process.pid}.pending`);
    await writeFile(file, JSON.stringify({ status: 'published', revision: incoming.revision, public_revision: result.revision,
      checked_at: new Date().toISOString() }) + '\n', { flag: 'wx', mode: 0o600 });
    await rename(file, path.join(stateDirectory, 'receipt.json'));
    return result;
  } finally { send.close?.(); }
}

async function main() {
let send;
try {
  if (process.argv.includes('--check-fake')) {
    send = blobTransport();
    const result = await send('https://vercel.com/api/blob?limit=1', { authenticated: true });
    if (![401, 403].includes(result.status)) throw new Error('Fake credential unexpectedly accepted');
    const denied = await send('https://api.github.com/');
    if (denied.status !== 403) throw new Error('Unexpected proxy egress');
    try { await readFile(path.join(root, '.internal/evidence/automatic-results/deny.txt')); throw new Error('Sandbox read allowed'); }
    catch (error) { if (!['EACCES', 'EPERM'].includes(error.code)) throw error; }
    await writeFile(path.join(directory, 'fake-proof.json'), JSON.stringify({ fake_rejected: true, unlisted_host_blocked: true, private_read_blocked: true }) + '\n', { mode: 0o600 });
  } else if (process.argv.includes('--check-auth')) {
    send = blobTransport();
    const result = await send('https://vercel.com/api/blob?limit=1', { authenticated: true });
    if (result.status !== 200 || !Array.isArray(result.value?.blobs)) throw new Error('Store identity check failed');
    console.log(JSON.stringify({ ok: true, read_only: true, credential_mode: 'public-placeholder' }));
  } else {
    await uploadResultsOutbox();
  }
} catch { process.exitCode = 1; }
finally { send?.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
