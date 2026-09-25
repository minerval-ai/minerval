# Scorecard history

Committed regression history for corpus runs — the numbers `docs/graph-epochs.md`
describes accumulating "as snapshots plus judge scorecards". Per-run artifacts
(`report.md`, `trace.jsonl`, `graph.json`) stay in the gitignored `runs/`; the
small `scorecard.json` lands here too, one file per scored run:

```
corpus/scorecards/<cluster>/<timestamp>.json
```

`corpus:score` writes here automatically. Commit the scorecards you want as
baselines (at minimum: the first scored run of each cluster under a new
`pipelineEpoch`, and the N≈3 runs around any prompt change you are judging).
Delete scorecards freely if a run was aborted or misconfigured — this is a
history of runs worth comparing against, not a log of every invocation.

Each scorecard embeds its configuration fingerprint (`pipelineEpoch`, git
commit, `profile`, agent + judge models, the spend `caps` in force, and the
models `observed` per agent during the run), so a file stays interpretable on
its own. `modelsSource` says where the agent models came from: `run` (recorded
by `corpus:run` when the graph was built), `registry` (read back from that
run's row by a later `corpus:score`), or `score-time` (config when scored —
right only if nothing changed in between; the one pre-existing baseline,
`blackholes/2026-08-09…`, is of this kind and records the Matcher wrongly for
exactly that reason). Compare any two with:

```bash
# two single runs: deltas printed, no verdict (one sample each)
npm run corpus:compare -- corpus/scorecards/<cluster>/<A>.json corpus/scorecards/<cluster>/<B>.json
# two configurations, three runs each: mean ± sd per side, and whether the
# delta clears the combined spread
npm run corpus:compare -- <A1>.json,<A2>.json,<A3>.json <B1>.json,<B2>.json,<B3>.json
```

One run is one nondeterministic sample: a delta is real only when it exceeds
the run-to-run spread, which takes N≈3 runs per side to measure
(`corpus/SCORING.md`). The committed baseline for each cluster should
therefore be the N≈3 set, not one file.

## Baselines and the epoch-bump gate

`corpus:gate <cluster>` (#334 L4) reads this directory and nothing else: it
compares a candidate group of scorecards against the cluster's baseline group
with the noise-band rule and exits 1 on a regression of a gated headline
metric (by default the claim-bar pass rate, coherence violations, the dedup
ratio and the share of assessments with a trace; `--gated=` changes the
set). The baseline group is declared in `corpus/scorecards/<cluster>/baselines.json`:

```json
{ "epoch": "2026-09-domain-skills", "files": ["<A1>.json", "<A2>.json", "<A3>.json"], "note": "why these" }
```

Without one, the gate takes the earliest runs sharing the earliest run's
epoch and profile. The candidate defaults to the newest runs outside the
baseline that share the newest run's fingerprint (`--baseline=` and
`--candidate=` take explicit comma lists). The gate refuses — deltas printed,
no verdict, exit 0 — when a side has fewer than `--min-n` runs (default 2)
or when the sides differ in profile or epoch: a delta across configurations
is a different graph, not a regression. Declare a baseline only once its
N≈3 runs are committed, and note that `scripts/sync-frontend-content.ts`
copies every `.json` in a cluster directory to the site as a scorecard, so
it must learn to skip `baselines.json` before one is committed here.

## Other suites that file here

`golden-matcher/` holds the Matcher golden runs (`corpus:golden`) and
`golden-canonical/` the canonical-form golden runs (`corpus:golden-canonical`,
#334 S1 addendum: pinned excerpt → expected §3 form, graded by a pair judge on
`JUDGE_MODEL`). Both write one file per run; commit the ones worth keeping as
the record, as with scorecards. The reasoner probe (`corpus:probe`, S5) and
the adoption runner (`corpus:adopt`, S7) register in the per-machine registry
and write to `runs/` only — diagnostic and decision-support respectively, not
history to gate on.

## Files are the record; the registry is a local index

The eval-run registry (`eval_runs`, #334 L1) exists and every scored run,
golden run, agreement, swap, property and contribution run registers in it
— but it lives in each developer's **corpus database**, not anywhere
shared. Two people's registries never see each other's runs, and a
`corpus:reset` on a fresh machine starts one empty. So the committed files
in this directory are the shared, durable record, and the registry is a
per-machine index over the runs that happened there: `corpus:runs` and
`db:<id>` refs are conveniences for the person who ran them, not history.

That is a deliberate resolution of the plan's original intent (that this
directory would "retire" once the registry landed): a shared registry would
mean a shared database the harness writes to, which the harness's
isolation discipline forbids. If the public evals page (#368) needs a
richer source than these files, the right move is to export registry rows
into version control (a `corpus:runs --export` into `corpus/runs/`), not
to point the site at anyone's corpus DB. Until then: commit the scorecards
that matter, and treat `runs/` and the registry as scratch.

## Publishing to the site

The public evals page (`/docs/evals`, #368) renders from these files, not
from any database. Publishing a result is a scripted step, not a page edit:

```bash
# 1. commit the record under corpus/: a scorecard here, a golden run under
#    golden-matcher/, a filled review sheet under corpus/calibration/, or a
#    change to a fixture (golden pairs, predictions, a contribution scenario)
# 2. vendor it into the frontend
npx tsx scripts/sync-frontend-content.ts     # corpus/ → web/content/evals/
# 3. commit web/content/evals/ and open the PR
```

The sync also regenerates `web/content/evals/index.json`: the production
model pins and their list rates, the judge default, every cluster's size and
sources, and the composition of every fixture, so the page's facts come from
the repository at sync time rather than from someone's memory. Results that
only register in the per-machine registry (agreement, swap, property and
contribution runs) have no committed home yet and reach the page by hand;
`corpus:runs --export` is the planned fix.

