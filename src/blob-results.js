import { Agent, request } from 'node:https';
import { createHash } from 'node:crypto';
import { validateResults } from '../web/results-model.js';
import { mergeResults } from '../web/public-results.js';

export const PLACEHOLDER = 'scummbench_results_placeholder';
export const BLOB_API = 'https://vercel.com/api/blob';
export function blobTransport(env = process.env) {
  if (env.BLOB_READ_WRITE_TOKEN !== PLACEHOLDER || !env.HTTPS_PROXY || env.NO_PROXY || env.no_proxy
    || !env.NODE_EXTRA_CA_CERTS || env.NODE_TLS_REJECT_UNAUTHORIZED === '0') throw new Error('Reviewed results proxy required');
  const proxy = new URL(env.HTTPS_PROXY);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || proxy.port !== '8283') throw new Error('Unexpected results proxy');
  const agent = new Agent({ proxyEnv: { HTTPS_PROXY: env.HTTPS_PROXY }, keepAlive: true });
  const send = (url, { method = 'GET', body, headers = {}, authenticated = false } = {}) => new Promise((resolve, reject) => {
    const target = new URL(url);
    if (authenticated && (target.origin !== 'https://vercel.com' || !['/api/blob', '/api/blob/'].includes(target.pathname))) throw new Error('Unexpected Blob API');
    const req = request(target, { agent, method, signal: AbortSignal.timeout(15000),
      headers: { ...headers, ...(authenticated ? { Authorization: `Bearer ${PLACEHOLDER}`, 'x-api-version': '13' } : {}) } }, res => {
      const chunks = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 2 * 1024 * 1024) req.destroy(new Error('Results size limit')); else chunks.push(chunk); });
      res.on('error', reject);
      res.on('end', () => { let value; try { value = JSON.parse(Buffer.concat(chunks)); } catch { value = null; }
        resolve({ status: res.statusCode, etag: res.headers.etag, value }); });
    });
    req.on('error', reject); req.end(body);
  });
  send.close = () => agent.destroy(); return send;
}
const empty = { schema_version: 1, games: [] };
const comparableTag = value => typeof value === 'string' ? value.replace(/^W\//, '').replace(/^"|"$/g, '') : null;
export async function syncResults(incoming, { url, send, now = () => new Date().toISOString() }) {
  validateResults(incoming);
  const target = new URL(url);
  if (target.protocol !== 'https:' || !/^[a-z0-9]+\.public\.blob\.vercel-storage\.com$/.test(target.hostname)
    || target.pathname !== '/results/current.json' || target.search || target.hash) throw new Error('Invalid public results destination');
  for (let attempt = 0; attempt < 4; attempt++) {
    const previous = await send(url + `?refresh=${Date.now()}-${attempt}`, { headers: { 'Cache-Control': 'no-cache' } });
    if (previous.status !== 200 && previous.status !== 404) throw new Error('Public results unavailable');
    if (previous.status === 200 && !previous.etag) throw new Error('Missing results concurrency token');
    let etag;
    if (previous.status === 200) {
      // The CDN returns weak tags. Blob's authenticated metadata API supplies
      // the storage tag required for ifMatch. Verify that it describes the
      // bytes we read before merging, so a stale CDN response cannot lose runs.
      const metadata = await send(BLOB_API + '?url=' + encodeURIComponent(url), { authenticated: true });
      etag = metadata.value?.etag;
      if (metadata.status !== 200 || metadata.value?.url !== url || !etag || etag.startsWith('W/')) throw new Error('Missing storage concurrency token');
      if (comparableTag(previous.etag) !== comparableTag(etag)) continue;
    }
    const data = mergeResults(previous.status === 404 ? empty : previous.value, incoming);
    const revision = createHash('sha256').update(JSON.stringify(data)).digest('hex');
    if (previous.value?.revision === revision) return { revision, unchanged: true };
    const payload = { ...data, revision, publication: { mode: 'automatic', generated_at: now() } };
    const result = await send(BLOB_API + '/?pathname=results%2Fcurrent.json', { method: 'PUT', authenticated: true,
      headers: { 'Content-Type': 'application/json', 'x-content-type': 'application/json', 'x-add-random-suffix': '0',
        'x-vercel-blob-access': 'public', 'x-cache-control-max-age': '60',
        'x-allow-overwrite': previous.status === 200 ? '1' : '0', ...(etag ? { 'x-if-match': etag } : {}) },
      body: JSON.stringify(payload) });
    if (result.status === 412 || result.value?.error?.code === 'precondition_failed' || result.value?.error?.code === 'blob_already_exists') continue;
    if (result.status < 200 || result.status >= 300 || result.value?.url !== url) throw new Error('Results upload not confirmed');
    return { revision, unchanged: false };
  }
  throw new Error('Concurrent publication; retry required');
}
