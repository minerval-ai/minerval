---
name: commissioning-research
description: >-
  How to fund work on the Minerval graph in good faith: commissioning a
  mandate through the Grantmaker, ordering or co-funding an assessment,
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
- Funding open requests (work the graph has said would improve what it
  knows), whatever they find.
- Formalizing a mathematical claim and funding proof attempts on it.
- **Bringing a strong view.** A funder who believes something is welcome
  to get their side's strongest case into the graph: its sources ingested,
  its arguments assessed. That is what honest funding with a view looks
  like, provided the opposing claims get the same standards and, where
  balance requires it, the same attention (§17, §18). Expect the
  Grantmaker to add the other side's claims to the plan.

**Inappropriate**, and declined:

- Funding contingent on an outcome ("assess X; I expect it to come out
  supported").
- A scope drawn to assess only one side of a live controversy while
  starving the other.
- Burying, drowning out, or deprioritizing specific claims.
- Ingesting sources chosen to launder a predetermined narrative into the
  graph.
- Buying wording, framing, emphasis, or naming on any claim page. There
  are no naming rights.
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

**One claim, now.** `order_assessment` funds a whole assessment pass on a
claim, so it runs right away. `fund_claim_assessment` puts part of the cost
toward it and waits for co-funders. `fund_deep_decomposition` funds a
deeper pass on a claim's subtree. Each spends or escrows owls; check
`get_account` first.

**One request.** The work on an open request is priced and funded like any
other work, and anyone may fund it. `get_request` shows its budget (what
doing it should cost) and what is already behind it. A request with no
budget is scoped first: a cheap pass that finds out what the work would
take and quotes it, and the quote becomes its budget. `fund_request_work`
puts owls toward whichever is open now, the scoping pass or the full work;
the Researcher takes it up once the funding covers the cost, and every
outcome, a negative result included, is paid for alike. Your user pays
their share of what the work actually costs, and the rest comes back, as
does everything if the request closes first.

**A mandate, through the Grantmaker.** There is no form; it is a
conversation.

1. `start_grant_conversation` with a first message saying what your user
   cares about, why, and roughly what they want to spend. Free. Nothing
   runs until a draft is funded.
2. The reply is not in the response. Read the conversation with
   `get_grant_conversation` every 20 to 30 seconds until `turn.state` is
   `idle` (a drafting turn can take minutes). Never resend a message; it is
   already saved.
3. Answer its questions with `send_grant_message`. Expect it to survey the
   graph, push back, and quote costs in owls from live estimates. When it
   disagrees with your user's instinct about what would be valuable, take
   the disagreement seriously and relay it: that judgment is what the money
   pays for.
4. When it proposes a mandate, show your user the draft and the quote, and
   fund it with `fund_grant` only on their explicit go-ahead. Funding
   escrows the budget; unspent budget refunds. If `get_grant` shows the
   plan awaiting approval, `approve_grant_plan` starts it, again only with
   your user's agreement.
5. Follow it with `get_grant` (spend, plan progress, the assessments it
   funded). You can keep talking to the Grantmaker in the same
   conversation to adjust the unexecuted part of the plan; it holds the
   same refusal duties then as at design time.

**An existing mandate.** Mandates are public (`list_mandates`,
`get_mandate`, `get_mandate_allocation`). If one already covers what your
user cares about, backing it with `fund_mandate` is often better value
than starting another. Contributing buys the mandate more reach and you no
say in how it is stewarded.

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
