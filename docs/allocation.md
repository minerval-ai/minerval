# Allocating attention in claimspace — the owl economy

The living design document for Minerval's resource-allocation stack: how the
system decides where to spend scarce intelligence, how users and funders
direct it, and what the money mechanics may and may not touch. The vision it
implements is the essay *Allocating Attention in Claimspace*; the
constitutional frame is §19's "Allocating Attention and Paid Attention"
section.

## The standard

One decision rule governs every action the system can take on its own
initiative — ingesting a source, assessing a claim, reassessing a stale one,
deepening a subtree, curating, escalating to a stronger model or a research
tool:

    take the actions with the highest
    expected marginal value / expected marginal cost,
    best first, up to a bounded total spend per day.

Both sides are estimates, produced by legible heuristics that start as
guesses and get revised as Minerval's evaluation machinery matures. Neither
side is ever a verdict input: the estimates order work and select effort,
and appear nowhere in an assessment.

## The unit: the owl

One **owl** = $4 face value, matching platform dollar spend one for one at
the metered cost-plus rate (~$1 of frontier-model work at the 4× margin);
that mapping is public, never a secret. Everything user-facing is
denominated in owls; internal accounting stays micro-USD (`owl_ledger`,
`llm_usage`). Owls are strictly one-way — bought or earned, then spent,
never redeemed for cash — which keeps the regulatory surface at "prepaid
credits".

One currency, deliberately: accepted contributions EARN spendable owls
(importance-scaled, docs/accounts.md), so the people who improve the graph
accumulate real say over what it assesses next. Recognition stays
ungameable by purchase: the leaderboard ranks lifetime owls *earned*.

## Caps, not prices

Nothing has a fixed price; everything is metered at cost-plus. A quoted owl
figure ("assess this claim: up to 1 owl") is a **cap** — the most the
operation may cost, set near its average cost so a button can carry one
honest number. The cap is charged when the work starts, the meter records
the real cost, and the unused fraction settles back to the balance
(`meter_settlement` ledger rows). A run that exceeds its cap is absorbed by
the platform: the ceiling is the user's to rely on, and at a 4× margin
losing on the occasional expensive run of a public good is fine. Fixed
prices anywhere would distort the very agents that must reason in value
over cost.

## Three lanes of attention

1. **Immediate (paid orders).** A user buys an assessment; it runs now,
   outside the background lane entirely. Queue-jumping by payment is fine
   and good — the buyer funds their own marginal cost, under a cap.
   Cap-charge at start, free cancellation while pending, settlement of the
   unused fraction at completion, automatic refund on failure.
2. **Funded (budgets & grants).** Open-ended work — deep decomposition,
   grant mandates, funded ingestion — runs on escrowed owl budgets, metered
   honestly against real model spend, pausing (never dying) at the budget
   floor. Unspent escrow returns.
3. **Background (the platform's own spend).** Not a queue: a candidate set.
   Each drain pass takes the pending claim whose expected value per owl of
   expected cost is highest, until the day's background budget
   (`BACKGROUND_DAILY_BUDGET_OWLS`) is spent. Candidates that never clear
   the bar remain embedded stubs; that is the intended steady state.

## The expected-value estimate (per assessment)

    value = importance                       (consequence-if-wrong, §19)
          × (floor + (1 − floor)×contestation)
          × expected quality gain            (marginal_yield; 1.0 when
                                              unassessed; revived by
                                              staleness over 90 days)
          + 0.5 × saturating(stake owls / 5) (paid demand)
          + 0.15 if user-proposed            (provenance, #284)

The multiplicative core is the essay's heuristic for the marginal value of
assessing a claim at a given model and effort level: importance ×
contestedness × quality-improvement-from-marginal-compute. Every knob is
config, printed on `GET /queue`, and every pending claim's inputs are
public — "why is this ahead of that" is always answerable (§15). Stake
saturation is an anti-plutocracy device: the sixth owl on one claim buys
less standing than the first.

Two hard lines, by construction:
- **Stakes never touch `claims.importance`.** Importance is a steward's
  epistemic judgment; the value estimate is an allocation judgment.
  Separate columns, separate writers.
- **The numbers are inputs to ordering, never to truth** (Part VIII).

## The expected-cost estimate

Every action type needs a denominator before it runs
(`cost-estimate-service.ts`): config priors (`EST_*`) that yield to live
rolling averages of recent metered runs once enough exist. Estimating a
cost must never rival the cost of doing the thing, so estimates are one
cached aggregate query. `GET /usage/allocation` still serves the raw
aggregates for human calibration of the priors, tiering thresholds, and
cadence.

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
