import { writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function fixtureRoute(directory) {
  const file = path.join(directory, 'route.json');
  await writeFile(file, JSON.stringify({ version: 1, bundle: 'local-scummbench-wandb', launcher: process.execPath,
    source: { instance: 'https://app.infisical.com', project_id: 'cba79865-b229-4181-909b-0da11a052799',
      environment: 'prod', path: '/wandb', variable: 'WANDB_API_KEY' } }), { mode: 0o600 });
  return file;
}
