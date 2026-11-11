import { verifyRun } from './runner.js';
import { requireThat } from './contracts.js';

export function wilson(successes, count) {
  if (!count) return null;
  const z = 1.959963984540054, p = successes / count;
  const denominator = 1 + z * z / count;
  const middle = (p + z * z / (2 * count)) / denominator;
  const half = z * Math.sqrt(p * (1 - p) / count + z * z / (4 * count * count)) / denominator;
  return [Math.max(0, middle - half), Math.min(1, middle + half)];
}

export async function aggregate(directories) {
  requireThat(directories.length > 0, 'Select at least one run directory');
  const seen = new Set(), groups = new Map();
  for (const directory of directories) {
    const run = await verifyRun(directory);
    requireThat(!seen.has(run.run_id), 'Duplicate run ID; attempts cannot be counted twice');
    seen.add(run.run_id);
    const identity = { suite: run.suite, task_id: run.task_id, task_sha256: run.task_sha256,
      track: run.track, agent: run.agent, backend: run.backend, budgets: run.budgets, scummbench: run.scummbench };
    const key = JSON.stringify(identity);
    if (!groups.has(key)) groups.set(key, { identity, counts: {}, attempted: 0, infrastructure_errors: 0, successes: 0 });
    const group = groups.get(key);
    group.attempted++;
    group.counts[run.status] = (group.counts[run.status] ?? 0) + 1;
    group.successes += Number(run.status === 'success');
    group.infrastructure_errors += Number(run.status === 'infrastructure_error');
  }
  return { schema_version: 1, official_eligible: false,
    notes: ['Development evidence only. Separate task groups are not independent games.',
      'Wilson intervals assume independent attempts; independence is not established by this tool.',
      'Infrastructure errors are preserved and excluded only from the valid-attempt rate.'],
    groups: [...groups.values()].map(group => {
      const valid = group.attempted - group.infrastructure_errors;
      return { ...group, valid_attempts: valid,
        success_rate_all_attempts: group.successes / group.attempted,
        success_rate_valid_attempts: valid ? group.successes / valid : null,
        wilson_95_valid_attempts: wilson(group.successes, valid) };
    }) };
}
