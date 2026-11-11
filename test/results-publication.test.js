import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { sampleResults } from '../web/sample-data.js';
import { mergeResults } from '../web/public-results.js';
import { syncResults, blobTransport } from '../src/blob-results.js';
import { resultsHandler } from '../api/results.js';
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
    if (!options.authenticated) { reads++; return { status: 200, etag: 'version-' + reads, value: reads === 1 ? empty : other }; }
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

test('unavailable reads and missing ETags never perform writes; raw credentials cannot start the client', async () => {
  for (const previous of [{ status: 503 }, { status: 200, value: empty }]) {
    let writes = 0;
    await assert.rejects(syncResults(fixture(), { url, send: async (_, options) => { if (options.authenticated) writes++; return previous; } }));
    assert.equal(writes, 0);
  }
  assert.throws(() => blobTransport({ BLOB_READ_WRITE_TOKEN: 'real-token' }), /proxy required/);
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
