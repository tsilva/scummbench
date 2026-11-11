# Live W&B reporting

Fixed-task attempts and interactive MCP sessions can publish scalar metrics to
Weights & Biases while they run. Reporting is opt-in and requires no SDK or new
package dependency. The local ScummBench journals and results remain authoritative.

## Configuration

Create a private configuration such as `local/wandb.json`, based on
[`examples/wandb.json`](../examples/wandb.json):

```json
{
  "entity": "your-entity",
  "project": "scummbench-{gameid}",
  "api_key_placeholder": "scummbench_wandb_placeholder"
}
```

`entity` is the destination user/team. A literal project name is supported;
`{gameid}` expands to the canonical ScummVM game ID, for example `scummbench-queen`
for Flight of the Amazon Queen. Catalog slugs and edition-specific launch targets
remain separate: `the-secret-of-monkey-island-demo` maps to `monkey`, and
`nippon-safes-inc` maps to `nippon`. Unrecognized games fail publication with
`unknown_scummvm_game_id` rather than deriving a project from a title or slug.
The current mapping covers ScummWEB backbone's eight bundled catalog entries; imported
games need a verified mapping before using a project template.
Each ScummBench run ID identifies one
W&B run. Fixed-task attempts and interactive sessions have distinct `kind` values.

This file contains destination metadata and a non-secret placeholder, never an
API key. It does not provision credentials or grant service access. Online use
requires the repository's reviewed credential-proxy route for
`https://api.wandb.ai`, covering the GraphQL and file-stream endpoints.

This checkout uses a dedicated Agent Vault profile. Its binding is documented in
`AGENTS.md` and the owner-only `local/wandb-agent-vault.json`; its dispatcher is
`scripts/wandb-agent-vault.py`. The maintainer explicitly authorized this W&B
profile without an additional OS sandbox. Agent Vault brokers credentials but
does not isolate the client or prevent a full-access process from accessing
same-user resources. This exception does not change other repository/service
policies or shared launcher defaults.

The host launcher pins the Infisical instance, dedicated access bundle, proxy
address and CA fingerprint, supplies only the expected placeholder and
process-local CA trust, and creates a 30-minute session revoked on exit. It
starts with a clean environment and disables skill installation and persistent
CA trust changes. The source key is copied to Agent Vault only by a separate
trusted administrative refresh, never during ordinary startup. Missing bindings
or rejected credentials fail explicitly; do not borrow another project's route,
read cached keys, or inject a real key into a client.

Check the configured route without publishing a run:

```sh
python3 scripts/wandb-agent-vault.py --check
```

The dedicated service allows POST to `api.wandb.ai:443` at `/graphql` and
`/files/tsilva/scummbench-queen`. The GraphQL path itself does not constrain the
query's operation or project; the client must still use the approved payloads.
Other game projects need an explicitly reviewed service-policy update.

The publisher requires `WANDB_API_KEY` to equal `api_key_placeholder` and an
`HTTPS_PROXY` (or `https_proxy`). It uses a private Node HTTPS agent, ignores
`NO_PROXY`, preserves certificate verification and rejects redirects. Node
22.21+, 24.5+, or 25+ is required for this optional proxy transport. Older Node
22 releases can still run ScummBench with reporting disabled. The reporter does
not itself verify proxy service permissions. Test any new route with fake
credentials, then a bounded authenticated check before use.
Obtain any required outbound-content approval before publishing real runs.

After authentication succeeds and any required publication approval is obtained,
opt in for a fixed-task attempt through the reviewed launcher:

```sh
python3 scripts/wandb-agent-vault.py scummbench run --backend local/backend.json \
  --agent examples/observe-agent.json --out runs/observer-001 \
  --wandb local/wandb.json
```

For interactive play, pass `scummbench mcp --wandb /absolute/path/to/wandb.json`
through the same dispatcher, with `--wandb` before the backend argument separator
`--`. Alternatively set
`SCUMMBENCH_WANDB_CONFIG` to an absolute configuration path in the launcher that
starts ScummBench. The CLI flag takes precedence over the environment variable.
W&B settings and credentials are not forwarded to the game or player processes.
The `--import-only` path does not publish a run. Existing processes must finish
normally; configuration applies on the next invocation.

Invalid configuration, missing placeholders or missing proxy settings fail before
gameplay starts. There is no automatic login, credential-cache lookup, direct
network fallback or billing action.

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

Enabled runs contain two additional private files:

- `wandb-events.jsonl`: the allowlisted start metadata and history points.
- `wandb.json`: destination, run URL, uploaded history-row count and publication
  state (`pending`, `running`, `synced` or `failed`) with a sanitized failure reason.

The reporter uses W&B's run-creation GraphQL and history/summary file-stream wire
protocol, as implemented in the upstream
[JavaScript client](https://github.com/wandb/wandb-js/tree/main/src/internal).
This is a small protocol adapter, not full SDK compatibility; remote compatibility
requires a live check against the configured service.

Network requests have a 1.5-second deadline and at most one retry of the same
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
