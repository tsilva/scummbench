# ScummBench Production deployment

The [Production delivery workflow](../.github/workflows/production-delivery.yml)
deploys code to [scummbench.tsilva.eu](https://scummbench.tsilva.eu) only after CI
passes for the current `main` commit. It verifies the repository and Vercel
destination, creates a Production deployment from that exact commit, and waits
for both READY and Production domain assignment. A failed check holds delivery.
Vercel's automatic Git deployments are disabled in `vercel.json`, so code
delivery follows the CI-gated workflow without a parallel Git-triggered build.
The [template contract](production-delivery.md) describes these checks in detail.

## Deployment credential

The Vercel token `scummbench-github-production-delivery` is scoped to the
`scummbench` project (`prj_Hgb3VY4wa4eFo9A5Xnrqnl9CuJ1X`) in `tsilvas-projects`
(`team_eE2Iv7IMqPOx8ZVN2xNfR2f0`). Its expiry is 11 November 2027.

Infisical is its source: `https://app.infisical.com`, Secret Manager project
`cba79865-b229-4181-909b-0da11a052799`, environment `prod`, folder
`/scummbench-deployment`, secret `VERCEL_TOKEN`. GitHub's `Production` environment
contains the deployment copy under the same name. Provisioning and rotation use
an explicitly authorized trusted transfer in memory; values must not enter logs,
files, command arguments or ordinary local client environments. Rotation must
update both Infisical and the GitHub environment before the old token is revoked.
There is no automatic credential-rotation or Secret Sync service configured.

The delivery manifest has empty application-key allowlists. This is intentional:
the page needs no application secrets synchronized during a code deployment.
The bootstrap deployment credential is separate from those allowlists.
Preserve Vercel's Require Separate Values policy and environment isolation.

## Verify or retry delivery

After successful main-push CI, delivery starts automatically. A manual retry
still requires successful CI for the current exact commit:

```sh
gh workflow run production-delivery.yml --repo tsilva/scummbench --ref main
gh run list --repo tsilva/scummbench --workflow production-delivery.yml
gh run watch RUN_ID --repo tsilva/scummbench --exit-status
```

Count delivery as successful only when the workflow completes and logs
`Production READY: DEPLOYMENT_ID commit COMMIT_SHA`. Confirm the deployment's
Production aliases and the live site's `/build-info.json` commit agree. A public
page served by an earlier deployment does not establish workflow success.

Finished run results use the [independent Blob publication flow](results-page.md).
Code deployments must preserve benchmark-version separation and explicit missing
metrics; new run results do not require a Git commit or a code deployment.
