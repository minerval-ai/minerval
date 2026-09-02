# Predictions — the calibration track (#334 S6, from #296)

Everywhere else in the graph there is no ground truth to grade against.
Predictions are the exception: a claim with a **resolution criterion**, a
**resolution date** and an **operationalization** (the source of truth that
settles it) is eventually graded by reality, not by a judge. Their credences,
scored against outcomes, are the one objective calibration signal the project
can produce — and under the holomorphy prior in #296, a probe of the whole
reasoning faculty, not just of these claims.

The signal accrues only as questions resolve, so the set is seeded early and
scored longitudinally.

## The fixture

`manifest.json` holds the pinned set: 22 predictions across nine domains with
horizons from one to sixteen months from authoring (2026-09-02). Each entry is
written so a human — or a future resolution watcher — can settle it without
judgment: what counts as YES, by when, and where to look. Wording follows §3,
in the direction the criterion resolves YES.

Two entries are there by construction rather than for their interest: a
low-probability sports question and a near-certain mission-status question,
so the calibration curve has both ends populated from the start.

**No market baseline is attached yet.** The forecasting platforms were not
reachable from the environment the set was authored in. Attach them with
`import-baselines` (below) so the Minerval-vs-crowd comparative can be
computed; until then `score` reports Minerval's own calibration only.

## Lifecycle

```bash
npm run predictions -- list                       # every fixture entry with its status
npm run predictions -- seed [--dry-run]           # seed unseeded entries as claims
npm run predictions -- resolve <id> yes|no --note="…"
npm run predictions -- import-baselines baselines.json
npm run predictions -- score [--out=FILE]
```

Add `--corpus` to run against the isolated corpus DB (`--profile=production`
works there too); `--corpus --drain` seeds and then drains the local queues so
the corpus Steward assesses the seeds immediately (LLM spend). Without
`--corpus` the script uses `DATABASE_URL` like the other operational scripts —
seeding **production** is a one-off ECS task on the API task definition with
the command `npm run predictions -- seed` (see the script header).

A seeded prediction enters the graph the way an API-proposed claim does: a
claim row (`created_by = prediction_seed`, type `empirical_verifiable`), a
`claim_pipeline` job, and the onboarding message that hands it to its Steward.
In production it then waits for a mandate's allocator to fund its assessment,
like any other claim (§19 as amended). Seeding is idempotent on fixture id.

Resolution is manual for now: when the world settles a question, run
`resolve` with a note saying how (the operationalization tells you where to
look). A watcher that polls the platforms is the follow-up.

## What is scored, and how

The credence graded is the one the Steward **held before the question was
decided**: the last `claim_credence` stated at or before the cutoff (the actual
resolution, or the scheduled resolution date if that came first). Assessment
history is immutable, so this is a read, never a snapshot, and never a later
revision. A resolved prediction with no credence stated in time is reported as
such and not scored — the system declined to forecast.

`score` reports (`scripts/corpus/prediction-score.ts`, pure and unit-tested):

- **Brier** (mean squared error of the probability) and **log score**
- a **calibration curve** — realized frequency per credence bucket — and
  **expected calibration error**
- per-**domain** slices: the cross-domain correlation #296 calls
  singularity-hunting — a domain whose calibration breaks from the rest is the
  most valuable result
- the **comparative** against the attached baselines, over the subset that
  has them, for both sides

Each line of the report is a small number on a small set for a long time.
That is the nature of the track; the value is in starting it.

## Schema

`claim_predictions` (migration 0044): one row per prediction claim — fixture
id, criterion, resolution date, operationalization, domain, baseline
probability with source and time, and, once resolved, outcome, time, note
and who resolved it. `corpus:reset` truncates it with the rest of the graph.
