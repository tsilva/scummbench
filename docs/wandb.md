# Live W&B reporting

Every new fixed-task attempt and interactive MCP session automatically publishes
scalar metrics to **`tsilva/scummbench-<canonical ScummVM gameid>`** while it runs.
Flight of the Amazon Queen uses `tsilva/scummbench-queen`. The configured publishing connection supplies authentication. Local ScummBench journals
and grades remain authoritative.

## First use

Run the usual command:

```sh
scummbench run --backend local/backend.json \
  --agent examples/observe-agent.json --out runs/observer-001
```

`scummbench mcp` also enables reporting by default, including when called by
AgentSCUMM's public launcher. Each newly started game session gets its own W&B
run, identified by the ScummBench run ID. Fixed tasks and interactive sessions
have distinct `kind` values. The import-only path does not publish a run.
Configuration takes effect on the next invocation; running processes keep their
loaded code.

For an explicitly offline run, use `--no-wandb`:

```sh
scummbench run --no-wandb --backend local/backend.json \
  --agent examples/observe-agent.json --out runs/offline-observer-001
scummbench mcp --no-wandb --scummweb /absolute/path/to/scummweb -- [backbone arguments]
```

MCP's W&B options belong before the `--` separator. Offline mode needs no W&B
binding and overrides `SCUMMBENCH_WANDB_CONFIG`. Combining `--wandb` with
`--no-wandb` is rejected.

## Worker contract

The normal path uses the supplied publishing environment. An explicit external
worker command may provide stdio JSON-RPC instead; its interface is defined in
`src/wandb-broker.js`. No checkout metadata discovers or starts credential tools.
Each run owns its worker, preserves its run ID/history offsets across the existing
20-minute restart cadence, and closes it on exit. External execution owns scoped
session creation and revocation. Publishing settings never enter player/game
processes. Missing access fails before gameplay; `--no-wandb` is offline.

The dedicated service permits POST only to `api.wandb.ai:443`, at `/graphql` and
eight explicit `/files/tsilva/scummbench-<id>` prefixes:

| ScummWEB catalog entry | Canonical ScummVM game ID |
| --- | --- |
| Beneath a Steel Sky | `sky` |
| Broken Sword 2.5 | `sword25` |
| Drascula | `drascula` |
| DreamWeb | `dreamweb` |
| Flight of the Amazon Queen | `queen` |
| Lure of the Temptress | `lure` |
| Nippon Safes Inc. | `nippon` |
| The Secret of Monkey Island demo | `monkey` |

The GraphQL path does not enforce operation or project permissions. The worker
separately validates the fixed run-creation mutation, entity, known project, run
ID and scalar payload allowlist. Adding a game requires a verified mapping and
reviewed service scope. Unknown games fail publication with
`unknown_scummvm_game_id`; project names are never guessed from titles or slugs.
Edition-specific launch targets such as `dreamweb-cd` remain separate from game IDs.

## Configuration overrides

`--wandb FILE` or `SCUMMBENCH_WANDB_CONFIG` can select a destination configuration;
the CLI flag wins. The built-in default is equivalent to:

```json
{
  "entity": "tsilva",
  "project": "scummbench-{gameid}",
  "api_key_placeholder": "scummbench_wandb_placeholder"
}
```

`{gameid}` expands using the verified mapping. A literal project name is also
supported, subject to the selected route's permissions and matching game metadata.
The automatic worker accepts only the dedicated `tsilva/scummbench-<id>` scope.
An override does not expand publishing permissions. Configurations contain
metadata and a non-secret placeholder, never an API key.

If already inside a matching reviewed proxy session, the publisher
uses that session directly. Its `WANDB_API_KEY` must equal the configured
placeholder and `HTTPS_PROXY` (or `https_proxy`) must be present. The private Node
HTTPS agent ignores `NO_PROXY`, verifies TLS, and refuses redirects. The proxy
transport requires Node 22.21+, 24.5+, or 25+; earlier Node 22 versions can run
with `--no-wandb`. No automatic login, credential-cache lookup or direct-network
fallback is performed. Test newly provisioned routes with fake credentials and
then a bounded authenticated check before use.

## Published data

The payload is deliberately limited to:

- Run ID and kind, game catalog slug, canonical `scummvm_game_id` where known,
  suite/task ID and task hash, track and category where known.
- Operator-declared agent label and configuration hash for fixed tasks.
- Available ScummBench/backend commit IDs and checkout dirtiness; `official_eligible: false`.
- History step, timestamp and elapsed milliseconds/runtime at recorded events.
- Fixed-task decision, submitted-action, action-sequence, observation and requested-wait counters.
- Interactive tool-call, tool-error, observation-request and submitted-action counters.
- Final status and reason; fixed-task success is 1 for native verified success and
  0 for other final outcomes. Success remains null while a fixed task is running.

Interactive sessions finish as `stopped` and never receive a success metric.
Interactive counters describe requests, including failed ones, rather than
confirmed game effects. Model identity, token counts and cost are not inferred.
Screenshots, commands, local paths, backend URLs, prompts, puzzle text, action
contents, evaluator predicates, native variables and receipts are never uploaded.

Updates are batched about once per second while events arrive. There is no
heartbeat during idle periods. Dashboard visibility also depends on W&B ingestion
and network latency; no exact delivery latency is guaranteed. Local elapsed time
and final grading are fixed before network shutdown draining.

## Delivery and recovery

Online runs contain two additional private files:

- `wandb-events.jsonl`: the allowlisted start metadata and history points.
- `wandb.json`: destination, run URL, uploaded history-row count and publication
  state (`pending`, `running`, `synced` or `failed`) with a sanitized failure reason.

The reporter uses W&B's run-creation GraphQL and history/summary file-stream wire
protocol, as implemented in the upstream
[JavaScript client](https://github.com/wandb/wandb-js/tree/main/src/internal).
This is a small protocol adapter, not full SDK compatibility; remote compatibility
requires a live check against the configured service.

Worker startup has a separate 15-second allowance and runs outside the gameplay
hot path. Network requests have a 1.5-second deadline and at most one retry of the same
payload/offset. Authentication and other non-transient HTTP failures are not
retried. Network memory holds at most 256 pending points; under backpressure the
newest pending point is replaced while the journal keeps every recorded point.
The final summary retains the latest counters and outcome. History offsets remain
contiguous even when history steps skip coalesced points.

Shutdown draining is limited to five seconds after local finalization. An upload
failure stops online delivery for that run, preserves subsequent points locally,
and never changes its grade. `synced` means the service acknowledged all queued
rows and completion, not that every original point survived coalescing or that
the dashboard was independently read back. A crash or forced kill can leave a
pending/running receipt and an unfinished remote run. Automatic replay/resume and
historical archive backfill are not implemented. Inspect the local journal and
receipt before retrying manually; never reuse an attempt directory.
