# Corpus scorecard — automated, diffable quality metrics (#99)

`report.md` is a legibility surface a human reads against [`RUBRIC.md`](./RUBRIC.md).
The **scorecard** is its scored counterpart: `corpus:score` walks the graph a run
produced and emits `scorecard.json` (+ `scorecard.md`) with a number — and
evidence — per rubric dimension, so a prompt change can be measured across runs
instead of eyeballed. This is layer 2 of the eval design; the Matcher golden
evals (layer 1) and full regression CI (layer 3) are follow-ups.

## What it measures

**Structural (free, no LLM)** — `scripts/corpus/metrics.ts`, a pure function so it
is unit-tested with fixtures (`tests/unit/scripts/corpus-metrics.test.ts`):

| RUBRIC | metric |
|---|---|
| A extraction | top-level claims, instances, claims per 1k source words, type mix |
| B canonical form | word-count p50/p90/max, share > 25 words |
| C matching | dedup ratio (instances ÷ top-level claims) |
| D decomposition | max depth, depth histogram, atomic share, mean children/parent |
| E cross-doc | shared subclaims (> 1 parent) |
| F assessment | status distribution, % with a substantive trace, mean trace length |
| importance | mean, histogram, and mean importance of **atomic vs compound** claims |

The depth walk memoizes and cycle-guards, so it counts each unique node in the
DAG exactly once — shared subclaims are **not** double-counted.

**Judged (bounded LLM sample)** — `scripts/corpus/judge.ts`, run through the real
LLM client so calls are metered and priced like any agent call. It grades a
sample of assessed claims and aggregates the two dimensions the rubric
under-weights, plus assessment quality:

- **claim-bar pass-rate** — share of sampled claims that pass §2's claim bar:
  single reusable propositions serving as units of reference, not arguments,
  stipulative glosses, or derivation steps. A low rate means the Steward is
  unfolding claims into proof steps and non-claims (over-decomposition, #98).
- **importance alignment** — stored importance vs the judge's independent
  importance, and the share overrated by > 0.2. Catches importance tracking
  logical necessity rather than what's worth spending compute on (#68); with
  settled propositions admitted as claims, this metric carries the discipline
  the bar used to: settled background must sit near the 0.15 anchor.
- **assessment readability / reasoning-fit / impartiality** (1–5), granularity
  distribution, and quality flags (false precision, status miscalibration,
  opaque ids, hallucination risk, …).

The scorecard lists the lowest-scoring sampled claims with the judge's one-line
note, so a low number is always traceable to specific claims.

## Judge design (why it's set up this way)

- **Different model/context than the agent under test.** `JUDGE_MODEL` defaults to
  Sonnet; the agents under test run on Fable in prod. Never let an agent grade
  its own trace with its own framing in context. This is enforced: `corpus:score`
  refuses a judge that is the Steward model the graph was actually built with
  (as recorded at run time, not as configured at score time — the first
  baseline judged a Sonnet Steward with Sonnet), unless
  `--allow-same-model-judge` is passed.
- **The fingerprint is recorded when the graph is built.** `corpus:run`
  registers the epoch, commit, profile, configured models and caps before its
  first LLM call, and the models actually observed per agent once drained;
  `corpus:score` reads that back. A scorecard whose models were only read from
  config at score time is marked `modelsSource: "score-time"`.
- **Graded against the constitution, not the judge's intuition** — the relevant
  standards are pinned into the judge prompt so the bar is explicit and stable.
- **Evidence, not just a number** — every verdict carries a note and the specific
  claim, so scores are spot-checkable and actionable.
- **Nondeterminism is designed in.** One run is one sample. Treat a delta as real
  only if it repeats across N≈3 runs or exceeds run-to-run noise — `corpus:compare`
  prints the deltas but does not pretend a single diff is significant.

- **Vetted by review, not blind-calibrated.** Judge verdicts are checked by a
  human READING them against the pinned standards (`corpus:calibrate review`),
  per #334 §2.8 as amended: the judge is presumed good-faith and competent at
  its assigned task, so the reviewer's contribution is catching where the
  task itself misses — standards that don't get at the right thing, missing
  dimensions, better designs — not re-deriving numbers. No agreement
  statistic is kept; the metrics that matter are the graph properties the
  scorecard measures, not human-vs-judge concordance.

Still pending from the master plan (#334): wiring the Matcher golden suite's
`--min-pass` into a CI gate (L4). The Matcher golden-pair set itself shipped
(S1, `corpus:golden`), and eval runs are first-class records in the `eval_runs`
registry; scorecards also accumulate as files in `corpus/scorecards/` (see its
README).

## Cost

Structural metrics are free. The judge adds ~1 call per sampled claim (default
15) — a few cents to a couple of dollars on top of a run, bounded by `--sample`
and metered by the budget tracker. Start with `--no-judge` for a free
structural pass, then add a sample once the run looks worth judging.
