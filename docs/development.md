# Development

ScummBench uses Node.js 22+ with no third-party runtime or test dependencies.
Its Python 3.11+ launcher supports global editable installation through uv.
The pnpm lockfile and release-age settings are checked in. No package lifecycle
scripts are needed.

```sh
pnpm install --frozen-lockfile --ignore-scripts --offline
pnpm check
pnpm test
python3 -B -m unittest discover -s python_tests -v
uv tool install --editable . --exclude-newer "7 days"
scummbench --version
```

The check command validates JavaScript syntax, JSON files, and the included task
contract. The Node test suite launches synthetic stdio MCP servers and agent
processes. Temporary fixture runs are created under a unique OS temporary
directory and removed after each test. No game assets, live browser, model API,
network access, or credentials are needed for the suite.

The automatic [W&B publisher](wandb.md) uses a dedicated Agent Vault worker and
Node's built-in HTTPS proxy transport. Ordinary synthetic gameplay tests explicitly
disable reporting. Publisher tests inject synthetic upstreams and temporary
owner-only route bindings; they never use the installed credential route.
They cover automatic fixed-task and MCP defaults, real stdio worker communication,
session renewal, cancellation, payload exclusions, canonical game project routing,
contiguous retry offsets, backpressure, shutdown deadlines,
independent grading during outages, and interactive sessions without inferred
success. These fixtures do not establish live W&B authentication or ingestion.

Tests cover native success after MCP closes, false completion claims, invalid
receipts, task isolation in the visible protocol, decision/action/response/wall
budgets, malformed output, prohibited actions, duplicate attempts, and tampered
artifacts. CI runs these checks on Linux; local success does not establish CI
success before publication.

## Results page

The dependency-free [results explorer](results-page.md) runs via
`pnpm dev -- --port auto`. It reads a local, read-only feed of finished run
evidence and registered archive projections, refreshing automatically. The feed
exposes only display fields; raw evidence stays private. Explicitly labelled
synthetic examples remain available separately for preview.

## Editable global command

The launcher uses the Python module's real source location to find the live
checkout and replaces itself with `node <checkout>/src/cli.js`. It preserves
arguments, the working directory, signals, and exit codes. Edits to the Python
launcher, Node implementation, schemas, and task files are read from that checkout
on the next invocation. Active Node processes do not hot-reload. Reinstall after
moving the checkout or changing Python package metadata or entry points.

The wheel configuration also bundles the Node runtime for non-editable installs.
Editable installs prefer the live checkout. Python has no runtime dependencies;
Hatchling is a pinned build dependency, and uv enforces the seven-day release-age
policy. `uv.lock` records the Python project; Node dependencies remain governed by
the separate pnpm lockfile. Keep both version declarations aligned.

AgentSCUMM's public `src/index.js` delegates to `scummbench mcp`. ScummBench
launches ScummWEB's `agent-backbone/src/server.js` for both interactive MCP and
fixed-task attempts. It never loads AgentSCUMM code. The backbone uses ScummWEB's
existing locked `playwright-core` and `zod` dependencies; ScummBench stays
dependency-free. See [ScummWEB's backbone guide](../../scummweb/docs/agent-backbone.md).

For editable sibling checkouts, the ScummWEB directory resolves automatically.
Other layouts set `SCUMMWEB_DIR` to an absolute checkout, or use
`scummbench mcp --scummweb /absolute/scummweb -- [backbone arguments]`.
The `--scummweb` option belongs before `--`; AgentSCUMM forwards only backbone
arguments after `--`. Missing ScummWEB fails closed. Existing live connections
keep their loaded code until their sessions finish; replacement connections
report `status.sourceRevision.repository: "scummweb"` and
`status.scummbench.mediated: true`.

## Backend configuration

Schema 1 configurations pointing at AgentSCUMM are rejected. Regenerate them
with `init-config --scummweb`; historical run artifacts remain verifiable.

`init-config` pins a clean ScummWEB checkout. A configuration contains:

```json
{
  "schema_version": 2,
  "scummweb_dir": "/absolute/path/to/scummweb",
  "scummweb_revision": "FULL_40_CHARACTER_COMMIT",
  "base_url": "https://your-scummweb-host.example",
  "runtime_revision": null,
  "asset_files": []
}
```

The placeholder commit must be replaced by the initializer's actual commit.
An optional `runtime_revision` is a declared 40-character commit; it is not
verified against the remote deployment. Optional asset declarations are objects
with absolute `path` and SHA-256 `sha256`. The loader checks those local files;
it does not claim that a deployment served the same bytes. No assets are uploaded
or imported through this configuration.

The current adapter launches the catalog Queen entry. A different game edition
or imported game requires an explicit adapter/task change and validation. Do not
silently point the task at a differently named local import or reuse another
attempt's browser profile. The player cannot restart the session or load saves.

## Extending the suite

Keep native maps in ScummWEB and input mechanics in ScummWEB's agent backbone. Add benchmark
tasks and grading policy here. Validate a new task's success rules with positive
and negative native traces, then with a live attempt on a pinned edition. A
successful synthetic fixture is not a successful game playthrough.

The reference player example demonstrates the protocol and intentionally fails
the game task. Add model integrations outside the core runner and preserve exact
harness prompts and provenance when introducing comparative results. No default
API provider or credential route is selected by this repository.

## Distribution

No license has been selected for this new repository's code. Select one before
inviting third-party reuse. Game data and saves are excluded and retain separate
rights. Do not infer distribution permission from free downloads or a public
ScummWEB deployment. Do not publish raw private trajectories or existing assets
without review.
