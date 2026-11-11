# ScummBench

ScummBench owns task definitions, evaluation policy, budgets, run orchestration,
portable artifacts, and aggregate scoring. ScummWEB owns the engine and native
game maps, game controls, screenshots, and mechanical telemetry. AgentSCUMM is
an agent-side consumer of ScummBench MCP; ScummBench must never launch or import
AgentSCUMM for gameplay or result registration.
Agents own puzzle solving and memory. AgentBench is not a dependency.

All new AgentSCUMM gameplay must use ScummBench. Its public launcher delegates
to the MCP gateway, which uses ScummWEB's agent backbone directly. Require mediation
provenance for ordinary gameplay and never add a direct-control fallback.
ScummBench owns future benchmark registration and BENCHMARKS.md. Keep historical AgentSCUMM rows in this repository and retain verified private
archive copies. Preserve original source conversation archives.

Read SPECS.md and the relevant docs before substantive changes. Work on the
current branch. Preserve the dependency-free Node.js implementation unless a
dependency is justified and approved under the user's supply-chain rules.

Never put solution hints or evaluator state in player observations. Keep evaluator
configuration and receipts separate from the player protocol. Local process
separation is not a security sandbox; development runs are never official scores.
Do not claim determinism, asset licensing, model performance, or live success
without matching evidence. Maintain negative grading tests as well as successes.

Run `pnpm check` and `pnpm test`. Tests use synthetic fixtures, never game assets
or model APIs. Use unique task-owned directories and clean temporary test data.
Private run artifacts belong in ignored runs/; working evidence belongs in
ignored .internal/. Do not commit assets, secrets, personal trajectories, or saves.
Do not modify or interrupt another AgentSCUMM process or profile.

Keep the README focused on first use; put protocol and reproducibility details
in docs/. Preserve the release-age settings and lockfile. Publishing, Git pushes,
and outgoing messages follow the user's approval rules.

## W&B service access

The user explicitly authorized ScummBench's dedicated Agent Vault route without
an additional OS sandbox on 2026-11-11. This exception is limited to W&B for this
repository. Agent Vault brokers credentials; it does not isolate the client.

Use `python3 scripts/wandb-agent-vault.py --check` for a read-only identity check,
or pass the selected command to that dispatcher. Its owner-only private binding
is `local/wandb-agent-vault.json`. The trusted host launcher uses the dedicated
`local-scummbench-wandb` bundle, the pinned proxy CA, process-local TLS trust,
30-minute sessions, automatic session revocation, and no skill installation.
Never use the shared `local-wandb` bundle as a fallback or change shared launchers.

The approved source is `https://app.infisical.com`, Secret Manager project
`cba79865-b229-4181-909b-0da11a052799`, environment `prod`, folder `/wandb`, variable
`WANDB_API_KEY`. Ordinary clients receive only `scummbench_wandb_placeholder`.
Source-key copying/renewal is a separate trusted administrative action, never an
ordinary startup step, raw environment injection, or a request for a key in chat.

The service permits only POST to `api.wandb.ai:443`, with path prefixes `/graphql`
and `/files/tsilva/scummbench-queen`. GraphQL path access does not enforce operation
or project permissions. Publishing uses canonical ScummVM IDs (`queen` here);
other projects need a reviewed route update. Preserve outbound draft approval.
