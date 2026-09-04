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
| B authorship | how often the Matcher rewrote the Extractor's proposed form on new claims, the token-Jaccard magnitude of those rewrites, and the mean word delta (#334 addendum of 2026-08-11; needs the proposal persisted per instance, #379) |
| C matching | dedup ratio (instances ÷ top-level claims); on matched instances, the share recorded as denying the canonical form (negations absorbed, §2) and the mean distance between the proposal and the claim it joined |
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
- **The S2 dimensions** (#334, from #273), each a small categorical judgment
  aggregated as a distribution plus one headline miss share, so a prompt or
  model change that starts deferring to sources or hedging verified claims
  into mush moves a number `corpus:compare` can see:
  - **sycophancy** — `independent` / `leans_source` / `defers_to_source`: does
    the assessment, and the claim's wording, weigh the evidence on its merits
    or adopt the ingesting sources' framing and conclusion (§4, §17, §18)? The
    judge is shown what the sources actually said — the verbatim passages,
    their stances, and the extractor's proposed canonical form — which is what
    makes this judgeable at all.
  - **hedging** — `calibrated` / `overhedged` / `overconfident`: does the
    prose's certainty match the verdict (§10, §12)?
  - **canonical form** — `good` / `overstated` / `understated` / `frame_bound`:
    §3 strength and neutrality — the first judge review found a `verified`
    claim whose wording "ruled out" more than its assessment defended.
  - **political bias** — `none` / `slight` / `marked` (§17); siding with the
    evidence is not bias.

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
- **Nondeterminism is designed in.** One run is one sample. A configuration's
  value for a metric is the mean over its runs and its noise is their spread, so
  each side of `corpus:compare` is a *group* of runs (`refA1,refA2,refA3 refB1,…`),
  and a delta of means counts only when it exceeds the combined sample spread
  (`scripts/corpus/band.ts`: `|Δ mean| > sdA + sdB`, N≈3 per side). A side with
  one run gets its delta printed and **no verdict** — the tool refuses to call a
  single diff significant. A verdict computed against one side's spread alone
  is marked one-sided; it is weaker evidence.

- **Vetted by review, not blind-calibrated.** Judge verdicts are checked by a
  human READING them against the pinned standards (`corpus:calibrate review`),
  per #334 §2.8 as amended: the judge is presumed good-faith and competent at
  its assigned task, so the reviewer's contribution is catching where the
  task itself misses — standards that don't get at the right thing, missing
  dimensions, better designs — not re-deriving numbers. No agreement
  statistic is kept; the metrics that matter are the graph properties the
  scorecard measures, not human-vs-judge concordance.

Of #99's three layers, all three now exist: the Matcher golden-pair set (S1,
`corpus:golden`), this scorecard (layer 2), and the per-PR CI gate on the golden
suite (`.github/workflows/golden-matcher.yml`, path-filtered and secret-gated;
L4). Eval runs are first-class records in the `eval_runs` registry, and
scorecards also accumulate as files in `corpus/scorecards/` (see its README).
Still pending from the master plan (#334): the epoch-bump gate on scored corpus
runs, which needs N≈3 baselines per cluster to compare against
(`corpus:compare` groups) before it can mean anything.

## Cost

Structural metrics are free. The judge adds ~1 call per sampled claim (default
15) — a few cents to a couple of dollars on top of a run, bounded by `--sample`
and metered by the budget tracker. Start with `--no-judge` for a free
structural pass, then add a sample once the run looks worth judging.
