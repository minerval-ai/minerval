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
| `npm run corpus:golden` | Matcher decisions against 30 pinned pairs (paraphrase 8, similar-but-different 7, negation 6, specification 6, hard 3) | S1 / P1 | **$0.06** per full pass (DeepSeek V4 Flash) | 30/30 pass, 2026-08-08. Not yet wired into CI. |
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

- **S1 in CI (L4 per-PR gate).** `corpus:golden` is the regression net for the
  one agent whose task saturates, it passes 30/30, and it costs six cents — but
  `ci.yml` still runs only typecheck, unit tests, and cdk synth. Wiring it is
  the cheapest real gate available.
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
| S3 property & stability | Metamorphic invariance, coherence | L2 graph-agreement metric |
| S4 adversarial robustness | Can illegitimate technique move the graph | L1 contribution driver (corpus ingest generates no contributions) |
| S5 downstream-reasoner probe | Does confidence survive a reasoner | — |
| S6 calibration / predictions | Truth anchoring against resolved reality | Schema; **seed early — signal accrues only after questions resolve** |
| S8 persona simulation | Whole-surface product testing | L1 contribution driver |
| S9 production monitors | Live-graph quality signals | L0 traces on in production |

Also open in L0: **no trace retention job**, which is the sole reason
`TRACE_LEVEL` hard-defaults to `off` in production (see `trace-service.ts`).
Traces are the substrate S9 and the cost joins read from.

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
