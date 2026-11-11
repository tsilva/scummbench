# ScummBench

ScummBench owns task definitions, evaluation policy, budgets, run orchestration,
portable artifacts, and aggregate scoring. ScummWEB owns the engine and native
game maps. AgentSCUMM owns game controls, screenshots, and mechanical telemetry.
Agents own puzzle solving and memory. AgentBench is not a dependency.

All new AgentSCUMM gameplay must use ScummBench. Its public launcher delegates
to the MCP gateway; managed backend access is internal. Require mediation
provenance for ordinary gameplay and never add a direct-control fallback.
ScummBench owns future benchmark registration and BENCHMARKS.md. Preserve
historical AgentSCUMM rows and source conversation archives in place.

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
