import { spawn } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import path from 'node:path';
import { root } from './contracts.js';

export function publicationEnvironment(env = process.env) {
  const names = ['HOME', 'PATH', 'SCUMMBENCH_RESULTS_UPLOADER_COMMAND'];
  if (env.BLOB_READ_WRITE_TOKEN !== undefined) names.push('BLOB_READ_WRITE_TOKEN',
    'HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy',
    'INFISICAL_AGENT_VAULT_URL', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED');
  return Object.fromEntries(names.filter(name => env[name] !== undefined).map(name => [name, env[name]]));
}

// Best-effort wakeup after authoritative local evidence is final. A periodic
// publisher retries offline failures independently of gameplay and grading.
export async function requestResultsPublication() {
  try {
    const file = path.join(root, 'local/results-publication.json');
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) return;
    const child = spawn(process.execPath, [path.join(root, 'scripts/results-sync.js'), '--once'], {
      cwd: root, detached: true, stdio: 'ignore', env: publicationEnvironment(),
    });
    child.on('error', () => {}); child.unref();
  } catch { /* Local results remain authoritative; the retry job records delivery failures. */ }
}
