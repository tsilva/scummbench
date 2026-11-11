#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, loadTask, json, requireThat } from './contracts.js';
import { gitRevision, loadBackend } from './backend.js';
import { runAttempt, verifyRun, validateAgent } from './runner.js';
import { aggregate } from './aggregate.js';

const taskFile = path.join(root, 'tasks/queen/hotel-laundry.v1.json');
const help = `ScummBench development runner (Node.js 22+)

  scummbench tasks
  scummbench init-config --agentscumm /absolute/agentscumm --base-url URL --out local/backend.json
  scummbench doctor --backend local/backend.json
  scummbench run --backend local/backend.json --agent examples/observe-agent.json --out runs/attempt-001
  scummbench verify --run runs/attempt-001
  scummbench aggregate --run runs/attempt-001 --run runs/attempt-002

run optionally accepts --task PATH. Output directories must not already exist.
doctor verifies the MCP connection without launching a game. No model API calls
or game assets are bundled. Run an agent inside your approved credential route.
All v1 results are development-only, with no enforced OS/network sandbox.
`;

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    backend: { type: 'string' }, agent: { type: 'string' }, task: { type: 'string' }, out: { type: 'string' },
    agentscumm: { type: 'string' }, 'base-url': { type: 'string' }, run: { type: 'string', multiple: true },
    help: { type: 'boolean' }, version: { type: 'boolean' },
  } });
  const [command] = positionals;
  requireThat(positionals.length <= 1, 'Unexpected positional arguments');
  if (values.version) {
    requireThat(!command && Object.keys(values).length === 1, '--version takes no other options');
    process.stdout.write(`scummbench ${(await json(path.join(root, 'package.json'))).version}\n`);
    return;
  }
  if (values.help || !command) { process.stdout.write(help); return; }
  const allowed = {
    tasks: [], 'init-config': ['agentscumm', 'base-url', 'out'], doctor: ['backend'],
    run: ['backend', 'agent', 'task', 'out'], verify: ['run'], aggregate: ['run'],
  };
  requireThat(Object.hasOwn(allowed, command), 'Unknown command');
  requireThat(Object.keys(values).every(key => allowed[command].includes(key)), 'Unexpected command option');
  let result;
  if (command === 'tasks') {
    const files = (await readdir(path.join(root, 'tasks/queen'))).filter(file => file.endsWith('.json')).sort();
    result = await Promise.all(files.map(async file => {
      const { task, sha256 } = await loadTask(path.join(root, 'tasks/queen', file));
      return { id: task.id, status: task.status, objective: task.objective, task_sha256: sha256 };
    }));
  } else if (command === 'init-config') {
    requireThat(values.agentscumm && values['base-url'] && values.out, 'agentscumm, base-url, and out are required');
    const revision = gitRevision(path.resolve(values.agentscumm));
    requireThat(revision.commit_id && revision.dirty === false, 'AgentSCUMM must be a clean Git checkout');
    const config = { schema_version: 1, agentscumm_dir: path.resolve(values.agentscumm),
      agentscumm_revision: revision.commit_id, base_url: values['base-url'], scummweb_revision: null, asset_files: [] };
    // Validate before writing. Parent directories are operator-selected; never
    // create a credential or secret binding implicitly.
    const url = new URL(config.base_url);
    requireThat(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash, 'Invalid base URL');
    await writeFile(values.out, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    result = { written: path.resolve(values.out), runtime_and_asset_pins: 'unknown; declaration is not deployed verification' };
  } else if (command === 'doctor' || command === 'run') {
    requireThat(values.backend, 'backend is required');
    const { config, provenance } = await loadBackend(values.backend);
    const loadedTask = await loadTask(values.task ?? taskFile);
    if (command === 'doctor') {
      // Plain MCP initialization creates no evaluation trial or game session.
      const { McpClient, textResult } = await import('./process.js');
      const client = new McpClient(process.execPath, [path.join(config.agentscumm_dir, 'src/index.js'), '--no-viewer'], { cwd: config.agentscumm_dir });
      try {
        const handshake = await client.connect();
        const status = textResult(await client.call('status'));
        requireThat(status.sourceRevision?.commit_id === config.agentscumm_revision && status.sourceRevision?.dirty === false, 'MCP source revision mismatch');
        result = { connection: 'verified', launches_game: false, handshake, source_revision: status.sourceRevision, provenance,
          official_eligible: false, live_game_evaluation: 'not tested by doctor' };
      } finally { await client.close(); }
    } else {
      requireThat(values.agent && values.out, 'agent and out are required');
      const attempt = await runAttempt({ loadedTask, backendConfig: config, provenance,
        agentConfig: validateAgent(await json(values.agent)), output: values.out });
      result = { directory: attempt.directory, ...attempt.result };
      if (result.status !== 'success') process.exitCode = result.status === 'infrastructure_error' ? 2 : 1;
    }
  } else if (command === 'verify') {
    requireThat(values.run?.length === 1, 'verify requires one run');
    result = await verifyRun(path.resolve(values.run[0]));
  } else result = await aggregate((values.run ?? []).map(directory => path.resolve(directory)));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(() => {
  // Do not echo child errors, configuration values, URLs, or command arguments.
  process.stderr.write('ScummBench command failed. Check the command options, clean pinned checkout, and private run artifacts. Use --help for usage.\n');
  process.exitCode = 2;
});
