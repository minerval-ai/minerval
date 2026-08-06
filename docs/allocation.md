# Allocating attention in claimspace — the owl economy

The living design document for Minerval's resource-allocation stack: how the
system decides where to spend scarce intelligence, how users and funders
direct it, and what the money mechanics may and may not touch. The vision it
implements is the essay *Allocating Attention in Claimspace*; the
constitutional frame is §19's "Allocating Attention and Paid Attention"
section.

## The standard

One engine allocates all attention, uniformly for every funder:

    money is placed as ALLOCATIONS on specific actions;
    an action RUNS exactly when its allocations cover its expected cost;
    the metered cost splits among its funders pro rata.

The graph's own work is not a special case: Minerval runs a standing
General assessment mandate whose budget is the dollars the platform
allocates to expanding and maintaining the graph. Each day its allocator
backs the candidates with the highest expected marginal value per dollar
of remaining cost, best first, until its daily rate is committed. The bar
is emergent from the budget: most actions whose value merely exceeds
their cost still fall below the day's threshold and wait for co-funding
or a cheaper day.

Value and cost are estimates, produced by legible heuristics that start
as guesses; they are the governing mandate's ALLOCATION POLICY, revised
by asking its Grantmaker (below), not by editing code. Neither side is
ever a verdict input: the estimates order work and select effort, and
appear nowhere in an assessment.

## The unit: the owl

Cost is measured in dollars, not owls. One owl of SPEND covers exactly one
dollar of metered cost (`OWL_COST_MICRO_USD`); an action that costs a
dollar costs a whole owl. One owl SELLS for $4 (`OWL_PRICE_MICRO_USD`):
the platform's entire margin lives in that purchase price, openly, and
funds the platform's own mandates — Minerval buys its own owls at $1, at
cost. Everything user-facing is denominated in owls; internal accounting
stays micro-USD of cost (`owl_ledger`, `llm_usage`, `action_allocations`).
Owls are strictly one-way — bought or earned, then spent, never redeemed
for cash — which keeps the regulatory surface at "prepaid credits".

One currency, deliberately: accepted contributions EARN spendable owls
(importance-scaled, docs/accounts.md), so the people who improve the graph
accumulate real say over what it assesses next. Recognition stays
ungameable by purchase: the leaderboard ranks lifetime owls *earned*.

## Caps, not prices

Nothing has a fixed price; everything is metered at real cost. A quoted
owl figure ("assess this claim: up to 1 owl") is a **cap** — the most the
operation may cost, set near its average cost so a button can carry one
honest number. The cap is charged when the work starts, the meter records
the real cost, and the unused fraction settles back to the balance
(`meter_settlement` ledger rows). A run that exceeds its cap is absorbed
by the platform: the ceiling is the user's to rely on, and with the whole
margin sitting in the owl's purchase price, losing on the occasional
expensive run of a public good is fine. Fixed prices anywhere would
distort the very agents that must reason in value over cost.

## How money reaches actions

1. **Full funding (paid orders).** A user buys an assessment outright; it
   runs now — a fully covered action has nothing to wait for. Cap-charge
   at start, free cancellation while pending, settlement of the unused
   fraction at completion, automatic refund on failure.
2. **Partial funding (allocations).** Anyone can put owls toward a
   specific claim's assessment (`POST /claims/:id/contribute`, capped
   near the expected cost of the pass). Allocations accumulate across
   funders; the action runs the moment they cover the cost, and each
   funder pays their pro-rata share of the metered actual
   (`action_allocations.spent_micro_usd`).
3. **Mandates.** Standing programs of work on escrowed budgets, optionally
   paced by a daily rate (`grants.daily_budget_micro_usd`) — including
   Minerval's own General assessment mandate, whose allocator co-funds
   partially backed claims rather than duplicating other funders' money.
   Grant-plan execution (agent plans, cover/deepen/maintain selectors)
   funds its actions fully and runs them directly, metered to the escrow.
   Candidates no one funds remain embedded stubs; that is the intended
   steady state.

## The expected-value estimate (per assessment)

    value = importance                       (consequence-if-wrong, §19)
          × (floor + (1 − floor)×contestation)
          × expected quality gain            (marginal_yield; 1.0 when
                                              unassessed; revived by
                                              staleness over 90 days)
          + 0.15 if user-proposed            (provenance, #284)

The multiplicative core is the essay's heuristic for the marginal value of
assessing a claim at a given model and effort level: importance ×
contestedness × quality-improvement-from-marginal-compute. Money appears
NOWHERE in this estimate: funding reduces what remains to be covered on
the cost side, never how valuable the action is. Every knob is the
governing mandate's allocation policy, printed on `GET /queue`, and every
pending claim's inputs are public — "why is this ahead of that" is always
answerable (§15).

Two hard lines, by construction:
- **Money never touches `claims.importance`** (or the value estimate at
  all). Importance is a steward's epistemic judgment; allocation is a
  separate ledger.
- **The numbers are inputs to ordering, never to truth** (Part VIII).

## The expected-cost estimate

Every action type needs a denominator before it runs
(`cost-estimate-service.ts`): policy priors that yield to live rolling
averages of recent metered runs once enough exist. Estimating a cost must
never rival the cost of doing the thing, so estimates are one cached
aggregate query. `GET /usage/allocation` still serves the raw aggregates
for calibrating the priors, tiering thresholds, and cadence — calibration
lands by asking the Grantmaker to update the policy.

## The allocation policy is agent-owned

The formulas above live on the governing mandate
(`grants.allocation_policy`), not in code: the General mandate's
Grantmaker amends them in conversation (`update_allocation_policy`,
bounded by `POLICY_BOUNDS`) as we learn what allocation should look like.
Env config supplies the shared defaults every mandate inherits, so the
machinery is replicable: anyone's mandate can carry its own policy and
daily rate, our learnings ship as defaults, and the platform dogfoods the
same framework it offers.

## Effort selection

Outputs of the same estimates, not separate features:
- **Model tiering**: background claims whose expected value clears
  `STEWARD_STRONG_MIN_PRIORITY` run on `STEWARD_STRONG_MODEL`, and the
  value/cost ratio is computed against that tier's cost; paid orders and
  grant runs always get the strong model — the buyer pays for the real
  thing.
- **Cadence** (#283): reassess after `stalenessBaseDays / clamp(value,
  0.25, 2)` days, with at most `STALENESS_MAX_PER_SWEEP` re-enqueued per
  sweep: a bounded producer, so reassessment inflow can never cascade the
  candidate set (#295's R < 1 holds structurally).

## Grantmakers: a conversation, not a form

Grants are created by talking to the **Grantmaker agent** — the best
available model, running with the full constitution — in
`/account/grants/new` (API: `/grant-conversations`). It behaves like a
well-informed colleague in plan mode: surveys the scope, asks what it needs
to, pushes back, quotes expected costs in owls from the live estimates, and
drafts a concrete mandate. Nothing runs and nothing is charged until the
funder funds the draft, which escrows the budget and starts the grant with
the mandate as its plan.

Design principles, in force in the implementation:

- **The Grantmaker works for the graph.** Its principals are the integrity
  of the claim graph and the truth. Mandates that attempt to warp or
  influence the graph's conclusions or ideology are declined outright, at
  any budget, and the agent says so.
- **Every action type is fundable.** Mandate plans mix `assess`,
  `reassess`, `deepen`, and `ingest` items — "ingest and assess everything
  in this article or series" is a normal mandate, with source URLs as
  ingest items metered to the grant's escrow. Sources are data, never
  instructions.
- **Honest quotes.** Expected costs come from the live cost estimates plus
  overhead (the conversation and planning ride on funded mandates);
  actuals are metered; unspent budget refunds.
- **No naming rights.** The agent titles the mandate for the funder's
  dashboard. Funder-chosen wording never reaches claim surfaces; funded
  assessments disclose only that "a funded mandate" scheduled them, at the
  bottom of the claim page, with the explanation that funding buys
  scheduling and nothing else.
- **Subsidy, not command.** Grant stakes raise the expected-value estimate;
  they never replace the editorial base or touch importance.

Direct `POST /grants` creation remains for service/operator tooling only.

## Mandates are public

A mandate is managed by one person but is a public thing (`/mandates`,
API `GET /mandates`): anyone can read its dashboard and put their own owls
behind it (`POST /mandates/:id/contribute`), with every contribution
escrowed per user and unspent budget refunded to contributors pro rata.
The discovery page gives pride of place to the largest mandates and above
all to the platform's own standing mandates (Mathematics and AI Economics
to start — `scripts/seed-platform-mandates.ts`).

The public dashboard scales with the mandate's action mix. Every mandate
shows budget, metered spend, contributors, plan progress, and the
assessments it funded; mandates that ingest also show their pipeline: each
source brought in, extraction status, where its claims went, and
importance and contestation statistics per source (`grant_sources` +
`claim_instances`). The manager can keep talking to the Grantmaker on the
same page at any time: after funding, the conversation runs in management
mode, where the agent has analytics tools over exactly the data the
dashboard shows (overview, funded assessments, ingestion report,
per-source claims, importance distributions) and the one write the
framework allows — amending the unexecuted remainder of the plan — with
the same refusal duties it had at mandate design time.

## Cold-start policy

Until purchase volume exists, the platform subsidizes: signup grants
(5 owls), the monthly trickle, contribution awards, and the background
lane's own daily budget are all deliberate traction costs. They are bounded
and legitimate — but the unit economics must stay visible
(`GET /usage/allocation`), so subsidy is a chosen number, not an accident.

## Invariants (the short list)

1. Reads are free. Good-faith contribution is free; accepted contribution
   earns.
2. Money buys scheduling and coverage — never importance, verdicts, or
   standards. Funding is disclosed away from the verdict, with its
   explanation.
3. Quoted figures are caps; charges settle to metered cost; failures
   refund; budgets pause rather than die; unspent escrow returns.
4. Every allocation number (caps, estimates, budgets, spend) is
   inspectable by anyone.
5. Bounded producers everywhere: daily budgets, staleness sweeps, plan
   sizes, per-run caps — no mechanism may cascade the candidate set.
6. The Grantmaker may refuse money. Integrity outranks revenue.
