#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root, loadTask, json, requireThat } from './contracts.js';
import { gitRevision, loadBackend } from './backend.js';
import { runAttempt, verifyRun, validateAgent } from './runner.js';
import { aggregate } from './aggregate.js';
import { loadWandb } from './wandb.js';
import { resolveBackbone } from './backbone.js';

const taskFile = path.join(root, 'tasks/queen/hotel-laundry.v1.json');
const help = `ScummBench development runner (Node.js 22+)

  scummbench tasks
  scummbench init-config --scummweb /absolute/scummweb --base-url URL --out local/backend.json
  scummbench doctor --backend local/backend.json
  scummbench run --backend local/backend.json --agent examples/observe-agent.json --out runs/attempt-001
  scummbench verify --run runs/attempt-001
  scummbench aggregate --run runs/attempt-001 --run runs/attempt-002
  scummbench mcp [--scummweb /absolute/scummweb] -- [backend arguments]
  scummbench register-archive --archive PATH --source-repo /absolute/source-repo
  scummbench paths

New runs publish to tsilva/scummbench-<ScummVM gameid> automatically through Agent Vault.
run optionally accepts --task PATH and --wandb CONFIG to override the default configuration.
Use --no-wandb for an explicitly offline run. MCP accepts W&B options before --.
SCUMMBENCH_WANDB_CONFIG selects an alternative configuration.
Output directories must not already exist.
doctor verifies the MCP connection without launching a game. No model API calls
or game assets are bundled. Run an agent inside your approved credential route.
All v1 results are development-only, with no enforced OS/network sandbox.
`;

async function main() {
  if (['mcp', 'mcp-worker'].includes(process.argv[2])) {
    const args = process.argv.slice(3);
    if (process.argv[2] === 'mcp-worker' || args.includes('--import-only')) {
      const { serve } = await import('./gateway.js');
      await serve(args, { supervised: process.argv[2] === 'mcp-worker' });
    } else {
      // Retain fail-fast configuration and credential-route diagnostics before
      // the supervisor starts a worker or reads host protocol messages.
      const { prepareGateway } = await import('./gateway.js');
      await prepareGateway(args);
      const { supervise } = await import('./mcp-runtime.js');
      await supervise(args);
    }
    return;
  }
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    backend: { type: 'string' }, agent: { type: 'string' }, task: { type: 'string' }, out: { type: 'string' },
    scummweb: { type: 'string' }, 'base-url': { type: 'string' }, run: { type: 'string', multiple: true },
    help: { type: 'boolean' }, version: { type: 'boolean' },
    wandb: { type: 'string' },
    'no-wandb': { type: 'boolean' },
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
    tasks: [], paths: [], 'init-config': ['scummweb', 'base-url', 'out'], doctor: ['backend'],
    run: ['backend', 'agent', 'task', 'out', 'wandb', 'no-wandb'], verify: ['run'], aggregate: ['run'],
  };
  requireThat(Object.hasOwn(allowed, command), 'Unknown command');
  requireThat(Object.keys(values).every(key => allowed[command].includes(key)), 'Unexpected command option');
  requireThat(!(values.wandb && values['no-wandb']), 'Conflicting W&B options');
  let result;
  if (command === 'paths') {
    result = { repository: root, benchmarks: path.join(root, 'BENCHMARKS.md'), interactive_runs: path.join(root, 'runs/interactive') };
    result.scummweb_checkout = await resolveBackbone().then(backbone => backbone.directory, () => null);
  } else if (command === 'tasks') {
    const files = (await readdir(path.join(root, 'tasks/queen'))).filter(file => file.endsWith('.json')).sort();
    result = await Promise.all(files.map(async file => {
      const { task, sha256 } = await loadTask(path.join(root, 'tasks/queen', file));
      return { id: task.id, status: task.status, objective: task.objective, task_sha256: sha256 };
    }));
  } else if (command === 'init-config') {
    requireThat(values.scummweb && values['base-url'] && values.out, 'scummweb, base-url, and out are required');
    const revision = gitRevision(path.resolve(values.scummweb));
    requireThat(revision.commit_id && revision.dirty === false, 'ScummWEB must be a clean Git checkout');
    await resolveBackbone(path.resolve(values.scummweb));
    const config = { schema_version: 2, scummweb_dir: path.resolve(values.scummweb),
      scummweb_revision: revision.commit_id, base_url: values['base-url'], runtime_revision: null, asset_files: [] };
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
      const client = new McpClient(process.execPath, [path.join(config.scummweb_dir, 'agent-backbone/src/server.js'), '--no-viewer'], { cwd: config.scummweb_dir, env: { SCUMMBENCH_MANAGED: '1' } });
      try {
        const handshake = await client.connect();
        const status = textResult(await client.call('status'));
        requireThat(status.sourceRevision?.repository === 'scummweb'
          && status.sourceRevision?.commit_id === config.scummweb_revision && status.sourceRevision?.dirty === false, 'MCP source revision mismatch');
        result = { connection: 'verified', launches_game: false, handshake, source_revision: status.sourceRevision, provenance,
          official_eligible: false, live_game_evaluation: 'not tested by doctor' };
      } finally { await client.close(); }
    } else {
      requireThat(values.agent && values.out, 'agent and out are required');
      const reporting = values['no-wandb'] ? false : await loadWandb(values.wandb ?? process.env.SCUMMBENCH_WANDB_CONFIG);
      const attempt = await runAttempt({ loadedTask, backendConfig: config, provenance,
        agentConfig: validateAgent(await json(values.agent)), output: values.out, reporting });
      result = { directory: attempt.directory, ...attempt.result };
      if (result.status !== 'success') process.exitCode = result.status === 'infrastructure_error' ? 2 : 1;
    }
  } else if (command === 'verify') {
    requireThat(values.run?.length === 1, 'verify requires one run');
    result = await verifyRun(path.resolve(values.run[0]));
  } else result = await aggregate((values.run ?? []).map(directory => path.resolve(directory)));
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

main().catch(error => {
  // Do not echo child errors, configuration values, URLs, or command arguments.
  process.stderr.write(error.code === 'WANDB_SETUP' ? error.message + '\n'
    : 'ScummBench command failed. Check the command options, clean pinned checkout, and private run artifacts. Use --help for usage.\n');
  process.exitCode = 2;
});
