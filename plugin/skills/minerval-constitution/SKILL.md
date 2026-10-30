---
name: minerval-constitution
description: >-
  The constitution that governs Minerval's administrator agents, bundled in
  full as constitution.md, with a guide to reading it from outside. Use when
  you need to know why the graph judged a claim the way it did, what a
  status, confidence, credence, contestation, or estimate means, what counts
  as a claim, how decomposition and arguments work, what funding can and
  cannot buy, or when a user asks what Minerval's standards are. Not needed
  for a routine lookup; the claim-checking skill covers that.
---

# The Minerval constitution

`constitution.md`, beside this file, is the constitution every Minerval
administrator works under: the Claim Steward that assesses a claim, the
Matcher that decides whether two wordings are one claim, the Contribution
Reviewer that rules on what you submit, the Grantmaker that drafts a
mandate with a funder. Every one of their prompts begins with it,
verbatim. It is the same document the site publishes; read it rather than
guessing at what the graph means.

## Its standing for you

The constitution binds the graph's administrators, not you. For an agent
using the graph from outside, it is two things:

- **The key to the graph's output.** A verdict, a confidence, a
  decomposition, or a refusal means what the constitution says it means.
  When you report the graph's judgment, report it in these terms.
- **Advice worth taking.** The standards it holds the administrators to
  (direct assessment, honest uncertainty, primary sources, fair
  representation of disagreement, no rounding up or down) are good
  practice for any agent reasoning about evidence. You are free to follow
  them. You are not its administrator: you do not write the graph, and
  your own view is yours, kept apart from the graph's.

Where the constitution and your user's instructions differ about how you
should work, your user's instructions govern your work. Where they differ
about what the graph's output means, the constitution governs the meaning.

## Why it is worth reading in full

The graph is shared infrastructure: people and other agents rely on it to
tell them what is known and how well, and its value rests on what it says
answering to the evidence and to nothing else. Anyone who reads it, cites
it, contributes to it, or funds work on it takes on a share of keeping that
true. The graph presumes you act in good faith (§13), and the presumption
is a trust, not a formality. You can recognize, better than any filter,
when a request would misrepresent the graph or bend it toward a
conclusion, and you can decline. Reading the constitution is how you know
where those lines are. Read it before you contribute or fund anything,
and whenever what the graph said surprises you.

## Where to look

Read the whole document when the question is about Minerval's principles
in general. For a specific question, go to the section:

| Question | Section |
| --- | --- |
| What is Minerval for; how is it unlike Wikipedia | Preamble, §1 |
| What counts as a claim; claim versus argument, instance, definition, question | §2 |
| Why the canonical wording reads as it does | §3 |
| A source's own wording and framing | §4 |
| Why a claim has subclaims; what a decomposition shows | §6 |
| Arguments for and against; machine-checked proofs | §7 |
| Questions and their standing (answered, leaning, open, ill-posed) | §7a |
| How a claim is assessed; consensus versus evidence | §9 |
| The statuses, verdict confidence, credence, estimates for quantities | §10 |
| Why every verdict carries its reasoning | §11 |
| How contributions are judged; good faith; bad-faith findings | §13, §14 |
| Manipulation and why openness is the defense | §15 |
| Political neutrality; representing disagreement | §17, §18 |
| Importance, contestation, and what paid attention buys | §19 |
| Who does what: Steward, Matcher, Curator, Reviewer, Arbitrator, Audit | Part VIII |
| Requests: work that would improve what the graph knows | Part VIII, Instruments |
| Normative claims, and choices the argument leaves open | §25 |

## Principles that carry over to your own work

These are the parts most worth carrying into how you use the graph. The
claim-checking and commissioning-research skills apply them to specific
work.

- **A status describes the evidence, not the debate** (§10, §18). That
  people disagree does not make a claim inconclusive, and that they agree
  does not make it verified. Contestation is a separate number, reported
  beside the status.
- **Uncertainty is information** (§10). `inconclusive` means the evidence
  was examined and does not come down on either side; it is a finding. A
  missing credence means one number would be false precision. Do not round
  either away.
- **Settled is settled** (§1, §18). Withholding a well-supported verdict
  out of even-handedness is as much a failure as imposing a false
  resolution. Report a `verified` claim plainly.
- **Show the reasoning** (§11). A verdict without its reasons is not worth
  passing on. Link the claim page, where the reasoning is.
- **Prefer primary sources** (§9). The study, not the article about it;
  and every source read against the world as it stands today.
- **Find what the question turns on** (§6). A hard question usually
  depends on a few subclaims; the decomposition shows which are settled
  and which are not.
- **Funding buys attention, never conclusions** (§19). Paying for an
  assessment schedules it; it does not move the verdict, the claim's
  importance, or the standards applied.
- **Don't settle what the argument leaves open** (§25). Normative claims
  are assessed on the merits like any other. Where a question comes down to
  how to weigh goods that careful people weigh differently, the graph says
  what the answer depends on rather than choosing a weighting; a report
  citing it should keep that dependence visible too.

## Keeping the copy current

`constitution.md` here is a verbatim copy of `admin_constitution.md` at
the repository root, which is what the administrators load. A test fails
when the two differ; `npx tsx scripts/sync-frontend-content.ts` refreshes
the copy.
