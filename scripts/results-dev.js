import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const args = process.argv.slice(2).filter(value => value !== '--');
let port = 0, host = '127.0.0.1';
for (let index = 0; index < args.length; index++) {
  const flag = args[index], value = args[++index];
  if (flag === '--port' && (value === 'auto' || /^\d+$/.test(value ?? ''))) port = value === 'auto' ? 0 : Number(value);
  else if (flag === '--host' && ['127.0.0.1', 'localhost', '::1'].includes(value)) host = value;
  else throw new Error('Use --port auto (or a numeric port) and an optional loopback --host.');
}
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port.');
const root = fileURLToPath(new URL('../web/', import.meta.url));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
const server = createServer(async (request, response) => {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; font-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405); response.end(); return; }
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root) || !mime[path.extname(file)]) { response.writeHead(404); response.end('Not found'); return; }
    const content = await readFile(file);
    response.setHeader('Content-Type', mime[path.extname(file)]);
    response.writeHead(200); response.end(request.method === 'HEAD' ? undefined : content);
  } catch { response.writeHead(404); response.end('Not found'); }
});
server.on('error', error => { console.error(`Preview could not start: ${error.code ?? 'unknown error'}.`); process.exitCode = 1; });
server.listen(port, host, () => {
  const address = server.address(), urlHost = host.includes(':') ? `[${host}]` : host;
  console.log(`ScummBench results: http://${urlHost}:${address.port}/`);
  console.log(`Sample preview: http://${urlHost}:${address.port}/?demo=1`);
});
