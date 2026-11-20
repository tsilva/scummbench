# Running the ScummBench observer

Requires an installed ScummBench CLI and a clean ScummWEB checkout with a compatible deployment.

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
`tsilva/scummbench-<canonical ScummVM gameid>` using the supplied publishing
connection. See [W&B reporting](wandb.md) for its contract. The demonstration
below uses `--no-wandb` for offline operation.

Run the protocol demonstration:

```sh
scummbench run --no-wandb --backend local/backend.json \
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
See the [agent protocol](agent-protocol.md) for message examples and controls.

The closed-book track permits only supplied observations and actions. Local
process execution does **not** enforce those restrictions against a hostile
agent; all v1 results explicitly have `official_eligible: false`.
