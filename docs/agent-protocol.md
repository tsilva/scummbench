# Agent process protocol v1

An agent is a long-running process, configured as JSON:

```json
{
  "command": "node",
  "args": ["examples/observe-agent.js"],
  "label": "protocol-observer-v1"
}
```

Run commands from the repository root; relative command arguments follow the
runner's working directory. An optional absolute `cwd` changes the agent's
working directory. There is no shell interpolation. Do not put credentials in
configuration, command arguments, stdout, or stderr. No secret environment
variables are inherited: only a small operating-system environment allowlist
is passed. Configure a separately reviewed credential broker if your agent
needs a provider; ScummBench does not retrieve keys or call model APIs.

## Input

Every input message occupies one UTF-8 JSON line on stdin. The first contains:

```json
{
  "schema_version": 1,
  "type": "start",
  "task": {
    "schema_version": 1,
    "task_id": "queen.hotel-laundry.v1",
    "game": "flight-of-the-amazon-queen",
    "objective": "Reach the laundry room downstairs in the opening hotel in Flight of the Amazon Queen.",
    "track": "closed-book",
    "observation": { "width": 651, "height": 490 },
    "actions": ["click", "move", "key", "drag", "wait", "wait_ticks", "screenshot"],
    "budgets": {},
    "rules": "Use only supplied screenshots and actions."
  },
  "content": [{ "type": "image", "mimeType": "image/jpeg", "data": "BASE64_IMAGE_BYTES" }],
  "remaining": { "decisions": 600, "primitive_actions": 3000 }
}
```

This abbreviated example omits the real budget fields and full rules. Subsequent
messages have `type: "observation"`, content, and remaining budgets. Images are
inline base64 MCP image blocks; text blocks contain visual-frame metadata.
The runner archives image bytes separately and uses relative hash references in
the saved trajectory. The agent receives neither archive paths nor grading data.

## Output

Return exactly one JSON line for each input message:

```json
{"type":"act","actions":[{"type":"click","x":100,"y":100}]}
```

```json
{"type":"observe"}
```

```json
{"type":"finish"}
```

`finish` means the agent elects to stop. Only an independent native success
receipt can turn an attempt into success. Do not print logs or model reasoning
on stdout. Stdout is capped at 1 MiB per buffered line; extra queued decisions
are a protocol violation. Child stderr is drained but not archived, to avoid
accidentally storing provider credentials.

## Actions

Coordinates are CSS pixels in the 651×490 cropped game screenshot, captured
inside a 960×720 engine viewport. The runner checks the actual screenshot
dimensions against the task before starting the agent. Batches
contain 1–32 ordered action records and must fit the ScummWEB backbone's 20-second
input-hold/wait limit. The ScummWEB backbone validates field types, coordinate bounds,
allowed keys, and hold limits before delivering inputs.

| Type | Fields |
| --- | --- |
| `click` | `x`, `y`; optional `button` (left/right/middle), `count` (1–2), `hold_ms` |
| `move` | `x`, `y` |
| `key` | `key`; optional `hold_ms`; one gameplay key, no shortcut combinations |
| `drag` | `from_x`, `from_y`, `x`, `y`; optional `button`, `steps`, `hold_ms` |
| `wait` | `ms` (0–10000) |
| `wait_ticks` | `ticks` (1–120), when supported by the game runtime |
| `screenshot` | No additional fields |

Save, load, pause, resume, session restart, file access, browser access, and raw
telemetry queries are not player actions in this track. `wait_ticks` advances
and holds native game time under ScummWEB backbone semantics. The development runner
does not automatically freeze time during inference, so it is not a fully
stepped environment and latency may affect gameplay.

After an act batch the runner captures a fresh observation. Explicit screenshots
inside a batch are preserved in the trajectory; the v1 player gets the fresh
post-batch observation, not intermediate batch images. A rejected or failed
batch ends the attempt; uncertain inputs are never automatically retried.

## Outcomes and exits

Runner exit 0 means native success, 1 means an unsuccessful agent attempt, and 2
means infrastructure or command failure. Details are in `result.json`.
Agents should handle stdin closing and SIGTERM. On completion the runner closes
only the process groups it owns and escalates to SIGKILL after two seconds.
SIGINT or SIGTERM to the runner records `failure / operator_interrupted` and
cleans up the attempt's children.
