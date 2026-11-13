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

Publishing uses the supplied environment or an explicitly supplied worker
command. No checkout file discovers a credential launcher.
Missing access must fail before gameplay;
`--no-wandb` explicitly selects offline operation. Keep per-run workers and their
20-minute renewal, 30-minute scoped sessions, native revocation and isolation from
player/game environments. Preserve fixed entity/project/mutation/scalar allowlists.
Automatic scalar result publication remains an existing user-requested default;
messages retain their separate draft approval. A runner setting grants no service permissions and cannot authorize source-key
retrieval, raw injection, broader projects or another user's credentials.

## Automatic public results

Finished verified results publish to the dedicated public Vercel Blob store
`scummbench-results-production` (`store_Pszke17tmuEHGEyB`), independently of Git
commits and code deployments. Publish only the display projection, preserve
benchmark identities and explicit missing metrics, and retain local evidence
when publication fails. Never upload raw archives or evaluator state.

The results uploader is separate from W&B. Its owner-only
`local/results-publication.json` records only publication metadata and
public destination. Keep its restricted transport, fixed display projection,
conditional writes and private outbox/receipt handling. Provider configuration
belongs to the optional external runner; ordinary startup never fetches source
keys. Preserve the existing publisher schedule and active consumer processes.
