# Results explorer

The page plots verified game progress against submitted actions. Each line is
one attempt, labelled with its date. Steps hold the previous verified high-water
progress until the next observed milestone. They do not interpolate progress or
project an unfinished attempt to completion.

```sh
pnpm dev -- --port auto
```

Open the printed results URL. The page reads the local `/api/results` feed and
refreshes every five seconds while visible. Returning to the page refreshes it
immediately. Requests have a ten-second deadline, do not overlap, and stop when
switching to sample data. An outage keeps the last successful chart visible and
marks it as retrying; an initial outage shows an error. The selected game and
benchmark version stay selected when other runs arrive.

The printed `?demo=1` URL uses entirely synthetic sample runs. It never mixes
sample and recorded data. The source control beneath the version selector
switches between them. The local feed reads private evidence; the public website
uses the separately published snapshot described below.

## Local sources

The reader discovers finished runs under the repository's ignored `runs/` and,
when configured, `SCUMMBENCH_RUNS_DIR`. It also reads canonical registration
receipts in `.internal/archive-registry/`. Alternative source directories can be
selected explicitly:

```sh
pnpm dev -- --port auto --runs /absolute/run-store --registry /absolute/receipt-store
```

`--runs` replaces the default run-store search. The server serves static assets
only from `web/`, plus the read-only JSON endpoint. Private trajectories, native
logs, screenshots, paths and evaluator predicates are never served. It binds to
loopback, rejects unrelated Host/Origin headers, and needs no service credentials
or third-party dependencies. It is a local results server, not public production
hosting. No W&B request or upload is part of this feed.

- Fixed-task attempts use ScummBench's existing offline verifier. Native progress
  samples in `evaluation.jsonl` are joined to `action_submission` timestamps.
  Task success does not imply full-game completion.
- New interactive gateway processes retain a private `progress.jsonl` projection
  when a session finishes. It is copied from that session's native ScummWEB log,
  with a checksum in the final run manifest. The projection contains timestamps,
  map revision, milestone counts, percentages and native win flags. It excludes
  native variable banks and solution labels. It does not change player MCP
  observations or launch another process.
- New archive registrations store a public-safe chart projection in their private
  canonical receipt, after ScummBench verifies the portable archive. This uses
  ScummBench-owned Python code, never an agent checkout. Existing receipts without
  a projection need normal re-registration before they can contribute a curve.

Already-running gameplay processes retain their loaded implementation. They are
not restarted or modified to add capture. Verified portable archives without milestone evidence show submitted action totals
with progress and actions-to-finish explicitly unavailable. They have no chart line.
A declared completed status never supplies a fabricated 100% endpoint. The reader never repairs or rewrites a source run.

About reports how many sources were discovered, charted, still running, missing
progress or invalid. One bad or partially written run does not hide other valid
runs. Native progress changes across map revisions within a run, incompatible
counts, mismatched sessions and unverified endings are withheld. No percentage
is inferred from an agent's completion claim or a conversation ending.

## Benchmark identity

Each version has a content-derived identity over the applicable task and budgets,
starting state, track, observation/control contract, ScummBench and mechanics
revisions, declared runtime and verified edition, progress-map revision and action
and completion definitions. Component changes stay separate. Player labels and
model configuration are not used to merge incompatible benchmark conditions.

Missing edition/runtime provenance, unknown starting conditions or a dirty/unknown
implementation produces a **Legacy** version isolated to that run. Matching HEAD
commits or progress-map hashes alone do not establish comparability. Legacy
archives are also isolated. Version IDs are stable for the recorded evidence;
there is no sequential version number to renumber when a late result arrives.

Only the selected game and version are drawn. Switching versions replaces every
line, label, detail and accessible table. New incompatible versions appear in the
selector without switching away from the version being inspected. No cross-version
trend, compatibility inference or retrospective rescoring is performed.

## Metric semantics

Actions count submitted records, including waits and explicit screenshots under
the recorded action definition. Entire batches are charged at their submission
timestamp. These timestamps are not exact low-level input-delivery times.

100% requires a native win flag. A completed short task or a rounded 100%
checklist cannot establish that the game ended. **Actions to finish** uses the
submission count at the first verified native ending, so later inputs do not
inflate it. The recorded total actions and original outcome remain available in
run details. Unfinished attempts have no actions-to-finish value. Archive curves
without a timestamped native ending cannot supply a completion cost.

Calendar dates identify runs; the horizontal axis always measures actions.
Individual trajectories do not establish completion reliability, statistical
improvement or official benchmark eligibility. A smaller completion cost applies
to that successful attempt; it is not a success-rate estimate.

## Display schema and interaction

The API uses display schema version 1 with `games`, each containing `benchmarks`
and their individual `runs`. Benchmark contracts expose the game edition, start,
track, progress revision, action definition, completion rule and toolset revision.
Available component commit IDs appear in run details. The response also includes
safe diagnostic counts and a deterministic `revision`; unchanged responses do not
rebuild the chart or disturb interaction.

Each run has an ID, label, date, total `actions`, `outcome`, `completion_verified`
and ordered `points` of `{ actions, progress }`. Optional `completion_actions`
records the native ending boundary separately from total actions. `finished_at`
retains the UTC cutoff for ordering attempts on the same day. Optional
`recorded_outcome` preserves the source result independently of native game win.

Samples must have nondecreasing action counts and verified high-water progress,
within the attempt's totals and time window. No zero baseline is invented if one
was not recorded. An unfinished curve extends its last verified high-water plateau
to its known action total. Completed curves stop at their native ending.

Point at a milestone to inspect its action count and progress. Click a milestone
or dated endpoint to inspect the run and version contract. Endpoint buttons are
keyboard-accessible. A collapsible chart-data table provides every plotted sample.
The page supports narrow viewports and reduced motion. Native records and local
checksums support auditing; they are not cryptographic attestation against a
hostile same-user process.

Historical archives are retained in ignored `runs/archives/` by canonical
registration, with their verified projections in private registry receipts. Each
is isolated as a legacy benchmark version because frozen comparison conditions
are missing. Agent package version and commit appear in run details when recorded;
they do not determine the benchmark version. Re-registering the same unchanged
archive is idempotent.

Summary-only legacy records can expose a native progress snapshot and action total
independently. Unknown totals display as Unavailable; snapshot percentages are
labelled separately from action-aligned trajectories. Run details disclose missing
image references, missing native progress and unavailable action alignment.


## Public website

The explorer at [scummbench.tsilva.eu](https://scummbench.tsilva.eu) reads a public
Blob results document through its read-only `/api/results` function. Finished
fixed-task runs, interactive sessions and canonical archive registrations wake the
publisher after their local evidence is finalized. A per-user retry job catches
missed wakeups, offline failures and already-running sessions once per minute
while the machine is awake. No source commit or page deployment is required for
new results. The page polls every five seconds; storage caches may take up to a
minute to expose a completed publication.

Publication uses the same verified display projection as the local explorer.
Archive manifest hashes are checked again. Private trajectories, screenshots,
paths, narratives and evaluator state never enter the outbox. Updates merge by
game, benchmark identity and run ID. Conflicting contracts cannot share a version.
Conditional Blob writes use ETags and retry conflicts, preventing a concurrent
publisher from silently deleting another publisher's results. Unknown metrics
stay null and legacy versions remain isolated.

The public reader needs no write credential. During an outage it returns an error
and the browser retains its last successful data. A missing initial object uses
the labelled bootstrap snapshot. About reports the last publication time.

### Publisher setup and operation

`local/results-publication.json` is owner-only, ignored metadata with this shape:

```json
{
  "version": 1,
  "enabled": true,
  "launcher": "scripts/results-agent-vault.py",
  "url": "https://STORE.public.blob.vercel-storage.com/results/current.json"
}
```

Use the dedicated, reviewed Infisical results profile described in `AGENTS.md`.
Its fixed client runs inside an OS sandbox with a non-secret placeholder and a
short-lived Agent Vault session. The source key stays out of the client. Source
renewal and protected code-hash updates are trusted administration; ordinary
startup never fetches source credentials or falls back to another route.

After the route has passed fake-key and real publication checks, install retries:

```sh
python3 scripts/install-results-publisher.py --install
```

To retry immediately, run `node scripts/results-sync.js --once`. Private outbox,
success receipts and pending status are in `.internal/publication/`. Failed
publication cannot alter an outcome or discard the outbox. Unchanged inputs do
not upload again. Inspect `status.json` and `receipt.json` for delivery state.

The checked-in `web/results.json` remains a bootstrap snapshot. `pnpm results:export`
can regenerate it explicitly, and `pnpm build` validates it while copying only
public assets into `dist/`. Runtime public data is independent of these assets.
The [Production deployment guide](deployment.md) governs code deployment;
it is separate from automatic result publication.
