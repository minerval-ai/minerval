# Resource allocation: the value/cost scheduler, grantor agents & funded campaigns

**Status: design, not yet implemented.** This document pins down the target
design for allocating compute across the claim graph — the successor to the
importance-ordered drain — and the funding mechanism built on top of it. It
subsumes [issue #172](https://github.com/minerval-ai/minerval/issues/172)
(stakes and yield as separate dimensions) and extends it to money: budgets,
grantor agents, and funder subsidies. Nothing here changes the constitution's
epistemic rules; it changes how the system decides what to spend cognition on.

## The problem

Compute is the binding constraint on the graph, and the allocation problem has
a particular shape:

- Claims vary in importance by orders of magnitude, and independently in how
  tractable they are to assess. Important-and-easy (the Pythagorean theorem)
  and unimportant-and-bottomless both exist.
- Claimspace is functionally infinite — every claim yields fractally more
  subclaims as resolution rises — so **the optimal allocation to the median
  claim is zero**. Only claims that could matter to a live discourse should
  be mapped at all.
- For claims that are important, neglected, *and* tractable, heavy spend is
  justified. The gains from deliberately covering regions the attention
  economy neglects are a core part of the project's value.
- There is a standing tension between the objectively highest-value claims
  and the salient/marketable ones that grow the system's resources. The
  design below resolves this structurally (see *Overhead as cross-subsidy*)
  rather than by discipline.

## What exists today: frozen shadow prices

The current system already embodies an allocation policy, scattered across
static knobs. Each is a frozen approximation of one quantity — the shadow
price of compute:

| Mechanism | Where | What it freezes |
|---|---|---|
| Importance-ordered steward drain | steward pipeline | queue priority = fused importance score |
| Deferral brake (`stewardEnqueueMinImportance` = 0.25) | `src/config.ts` | the price of recursively processing a subclaim |
| Extraction selectivity + confidence floor | Extractor | the price of seeding a new tree |
| Per-agent model tiers | env / `src/config.ts` | the price of capability, per role |
| Hourly/daily call+token circuit breaker | `src/llm/budget-tracker.ts` | a blunt global spend bound (bounds, doesn't allocate) |
| Per-account monthly grants | metering (#70) | user-triggered spend |

Phase 1 of #172 is done: `contestation` (on claims) and `marginal_yield` (on
assessments) are recorded on every pass. Nothing reads them yet. Assessments
also record the assessing model (#294), and `llm_usage` prices every call in
micro-USD per agent — the accounting substrate for everything below.

## The core model: one ordering, keyed on value/cost

Every candidate action in the system — steward a claim, reassess on a
trigger, run a curator sweep, ingest a source — is assigned an estimated
dollar **value** and an estimated dollar **cost**. There is no queue in the
FIFO sense: there is a single global priority ordering, and the processor
executes from the top as fast as its throttle allows.

**The ordering key is value/cost, not value − cost.** Under a binding budget
you fund by bang-per-buck: a $100-value action costing $90 loses to ten
$10-value actions costing $1 each. The value/cost ratio of the marginal
funded action *is* the shadow price of compute, and it is a genuinely useful
number in its own right: when the marginal queued action returns 5× its cost
and remains unaffordable, that ratio is the fundraising pitch, quantified.
(When compute is idle and the budget slack, the criterion relaxes to
value > cost — the throttle floats the effective bar automatically.)

**Cost includes induced cost.** A steward pass that mints twenty subclaims
does not cost one run; it commits the budget to the enqueue tail it creates.
The true cost of an action is its immediate metered cost plus the expected
discounted cost of the work it spawns. Actions differ enormously here: a
triggered reassessment induces almost nothing; onboarding a top-level claim
in unmapped territory induces a whole subtree; ingesting a source induces
the most of all (extraction count is already the dominant cost driver — see
the note on `extractionMaxClaims` in `src/config.ts`). Pricing induced cost
in makes the scheduler favor deepening existing structure over breaking new
ground when budgets are tight, which is usually right.

**The throttle stays.** A queue-speed cap is not training wheels to be
removed once estimates improve: it converts estimation errors from unbounded
to bounded and smooths spend across the budget period. It loosens as
calibration improves; it does not disappear. A corollary: under a throttle,
only the top of the ordering runs, so **ranking quality at the top** is what
matters. Absolute dollar accuracy matters later, for the buy-more-compute /
raise-more-money decision, not for day-to-day scheduling.

**Floating thresholds replace fixed ones.** The 0.25 deferral brake is the
shadow price frozen at one moment's budget. Under this design the brake
floats: when the ordering is rich the bar rises; when the graph is drained
and compute idle it falls — and settled foundations (the derivation
structure behind special relativity) cross the do-it line automatically as
cognition gets cheaper, exactly as #172 anticipates. No policy change, a
price that moves.

## Valuation: staged, logged, and honestly vibes at first

Valuation is itself a compute-allocation problem — the median candidate
action's optimal valuation effort is zero — so it is staged:

1. **Arithmetic score for everything.** A cheap function over stored
   signals: importance, `contestation`, `marginal_yield`, consultation
   counts (once the read path records them), trigger type, staleness, and
   any active subsidies (below). This ranks the entire candidate set for
   near-zero cost.
2. **LLM valuation at the boundary.** A model call prices an action only
   where a better estimate can change the outcome: near the funding cutoff,
   or above a stakes threshold. Ranking errors deep in the never-funded tail
   and high in the always-funded head cost nothing; precision pays only at
   the margin. Grantor agents (below) are the other place model-grade
   judgment enters — periodically, over slates, never per-action.

The value functions start as heuristics and will remain largely judgment
indefinitely. That is acceptable **iff the loop is closed**: every funding
decision writes a row to a prediction ledger — action, predicted value,
basis — at decision time, and outcomes are joined against it later: did the
verdict change, did `marginal_yield` drop, was the claim consulted, did the
assessment trigger downstream re-judgments, did contributions arrive.
Predicted-vs-realized is the calibration dataset; it is nearly free to
collect and impossible to reconstruct after the fact. Realized value is the
weakest link — these are proxies, and verdict-changed is cruder than one
would like — but a crude closed loop beats an elegant open one.

Model-tier selection folds into the same frame: instead of a fixed tier per
agent, tier becomes f(stakes, expected yield) — and the elasticity is
measurable, because assessments record their model and the corpus harness
has an independent judge. "How much does Fable-over-Sonnet buy, per claim
stratum" is an experiment, not a vibe.

One boundary that must hold: the internal action price is an **allocation
input**, and a claim's `importance` is an **epistemic judgment**. They stay
separate fields. Letting them blur creates Goodhart pressure on the one
number the Steward prompt says must never be inflated to force processing.

## Budgets and envelopes

The global budget is denominated in dollars per period, enforced against
`llm_usage`, and partitioned into envelopes by work class: ingestion,
first-pass stewardship, reassessment, curation/governance, and an explicit
**exploration tranche** for neglected regions. Envelopes are theoretically
wrong at the margin (the optimum equalizes marginal value across all
activities) but right as governance: they protect work whose value is hard
to estimate (audit, curation, neglectedness sweeps) from being starved by
work whose value is always legible (fresh ingestion is perpetually
seductive).

The exploration tranche exists because neglectedness is, by definition,
where demand signals are silent — it cannot be discovered by
demand-weighting and must be an affirmative budget line. "Where in
claimspace are stakes high and coverage absent" is itself cheap-model work
over embeddings, and its output seeds actions the scoring formula would
never generate.

Because execution drains a single value/cost ordering, a binding budget
degrades gracefully: what goes unfunded is the tail, and the system can say
exactly what the tail was and what funding it would cost.

## Grantor agents

A grantor agent is the Steward pattern applied one level up — judgment over
mechanism, mechanism as backstop — for money instead of epistemics. Each
grantor owns an envelope (a funded campaign, the exploration tranche, base
operations) and acts as a **periodic portfolio reviewer, never a per-action
gatekeeper**: on a cadence it reviews the top and bottom of its ordering,
adjusts scoring weights, seeds actions the formula misses, and can override
individual rankings. Per-action LLM gating is the expensive place to put
judgment; periodic review of a slate is where a model call pays for itself.

Grantors deploying money over time are systems, not single calls: a
scheduled agent with a balance, a burn-rate policy, and a fleet of
**scouts** — read-only research subagents that survey a discourse, enumerate
the canon and live debates, find sources, and map coverage gaps against the
existing graph. One bright line: **grantors and their scouts allocate and
monitor; they never assess, and they never write to the graph.** The
epistemic work stays with the standard pipeline agents. A grantor is a
budget officer with a research staff, not a parallel pipeline — the moment
grantor-fleet output touches epistemic content directly, funder money has a
path to verdicts that no prompt firewall closes.

Every grantor decision lands in an append-only **allocation ledger**
(the Curator's reconciliation log, but for money): what was funded, at what
predicted value, on what basis, with overrides labeled as such. The ledger
is simultaneously the audit trail, the training signal for the scoring
formula, the funder-facing transparency artifact, and — because each grantor
accrues its own predicted-vs-realized record — the basis for comparing
grantor performance over time.

## The marketplace: subsidies on top of base EV

Funders never get separate infrastructure. There is one ordering, and
funders add terms to the value function:

- Every action carries a **base EV** — the system's own judgment of the
  public good of doing it.
- Funders add **subsidies** on top, pushing specific actions or whole
  regions over the funding line.

This makes the marketplace a continuum on one primitive. At the small end, a
few dollars bumps a single claim's assessment — product-wise a "fund this
assessment — $4" button on every unassessed claim page, with none of the
machinery visible. At the large end, a major funder endows a grantor agent
with a mandate over a whole discourse. Two instruments, genuinely different:

- **Bumps** price leaf actions. A one-shot subsidy attached to a specific
  action, spent when it executes at metered actuals.
- **Mandates** are standing subsidies over a *scope*, held by a grantor
  agent with a balance and burn policy, and — critically — **flowing down
  the induced tree**. Funding "ingest AI economics" commits to the whole
  funnel: extraction spawns claims, claims spawn steward runs, runs mint
  subclaims. If the subsidy doesn't propagate, the system ingests a
  discourse it cannot afford to assess — visible stubs, no verdicts, the
  worst outcome.

**Mandates are data, not instructions.** A funder-written mandate is a
scoped document the grantor reads under its own constitution-first system
prompt, explicitly subordinated — the same pattern as the Steward reading
contributions: input, never authority. The grantor is Minerval's agent
administering the funder's money, not the funder's agent inside Minerval.
Mandates pass an intake review like contributions do: "prioritize AI
economics" is a scope; "prioritize claims supporting X" is rejected or
normalized to "prioritize the X question."

### The firewalls

Money buys priority. It never buys verdicts. Concretely:

1. **Fund the question, never the argument.** Subsidies attach at the
   claim/action level. Once a claim's assessment clears the line, the
   Steward's judgment alone decides where effort goes within its tree.
   Funders cannot line-item one side's supporting subclaims —
   asymmetric-scrutiny-as-a-service is the failure mode this rule exists
   to prevent.
2. **Money cannot manufacture yield.** A paid reassessment bump on a claim
   where nothing changed and `marginal_yield` ≈ 0 does not run. Funded
   re-runs require the same new-information trigger unfunded ones do —
   otherwise deep pockets buy verdict-shopping lottery tickets, re-rolling
   until variance delivers.
3. **Funded and unfunded assessments are procedurally identical.** Same
   prompts, same transparency rules, same evidence standards.
4. **Disclosure, and blindness where it counts.** Funding is disclosed on
   every subsidized claim's page; the Steward's prompt context never
   contains funder identity, so independence is architectural, not
   aspirational.
5. **Overhead as cross-subsidy.** Campaigns carry an explicit overhead
   margin (order 15–20%) that funds what no funder earmarks: curation,
   governance, audit, and the exploration tranche. The marketable regions
   fund the neglected-but-important ones by construction — the structural
   resolution of the salience-vs-mission tension.

These belong in the funder agreement and, where they touch agent conduct, in
the constitution — stated before the first dollar arrives.

### Accounting and reporting

Subsidies draw against funder balances and are spent at metered actuals when
actions execute; unspent subsidy on actions that never clear expires or
refunds per the agreement. Each executed action's ledger row records the
base-EV/subsidy split, which makes the funder report an **additionality**
statement: these actions ran that would not otherwise have run, at these
per-claim actuals. Because the graph is public, delivery is inspectable in a
way no grant report matches — here is the region, browse it — and
`marginal_yield` data makes the re-up honest: the next $10k buys these
specific under-assessed claims, not diminishing polish on finished ones.

## Ingestion under the same framework

Ingestion is priced by the same ordering, and it is a value-of-information
problem: a source's value is the expected value of the claims it yields,
which is mostly unknowable before extraction. So it stages like valuation:

1. **Triage** (cheap): metadata, abstract, citation footprint, novelty
   against existing graph embeddings, mandate coverage → a priced slate.
2. **Extraction as sensing**: the extraction pass itself reveals the real
   value, and its output re-prices the induced tree before stewardship
   spends the bulk of the money.

Grantor scouts naturally produce the ingestion slate for their region,
priced and ranked, feeding the same queue. Ingestion sits at the top of the
induced-cost funnel, so it is where EV discipline pays most — and where the
current take-what-arrives behavior is furthest from the target.

## Worked example: the AI Economics campaign

The bootstrap case. At the start the system is poor, so almost no action's
value/cost clears the bar — that is the honest price signal, not a failure.
A funder dedicates several thousand dollars to a grantor agent whose mandate
is: ingest and fund assessment of the AI-economics discourse.

1. **Scoping.** The grantor's scouts survey existing graph coverage and the
   discourse (canon, live debates), estimate region size and contestation
   mix, and price the campaign **off metered actuals** — `llm_usage` already
   knows what a stewarded claim costs per importance stratum and tier. The
   quote is "≈120 top-level claims, ≈900 subclaims, this mix, at observed
   per-claim costs = $X + contingency," not a made-up number. The quote
   document doubles as the pitch: no grant proposal in this space arrives
   with a cost model derived from production telemetry.
2. **Milestone release.** Early size estimates will be miscalibrated, so the
   first tranche funds a ~20% pilot slice; actuals recalibrate the estimate
   before the rest releases.
3. **Execution.** Seed sources flow through the normal ingestion path;
   claims tagged to the campaign drain through the one global ordering with
   the mandate's subsidy applied, flowing down the induced tree. Every call
   is tagged with the campaign in `llm_usage`.
4. **Closeout.** The report is a URL: the region, its verdicts, reasoning
   traces, per-claim costs, consultation stats — plus exactly what the
   unfunded tail was and what it would cost, which is the re-up.

Cost attribution at region boundaries: a claim already in the graph costs a
campaign nothing (it is linked, not re-created); new claims minted while
stewarding campaign work bill to the campaign. Consequence, worth stating in
every pitch: **the marginal cost of mapping a region falls as the graph
densifies** — early funders buy infrastructure that makes every later
campaign cheaper, which justifies both premium pricing now and the ask
itself. The first campaign should run semi-manually: spec by hand with agent
assistance, execute with existing metering, and let it become both the
calibration data for the quote model and the case study in the deck.

## Build order

Each phase is useful standing alone; later phases refine a loop that is
already running.

0. **Instrumentation.** Consultation counters on the read path (claim views,
   extension hits, searches returning stubs or nothing) — smallest change,
   unblocks "consequence weighted by consultation." Campaign/funder tag on
   `llm_usage` plus a cost-actuals query (per-claim cost by stratum and
   tier) — unblocks honest quoting.
1. **The scored drain.** Replace importance-order with the arithmetic
   value/cost score over existing columns (this is #172 phase 2 — the
   accrued `contestation`/`marginal_yield` data starts being read), log
   predictions to the ledger, keep the throttle. Floating deferral threshold.
2. **One grantor.** A single internal grantor agent (exploration-tranche
   mandate), reviewing the ordering weekly, with labeled overrides.
3. **Money in.** Funder balances, the subsidy ledger, the per-claim funding
   button, mandate intake review. Dollar-denominated period budget with
   envelope reporting — even unenforced at first, the weekly "where did
   compute go vs. where were the stakes" report tells us whether the
   allocator agrees with the one being run by hand.
4. **Scale.** Grantor fleets with scouts, ingestion triage/EV, LLM valuation
   at the funding boundary, per-campaign public dashboards, model-tier
   selection as f(stakes, yield) calibrated by the corpus judge.
