---
name: costing
description: >-
  How to estimate what a piece of work will cost before anyone pays for
  it: a request's budget, a scoping quote, a research run's ceiling, or a
  check on a budget someone else stated. A method skill: it belongs to no
  domain and is offered to every role that files, scopes, funds, or reviews
  requests. Use it when you put a number on work; it does not decide
  whether the work is worth doing, which is a judgment of value.
metadata:
  minerval:
    version: 1
    since_epoch: 2026-09-domain-skills
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

You price plans with estimate_costs, and the standard above is the same
one: quotes are estimates and ceilings, and work is metered. When you put
money toward a request with fund_request, its budget is the price, and
you weigh what meeting the request would change in your territory against
it. A request that came back partly met with a stated remainder is a
fresh decision at the new price, not a commitment to finish what you
began. When a request in your scope has no budget, funding its scoping
pass is cheap and tells you and every other funder what the work would
cost.

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
takes and on which tier. Then build the quote from the steps, as above,
and report it in budget_quote_usd with the plan it prices in answer.
Spend on scoping only what the quote needs; a scoping run that drifts into
doing the work spends the scoping budget on work no one has yet agreed to
fund.

**Taking up a request.** Your ceiling is the request's budget, and the
spend line after every turn shows where you stand against it. Plan the
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
