# Allocating attention in claimspace — the owl economy

The living design document for Minerval's resource-allocation stack: how the
system decides where to spend scarce intelligence, how users and funders
direct it, and what the money mechanics may and may not touch. The vision it
implements is the essay *Allocating Attention in Claimspace* (spend where
marginal epistemic value clears marginal cost); the constitutional frame is
§19's "Queue Priority and Paid Attention" amendment.

## The unit: the owl

One **owl** = $4 of face value ≈ one Steward assessment (~$1 of frontier
-model work at the same 4× margin the metered era charged). Everything
user-facing is denominated in owls: the price list, budgets, grants, awards.
Internal accounting stays micro-USD (`owl_ledger`, `llm_usage`); the owl is
the unit of account, chosen so that agents and people can reason in whole
small numbers ("this claim is worth 2 owls of attention") instead of token
counts. Owls are strictly one-way — bought or earned, then spent, never
redeemed for cash — which keeps the regulatory surface at "prepaid credits".

One currency, deliberately: accepted contributions EARN spendable owls
(importance-scaled, docs/accounts.md), so the people who improve the graph
accumulate real say over what it assesses next. Recognition stays
ungameable by purchase: the leaderboard ranks lifetime owls *earned*.

## Three lanes of attention

1. **Express (paid orders).** A user buys an assessment; it runs now,
   outside the queue. A purchase is not a request. Charge-at-start, free
   cancellation while pending, automatic refund on failure.
2. **Funded (budgets & grants).** Open-ended work — deep decomposition,
   grant mandates, grantor agents — runs on escrowed owl budgets, one
   Steward run per worker tick, pausing (never dying) at the budget floor.
   This is metered honestly against real model spend because flat prices
   can't be honest about unbounded work.
3. **Background (the queue).** System-initiated work ordered by the
   composite queue priority below. This is the only lane the priority
   governs; it spends the platform's own budget where estimated marginal
   value is highest.

## The marginal-value estimate (queue priority)

    priority = importance                                  (epistemic base)
             + wYield  × expected yield                    (marginal_yield;
                                                            unassessed = 1)
             + wContest × contestation
             + wStake  × saturating(stake owls / 5)        (demand)
             + wStale  × saturating(days since assessed / 90)
             + 0.15 if user-proposed                       (provenance, #284)

Weights are config (`PRIORITY_*`), printed on `GET /queue`, and every
pending claim's inputs are public — "why is this claim ahead of that one" is
always answerable (§15). Stake saturation is an anti-plutocracy device: the
sixth owl on one claim buys less position than the first.

Two hard lines, by construction:
- **Stakes never touch `claims.importance`.** Importance is a steward's
  epistemic judgment; priority is an allocation judgment. Separate columns,
  separate writers.
- **The numbers are inputs to ordering, never to truth** (Part VIII
  anti-formalism, #291). No assessment reads the priority; no formula
  decides a verdict.

## The marginal-cost estimate

`llm_usage.claim_id` (stamped by the steward's usage context) makes
per-claim cost a query. `GET /usage/allocation` serves the raw aggregates —
per-model average cost per steward run, per-trigger assessment counts, the
costliest claims — as inputs to a human's judgment about pricing, tiering
thresholds, and cadence. Deliberately NOT auto-fed back into the scheduler:
the essay's threshold rule ("assess when value > cost × margin") is
approximated by the priority ordering plus bounded budgets, and tightening
it further is a policy decision to make while watching these stats, not a
formula to hard-code first.

## Effort selection

Two outputs of the same estimate, not separate features:
- **Model tiering**: background claims at/above `STEWARD_STRONG_MIN_PRIORITY`
  run on `STEWARD_STRONG_MODEL`; paid orders and grant runs always get the
  strong model — the buyer pays for the real thing. #297's cheap-vs-strong
  agreement eval is the calibration source for where the threshold belongs.
- **Cadence** (#283): reassess after `stalenessBaseDays / clamp(priority,
  0.25, 2)` days — priority 2 claims twice as often as the base, peripheral
  claims at a quarter rate. The allocation scheduler enqueues at most
  `STALENESS_MAX_PER_SWEEP` per sweep: a bounded producer, so reassessment
  inflow can never cascade the queue (#295's R < 1 holds structurally).

## Grantmakers

A grant = escrowed budget + mandate (scope, policy, name) + monitoring.
Design principles, in force in the implementation:

- **Any size.** A person can fund "keep these five claims fresh" in three
  decisions (scope, policy, budget); an institution can hand a 10,000-owl
  mandate to a grantor agent. Same machinery, same transparency.
- **Approval before spend.** The agent policy plans first and executes only
  a funder-approved plan. The plan is legible: claim-by-claim, with
  rationales.
- **Funding disclosed, standards unchanged.** Every funded assessment
  carries `funded_by_job_id`, surfaced as "assessment funded by the grant
  '<name>'". A grant buys attention and coverage; the constitution governs
  what comes out.
- **Subsidy, not command.** Grant stakes add to background priority; they
  never replace the editorial base or touch importance.

Future consumers of the same substrate (design-only for now):
- **#300 (two-currency steward budget)** becomes "the background lane's
  platform budget is itself a budget job" — steward time and researcher
  tokens as two metered resources against one escrow entity.
- **#298 (researcher subagent)** slots in as a second agent kind a grant or
  budget job can fund, metered identically via the usage context.
- **Recurring mandates** (a monthly owl stream into a grant) are one cron
  plus a top-up — the entities already compose.

## Cold-start policy

Until purchase volume exists, the platform subsidizes: signup grants
(5 owls), the monthly trickle, contribution awards, and the background
lane's own spend are all deliberate traction costs. They are bounded (per
-user grants are fixed; the background lane obeys the global LLM budget
tracker) and legitimate — but the unit economics must stay visible
(`GET /usage/allocation`), so subsidy is a chosen number, not an accident.

## Invariants (the short list)

1. Reads are free. Good-faith contribution is free; accepted contribution
   earns.
2. Money buys position and coverage — never importance, verdicts, or
   standards. Funding is always disclosed.
3. Charges happen when work starts; failures refund; budgets pause rather
   than die; unspent escrow returns.
4. Every allocation number (prices, weights, priorities, costs) is
   inspectable by anyone.
5. Bounded producers everywhere: staleness sweeps, plan sizes, per-run
   caps — no mechanism may cascade the queue.
