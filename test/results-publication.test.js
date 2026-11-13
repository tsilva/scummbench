import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sampleResults } from '../web/sample-data.js';
import { mergeResults } from '../web/public-results.js';
import { createWandbTransport, defaultWandbConfig } from '../src/wandb.js';
import { syncResults, blobTransport } from '../src/blob-results.js';
import { resultsHandler } from '../api/results.js';
import { uploadResultsOutbox } from '../scripts/results-upload.js';
import { publicationEnvironment } from '../src/results-publication.js';
import { gatewayEnvironment } from '../src/mcp-runtime.js';
import { cleanEnv } from '../src/process.js';
const empty = { schema_version: 1, games: [] };
const fixture = () => structuredClone(sampleResults);
const url = 'https://synthetic.public.blob.vercel-storage.com/results/current.json';

test('publication preserves independent versions and rejects conflicting contracts or reassigned run identities', () => {
  const data = fixture();
  const previous = structuredClone(data), incoming = structuredClone(data);
  previous.games[0].benchmarks = [data.games[0].benchmarks[0]];
  incoming.games[0].benchmarks = [data.games[0].benchmarks[1]];
  const merged = mergeResults(previous, incoming);
  assert.equal(merged.games.find(g => g.id === 'flight-of-the-amazon-queen').benchmarks.length, 2);
  assert.equal(mergeResults(merged, incoming).diagnostics.discovered, merged.diagnostics.discovered);
  const conflict = fixture(); conflict.games[0].benchmarks[0].contract.start = 'Other start';
  assert.throws(() => mergeResults(data, conflict), /identity conflict/);
  const reassigned = fixture(); reassigned.games[0].benchmarks[1].runs[0].id = data.games[0].benchmarks[0].runs[0].id;
  assert.throws(() => mergeResults(data, reassigned), /Run identity conflict/);
});

test('concurrent publication re-reads current results and uses the current ETag', async () => {
  const data = fixture(), other = fixture();
  data.games[0].benchmarks = [data.games[0].benchmarks[0]];
  other.games[0].benchmarks = [other.games[0].benchmarks[1]];
  let reads = 0, writes = 0;
  const result = await syncResults(data, { url, send: async (endpoint, options) => {
    if (!options.authenticated) { reads++; return { status: 200, etag: 'W/"version-' + reads + '"', value: reads === 1 ? empty : other }; }
    if (options.method !== 'PUT') return { status: 200, value: { url, etag: 'version-' + reads } };
    writes++; assert.equal(options.headers['x-if-match'], 'version-' + writes);
    const body = JSON.parse(options.body);
    assert.equal(body.publication.mode, 'automatic');
    if (writes === 2) assert.equal(body.games.find(g => g.id === 'flight-of-the-amazon-queen').benchmarks.length, 2);
    return writes === 1 ? { status: 412 } : { status: 200, value: { url } };
  } });
  assert.equal(reads, 2); assert.equal(writes, 2); assert.equal(result.unchanged, false);
});

test('initial publication cannot overwrite an unseen writer and success needs the expected URL', async () => {
  let options;
  await syncResults(fixture(), { url, send: async (_, value) => {
    if (!value.authenticated) return { status: 404 };
    options = value; return { status: 200, value: { url } };
  } });
  assert.equal(options.headers['x-allow-overwrite'], '0');
  assert.equal(options.headers['x-if-match'], undefined);
  await assert.rejects(syncResults(fixture(), { url, send: async (_, value) => value.authenticated
    ? { status: 200, value: { url: 'https://other.invalid/' } } : { status: 404 } }), /not confirmed/);
});

test('unavailable reads and missing ETags never perform writes; invalid protected credentials fail', async () => {
  for (const previous of [{ status: 503 }, { status: 200, value: empty }]) {
    let writes = 0;
    await assert.rejects(syncResults(fixture(), { url, send: async (_, options) => { if (options.authenticated) writes++; return previous; } }));
    assert.equal(writes, 0);
  }
  assert.throws(() => blobTransport({ INFISICAL_AGENT_VAULT_URL: 'https://app.infisical.com', BLOB_READ_WRITE_TOKEN: 'real-token' }), /proxy required/);
});

function response() { return { headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(value) { this.body = value; } }; }
test('public reader serves dynamic data, preserves unavailable metrics, and reports outages', async () => {
  const data = JSON.parse(await readFile(new URL('../web/results.json', import.meta.url)));
  data.publication.mode = 'automatic';
  const handler = resultsHandler({ url, fetchResults: async () => ({ ok: true, status: 200, json: async () => data }) });
  const res = response(); await handler({ method: 'GET' }, res);
  assert.equal(res.statusCode, 200); assert.deepEqual(JSON.parse(res.body), data);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  const down = response(); await resultsHandler({ fetchResults: async () => ({ ok: false, status: 503 }) })({ method: 'GET' }, down);
  assert.equal(down.statusCode, 503);
  const post = response(); await handler({ method: 'POST' }, post); assert.equal(post.statusCode, 405);
});


test('stale CDN bytes or missing authenticated metadata never overwrite current results', async () => {
  for (const metadata of [{ status: 503 }, { status: 200, value: { url, etag: 'current' } },
      { status: 200, value: { url, etag: 'W/"old"' } }]) {
    let writes = 0;
    await assert.rejects(syncResults(fixture(), { url, send: async (_, options) => {
      if (!options.authenticated) return { status: 200, etag: 'W/"old"', value: empty };
      if (options.method !== 'PUT') return metadata;
      writes++; return { status: 200, value: { url } };
    } }));
    assert.equal(writes, 0);
  }
});

test('normal uploader uses supplied transport and ignores obsolete launcher metadata', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-outbox-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const marker = path.join(directory, 'unexpected-launch');
  const configFile = path.join(directory, 'publication.json');
  await writeFile(configFile, JSON.stringify({ version: 1, enabled: true, url,
    uploader: { command: process.execPath, arguments: ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'bad')`] } }));
  await writeFile(path.join(directory, 'outbox.json'), JSON.stringify(fixture()));
  const calls = []; let closed = false;
  const send = async (_, options) => { calls.push(options); return options.authenticated
    ? { status: 200, value: { url } } : { status: 404 }; };
  send.close = () => { closed = true; };
  await uploadResultsOutbox({ stateDirectory: directory, configFile, transport: () => send });
  assert.equal(calls.filter(call => call.method === 'PUT').length, 1);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'receipt.json'), 'utf8')).status, 'published');
  await assert.rejects(access(marker)); assert.equal(closed, true);
});

test('only trusted publication workers receive explicit executors or scoped environments', () => {
  const command = JSON.stringify([process.execPath, '/synthetic/worker.js']);
  const env = { HOME: '/synthetic', PATH: '/bin', SCUMMBENCH_WANDB_WORKER_COMMAND: command,
    SCUMMBENCH_RESULTS_UPLOADER_COMMAND: command, WANDB_API_KEY: 'synthetic_placeholder',
    HTTPS_PROXY: 'http://capability@127.0.0.1:8283', UNRELATED_TOKEN: 'synthetic-private' };
  const gateway = gatewayEnvironment(env);
  assert.equal(gateway.SCUMMBENCH_WANDB_WORKER_COMMAND, command);
  assert.equal(gateway.UNRELATED_TOKEN, undefined);
  const publication = publicationEnvironment(env);
  assert.equal(publication.SCUMMBENCH_RESULTS_UPLOADER_COMMAND, command);
  assert.equal(publication.HTTPS_PROXY, undefined);
  assert.equal(publication.WANDB_API_KEY, undefined);
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  try {
    Object.assign(process.env, env);
    const game = cleanEnv();
    for (const name of ['SCUMMBENCH_WANDB_WORKER_COMMAND', 'SCUMMBENCH_RESULTS_UPLOADER_COMMAND',
      'WANDB_API_KEY', 'BLOB_READ_WRITE_TOKEN', 'HTTPS_PROXY', 'UNRELATED_TOKEN']) assert.equal(game[name], undefined);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});


test('ordinary supplied Blob token uses fixed authenticated HTTPS and ignores ambient proxy', async () => {
  let observed;
  const transport = blobTransport({ BLOB_READ_WRITE_TOKEN: 'synthetic-user-token', HTTPS_PROXY: 'http://untrusted.invalid' }, (url, options, callback) => {
    observed = { url, options }; const req = new EventEmitter();
    req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.headers = {};
      callback(res); res.emit('data', Buffer.from('{}')); res.emit('end'); };
    return req;
  });
  try {
    await transport('https://vercel.com/api/blob?limit=1', { authenticated: true });
    assert.equal(observed.url.href, 'https://vercel.com/api/blob?limit=1');
    assert.equal(observed.options.headers.Authorization, 'Bearer synthetic-user-token');
    assert.deepEqual(observed.options.agent.options.proxyEnv, {});
    await assert.rejects(transport('https://other.invalid/', { authenticated: true }), /Unexpected Blob API/);
  } finally { transport.close(); }
  for (const key of ['', ' ', 'bad\nkey', 'wrong_placeholder']) {
    assert.throws(() => blobTransport({ BLOB_READ_WRITE_TOKEN: key }));
  }
});


test('trusted child boundaries retain explicit protected mode and never leak it to players', () => {
  const marker = 'https://app.infisical.com';
  assert.equal(gatewayEnvironment({ BLOB_READ_WRITE_TOKEN: 'synthetic-blob-token' }).BLOB_READ_WRITE_TOKEN, 'synthetic-blob-token');
  const gateway = gatewayEnvironment({ INFISICAL_AGENT_VAULT_URL: marker, WANDB_API_KEY: 'synthetic-user-key' });
  assert.equal(gateway.INFISICAL_AGENT_VAULT_URL, marker);
  assert.throws(() => createWandbTransport(defaultWandbConfig, gateway), /placeholder/);
  const publication = publicationEnvironment({ INFISICAL_AGENT_VAULT_URL: marker, BLOB_READ_WRITE_TOKEN: 'synthetic-user-token' });
  assert.equal(publication.INFISICAL_AGENT_VAULT_URL, marker);
  assert.throws(() => blobTransport(publication), /proxy required/);
  const old = process.env.INFISICAL_AGENT_VAULT_URL, oldBlob = process.env.BLOB_READ_WRITE_TOKEN;
  try {
    process.env.INFISICAL_AGENT_VAULT_URL = marker;
    process.env.BLOB_READ_WRITE_TOKEN = 'synthetic-blob-token';
    assert.equal(cleanEnv().INFISICAL_AGENT_VAULT_URL, undefined);
    assert.equal(cleanEnv().BLOB_READ_WRITE_TOKEN, undefined);
  } finally {
    if (old === undefined) delete process.env.INFISICAL_AGENT_VAULT_URL; else process.env.INFISICAL_AGENT_VAULT_URL = old;
    if (oldBlob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN; else process.env.BLOB_READ_WRITE_TOKEN = oldBlob;
  }
});
