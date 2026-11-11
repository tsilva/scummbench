# Results explorer

The results page plots verified game progress against submitted actions. Each
line is an individual attempt, labelled with its date. Horizontal segments hold
the previous high-water progress until the next verified milestone; they do not
interpolate progress or project an unfinished run to completion. Reaching 100%
at a smaller action count indicates fewer actions for that particular completion,
not greater reliability across repeated attempts.

```sh
pnpm dev -- --port auto
```

Open the URL printed by the preview server. The default page reads
`web/results.json`, which initially has no registered data. The printed sample
URL uses `?demo=1` and clearly marks its entirely synthetic runs as sample data.
The source control beneath the version selector switches between them. Sample
full-game results do not imply that a full-game evaluation has been validated.

The page uses native browser APIs, a canvas chart and a loopback-only Node
server. No dependencies, credentials, game assets or active game sessions are
required. Only the `web/` directory is served; private run directories are never
exposed. Do not use the preview server as a public production server.

## Display export

`web/results.json` is an explicitly curated, public-safe display export. It is
not a raw run directory, automatic registry importer or independent verifier.
Keep transcripts, local paths, evaluator predicates and private receipts out of
it. Review any real export before publication. An unsupported or invalid file
shows an error instead of silently falling back to sample data.

The schema is version 1 and contains a `games` array. Each game has an `id`,
`label`, and `benchmarks` array. Each benchmark contains:

- `id`: stable comparison identity within the game, not a Git commit alone.
- `label` and `context`: display name and the category/starting conditions.
- `contract`: `game_edition`, `start`, `track`, `progress_revision`,
  `action_revision`, `completion_revision`, and `toolset_revision` identifiers.
  Each identifier must resolve to the exact definition used for that version;
  budgets and other conditions belong in that version's frozen definition.
- `runs`: individual attempts with `id`, `label`, ISO `date` (`YYYY-MM-DD`),
  `actions`, `outcome`, `completion_verified`, and `points`.

Each point has an integer submitted `actions` count and a `progress` percentage,
plus an optional public-safe `milestone` label. Samples must be ordered by action
count, within the run's total, and report monotonically nondecreasing verified
high-water progress. Export the first-observed high-water samples; do not turn
estimates, raw percentages under a different rubric, or restored-state
regressions into newly earned progress. The chart does not invent a zero
baseline if one was not recorded. It extends the final plateau to the known
total actions for unfinished attempts.

`outcome` is `completed`, `stopped`, `budget_exhausted`, `infrastructure_error`,
or `in_progress`. A completed attempt must have independent ending verification,
`completion_verified: true`, and a final 100% point at its final action count.
An unfinished attempt cannot report 100%; rounding a rubric to 100 is not ending
verification. Actions to finish remain unavailable for unfinished attempts.
Submitted records can include waits and screenshots, according to the frozen
action definition. Submission accounting is not low-level delivered-input timing.

See `web/sample-data.js` for synthetic examples of this shape. The samples have
separate benchmark versions and an empty second game for interaction testing.
They are intentionally separate from the recorded export.

## Comparisons and interaction

Only runs nested under the selected game **and** benchmark version are drawn.
Changing versions replaces every line, label, detail and accessible table. There
is no cross-version trend, automatic compatibility inference or historical
rescoring. The selected data source, game and version are encoded in the URL.

Point at a milestone to inspect its action count and progress. Click a point or
dated endpoint label to inspect the run, outcome and version contract. Endpoint
buttons are keyboard-accessible. A collapsible data table provides every plotted
milestone without requiring canvas interpretation. About explains the axes and
measurement limitations. The page supports narrow viewports and reduced motion.

Calendar dates identify the runs; the horizontal axis always measures actions.
These individual trajectories are not a success-rate estimate, a best-of-many
record curve or a statistical assertion that newer players improved.
