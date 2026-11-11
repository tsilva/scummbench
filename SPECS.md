# ScummBench commitments

ScummBench evaluates agents playing adventure games through AgentSCUMM and
ScummWEB. The first game is Flight of the Amazon Queen. AgentBench is excluded.
Any agent harness may participate through the documented interface.

All new AgentSCUMM gameplay uses ScummBench exclusively. The public AgentSCUMM
launcher delegates to the ScummBench MCP gateway, with no direct backend fallback.
Existing live sessions are preserved; new connections must expose mediation
provenance. ScummBench owns future benchmark registration and its canonical
BENCHMARKS.md. Existing AgentSCUMM records and conversation archives stay intact.

The global `scummbench` command supports `uv tool install --editable` from this
checkout. It runs the live repository implementation, so subsequent source and
task edits take effect on the next invocation without reinstalling. Already
running processes are not hot-reloaded. Node.js 22+ remains required.

- Task definitions version the starting state, visible objective, permitted
  inputs, budgets, and engine-state success condition.
- The evaluator grades independently of player claims. AgentSCUMM receipts and
  native telemetry establish success; screenshots support auditing.
- Each attempt owns a fresh process and profile. Previous saves and memories are
  not reused. ScummWEB assets and runtime stay outside this repository.
- Closed-book development runs disclose their isolation limitations. Official
  evaluation requires enforced access boundaries, verified runtime/assets and
  resets, and a frozen protocol; these gates cannot be inferred from a clean Git
  revision or successful launch.
- Results preserve every outcome, configuration and source provenance, budget
  use, and available usage telemetry. Unknown values remain null with reasons.
- Short tasks and full-game completion are separate evaluation categories.
  Existing assisted playthroughs are development evidence, not controlled scores.

The initial release is a development implementation. Its included task reaches
the opening hotel's laundry room from a fresh launch. Full-game evaluation,
checkpoint tasks, deterministic stepping, enforced isolation, and statistically
powered model comparisons require later validation.
