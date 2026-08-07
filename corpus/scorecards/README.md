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
commit, agent + judge models), so a file stays interpretable on its own.
Compare any two with:

```bash
npm run corpus:compare -- corpus/scorecards/<cluster>/<A>.json corpus/scorecards/<cluster>/<B>.json
```

One run is one nondeterministic sample: a delta is real only if it repeats
across N≈3 runs or exceeds run-to-run noise (`corpus/SCORING.md`).

This file-based history is the phase-0 form of #334's eval-run registry (L1);
when runs become first-class database records, this directory becomes an
import source and retires.
