import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import path from 'node:path';
import { LineProcess, ProtocolError, TimeoutError } from './process.js';
import { digest, visibleTask, validateDecision, requireThat, root, json, validate, loadTask } from './contracts.js';
import { ScummWebBackend, gradeReceipt, gitRevision } from './backend.js';
import { requestResultsPublication } from './results-publication.js';
import { loadWandb } from './wandb.js';

class Outcome extends Error {
  constructor(status, reason) { super(reason); this.status = status; this.reason = reason; }
}
export function validateAgent(config) {
  requireThat(config && typeof config === 'object' && Object.keys(config).every(key => ['command', 'args', 'cwd', 'label'].includes(key)), 'Unknown agent configuration field');
  requireThat(typeof config.command === 'string' && config.command.length > 0 && Array.isArray(config.args)
    && config.args.every(arg => typeof arg === 'string'), 'Agent requires command and string args');
  requireThat(config.cwd === undefined || path.isAbsolute(config.cwd), 'Agent cwd must be absolute');
  requireThat(typeof config.label === 'string' && config.label.length > 0 && config.label.length <= 200, 'Agent label required');
  return config;
}

export async function archiveContent(content, directory) {
  requireThat(Array.isArray(content), 'Invalid MCP content');
  const archived = [];
  for (const block of content) {
    if (block.type !== 'image') { archived.push(block); continue; }
    requireThat(['image/jpeg', 'image/png'].includes(block.mimeType) && typeof block.data === 'string', 'Unsupported image format');
    const bytes = Buffer.from(block.data, 'base64'), hash = digest(bytes);
    const relative = `screenshots/${hash}.${block.mimeType === 'image/png' ? 'png' : 'jpg'}`;
    try { await writeFile(path.join(directory, relative), bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    archived.push({ type: 'image', mimeType: block.mimeType, path: relative, sha256: hash });
  }
  return archived;
}

export async function runAttempt({ loadedTask, backendConfig, provenance, agentConfig, output, reporting,
  loadReporting = loadWandb,
  createBackend = (config, directory, task) => new ScummWebBackend(config, directory, task) }) {
  const { task, sha256: taskHash } = loadedTask;
  validateAgent(agentConfig);
  if (reporting === undefined) reporting = await loadReporting(process.env.SCUMMBENCH_WANDB_CONFIG);
  if (reporting === false) reporting = undefined;
  const directory = path.resolve(output);
  await mkdir(directory, { mode: 0o700 }); // Never reuse/overwrite any existing run.
  await mkdir(path.join(directory, 'screenshots'), { mode: 0o700 });
  const write = (file, value) => writeFile(path.join(directory, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await write('task.json', task);
  await writeFile(path.join(directory, 'task-source.json'), loadedTask.source, { flag: 'wx', mode: 0o600 });
  await write('player-task.json', visibleTask(task));
  await write('backend-provenance.json', provenance);
  const stream = createWriteStream(path.join(directory, 'trajectory.jsonl'), { flags: 'wx', mode: 0o600 });
  let streamError;
  stream.on('error', error => { streamError = error; });
  await once(stream, 'open');
  const record = async event => {
    if (streamError) throw streamError;
    if (!stream.write(JSON.stringify({ timestamp: new Date().toISOString(), ...event }) + '\n')) await once(stream, 'drain');
    if (event.type !== 'result') await publisher?.log({ elapsed_ms: performance.now() - started, usage });
  };
  const startedAt = new Date().toISOString(), started = performance.now(), runId = randomUUID();
  const usage = { decisions: 0, submitted_actions: 0, action_sequences: 0, observations: 0,
    requested_wait_ticks: 0, requested_wait_ms: 0 };
  const publisher = reporting?.({ directory, runId });
  const sourceRevision = publisher ? gitRevision(root) : undefined;
  await publisher?.start({ kind: 'fixed_task', suite: task.suite, task_id: task.id, task_sha256: taskHash,
    game: task.game, track: task.track, category: task.category, agent_label: agentConfig.label,
    agent_config_sha256: digest(JSON.stringify(agentConfig)), scummbench_commit: sourceRevision?.commit_id,
    scummbench_dirty: sourceRevision?.dirty, backend_commit: provenance.commit_id, backend_dirty: false });
  await publisher?.log({ elapsed_ms: 0, usage, status: 'in_progress' });
  let backend, player, result, poll, deadlineTimer, startupTimer, playPromise, deadlineAt = Infinity;
  let finishing = false, active = false, polling = false;
  let settleTerminal, rejectTerminal;
  const terminal = new Promise((resolve, reject) => { settleTerminal = resolve; rejectTerminal = reject; });
  const interrupt = () => rejectTerminal(new Outcome('failure', 'operator_interrupted'));
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  // Attached before polling starts, so an early native terminal never becomes an
  // unhandled rejection while startup RPC is completing.
  terminal.catch(() => {});
  const readTerminal = async () => {
    if (!backend || finishing) return;
    const receipt = await backend.receipt();
    if (!receipt) return;
    if (!receipt.success) throw new Outcome('infrastructure_error', 'native_evaluator_failed');
    gradeReceipt(receipt, task, backend);
    if (!active) throw new Outcome('infrastructure_error', 'starting_state_already_satisfies_goal');
    // Native detection, not a later filesystem polling time, determines whether
    // the wall deadline was met. Host and native timestamps are both preserved.
    if (Date.parse(receipt.detected_at) > deadlineAt) throw new Outcome('budget_exhausted', 'wall_time');
    return receipt;
  };
  try {
    backend = createBackend(backendConfig, directory, task);
    const deadline = new Promise((_, reject) => {
      deadlineTimer = setTimeout(() => reject(new Outcome('budget_exhausted', 'wall_time')), task.budgets.wall_ms);
    });
    poll = setInterval(() => {
      if (polling || finishing) return;
      polling = true;
      readTerminal().then(receipt => { if (receipt) settleTerminal(receipt); }).catch(rejectTerminal).finally(() => { polling = false; });
    }, 50);
    const play = async () => {
      const ensureRunning = () => { if (finishing) throw new Error('Attempt ended'); };
      await backend.connect();
      ensureRunning();
      await record({ type: 'backend', source_revision: backend.revision, handshake: backend.handshake, tools: backend.tools });
      await backend.start(task);
      ensureRunning();
      clearTimeout(startupTimer);
      if (await backend.receipt()) throw new Outcome('infrastructure_error', 'starting_state_already_satisfies_goal');
      ensureRunning();
      active = true;
      deadlineAt = Date.parse(startedAt) + task.budgets.wall_ms;
      await record({ type: 'session', session_id: backend.sessionId, game: task.game });
      ensureRunning();
      player = new LineProcess(agentConfig.command, agentConfig.args, { cwd: agentConfig.cwd, maxBytes: 1024 * 1024, maxQueue: 1 });
      let observation = backend.initialObservation ?? await backend.observe();
      for (;;) {
        ensureRunning();
        if (observation.isError) throw new Outcome('infrastructure_error', 'observation_failed');
        usage.observations++;
        const content = await archiveContent(observation.content, directory);
        await record({ type: 'observation', content });
        const message = { schema_version: 1, type: usage.decisions === 0 ? 'start' : 'observation',
          ...(usage.decisions === 0 && { task: visibleTask(task) }), content: observation.content,
          remaining: { decisions: task.budgets.decisions - usage.decisions, primitive_actions: task.budgets.primitive_actions - usage.submitted_actions } };
        if (usage.decisions >= task.budgets.decisions) throw new Outcome('budget_exhausted', 'decisions');
        player.send(message);
        let decision;
        try {
          const line = await player.line(task.budgets.response_ms);
          ensureRunning();
          requireThat(!player.lines.length, 'Agent sent unsolicited decisions');
          decision = validateDecision(JSON.parse(line), task);
        } catch (error) {
          if (error instanceof TimeoutError) throw new Outcome('budget_exhausted', 'agent_response_time');
          throw new Outcome('invalid_agent', error instanceof ProtocolError ? 'agent_protocol' : 'invalid_decision_or_process_exit');
        }
        usage.decisions++;
        await record({ type: 'decision', decision });
        if (decision.type === 'finish') throw new Outcome('failure', 'agent_stopped');
        if (decision.type === 'act') {
          if (usage.submitted_actions + decision.actions.length > task.budgets.primitive_actions) throw new Outcome('budget_exhausted', 'primitive_actions');
          usage.submitted_actions += decision.actions.length;
          usage.action_sequences++;
          for (const action of decision.actions) {
            if (action.type === 'wait_ticks' && Number.isSafeInteger(action.ticks)) usage.requested_wait_ticks += action.ticks;
            if (action.type === 'wait' && Number.isSafeInteger(action.ms)) usage.requested_wait_ms += action.ms;
          }
          const requestId = randomUUID();
          await record({ type: 'action_submission', request_id: requestId, actions: decision.actions });
          ensureRunning();
          const response = await backend.act(decision.actions, requestId);
          ensureRunning();
          await record({ type: 'action_receipt', is_error: Boolean(response.isError), content: await archiveContent(response.content, directory) });
          const receipt = await readTerminal();
          if (receipt) return receipt;
          if (response.isError) throw new Outcome('invalid_agent', 'action_rejected_or_failed');
        }
        observation = await backend.observe();
      }
    };
    try {
      playPromise = play();
      const startup = new Promise((_, reject) => {
        startupTimer = setTimeout(() => reject(new Outcome('infrastructure_error', 'startup_timeout')), task.budgets.startup_ms);
      });
      const receipt = await Promise.race([playPromise, terminal, deadline, startup]);
      result = { status: 'success', reason: 'native_stop_condition', native_receipt: receipt };
    } catch (error) {
      // A terminal may close MCP during a final action. Recover that receipt,
      // never retry the input and accidentally perform it twice.
      let receipt;
      try { receipt = await readTerminal(); } catch { /* Original failure remains unless grading succeeds. */ }
      result = receipt ? { status: 'success', reason: 'native_stop_condition', native_receipt: receipt }
        : { status: error instanceof Outcome ? error.status : 'infrastructure_error',
          reason: error instanceof Outcome ? error.reason : 'backend_or_artifact_error' };
    }
  } catch {
    result = { status: 'infrastructure_error', reason: 'backend_start_failed' };
  } finally {
    finishing = true;
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    clearInterval(poll); clearTimeout(deadlineTimer); clearTimeout(startupTimer);
    // Close the player first so a late decision cannot submit further input.
    for (const process of [player, backend]) {
      try { await process?.close(); } catch { result = { status: 'infrastructure_error', reason: 'process_cleanup_failed' }; }
    }
    await playPromise?.catch(() => {});
  }
  const manifest = { schema_version: 1, run_id: runId, suite: task.suite, task_id: task.id,
    task_sha256: taskHash, game: task.game, track: task.track, category: task.category, session_id: backend?.sessionId ?? null,
    official_eligible: false, eligibility_reasons: ['Development suite', 'Agent has no enforced OS/network sandbox',
      'Served runtime/assets and reset determinism are not verified'],
    started_at: startedAt, finished_at: new Date().toISOString(), elapsed_ms: Math.round(performance.now() - started),
    agent: { label: agentConfig.label, config_sha256: digest(JSON.stringify(agentConfig)), provenance: 'operator-declared', model: null, seed: null },
    scummbench: gitRevision(root), backend: provenance, budgets: task.budgets, usage,
    model_usage: { input_tokens: null, cached_input_tokens: null, output_tokens: null, api_equivalent_usd: null,
      reason: 'The v1 agent protocol does not collect provider usage; never inferred from screenshots or decisions.' },
    ...result };
  await record({ type: 'result', result: manifest });
  await new Promise((resolve, reject) => { stream.once('error', reject); stream.end(resolve); });
  await write('result.json', manifest);
  // Network draining happens after the authoritative result and measured run
  // duration are fixed. Publication failure cannot change the grade.
  await publisher?.finish({ elapsed_ms: manifest.elapsed_ms, usage, status: manifest.status, reason: manifest.reason });
  await requestResultsPublication();
  return { directory, result: manifest };
}

export async function verifyRun(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, 'result.json'), 'utf8'));
  validate(await json(new URL('../schemas/result.schema.json', import.meta.url)), manifest);
  const { task } = await loadTask(path.join(directory, 'task.json'));
  // task.json is normalized for portability; compare against the recorded source
  // hash through its separate exact-byte copy, written by the CLI.
  const raw = await readFile(path.join(directory, 'task-source.json'));
  requireThat(digest(raw) === manifest.task_sha256 && JSON.stringify(JSON.parse(raw)) === JSON.stringify(task), 'Task checksum/content mismatch');
  const events = (await readFile(path.join(directory, 'trajectory.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  requireThat(events.length > 0 && JSON.stringify(events.at(-1).result) === JSON.stringify(manifest), 'Result does not match trajectory');
  requireThat(task.id === manifest.task_id && task.suite === manifest.suite && JSON.stringify(task.budgets) === JSON.stringify(manifest.budgets), 'Task/result identity mismatch');
  const decisions = events.filter(event => event.type === 'decision');
  const submissions = events.filter(event => event.type === 'action_submission');
  const batches = events.filter(event => event.type === 'action_receipt');
  requireThat(decisions.length === manifest.usage.decisions && batches.length <= manifest.usage.action_sequences, 'Usage does not match trajectory');
  requireThat(submissions.length === manifest.usage.action_sequences
    && submissions.reduce((count, event) => count + event.actions.length, 0) === manifest.usage.submitted_actions, 'Submitted action count mismatch');
  requireThat(manifest.usage.decisions <= task.budgets.decisions && manifest.usage.submitted_actions <= task.budgets.primitive_actions, 'Usage exceeds allowed budgets');
  for (const event of events) for (const block of event.content ?? []) if (block.type === 'image') {
    requireThat(/^screenshots\/[a-f0-9]{64}\.(jpg|png)$/.test(block.path), 'Invalid screenshot reference');
    requireThat(digest(await readFile(path.join(directory, block.path))) === block.sha256, 'Screenshot checksum mismatch');
  }
  if (manifest.status === 'success') {
    const receipt = JSON.parse(await readFile(path.join(directory, 'evaluator-result.json'), 'utf8'));
    requireThat(JSON.stringify(receipt) === JSON.stringify(manifest.native_receipt), 'Native receipt mismatch');
    requireThat(events.some(event => event.type === 'session' && event.session_id === manifest.session_id), 'Missing independent session record');
    requireThat(events.some(event => event.type === 'backend' && event.source_revision?.commit_id === manifest.backend.commit_id && event.source_revision?.dirty === false), 'Missing backend revision record');
    gradeReceipt(receipt, task, { sessionId: manifest.session_id, config: { scummweb_revision: manifest.backend.commit_id } });
    requireThat(Date.parse(receipt.detected_at) >= Date.parse(manifest.started_at)
      && Date.parse(receipt.detected_at) <= Date.parse(manifest.started_at) + task.budgets.wall_ms, 'Receipt outside wall budget');
    const nativeEvents = (await readFile(path.join(directory, 'evaluation.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    const { screenshot, ...withoutScreenshot } = receipt;
    requireThat(nativeEvents.some(event => JSON.stringify(event) === JSON.stringify(withoutScreenshot)), 'Receipt not found in native event log');
  }
  requireThat(manifest.official_eligible === false, 'v1 cannot certify official results');
  return manifest;
}
