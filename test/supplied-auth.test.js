import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createWandbTransport, defaultWandbConfig } from '../src/wandb.js';
import { blobTransport } from '../src/blob-results.js';

test('ordinary supplied credentials reach actual TLS HTTP clients without proxy setup', async t => {
  const directory = await mkdtemp(path.join(tmpdir(), 'scummbench-direct-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const key = path.join(directory, 'key.pem'), cert = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=api.wandb.ai', '-addext', 'subjectAltName=DNS:api.wandb.ai,DNS:vercel.com',
    '-keyout', key, '-out', cert], { stdio: 'ignore', timeout: 10000 });
  const pem = await readFile(cert), received = [];
  const server = createServer({ key: await readFile(key), cert: pem }, (req, res) => {
    received.push({ host: req.headers.host, auth: req.headers.authorization, path: req.url });
    req.resume(); res.setHeader('Content-Type', 'application/json'); res.end('{"data":{}}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  // Redirect only the test socket; preserve the production URL, TLS hostname,
  // authentication construction and actual HTTPS implementation.
  const localRequest = (url, options, callback) => request(url, { ...options,
    port: server.address().port, ca: pem,
    lookup: (_host, _options, done) => done(null, [{ address: '127.0.0.1', family: 4 }]),
  }, callback);
  const wandb = createWandbTransport(defaultWandbConfig, { WANDB_API_KEY: 'synthetic-wandb-key' }, localRequest);
  const blob = blobTransport({ BLOB_READ_WRITE_TOKEN: 'synthetic-blob-token' }, localRequest);
  try {
    await wandb('/graphql', { query: 'synthetic' }, AbortSignal.timeout(5000));
    await blob('https://vercel.com/api/blob?limit=1', { authenticated: true });
    assert.equal(received.length, 2);
    assert.match(received[0].host, /^api\.wandb\.ai:/);
    assert.equal(received[0].auth, `Basic ${Buffer.from('api:synthetic-wandb-key').toString('base64')}`);
    assert.match(received[1].host, /^vercel\.com:/);
    assert.equal(received[1].auth, 'Bearer synthetic-blob-token');
  } finally { wandb.close(); blob.close(); }
});
