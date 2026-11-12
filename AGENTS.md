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
or pass the selected command to that dispatcher. New runs also start their own
publishing worker automatically, using `tsilva/scummbench-<canonical gameid>`;
`--no-wandb` explicitly disables publishing. Its owner-only private binding
is `local/wandb-agent-vault.json`. The trusted host launcher uses the dedicated
`local-scummbench-wandb` bundle, the pinned proxy CA, process-local TLS trust,
30-minute sessions, worker renewal after 20 minutes, automatic session revocation,
and no skill installation.
Never use the shared `local-wandb` bundle as a fallback or change shared launchers.

The approved source is `https://app.infisical.com`, Secret Manager project
`cba79865-b229-4181-909b-0da11a052799`, environment `prod`, folder `/wandb`, variable
`WANDB_API_KEY`. Ordinary clients receive only `scummbench_wandb_placeholder`.
Source-key copying/renewal is a separate trusted administrative action, never an
ordinary startup step, raw environment injection, or a request for a key in chat.

The service permits only POST to `api.wandb.ai:443`, with path prefixes `/graphql`
and the eight explicit `/files/tsilva/scummbench-<id>` prefixes for `drascula`,
`dreamweb`, `lure`, `monkey`, `nippon`, `queen`, `sky`, and `sword25`. GraphQL path
access does not enforce operation or project permissions; the publishing worker
validates the fixed mutation, destination, run ID, and scalar payload allowlist.
Additional game IDs need a verified mapping and reviewed route update. Preserve
outbound draft approval for messages; automatic scalar result publishing is
explicitly requested by the user.

## Automatic public results

Finished verified results publish to the dedicated public Vercel Blob store
`scummbench-results-production` (`store_Pszke17tmuEHGEyB`), independently of Git
commits and code deployments. Publish only the display projection, preserve
benchmark identities and explicit missing metrics, and retain local evidence
when publication fails. Never upload raw archives or evaluator state.

The dedicated results route is separate from W&B. Its reviewed Secret Manager
source is `https://app.infisical.com`, project
`cba79865-b229-4181-909b-0da11a052799`, environment `prod`, folder
`/scummbench-results`, key `BLOB_READ_WRITE_TOKEN`. A one-time user-approved trusted transfer imports this store credential from
only the ScummBench Production environment. Infisical is the ongoing source;
ordinary startup never copies credentials. Preserve Require Separate Values and keep
Preview/Development disconnected from the Production store credential.

`scripts/results-agent-vault.py` validates the owner-only protected profile at
`~/.config/infisical/scummbench-results/route.json`, then starts only the fixed
uploader inside the macOS sandbox with the dedicated `local-scummbench-results`
bundle and a five-minute, automatically revoked session. The client receives
only `scummbench_results_placeholder`. The sandbox permits the reviewed loopback
proxy, public projection files and private publication state; it denies direct
networking and unrelated home-directory reads. This child sandbox does not
isolate its full-access parent. No global launcher or CA trust changes are made.

The broker permits GET/PUT only on `vercel.com:443` under `/api/blob` and
credential-free GET/HEAD only on the dedicated store's `/results/current.json`.
The store token scopes writes to that store. Source copying, rotation and
protected client-hash updates are explicit trusted administration, never an
ordinary startup hook. Missing/invalid profiles fail with no other credential
route. Require fake-key, denied-host and sandbox checks before real publication.
See `docs/results-page.md` for automatic retries and delivery receipts.

## Production deployment credential

Code delivery uses `.github/workflows/production-delivery.yml` after successful
exact-commit main CI. Its `VERCEL_TOKEN` is limited to the ScummBench Vercel project
`prj_Hgb3VY4wa4eFo9A5Xnrqnl9CuJ1X` in team `team_eE2Iv7IMqPOx8ZVN2xNfR2f0`.
The reviewed source is `https://app.infisical.com`, Secret Manager project
`cba79865-b229-4181-909b-0da11a052799`, environment `prod`, folder
`/scummbench-deployment`, key `VERCEL_TOKEN`. GitHub's `Production` environment
holds the CI copy. This is separate from the Blob result publisher credential.

Provisioning or rotation is explicit trusted administration: transfer only the
approved source to that GitHub environment in memory, without printing values,
writing credential files, or passing values through command arguments. Ordinary
local service commands must not retrieve or inject this token. Use the connected
Vercel tools for supported maintenance; no local deployment proxy is provisioned.
Keep the exact-commit CI, destination and Production alias checks enforced.
See `docs/deployment.md` for operation and verification.
