<p align="center">
  <img src="logo.png" alt="ScummBench cursor detective reviewing an evaluation clipboard" width="256" />
  <br />
  <!-- repo-tagline:start -->
  <strong>🧭 Evaluate agents through adventure games 🕹️</strong>
  <!-- repo-tagline:end -->
</p>

# ScummBench

ScummBench runs adventure-game tasks against agents and records independently
graded results. It uses the **ScummWEB backbone** for the game,
screenshots, input, and native evaluator telemetry. **AgentSCUMM** consumes the
ScummBench MCP interface. Bring your own agent through
a small JSON-lines process interface; AgentBench is not required.

The first development task asks an agent to reach the opening hotel's laundry
room in **Flight of the Amazon Queen**. Success requires the native engine to
report the target room ready. An agent's completion claim cannot pass the task.

AgentSCUMM's normal MCP launcher also routes through ScummBench. Interactive play
keeps its existing controls and records evidence separately from fixed-task
attempts. [Explore game results](https://scummbench.tsilva.eu), or read the
[registered playthrough records](BENCHMARKS.md).

**Development status:** the runner and synthetic evaluation tests work locally.
This is not yet a frozen benchmark or an official leaderboard. Game completion,
served asset provenance, deterministic resets, and enforced agent isolation
require additional validation. No model performance result is bundled.

## Try it

Requires **Node.js 22+**, **Python 3.11+**, **uv**, a clean installed ScummWEB checkout, and
a compatible ScummWEB deployment with Queen and evaluator hooks. Install the
ScummWEB checkout's locked dependencies before use. ScummBench itself has no package
runtime dependencies and bundles no game data, saves, or model credentials.

From this repository:

```sh
uv tool install --editable . --exclude-newer "7 days"
scummbench --version
scummbench tasks
```

This installs a global command linked to the checkout. Python launcher, Node
source, and task edits apply on the next invocation without reinstalling; running
processes keep their loaded code. Package metadata or entry-point changes can
require reinstalling. See [development checks](docs/development.md) for testing.

Create a private backend configuration, substituting your installed checkout
and chosen ScummWEB URL:

```sh
mkdir -p local runs
scummbench init-config \
  --scummweb /absolute/path/to/scummweb \
  --base-url https://your-scummweb-host.example \
  --out local/backend.json
scummbench doctor --backend local/backend.json
```

`doctor` checks the MCP connection and pinned clean ScummWEB backbone revision without
starting a game. The configuration records runtime and asset pins as unknown
until supplied; declarations do not verify the served deployment.

New runs automatically publish scalar updates to
`tsilva/scummbench-<canonical ScummVM gameid>` through the configured Agent Vault
route. See [W&B setup](docs/wandb.md) for the required private binding. Use
`--no-wandb` to run offline without that route.

Run the protocol demonstration:

```sh
scummbench run --backend local/backend.json \
  --agent examples/observe-agent.json --out runs/observer-001
scummbench verify --run runs/observer-001
```

This example observes twice and stops. Its expected game outcome is
`failure / agent_stopped`, with process exit code 1; it contains no puzzle solver.
A unique run directory contains the task, screenshots, trajectory, evaluator
receipt when available, source provenance, budgets, and result. Existing run
directories are never overwritten. `verify` checks internal consistency offline;
it does not certify an untrusted submission or replay the game.

## Connect an agent

Supply an executable and arguments in an agent configuration. The process reads
the task and screenshots from stdin and returns one `act`, `observe`, or `finish`
decision per message on stdout. The runner owns the MCP connection and grading.
See the [agent protocol](docs/agent-protocol.md) for message examples and controls.

The closed-book track permits only supplied observations and actions. Local
process execution does **not** enforce those restrictions against a hostile
agent; all v1 results explicitly have `official_eligible: false`.

## Read more

- [Architecture](docs/architecture.md): component ownership and execution flow.
- [Evaluation protocol](docs/evaluation.md): tasks, accounting, outcomes, scoring,
  provenance, and requirements for an official release.
- [Development](docs/development.md): tests, CI, assets, and extension boundaries.
- [Live W&B reporting](docs/wandb.md): automatic per-game metrics and final outcomes.

Code distribution licensing has not been selected. Game assets retain their
own terms and are not included; deployment availability is not a redistribution
permission. Branding sources and export records are in [image-assets](image-assets/).
