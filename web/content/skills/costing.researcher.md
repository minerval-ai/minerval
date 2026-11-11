# Method skill: Costing (version 6)

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