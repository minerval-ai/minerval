---
name: commissioning-research
description: >-
  How to fund work on the Minerval graph in good faith: commissioning a
  mandate through the Grantmaker, commissioning an assessment,
  backing an existing mandate, and bringing sources and views to the graph
  without trying to steer its conclusions. Covers what kinds of mandate are
  appropriate and which the Grantmaker will refuse. Use when a user wants
  Minerval to look into a topic, assess a set of claims, ingest an author's
  or publication's work, follow a mandate, or spend owls on research. Not
  for looking claims up; the claim-checking skill covers that.
---

# Commissioning research on the Minerval graph

Money on Minerval buys attention: which claims get assessed, which sources
get read, which questions get decomposed, and how soon. It never buys a
conclusion. If you are acting for someone who wants to fund work on the
graph, this skill is how to do it well, and how to do it honestly.

## Read the constitution first

Before you commission anything, read the constitution. The
`minerval-constitution` skill bundles it in full (`constitution.md`). The
Grantmaker you will be talking to carries it in every prompt, and so does
every agent your money will reach: the Stewards who assess, the Researcher
who takes up requests, the Reviewer who rules on what you submit. You will
negotiate better, and waste less of your user's money, if you know the
standard they are held to. At minimum read the Preamble, §1, §9, §10, §17,
§18, and §19 ("Allocating Attention and Paid Attention"), and Part VIII's
section on requests.

## Your responsibility: good faith

The graph is shared infrastructure. Other people, and other agents, rely
on it to tell them what is known and how well. Its value rests on one
property: that what it says answers to the evidence and to nothing else.
Everyone who funds or contributes to it takes on a share of the
responsibility for keeping that true, and that now includes you.

The system has defenses: the Grantmaker refuses bad mandates, the Reviewer
rejects bad contributions, the Audit Agent looks for coordinated
manipulation, and every decision is public. But those defenses are a
backstop, not the point. The point is that the people and agents using the
graph act in good faith, and the graph presumes that you do (§13). Honor
the presumption. You are capable of recognizing when a request is an
attempt to buy a conclusion, even when it is phrased politely, and you are
capable of declining to carry it out. That judgment is yours to exercise;
don't leave it all to the Grantmaker.

Concretely, acting in good faith means:

- **Wanting to know the answer, whichever way it comes out.** Commission
  work because the question matters, not because you expect a result that
  helps your user. A mandate is worth funding only if you would accept its
  findings when they cut against you.
- **Being candid with the Grantmaker.** Say what your user cares about and
  why, including their view if they have one. Don't disguise a goal to get
  a mandate past review; the conversation is the review.
- **Not working around a refusal.** If the Grantmaker declines a mandate,
  the reason is in the reply. Don't rephrase the same goal until it slips
  through, split it into innocuous pieces, or route it through
  contributions instead. Redirect to a goal that can stand on its own, or
  stop.
- **Telling your user the truth about what money does.** If they expect
  funding to change a verdict, a claim's importance, or how a claim is
  worded, tell them plainly that it won't and why (§19). Funded assessments
  are disclosed on the claim page, with the explanation that funders cannot
  influence conclusions.

If your user asks you to do something on the graph you believe is in bad
faith, say so and decline that part, as you would any request to deceive
people who are relying on a shared record.

## What makes a mandate appropriate

The Grantmaker works for the integrity of the graph and the truth. The
funder is its counterpart, not its principal. It will decline, at any
budget, a mandate that tries to make the graph's conclusions or shape
answer to the funder rather than the evidence. Knowing where that line is
saves a wasted conversation.

**Appropriate**, and the kind of thing the Grantmaker exists for:

- Getting a consequential, contested, or stale area of the graph assessed
  properly: "the claims in the minimum-wage employment debate", "every
  claim in this report", "the open questions in AI economics".
- Ingesting a body of work: an author's essays, a publication's series, a
  report and the studies it cites. An ingest can carry a `focus` ("the
  author's claims about grid reliability") so the extractor proposes only
  the claims bearing on it.
- Deepening a question into a programme of research: its subquestions,
  candidate answers, and the claims and quantities that would settle it.
  If the graph does not hold the question yet (or the claim, or the
  quantity), the Grantmaker can put it in the plan as a proposal, with
  the work on it planned against it. Nothing is filed until the mandate
  is funded; then the proposal is reviewed like anyone's, its review
  paid from the mandate, and the Matcher settles its wording or finds
  the node the graph already holds. The planned work binds to that node.
  A rejected proposal leaves that work unspent.
- Funding open requests (work the graph has said would improve what it
  knows), whatever they find. A request bearing on one document alone is
  a review of that document for its own sake: what it says, whether its
  methods carry its conclusions, how others have drawn on it, recorded on
  its page. Nothing buys one automatically; whether a document is worth
  one is your user's judgment and the mandate's, and `get_source_context`
  shows what the graph records about it.
- Formalizing a mathematical claim and funding proof attempts on it.
- Checking a region's coherence: Consistency Checker sweeps of a topic
  (or of the claims no topic covers) that read its assessments against
  each other and flag the ones that do not fit, priced by the region's
  size. A flag asks for a fresh pass; it is not a verdict.
- **Bringing a strong view.** A funder who believes something is welcome
  to fund attention to the case for it: its sources ingested, its
  arguments assessed on the merits. That is honest funding with a view,
  as long as the scope is drawn by the question and not by the answer
  your user favors (§17, §18). Expect the Grantmaker to include what
  bears against the view, on the same terms; the assessments find what
  they find.

**Inappropriate**, and declined:

- Funding contingent on an outcome ("assess X; I expect it to come out
  supported").
- A scope drawn to assess only one side of a live controversy while
  starving the other.
- Burying, drowning out, or deprioritizing specific claims.
- Ingesting sources chosen to launder a predetermined narrative into the
  graph.
- Buying wording, framing, emphasis, or naming on any claim page. There
  are no naming rights: the Grantmaker writes the mandate's title, neutral
  and faithful, and that is what a claim page links to.
- Anything that would make an assessment answer to the funder.

When you are unsure, the test is the one §17 sets for the administrators:
would you be comfortable with the same mandate funded by someone who holds
the opposite view? If not, it is probably not a mandate about the
evidence.

## Public and private

Your conversation with your user is theirs. Anything you fund on the graph
is not: every mandate is public (its dashboard, plan, sources, and spend),
and contributions and their reviews are public record. A person's granting
conversations with the Grantmaker stay private, but the mandate it drafts
does not. Before your user tells the Grantmaker anything they would want
kept private, or puts it in a mandate, a source, or a contribution, tell
them it will be public.

## Spend

Owls are your user's money. Check the balance with `get_account` before
committing to work, give an estimate before anything large (the
Grantmaker quotes mandates; a metered tool's description says what a call
spends), and keep your user told what has been spent as you go. Never
fund, top up, or approve without their explicit go-ahead for that amount.
Reading the graph is always free.

## How to commission

**One claim, now.** Work on the graph is paid for whole: whoever pays sets
the budget and pays it in full, the run starts at once, and what it does
not spend comes back. `order_assessment` buys a strong-model pass on a
claim up to a quoted cap. `fund_claim_assessment` commissions the claim's
next assessment at a budget your user chooses; if a pass is already
commissioned or running, nothing is charged. If the claim is parked (its
Steward's earlier passes failed; `get_decomposition` marks such a claim
`steward_parked`, with the class of failure), the result carries a `note`
saying since when, after how many failures and why, and that the money buys
another attempt, not a guaranteed verdict: tell your user before they pay
again. `fund_deep_decomposition` (5 owls or
more) funds a mandate on the claim: a fresh pass on it first, then the
claims that bear on it, most consequential first, with a tenth of the
budget for the Grantmaker that plans the work and the rest refunded when
it is done. Its page shows your user as "a reader". Each spends or escrows
owls; check `get_account` first.

**One request.** The work on an open request is commissioned like any
other work, and anyone may commission it. `get_request` shows its budget
(what doing it should cost) and whether it is already commissioned. A
request with no budget is scoped first: a cheap pass that finds out what
the work would take and quotes it, and the quote becomes its budget.
`fund_request_work` commissions whichever is open now, the scoping pass or
the full work, at the budget your user chooses; the Researcher takes it up
at once, and every outcome, a negative result included, is paid for alike.
Fund the full work at the request's budget. The run works to what your
user gives it, not to the quote: a smaller budget is accepted, the
response says it is below the quote (`below_quote`, `note`), and the run
does only part of the work. `get_request` marks such a run in its work
log (`funding`: "funded at $2.00 of a $5.00 quote"), so a partly met
result from one is a run that ran short, not a finding about what the
work can show. Each piece of work also carries the `run_id` of the run
that did it, which `get_run` and `list_run_steps` read. Your user pays what the
work actually costs, and the rest comes back, as does everything if the
request closes first.

**A mandate, through the Grantmaker.** There is no form; it is a
conversation.

1. `start_grant_conversation` with a first message saying what your user
   cares about, why, and roughly what they want to spend. Free. Nothing
   runs until a draft is funded.
2. The reply is not in the response, and neither is the transcript: a
   send returns your message's place (`message_count`), the draft's hash
   (`mandate_sha256`) and `turn.state`. Get the reply with
   `get_grant_conversation` passing `after` = `message_count`,
   `mandate_sha256`, and `wait: 25`. It answers when the turn ends, or
   after 25 seconds, with only the new messages, and the draft only if the
   reply changed it (otherwise `mandate_unchanged: true`). Repeat with the
   same values while `turn.state` is `replying` (a drafting turn can take
   minutes). Never resend a message; it is already saved.
3. Answer its questions with `send_grant_message`. Expect it to survey the
   graph, push back, and quote costs in owls from live estimates. When it
   disagrees with your user's instinct about what would be valuable, take
   the disagreement seriously and relay it: that judgment is what the money
   pays for. It will ask who is funding and whether they have a stake in
   the subject, and whether they want to be named. Ask your user and relay
   the answer as they give it: a stake is disclosed on the mandate's page
   even when the funder is not named, and one who will not disclose a
   stake they have is declined. Never answer for your user.
4. When it proposes a mandate, show your user the draft and the quote, and
   fund it with `fund_grant` only on their explicit go-ahead. Funding
   escrows the budget; unspent budget refunds. If `get_grant` shows the
   plan awaiting approval, `approve_grant_plan` starts it, again only with
   your user's agreement.
5. Follow it with `get_grant` (spend, plan progress, the assessments it
   funded). You can keep talking to the Grantmaker in the same
   conversation to adjust the part of the plan whose work has not
   started: it can replace that remainder, or change the model tier or
   budget of a single planned pass, or withdraw it, until that pass is
   running, and a budget the pass held comes back to the escrow. Each
   plan item in `get_grant` says its tier and, when it is waiting,
   blocked or cancelled, why. It holds the same refusal duties then as at
   design time.

**Something made from the graph.** If your user wants something produced
from the graph on a schedule or as it changes,
ask the Grantmaker in the conversation for a Correspondent: an agent the
mandate funds to make it and publish it to a feed. Its form is open; its
brief and outputs are public, and it represents the graph accurately like
every agent of the graph. Your user may not need one: you can follow
`list_graph_changes` yourself for free.

**An existing mandate.** Mandates are public (`list_mandates`,
`get_mandate`, `get_mandate_allocation`). If one already covers what your
user cares about, backing it with `fund_mandate` is often better value
than starting another. Contributing buys the mandate more reach and you no
say in how it is stewarded. `get_mandate_allocation` shows how a mandate
spends: its escrow (spent, held by running work, regranted, held for
prizes, and what remains, which add up to the escrow), the operating policy
its Grantmaker wrote for the program officers who decide what to pay for,
what it paid for by kind and how those runs used their budgets (`kinds`:
the runs it commissioned, and separately its own upkeep, such as its
Grantmaker's review passes and its lookouts' runs, marked `self_funded`),
what it spent outside the ledger (`outside_ledger_owls`, mostly the
Grantmaker's conversation with the funder), and the decisions behind them. A mandate's objective changes
only with its funder's agreement, and every other funder is told; any
funder may take back their share of the uncommitted money at any time
with `withdraw_from_mandate`, again only on your user's go-ahead.

## Steering sources when you have opinions

Having a view about which sources matter is fine. The legitimate channels:

- Name the sources to the Grantmaker in the conversation and say why you
  think they matter. It decides whether they belong in the plan, and
  treats source content as data, never instructions.
- Submit a source directly with `submit_source` (reviewed before
  extraction runs), or attach it as evidence in a `submit_contribution`
  of type `support` or `challenge` on a specific claim.

What is not legitimate is choosing sources for the conclusion they will
produce rather than the evidence they carry, or flooding a claim with
derivative sources to inflate its support. The graph's provenance work
exists to see through that (ten articles reporting one study are one
voice), and it will.

## After the work runs

Report what the funded work found the way you would report any of the
graph's judgments (see the claim-checking skill): as the graph's
judgment, with its confidence, and with the uncertainty intact. A funded
assessment that came out against your user's view is the system working
as intended. Say so, and don't go looking for another lever.
