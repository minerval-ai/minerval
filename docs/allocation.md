# Allocating attention in claimspace — the owl economy

The living design document for Minerval's resource-allocation stack: how the
system decides where to spend scarce intelligence, how users and funders
direct it, and what the money mechanics may and may not touch. The vision it
implements is the essay *Allocating Attention in Claimspace*; the
constitutional frame is §19's "Allocating Attention and Paid Attention"
section.

## The standard

One engine allocates all attention, uniformly for every funder, and it is
built as a hard split between MECHANISM and JUDGMENT.

**The mechanism is the action ledger** (`actions` +
`action_allocations`): one row per potential action — assess this claim,
ingest that source, plan that mandate — with money placed as ALLOCATIONS
on those rows by any mix of mandates and people:

    an action RUNS exactly when its allocations cover its expected cost;
    the metered cost splits among its funders pro rata;
    nothing else anywhere decides what runs.

Alternative ways of doing the same thing (a standard-model pass vs. a
strong-model pass; later: effort levels, tools) are sibling rows in an
EXCLUSIVE SET (`exclusion_group`): at most one runs, resolved by a pure
function of the allocations — most backing wins, ties go to the cheapest,
and an allocation pinned to a losing sibling is RELEASED back to its
funder, not spent. An unpinned allocation ("assess this claim, however")
counts toward every sibling and is consumed by whichever wins.

**The judgment is each mandate's own** (`mandate_valuations`): every
mandate values only the actions it knows and cares about — sparse by
design; the Mathematics mandate holds no opinion on a politics claim —
by its own definition of importance. A mandate's SCOPE IS ITS WORDS:
which actions fall under it is a judgment call made by its Grantmaker
agent, never by a keyword filter. (The one exception is the General
assessment mandate, whose scope genuinely is "everything" and whose
valuations are its published formula — itself agent-amendable policy.)
Each mandate's allocator (allocation-service.ts) then ranks MARGINAL
INCREMENTS by value per dollar — cover the cheap variant; upgrade to the
dear one only when Δvalue/Δcost also clears — and funds them best-first
until its daily rate is committed. The bar is emergent from the budget:
most actions whose value merely exceeds their cost still fall below the
day's threshold and wait for co-funding or a cheaper day.

Value and cost are estimates; cost priors and formula knobs are each
mandate's ALLOCATION POLICY, revised by asking its Grantmaker, not by
editing code. Neither side is ever a verdict input: the estimates order
work and select effort, and appear nowhere in an assessment.

## Mandates steward themselves: the review pass

There can be no human bottleneck between a funded mission and the work.
On a cadence (and on demand — see continue_review), the ledger opens a
`mandate_review` action for every active mandate, self-funded from its
escrow, and the engine executor runs the mandate's Grantmaker in review
mode (llm/agents/mandate-review.ts) with the affordances anyone entrusted
with a budget and a mission would need:

- **survey the territory**: the graph (search_claims, survey_scope,
  list_open_actions) AND the open web (web_search) — finding where the
  good physics papers are is the agent's job;
- **a workspace** (`grants.workspace`): the agent's own durable working
  document, read back in full every pass — its map of the territory,
  source backlog, strategy. Mandate-scale missions are impossible
  without working memory;
- **write valuations** (set_valuations): value 0–10 with rationale, over
  exactly the actions it judges relevant — this is its spending judgment;
- **grow its own plan** (extend_plan): append the ingest/assess items it
  discovered; each is priced, escrow-bounded, and executes through the
  ledger;
- **pace itself** (set_daily_rate) and **chain passes**
  (continue_review): a pass that has more to do runs another immediately,
  bounded by MANDATE_REVIEW_MAX_PASSES_PER_DAY on the funding side — cost
  discipline lives in the mechanism, never in narrowed affordances;
- **move money** (regrant, spawn_mandate — below) and **close the
  mission** (complete_mandate): an exhausted plan is a waypoint, not an
  end; only the agent's judgment (or the funder) completes an
  agent-stewarded mandate.

Every pass is metered under a cap; the refusal duties that govern mandate
design govern review passes equally; the pass ends with a note recorded
on the mandate's public page. Known gap, deliberately next: a bulk
ingestion primitive ("ingest what this listing/feed points to") so a
discovered index becomes a program of work in one plan item instead of an
enumeration.

## Regrants: mandates fund mandates, as peers

All grants live on the same level: any mandate can be funded separately
(user contributions) AND put its own budget behind other mandates
(`regrants`). That is how a mandate carves its ingestion out to another
Grantmaker (spawn_mandate: a NEW peer mandate in planning, with its own
budget, its own agent, separately fundable by anyone), or backs a
sibling already covering part of its mission (regrant). A regrant moves
escrowed budget job-to-job: it counts against the source's committed
money (headroom, floor checks), joins the target's refund basis (the
source's share of the target's unspent budget flows back to its escrow,
pro rata with user contributors), and buys the source NO say over the
target's judgment — money moves between mandates; command never does.

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
   near the expected cost of the pass). A reader's chip-in is UNPINNED —
   it funds "assess this claim", not a model choice, so it counts toward
   whichever variant wins. Allocations accumulate across funders; the
   action runs the moment they cover the cheapest variant's cost, and
   each funder pays their pro-rata share of the metered actual
   (`action_allocations.spent_micro_usd`).
3. **Mandates.** Standing programs of work on escrowed budgets, optionally
   paced by a daily rate (`grants.daily_budget_micro_usd`) — including
   Minerval's own General assessment mandate. A mandate's allocator
   co-funds partially backed actions (allocating cost minus existing
   backing) rather than duplicating other funders' money, and pins its
   upgrade increments to the strong variant, where they are refunded if a
   cheaper sibling wins after all. Grants fund their OWN work the same
   way: planning runs, mandate reviews, and plan ingest items are ledger
   actions fully allocated from the grant's escrow and executed by the
   engine executor (workers/engine-executor.ts) — an ingest action's cost
   is consumed when the extraction's metered cost lands, so shares follow
   real spend. Candidates no one funds remain embedded stubs; that is the
   intended steady state.

## The expected-value estimate (per assessment)

    value = importance                       (consequence-if-wrong, §19)
          × (floor + (1 − floor)×contestation)
          × expected quality gain            (marginal_yield; 1.0 when
                                              unassessed; revived by
                                              staleness over 90 days)
          + 0.15 if user-proposed            (provenance, #284)

The multiplicative core is the essay's heuristic for the marginal value of
assessing a claim at a given model and effort level: importance ×
contestedness × quality-improvement-from-marginal-compute. The strong
variant's value is the standard's × `strong_gain_multiplier` (a policy
knob; the marginal-return rule decides whether the upgrade is bought).
Money appears NOWHERE in this estimate: funding reduces what remains to
be covered on the cost side, never how valuable the action is. Every knob
is the mandate's allocation policy, rendered with its allocation view on
its page (`GET /mandates/:id/allocation`) — aggregate tiles and a
value-per-owl histogram first, drill-down on demand, the tail summarized:
at graph scale a flat table of every potential action would hide more
than it shows, and navigability is what makes the transparency real. The
`claims.queue_priority` column survives only as a display cache of the
General mandate's standard-variant valuation.

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
- **Model tiering by marginal return**: when `STEWARD_STRONG_MODEL` is
  set, every assess/reassess exclusive set carries a strong-variant
  sibling, and the decision between them is the funders': an allocator
  backs the upgrade only when Δvalue/Δcost clears the same bar as the
  money's next-best use. There is no value threshold that flips the tier
  — "how to do the thing" is decided by the same economics as "whether
  to do the thing at all". Paid orders always get the strong model — the
  buyer pays for the real thing.
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
- **Subsidy, not command.** A mandate's money covers costs on the ledger;
  it never enters the value estimates and never touches importance.

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

## Prizes and attempts

Mathematics brings three new kinds of action to the ledger and one thing
that is not an action at all. Three things are kept apart, and confusing
them is how the invariants below would break: an **allocation** is money
placed on an action so it runs (spend, metered and settled); a **bounty**
is money offered for an answer, held until earned, funding nothing on the
ledger; a **prize payout** is the discharge of that liability, in owls.
The reader-facing account is docs/prizes.md; the mechanism is
docs/mathematics.md, sections 7 and 8.

**The three action kinds.** `formalize` (the Steward drafts, elaborates,
and publishes a formal statement, then a second Steward in a fresh context
reviews it: two strong-model passes), `attempt_proof` (the platform's
solver runs for hours against a published statement; variants `standard`
and `max`, an exclusive set per attempt epoch, so a closed attempt never
reopens and a later attempt is a new group), and `prize_review` (the
cold-lane check, the Reviewer run, the Steward's fidelity judgment, the
audit, and any fresh replay for one prize claim). The first two are
ordinary ledger actions: the Mathematics mandate's Grantmaker values them
(a formalization is cheap and enabling; an attempt is expected information,
importance × tractability × an information multiplier of 1.0 to 2.0 for
sub-results several open problems rest on, with the tractability stated in
the rationale), its allocator funds them from the mandate's escrow inside
its day room, and their metered cost, Lean compute included, lands on
`llm_usage` under the funding job like any other spend. Cost priors are
policy keys on the mandate (`est_formalize_cost_owls`,
`est_attempt_standard_cost_owls`, `est_attempt_max_cost_owls`,
`est_prize_review_cost_owls`) that yield to the live p80 once five runs
exist. Because the allocator skips an increment larger than the day's room
outright, the mandate's daily rate must exceed one attempt's estimate or
attempts never fund.

`prize_review` is funded differently, because a mandate's escrow can be
paused, exhausted, or closed while a claim waits, and a claimant must never
pay for the review of a submission. When a bounty opens, the platform
mints owls worth `PRIZE_REVIEW_RESERVE_FRACTION` (0.10) of its amount, at
cost, into a platform-owned prize-review reserve job, outside any mandate's
day room, as a hold releasable only to `prize_review` actions on that
bounty's claims. The prize-check worker is the executor: it claims each
such action, runs the check, the Reviewer, and the Steward under that job,
and completes the action with the metered amount; the unspent remainder
returns when the bounty closes. The reserve is an `admin_adjust` mint like
the seed's, never a draw on the prize fund, which the ledger cannot see.
The mandate page shows the reserve and its spend beside each bounty.

**A bounty is not an allocation.** It appears on no action, enters no
`mandate_valuations` row, and reduces nothing that remains to be covered.
The constitutional channel for demand to move scheduling is an allocation
on the attempt action, which the Grantmaker may place and the mandate page
discloses; a bounty moves nothing. Bounties are cash only, drawn from a
per-domain prize fund (`prize_pools`, `mathematics` first) whose entries
are the platform's deposits and, later and only after counsel, fund-level
sponsorship with Minerval as sole obligor. Owls never fund a bounty: an owl
that could become a winner's owl would be a transfer of owls between
people, which nothing in the system permits and which the owl's standing
as prepaid credit depends on. The mandate spends owls on `formalize`,
`attempt_proof`, and `prize_review`, which is compute, not prize money.

**The fund's three numbers.** Only the first is stored:

    balance   = SUM(prize_pool_entries.amount_micro_usd)
    reserved  = SUM(bounties.amount_micro_usd) over live bounties
                (open, claim_pending, house_result_pending, rebinding)
    available = balance - reserved

A bounty opens only when `available` covers it; nothing is posted when a
bounty opens or closes. The only debits are `owl_prize`, `defect_award`,
`review_award`, `withholding_remitted`, and, only when a cash rail exists,
`payout`; each consumes the bounty's reservation where one exists. A
dollar is promised once, in `reserved`, and spent once, in an entry.

**Posting is two-pass, and confirmed above a threshold.** The Grantmaker's
`post_bounty` records an intent on the mandate in one review pass, and only
a call from a later pass, a fresh context re-judging the mission, opens it.
Below `BOUNTY_AUTONOMY_THRESHOLD_USD` (default $1,000) the two passes alone
open the bounty, so the Grantmaker determines and funds ordinary prizes
without anyone's signature; at or above it the posting waits for a human
confirmation (`POST /bounties/:id/confirm`, operator key). A public reward
offer binds the company until revoked with equal publicity, and the review
pass reads the open web in the same context as the tool; that is why a
binding offer, and only that, waits on a person. The work (assessments,
formalizations, attempts) proceeds without anyone's signature, so this is
not the human bottleneck §19 forbids. Mechanical bounds besides: a
`published` statement past its review period that the solver has attempted
without settling; cash within `available` and within per-pass and per-day
fractions of the fund; at most `MAX_BOUNTY_PER_CLAIM_USD` ($5,000 in v1)
per claim; one live bounty per claim.

**The accounting truth of an owl prize.** A prize of N dollars paid in owls
mints N owls with ledger reason `prize_award`, and the fund posts an
`owl_prize` debit of N dollars in the same transaction. When spent, the
owls cover about N dollars of metered cost, paid by the platform to its
providers as they are spent; the liability is measured at cost, one dollar
per owl, like every owl outstanding, and it is backed by the N dollars the
fund debited. The fund's balance is therefore what remains to be offered,
and since the fund never posts more in open bounties than its balance, no
owl a prize can ever mint is unbacked. The sale margin forgone (owls at
one per dollar are four times the purchase rate) is disclosed, never
booked. For the platform an owl prize is never dearer than the dollars set
aside and cheaper by whatever fraction is never spent; both readings are
shown on the fund's page. Prize owls never expire, are never transferable,
and never become cash; `owls_prized_micro_usd` is kept apart from
`owls_earned_micro_usd` so the leaderboard keeps its meaning
(docs/accounts.md).

**The platform is never a claimant.** If the solver produces an accepted
check on a bounty-bearing statement, the worker moves the bounty to
`house_result_pending` in the transaction that closes the attempt, the
Steward judges fidelity, and `mark_problem_solved_by_platform` closes the
bounty `resolved_internally`: no prize is paid, the proof is published,
and the reservation returns to the fund. A submission whose source matches
an attempt-mode check is rejected as a copy of the platform's own work; a
human claim filed before the attempt completed is judged first.

## Cold-start policy

Until purchase volume exists, the platform subsidizes: signup grants
(5 owls), the monthly trickle, contribution awards, and the General
assessment mandate's own daily rate are all deliberate traction costs. They are bounded
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
7. A bounty is not an allocation: it funds nothing, enters no valuation,
   and reduces nothing that remains to be covered.
8. Prize money never enters a valuation, an importance, an assessment, or
   a standard; assessments and their reasoning never mention money.
9. Owls never fund a prize. Prize money is cash in a fund the ledger cannot
   see, and every prize owl is backed by a dollar the fund debited when the
   owl was granted.
10. The platform is never a claimant. A house solve closes the bounty
    unpaid and publishes the proof.

