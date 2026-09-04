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
