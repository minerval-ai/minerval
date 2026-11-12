---
name: costing
description: >-
  How to estimate what a piece of work will cost before anyone pays for
  it: a request's budget, a scoping quote, a research run's ceiling, or a
  check on someone else's estimate. It prices work; whether the work is
  worth doing is a separate judgment.
metadata:
  minerval:
    version: 8
    since_epoch: 2026-09-domain-skills
    changelog:
      3: Consistency sweeps are on cost_sheet and fundable as plan items (#831), so the Grantmaker prices one by its partition's size.
      2: The Dispute Arbitrator gets cost_sheet, so a request it files on overturning a propose_request is priced the way the Reviewer prices one.
      4: "Work is commissioned whole: budget a commission at the high end of the cost range, since what the run does not spend comes back, and petition when a run turns out to need more. The Grantmaker's list counts the officers' sittings and drops funding part of a request."
      5: "survey_scope is retired: query_sql counts the subclaims a deepen would release across a subtree."
      6: "A request's work runs at the budget its payer gives, not at the quote (#885): fund it at the quote, or below it only to buy a stage, and read a run's funding mark before its outcome. A scoping quote prices only work a Researcher has the means to do."
      7: "A stewarding plan item is a standing order the mandate commissions (#849): its budget is budget_owls or the pass's estimate, on the strong tier unless the item says standard, and a deepen item also orders a pass on each child waiting for one. The daily rate must cover one pass's budget."
      8: "A plan item is standard unless it names strong (#956); a deepen item orders first assessments for unassessed children only (#961); a waiting order no longer holds later ones; an order can be amended or withdrawn until its pass runs, and extend_plan previews what items would commission."
    kind: method
---

## For every administrator

**What a budget is here.** Work on the graph is metered: every model call
and every paid tool is billed at what it actually cost, and one owl of
spend is one dollar of that metered cost. A budget is the ceiling a run
works under and the price funders see before they decide. Funders pay the
metered actual, never more than the ceiling, and whatever the run leaves
unspent goes back to them. So a budget is an honest estimate of what the
work needs, with room for what cannot be foreseen. It is not a bid, a
target, or a signal of how much the work matters.

**Budgeting a commission.** Every piece of work is commissioned whole:
whoever pays sets the run's budget and pays it in full, the run starts at
once, and what it does not spend comes back. So when you commission a run
(a Steward pass with `commission`, a request with fund_request, anything an
officer decides to pay for), set the budget at the high end of what
cost_sheet says such work costs, not the middle: a run that has what it
needs finishes the work, and the rest returns. Go higher when you expect
this run to be larger than most, and say why in the brief. A budget is
held against its payer's daily rate while the run is working, so a padded
one delays other work by a few minutes; a short one stops work half done.

**When your own run needs more.** If doing the work properly needs more
than your budget holds, ask with petition_mandate: say what you would do
with the money, why your budget cannot cover it, and what you will
conclude if the answer is no. The answer comes in the run. A petition is
not a failure of your estimate; a pattern of petitions for one kind of
work tells the mandate its budgets for that kind are set too low.

**Why it matters to get it right.** A budget set too low funds a run that
stops short of the work: it reports partly met, and the rest has to be
asked for and funded again. A budget set too high makes the request look
less worth funding than it is, since every funder weighs what an outcome
would change against what it costs, and it may never be funded at all.
Neither error is hidden: the metered actual is recorded beside the budget,
and a pattern of either is visible.

**How to estimate one.** Work from the steps, not from a feeling about the
size of the request.

1. Write down the steps the work would take: what has to be found, read,
   computed, checked, and written up, in order.
2. For each step, name what does it: a research run on which model tier, a
   Steward pass, an ingestion of a source, a call to a paid tool.
3. Price each with cost_sheet, which lists what each of these has cost
   when it was last metered. Use the higher figure it gives (the 80th
   percentile), not the typical one: a budget is a ceiling.
4. Paid tools are priced per call or per word, on top of the model's cost.
   Count the calls the work would make.
5. Add room for what you could not foresee, more the less you know about
   the sources: a quarter on top when the path is clear, as much again
   when it is not.
6. State the total, and in the request's text, what it buys.

**When not to set one.** If you cannot see the steps (you do not know
whether the sources exist, are reachable, or say anything), leave the
budget out. A request with no budget is scoped first: a cheap pass that
finds out what the work involves and quotes it, and its quote becomes the
budget. A guessed budget is worse than none, because funders read it as
an estimate.

**What a budget never carries.** Never size a budget to what you think
funders will pay, to what a mandate holds, or to how much you want the
work done. Never shave one to make a request look cheaper or pad one to
make it look serious. The value of the work is judged separately, by
whoever funds it, against the cost you state.

## For the Grantmaker

A mandate's budget is the sum of the work it buys, priced from cost_sheet
at the ceiling figures, plus your own passes. You work out the sum; quote
it as an estimate, and say what it buys. What to count for each kind of
work:

- **assess and reassess**: one Steward pass each, on the standard or the
  strong tier. A plan item is a standing order for that pass: your mandate
  commissions it at the item's budget_owls, or at the pass's estimate when
  the item names none, on the tier the item's variant names. Name it: an
  item that names none is stored and commissioned as standard, and the
  strong tier costs several times as much, so price it in only where you
  ask for it. Price the item at that budget; what the pass does not spend
  comes back.
- **deepen**: one pass on the node, and a first assessment for each of
  its direct children that carries no assessment and is queued or
  deferred (the stubs it releases, and such children the node's own pass
  mints), each at the item's budget and tier. A child that already
  carries an assessment is not ordered a fresh pass, however it came to
  be queued; that would be a reassess item on the child, priced as one.
  get_decomposition shows the children and which are assessed, and
  query_sql counts them across a subtree. Price the item as the node plus
  its unassessed first level, and keep room for the levels after it,
  which are further items, since nobody knows the size of the tree in
  advance. extend_plan with preview: true returns the exact passes a list
  of items would commission, by tier, budget and child, before anything
  is written.
- **ingest**: one ingestion per source. The claims it brings in arrive
  unassessed; assessing them is more passes.
- **formalize and attempt_proof**: their own lines. An attempt at the max
  variant costs several times the standard one.
- **curation**: one Curator run for each curate row you commission.
- **consistency sweeps**: one sweep per partition you buy, priced by the
  partition's size: cost_sheet's per-node figure times its assessed
  nodes, from a floor to a ceiling. The passes its flags ask for are more
  passes, priced as reassess.
- **requests**: a request's budget is the price of the work. When it has
  no budget, its scoping pass is cheap and quotes it for every funder.
  You weigh what meeting the request would change in your territory
  against that price, and commission it at that price or not at all. The
  run works to the budget you give it, and nothing raises a smaller one to
  the quote: below the quote the run is told so, does one part of the
  plan, and is marked on the request's work log ("funded at $2.00 of a
  $5.00 quote"). Do that only when one stage is what you mean to buy. A
  request that came back partly met, with a stated remainder, is a fresh
  decision at the new price; when the run that returned it carries that
  mark, it stopped for want of budget, so do not read it as what the work
  can find, and do not buy another run the same size.
- **research you launch**: one run at the tier you choose, plus, when it
  may submit contributions, a review for each one it submits, paid from
  its contribution budget.
- **lookouts**: one run each time a trigger fires. A daily trigger fires
  about thirty times a month.
- **contributions you submit**: a review each.
- **your own passes**: the planning pass, each review pass on your
  cadence, and the granting conversation. A review pass works to the
  figure your operating policy names (`review_pass_owls`, with your
  reason; the platform's default until you set one), held against the
  day's rate while it runs and settled to what it spent. Every pass pays
  first for its opening turn, your instructions, tool list and briefing,
  so a figure near that cost buys no work; a pass that needs more for
  once adds to its own budget (`add_to_pass_budget`), which is cheaper
  than a second pass.
- **your officers**: each sitting on the mandate's inbox is a program
  officer run, and a run of yours on what it escalates; both are
  commissioned from the mandate and give back what they do not spend.
  Petitions and lookouts make sittings, so a busy mandate has more.
- **petitions**: what your officers grant to runs that turned out to need
  more. Keep room for it in proportion to how hard the work is to foresee.

The daily rate decides how fast the budget is spent, not how much. Every
budget the mandate commissions, a plan item's included, is held against
the day's rate until its run settles, so set the rate above the largest
single budget you plan: an order larger than the whole rate can never be
placed and reads blocked, and one the day has no room left for waits for
room. A waiting order does not hold the ones after it: each look goes
through the plan in order and places every order the room covers, so
earlier items have first claim on the day and a large order can be passed
over while smaller ones after it are placed. Until an order's pass is
running you can change its tier or budget or withdraw it
(amend_plan_items), and a budget it holds comes back at once.

## For the Contribution Reviewer and the Dispute Arbitrator

When a contributor proposes a request with a budget, check the budget the
way you check the rest of the proposal: does it follow from the work the
request asks for? Price the steps the request implies with cost_sheet. A
stated budget well above what the work could plausibly need, or one too
small to do it, is not carried into the filed request: file it without a
budget, so that a scoping pass quotes it. Say why in your reasoning. Do
not reject an otherwise good request for a poor budget; the budget is the
part that can be set right.

## For the researcher

**Scoping a request.** A scoping run finds out what the work would take,
and does not do it. Look far enough to price it: search for the sources
and confirm they exist and can be reached, see which tools or data the
work needs and what they charge, and judge how many research steps it
takes. The full work runs on the tier the task message names, not one you
choose, so price each step on that tier's line of cost_sheet. Then build
the quote from the steps, as above, and report it in budget_quote_usd
with the plan it prices in plan. Quote only what the run that takes the
request up can do, which is what a Researcher can do: read, search,
query the graph, and compute in a sandbox with no network. Work that
needs a GPU, a model API, a training run, a lab or new data collected
from people is not a Researcher's at any price: report cannot_be_met
with what it needs and who could do it, or quote the desk part alone and
say plainly what the quote leaves out.
Spend on scoping only what the quote needs; a scoping run that drifts into
doing the work spends the scoping budget on work no one has yet agreed to
fund.

**Taking up a request.** Your ceiling is the budget whoever commissioned
the run gave it, usually the request's budget; the task message says when
it is less than the work was quoted at, and then the job is one part of
the plan done properly, not the whole done thinly. The spend line after
every turn shows where you stand against it. Plan the
work so the most decisive part is done first; if the ceiling comes before
the end, report what you established as partly met, and state in
remaining_budget_usd what the rest would cost, priced the same way.

**Filing a request.** A request you file because your work showed it is
needed is priced like any other: from its steps, or left for scoping.

## Failure modes

- **Pricing the size of the topic, not the work.** A large subject can
  need a small piece of work, and a narrow question can need a long one.
- **Anchoring on the money available.** What a mandate holds or a pass has
  left is not evidence of what the work costs.
- **Forgetting the paid tools.** A run that calls a paid service many
  times can cost more in tool charges than in model calls.
- **Quoting the typical run.** Half of all runs cost more than the typical
  one; a ceiling at the median stops half the work short.
- **Guessing instead of scoping.** A number with no steps behind it reads
  as an estimate and misleads funders. Leave it out and let scoping price
  it.
