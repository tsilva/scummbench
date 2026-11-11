# ScummBench commitments

ScummBench evaluates agents playing adventure games through ScummWEB's backbone. The first game is Flight of the Amazon Queen. AgentBench is excluded.
Any agent harness may participate through the documented interface.

All new AgentSCUMM gameplay uses ScummBench exclusively. The public AgentSCUMM
launcher delegates to the ScummBench MCP gateway, with no direct backend fallback.
The dependency direction is AgentSCUMM → ScummBench MCP → ScummWEB backbone.
ScummBench never launches or imports AgentSCUMM code, including for archive
registration. ScummWEB owns controls, captures and mechanical telemetry;
ScummBench owns evaluation policy and result verification.
Existing live sessions are preserved; new connections must expose mediation
provenance. ScummBench owns all benchmark registration and its canonical BENCHMARKS.md,
including migrated historical AgentSCUMM records and verified private archive
copies. Original conversation archives remain intact. Every new AgentSCUMM
playthrough records its agent package version and clean starting commit, including
resume revisions, separately from ScummWEB and benchmark contract versions.

The global `scummbench` command supports `uv tool install --editable` from this
checkout. It runs the live repository implementation, so subsequent source and
task edits take effect on the next invocation without reinstalling. Already
running processes are not hot-reloaded. Node.js 22+ remains required.

- Task definitions version the starting state, visible objective, permitted
  inputs, budgets, and engine-state success condition.
- The evaluator grades independently of player claims. ScummWEB backbone receipts and
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
- Runs can opt into live W&B result reporting, with projects selected per game
  (`scummbench-<gameid>`, using canonical ScummVM game IDs, such as `queen`).
  Local evidence and grading remain authoritative;
  reporting does not expose evaluator state to players or make interactive play
  an independently graded benchmark result.

The initial release is a development implementation. Its included task reaches
the opening hotel's laundry room from a fresh launch. Full-game evaluation,
checkpoint tasks, deterministic stepping, enforced isolation, and statistically
powered model comparisons require later validation.

The results page presents one progress-versus-actions chart, with stepped lines
at verified milestones and dated individual runs. Results from different games
or benchmark versions stay separate. Verified ending evidence establishes
completion; unfinished attempts have no actions-to-finish value. Sample data is
explicitly labelled and remains separate from recorded results. See
[the results explorer](docs/results-page.md) for the display export and controls.

Recorded results refresh automatically from finished local runs and registered
archive receipts. Missing progress is reported rather than inferred. Unknown or
dirty comparison provenance isolates a run in a legacy version. Progress samples
stay private to evaluation and results; they are never added to player observations.

Verified action and native-progress measurements can be recovered from unfinished
legacy archives even when screenshots are invalid. Image gaps remain explicit;
unknown action totals remain null. Progress snapshots without verified action
alignment have no fabricated chart trajectory or actions-to-finish value.


The public explorer is served at scummbench.tsilva.eu from a verified,
public-safe registration snapshot. Its publication timestamp is explicit;
new public measurements require snapshot publication. The local feed continues
to refresh from finished private runs. Hosting never serves private artifacts.
