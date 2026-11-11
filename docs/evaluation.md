# Evaluation protocol: development v1

## Task

`queen.hotel-laundry.v1` starts Flight of the Amazon Queen in a fresh profile
using ScummWEB's backbone catalog launch, including its existing skip-intro behavior.
It asks the player to reach the opening hotel's laundry room downstairs. The
native success condition requires Queen engine identity, room 71, and room-ready
state. The condition was originally derived from AgentSCUMM's evaluator example;
this repository has not independently validated every game edition.

Room-ready means a room update without a pending transition/cutaway. It does not
establish that all dialogue is finished or that the whole hotel has been escaped.
This task is not full-game completion. Additional checkpoints and full-game rules
must be separately authored, versioned, and validated before inclusion.

Task schema validation and Queen-specific semantic checks run before startup.
The exact task source bytes are hashed. Changing a released task's meaning must
create a new version; the development suite is not frozen yet.

## Policy and budgets

The only current track is closed-book: no external browsing, walkthroughs, prior
run memories, human interventions, or external tools. The protocol omits grading
state, but the process host does not enforce OS or network isolation. Such runs
are always marked development-only. Pretrained knowledge of the game can still
affect results; these tasks do not establish contamination-free reasoning.

| Budget | Default |
| --- | ---: |
| Agent decisions | 600 |
| Submitted action records | 3000 |
| Total wall time, including startup | 30 minutes |
| Game startup | 2 minutes |
| Agent response per observation | 2 minutes |

Every `act`, `observe`, or `finish` response consumes one decision. Every record
in a submitted action batch consumes one primitive-action slot, including waits
and screenshots. A double-click record counts as one submitted action record,
not two low-level hardware events. Budgets are checked before dispatch; counts
describe submitted records, not confirmed delivered inputs. The native receipt
and action trajectory retain the distinction when a batch stops partway through.

Requested wait milliseconds and ticks are summed separately. They are not a
measurement of total game time. Wall time is hardware- and latency-sensitive.
Total reported elapsed time also includes bounded process cleanup.

## Grading and outcomes

Success requires a native receipt with the expected game, session, clean server
commit, exact configured predicate, matching variables, and valid event times.
The runner polls receipts independently of model responses and recovers success
when the evaluator closes MCP during the final action. Wall-deadline decisions
use the receipt's host detection timestamp; native event time is also preserved.

| Status | Meaning |
| --- | --- |
| `success` | Valid independent native condition receipt |
| `failure` | Agent stops before verified success |
| `budget_exhausted` | Decision, submitted-action, response, or wall budget reached |
| `invalid_agent` | Malformed decision, prohibited action, process exit, or rejected/failed action |
| `infrastructure_error` | Backend, evaluator, artifact, source, or cleanup failure |

The initial protocol conservatively ends on failed action calls rather than
guessing whether input was delivered. Some such failures may be infrastructure
issues; inspect the preserved native records before interpreting comparisons.

## Artifacts and verification

Each exclusive `runs/<attempt>/` directory contains:

- `task-source.json`: exact task bytes, with SHA-256 in the result.
- `task.json` and `player-task.json`: full and player-visible contracts.
- `backend-provenance.json`: source pin, base URL, declared runtime revision, and
  locally checked asset hashes, with deployment verification explicitly false.
- `trajectory.jsonl`: backend inventory, observations, decisions, action receipts,
  timestamps, image references, and final result.
- `screenshots/`: content-addressed screenshot files.
- `evaluation.jsonl` and `evaluator-result.json`: native evidence, when generated.
- `result.json`: outcome, counters, budgets, eligibility limitations, and usage.
- `runtime/`: attempt-owned browser profile and native logs; private working data.

`verify` checks task content and hashes, screenshot references, trajectory/result
agreement, and native success receipt agreement. It is an internal-consistency
check, not cryptographic attestation, historical game replay, or proof that an
agent complied with the policy. Run artifacts can contain personal agent output
and are Git-ignored. Review and sanitize them before sharing.

Model identifiers, seeds, tokens, and cost are unknown in protocol v1. The agent
label is operator-declared, and its configuration is hashed. Unknown usage and
cost stay null with a reason. The result records ScummBench's actual checkout
revision and dirtiness; an unborn repository has an unknown commit.

## Aggregation

```sh
node src/cli.js aggregate --run runs/attempt-001 --run runs/attempt-002
```

Aggregation verifies each run and rejects duplicate run IDs. It groups by task
bytes, agent label/configuration hash, backend provenance, ScummBench revision,
track, and budgets. Different groups stay separate. The output retains every
outcome count, infrastructure failures, success rate over all attempts, success
rate over non-infrastructure attempts, and a 95% Wilson interval for the latter.
Intervals assume independent attempts; repeat runs do not prove independence.
No overall cross-game score or leaderboard is produced yet.

## Before an official release

Required work includes verified game editions/assets and immutable runtime
builds; empirically repeatable clean resets; independent positive and negative
live grading tests; enforced player/evaluator isolation; frozen tasks and agent
interfaces; exact model/harness/seed/usage capture; declared retry and interruption
policy; multiple games and task horizons; human and simple-agent baselines;
and repeated model attempts with suitable statistical reporting.

Keep development and held-out evaluation data separate. Existing walkthrough-
assisted playthroughs can inform development and engine validation, but should
not be presented as closed-book benchmark results. Familiar games require an
explicit contamination limitation even when evaluation tasks are held out.

## Registered playthroughs

AgentSCUMM's finalizer exports and verifies its conversation archive, then calls
`scummbench register-archive --archive PATH --source-repo CHECKOUT`. ScummBench
re-verifies the source archive, owns the registration lock and private receipts,
and updates its own `BENCHMARKS.md` idempotently by trajectory checksum. ScummBench owns the portable verifier and renderer and never imports an agent
checkout during registration. Missing ScummBench fails without a local registration
fallback. Archives and historical AgentSCUMM results are not migrated.

Registered interactive playthroughs retain declared assistance and are always
development evidence. Registration neither grants official eligibility nor
publishes a Git commit. Known token costs retain their archived rates and
processing-tier assumptions; unknown costs stay unknown. Source transcripts and
private paths stay out of the public result table.

The gateway records MCP observations and inputs under `runs/interactive/` by
default. `SCUMMBENCH_RUNS_DIR` selects an alternative private evidence directory,
including test-owned temporary storage. These journals are not conversation
archives and never infer a game victory from a session closing. The normal play
skill still requires ending evidence and deferred archive verification.
