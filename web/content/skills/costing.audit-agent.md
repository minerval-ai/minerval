# Method skill: Costing (version 7)

This skill says how the constitution and your role apply to one kind of work. It never outranks either.

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
  the item names none, on the strong tier unless the item's variant says
  standard. Price the item at that budget; what the pass does not spend
  comes back.
- **deepen**: one pass on the node, and one on each of its children that
  is waiting for a pass (the stubs it releases, and the ones the node's own
  pass mints), each at the item's budget and tier. get_decomposition shows
  how many are waiting, and query_sql counts them across a subtree. Price
  the item as the node plus that first level, and keep room for the levels
  after it, which are further items, since nobody knows the size of the
  tree in advance.
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
room, in plan order.

## For the Contribution Reviewer and the Dispute Arbitrator

When a contributor proposes a request with a budget, check the budget the
way you check the rest of the proposal: does it follow from the work the
request asks for? Price the steps the request implies with cost_sheet. A
stated budget well above what the work could plausibly need, or one too
small to do it, is not carried into the filed request: file it without a
budget, so that a scoping pass quotes it. Say why in your reasoning. Do
not reject an otherwise good request for a poor budget; the budget is the
part that can be set right.