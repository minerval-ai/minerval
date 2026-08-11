# Eval catalog

Every eval that can be run today, what it measures, and what it costs — so
spend is chosen deliberately rather than discovered after the fact.

Costs below are **metered, not estimated**, unless marked otherwise: they come
from `llm_usage` via the cost meter, recorded in the run's scorecard or the
phase log. Where a figure is extrapolated it says so.

Cross-references are to the master plan (#334): purposes P1–P9, suites S1–S9,
layers L0–L4.

---

## 1. Runs today

| Command | Measures | Plan | Metered cost | State |
|---|---|---|---|---|
| `npm run corpus:golden` | Matcher decisions against 30 pinned pairs (paraphrase 8, similar-but-different 7, negation 6, specification 6, hard 3) | S1 / P1 | **$0.059** per full pass (DeepSeek V4 Flash); retries add ~$0.001 | **Wired into CI** as a blocking per-PR gate. See §2.1 on what its pass rate actually is. |
| `npm run corpus:agree -- <refA> <refB>` | Distance between two graphs: claim-set precision/recall, structural edge agreement, credence agreement, and divergence attributed to the agent that created each claim | L2 / P3,P5,P6 | **free** (no LLM; pairs on stored embeddings) | Working. The instrument S3, S4, S7 and #170 all read. |
| `npx vitest run tests/unit/llm/model-guard.test.ts` | Every reachable model has routing, pricing, and correct quirk predicates | S7 guard / P7 | **free** | Passing; runs in CI with the unit suite. |
| `npm run corpus:score -- <cluster> --no-judge` | Structural metrics over the graph a run produced: depth histogram, dedup ratio, canonical-form length, status distribution, importance-vs-decomposition | S2 / P2 | **free** (no LLM) | Working. |
| `npm run corpus:score -- <cluster>` | The above plus a judge panel over a bounded sample: claim-bar pass rate, readability, reasoning fit, impartiality, granularity, independent importance | S2 / P2 | **$0.06** (2 claims) to **$0.60** (13 claims), cross-vendor panel | Working. Panel = Fable + GPT-5.6 Sol. |
| `npm run corpus:judge-compare -- <cluster> --models=…` | How much a scorecard depends on *which* judge graded it — identical sample, N models, pairwise agreement | L2 / P2 | **$3.53** for 6 models × 13 claims (per-model $0–$1.26) | Working; run 2026-08-09. |
| `npm run corpus:calibrate -- sheet` / `compare` | Judge verdicts vs. **human** labels, per dimension — the gate on trusting any judge number | L2 / P2 | **free** in LLM spend; costs your labeling time (~15 samples/dimension) | Harness works. **No labels collected yet** — every judge number below is uncalibrated. |
| `npm run corpus:run -- <cluster>` | Full pipeline over a cluster through the real app: ingest → extract → match → steward | L1 driver | scales with cluster and steward model — see §2 | Working. |
| `scripts/corpus/steward-bakeoff.ts prepare\|phase` | One steward model vs. another over an identical claim queue, same quota, same judge panel | S7 / P6 | **$0.40–$2.36** per phase at 2 runs | Working; 5 models compared 2026-08-09/10. |
| `npm run corpus:runs` / `corpus:compare` | Eval-run registry history and noise-band diffing between any two scorecards | L1 / L2 | **free** | Working; 12 runs registered. |
| `npm run corpus:report -- <cluster>` | Human-readable legibility surface for a run, organized against RUBRIC.md | — | **free** | Working. |
| `npm run corpus:snapshot -- save\|restore` | Template-DB snapshot/restore of the corpus DB | L1 | **free** | Working; what makes repeated phases affordable. |
| `tsx scripts/corpus/extract-only.ts` | Extractor prompt iteration, no DB and no embeddings | — | ~1 cheap call per iteration | Working. |

## 2.1 The golden suite does not score 30/30 single-shot

The committed 2026-08-08 scorecard records 30/30, and an earlier revision of
this catalog repeated it. **It does not reproduce.** Measured 2026-08-11
against a freshly reset corpus DB on the production Matcher model:

| Run | Model | Result | Cost |
|---|---|---|---|
| single-shot | deepseek-v4-flash | **28/30** (neg-03, spec-05) | $0.058 |
| single-shot | claude-haiku-4-5 | **28/30** (spec-03, spec-05) | $0.302 |
| `--retries=2` | deepseek-v4-flash | **30/30** (hard-01 on attempt 2) | $0.059 |

The failures are not a regression and not bad pins. Both DeepSeek failures
passed **5/5** when re-run in isolation, so those pairs sit on a genuine
decision boundary and fail roughly **one run in six**. Haiku corroborates from
the other side: it fails `spec-05` 2 of 3 times and `spec-03` 3 of 3, so the
marginality belongs to the *pair*, not the model.

Consequences worth keeping straight:

- **A rate threshold cannot gate this suite.** Single-shot at `--min-pass=0.95`
  blocks the repo on a coin-flip about a third of the time; `0.90` waves
  through a real three-pair regression. A known-failures allowlist fails too,
  because these pairs flip rather than failing consistently.
- **CI therefore runs `--retries=2 --min-pass=0.95`.** A boundary pair must
  fail three consecutive attempts to fail the build; a genuinely broken pair
  still fails all of them.
- **Retries are off by default** for manual runs, which report raw single-shot
  behaviour — what you want when investigating.
- **`passedOnRetry` is reported by name.** A green run that needed retries is
  the suite drifting toward the boundary, and that is the signal a retry
  mechanism would otherwise destroy.

The Haiku/DeepSeek gap is also free S7 fidelity data: on the two pins Haiku
fails, it absorbs a *narrower* proposition into a broader existing claim
(MMR-vs-vaccines; one step of the cosmic-ray argument) — a reproducible
difference on exactly the specification distinction the constitution turns on,
at 5× the cost.

## 2. The one cost lever that matters

Nothing else moves the bill like **steward model × claims assessed**. Measured
cost per assessed claim, from the 2026-08-09/10 bake-off on `blackholes`:

| Steward model | $/assessed claim | Relative |
|---|---|---|
| DeepSeek V4 Flash | $0.142 | 1× |
| GPT-5.6 Terra | $0.233 | 1.6× |
| Kimi K3 | $0.924 | 6.5× |
| GPT-5.6 Sol | $1.141 | 8× |
| Claude Sonnet 5 | $1.815 | 13× |

Cluster sizes, and what a **full** drain therefore costs:

| Cluster | Posts | Claims (blackholes measured; others extrapolated) | Full drain, DeepSeek | Full drain, Sonnet |
|---|---|---|---|---|
| `blackholes` | 4 | 21 pending | ~$3 | ~$38 |
| `eggs` | 3 | ~16 | ~$2 | ~$29 |
| `lableak` | 5 | ~26 | ~$4 | ~$47 |
| `lethalities` | 11 | ~58 | ~$8 | ~$105 |

These are **floors**. A steward run can mint subclaims that themselves need
assessment, so a true drain cascades past the initial queue — in the bake-off,
2 steward runs generated 3–6 downstream claim-pipeline tasks each time.

## 3. Built, not yet wired

- **S1 in CI — wired, but inert until secrets exist.** The `golden` job runs on
  every PR with `MATCHER_MODEL` pinned to production's `deepseek-v4-flash`
  (config's *default* is Haiku, so an unpinned job would gate the wrong model
  at 5× the cost). It needs `OPENAI_API_KEY` and `OPENROUTER_API_KEY` as repo
  secrets; without them it **skips with a warning rather than blocking**, so
  today it is green-but-not-gating. It never touches Anthropic credits.
- **Judge calibration.** The harness exists and a blinded sheet is already
  generated (`corpus/calibration/blackholes-2026-08-09-832f7f15.md`); no human
  labels have been filled in. Per the plan's own rule (#334 §2.8), *no judge
  number should feed a gate until this is done* — including the ones in §1.
- **Epoch baseline — cut, but under a stale model config.** #349 landed a real
  baseline under `2026-08-owl-economy` (blackholes, 26 claims, 13 assessed:
  7 verified / 5 supported / 1 contested, $0.60 judged). It ran
  **matcher=claude-haiku-4-5 and a single Sonnet judge** — both since replaced
  (DeepSeek V4 Flash matcher per #337, cross-vendor Fable+Sol panel). It is a
  valid epoch anchor; it is *not* a like-for-like reference for runs under the
  current config, and comparisons across that gap are cross-configuration.

## 4. Not yet built

| Suite | Purpose | Blocked on |
|---|---|---|
| S3 property & stability | Metamorphic invariance, coherence | Nothing — the graph-agreement metric now exists; S3 is thin configs over it |
| S4 adversarial robustness | Can illegitimate technique move the graph | L1 contribution driver (corpus ingest generates no contributions) |
| S5 downstream-reasoner probe | Does confidence survive a reasoner | — |
| S6 calibration / predictions | Truth anchoring against resolved reality | **Schema, loader and scorer are built** — needs resolvable questions SEEDED. Signal accrues only after they resolve, so every month unseeded is lost. |
| S8 persona simulation | Whole-surface product testing | L1 contribution driver |
| S9 production monitors | Live-graph quality signals | Nothing structural — traces now run in production |

**L0 is complete.** The trace retention job (`workers/trace-retention.ts`)
bounds `agent_runs`/`agent_steps` growth in two tiers — steps expire at 14
days, runs at 90, so per-claim cost attribution outlives the transcripts — and
with it `TRACE_LEVEL` now defaults **on** in production.

One privacy carve-out: browser-extension ingestion (#72) runs the Extractor
and Matcher over whatever page the user is viewing, so those runs are marked
`sensitive` and **no transcript is recorded at all** — suppressed at recording
rather than retention, since pruning later still means collecting now.
System-invoked extractor/matcher runs trace normally. Cost metering is
unaffected either way (`llm_usage` records tokens, never content).

## 5. What the existing results already say

Two findings from the completed bake-offs, worth weighing before buying more:

1. **Every frontier steward chose `supported` where Sonnet chose
   `verified`/`contradicted`.** The status-rounding the judges flag as
   `status_miscalibrated` looks like a *steward* trait, and the pricier models
   are better calibrated on exactly the dimension the constitution cares about.
2. **Judge choice moves the numbers.** The 6-model judge bake-off is why the
   panel is cross-vendor — and why §3's calibration gap matters: an uncalibrated
   panel's agreement with itself is not evidence it is right.

A caveat on both: the steward comparison graded 2 claims per model. That is
enough to see a categorical difference in status choice; it is **not** enough
to rank the models on quality.
