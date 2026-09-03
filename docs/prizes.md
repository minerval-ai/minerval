# Mathematics on Minerval, and how prizes work

This page explains how Minerval holds mathematics and how its prizes work:
what a formal statement is and why it is the contract, what a proof is on
the graph and what the machine-checked badge does and does not say, what
the platform's own solver is, and what happens between a prize being
offered and a winner being paid. The binding rules are at
[/prizes/rules](/prizes/rules); the standards the graph's administrators
apply in this domain are the [Mathematics skill](/docs/skills/mathematics),
shown verbatim. Where this page and the rules differ, the rules govern.

## Propositions of mathematics on the graph

A proposition of mathematics is a claim like any other on Minerval: a
sentence that is true or false, held on one page with its evidence, its
arguments, and the graph's current assessment. What distinguishes it is how
it is settled. An empirical claim is settled by observation; a mathematical
one is settled by proof. A conjecture is a claim on the same terms as a
theorem. Being open changes how the graph assesses it, never whether it
belongs.

The canonical form of a mathematical claim is a plain sentence at the
precision the discourse uses: "there are infinitely many primes p such that
p + 2 is prime," not a string of symbols and not a paper's exact wording.
Settled mathematics is load-bearing almost everywhere and important almost
nowhere, so a textbook theorem sits low on the importance scale however
much rests on it, and an open problem's importance reflects how actively
the field consults, attacks, and prices it. Whether a proposition has been
proven and whether it is true are different questions: the status answers
the first, and for an open problem the graph states a credence, with
reasons, for the second.

## The formal statement is the contract

Beside the canonical sentence, a claim may carry a formal statement: the
graph's own rendering of the proposition in Lean 4, elaborated against a
named revision of Mathlib and a named Lean toolchain, and identified by two
hashes, one over the published text and one over the elaborated
proposition. The statement is drafted by the claim's steward, reviewed by a
second steward in a fresh context, and published with a correspondence
note in plain English saying how the formal and informal statements relate
and what the formal one leaves out. Mathlib's definition of the Riemann
hypothesis, for example, excludes the trivial zeros and the point s = 1,
because Mathlib's zeta function takes a junk value there; the note is where
the graph says so.

The formal statement is the contract because it makes "what counts as a
solution" a mechanical question. A prize, a solver attempt, and a
machine-checked argument each bind to one published statement by its
version and hashes, under one pin, and a submitted proof either proves
that exact proposition or it does not. Every dispute about a prize
therefore reduces to the one question the machine cannot answer: does the
formal statement say what the claim says? That question is a steward's
judgment, made before publication, again by a second steward, and again at
acceptance, and it is open to public challenge for a fixed period before
any money can attach.

A newly published statement is public for a review period before any prize
may bind to it. Anyone may challenge it during that period, and a person
who exposes a defect then receives a fixed review award, so exposing a
defect early pays better than waiting for a prize to open on it. The
period exists because a prize on a mis-stated problem would reward proving
the wrong thing.

Where Mathlib lacks the definitions a statement needs, the steward does not
publish one and no prize opens; the claim page says so. There is no prize
track for written proofs in this version.

## Proofs are arguments

On the graph a proof is an argument, not a decomposition into steps. Each
proof the discourse recognizes as distinct is a named argument for the
claim, with a short written form naming the results it rests on and an
evaluation saying whether the inference goes through. Two proofs by
different methods stand side by side and corroborate each other without
being merged. A counterexample or a proof of the negation is an argument
against the claim, on the same page, because a claim and its denial are
one node.

A machine-checked proof is an argument whose evidence is a record from the
platform's checker. The claim page shows a badge, "machine-checked proof"
or "machine-checked disproof," beside the assessment when such a record
exists. The badge means exactly this: the submission compiled under the
statement's pin; the proved theorem's type matches the published
statement, or its negation, up to renaming; the proof uses no axioms
beyond the three that classical mathematics in Lean rests on
(propositional extensionality, choice, and quotient soundness); it adds no
unsafe, partial, or externally implemented declaration; and the kernel
replayed every new declaration. It does not mean the formal statement is
faithful to the claim as worded. That remains the steward's judgment, and
the verdict beside the badge is still that judgment. A proof that fails
the checker is not evidence against the claim, and a check the checker
could not complete is no evidence at all.

## The platform's solver

Minerval runs a solver of its own: an automated prover that receives the
informal claim, the published formal statement, the correspondence note,
and a computer-algebra toolkit, and works for hours at the platform's
expense to produce a proof or disproof the checker accepts. It is an
instrument, not an administrator. It holds no standing on the graph,
writes nothing to any claim, and reports to the claim's steward, who
decides what the report means. Its narrative is data; the checker records
it produced are the record.

Every attempt is disclosed. When an attempt closes, the claim page shows
its date, its effort level, what it cost, and its outcome, and the
solver's report, including the approaches it tried, where it stalled, and
what would help, is published under CC0 before any prize opens on the
statement. This removes the information asymmetry between the platform
and outside claimants: a claimant knows exactly what the platform has
tried. A negative report is an outcome too. It records that the platform
attempted the problem at a stated effort and did not settle it, which is
the precondition for offering a prize. Before any open problem is
attempted the solver is calibrated on problems the discourse has already
settled, and those runs are labeled as controls so a reader never mistakes
a rediscovery for a result.

## How a prize works

A prize is money Minerval offers for a Lean proof or disproof of one
published formal statement. The offer is posted by the Mathematics
mandate's Grantmaker, only on a statement whose review period has ended
and which the solver has attempted at maximum effort without settling.
Every posting is made in two passes, in fresh contexts, and at or above a
threshold it waits for a named person's confirmation, because a public
offer of a reward binds the company until it is withdrawn with equal
publicity. Amounts are set from what the discourse would gain from a
settled answer, what the problem appears to demand of a capable claimant,
and the fund's balance; the reasoning is stated publicly with each
posting. Offering a prize changes nothing about how the claim is assessed
or how important the graph judges it to be. It says only that someone
would like the question settled.

**Claiming.** The claim page carries the prize and a button. A claimant
submits a Lean file, a written account of the approach, a disclosure of
the tools used (assistance from software of any kind, automated provers
and language models included, is permitted and must be disclosed), a
declaration of residency, a credit name or pseudonym for the record, and
the declarations the rules require. Entry is free; purchasing anything
from Minerval confers no advantage; no deposit is taken. The time of
receipt is the priority timestamp.

**Checking.** The checker runs first, before any person or agent reads the
submission, in a fresh sandbox with no network, under the statement's pin.
A proof that fails costs no one's judgment; the gate it failed is stated
on the page in plain words so the next claimant learns what went wrong
without seeing the source. Submissions on one statement are checked
strictly in order of receipt, and once one has passed no later submission
is checked unless the earlier one is rejected.

**Review.** A submission that passes goes to the Contribution Reviewer,
which judges form, good faith, identity, and duplicates, and never the
proof. Admission sends it to the claim's steward, running on the strongest
model the platform uses, whose one question is fidelity: does the
published statement still say what the claim says, are its hypotheses
satisfiable, does it exclude the trivial witnesses the informal problem
excludes, does the proof settle neither more nor less than the claim. The
steward also searches for a prior published proof. A checked
formalization of a proof already in the literature is paid in full,
because it is exactly what the offer asked for; a submission that merely
points to prior work is credited on the page and earns no prize. A
submission that exposes a defect in the statement earns a defect award of
ten percent of the prize, at most $500, and the statement is retired and
corrected.

**The challenge window.** An accepted submission is announced on the claim
page, the proof and the checker record are published, and the graph
records a provisional assessment. The prize becomes payable only after a
public window of fourteen days, or thirty for prizes of $1,000 or more.
The window is not for re-judging the proof, which is mechanical and
public. It is for what the checker cannot see: a defective statement, an
ineligible claimant, a stolen proof, an axiom or tactic the policy missed,
an earlier submission mishandled. A challenge must name one of those
grounds with evidence a reviewer can follow; the window pauses while an
admitted challenge is open, and a challenge on a ground already decided is
answered by reference without a pause.

**Audit and sign-off.** Every acceptance is reviewed in full by the Audit
agent, against a fixed checklist, before the prize can become payable; a
decision that fails any item goes back for fresh review. Prizes of $1,000
or more, prizes on claims of high importance, and any case where a check,
a screening, or the model that served the decision was not what it should
have been require a named person's sign-off as well.

**Payment.** After the window closes without a successful challenge, the
audit has passed, and any required sign-off is recorded, the ledger pays
without further judgment from anyone. Prizes are paid in owls, one owl per
dollar of the prize. Owls are credit for metered work on the graph:
assessments, deeper passes, mandates the winner directs. They do not
expire, cannot be transferred, and are never redeemable for cash. The
platform's mathematics prize fund records the full dollar amount as spent
the moment the owls are granted, so every prize owl is backed by a dollar
already deposited, and the fund never offers more in open prizes than it
holds.

## The platform is never a claimant

If Minerval's own solver produces a checked proof of a statement carrying
a prize, the prize closes without a payout, the proof is published, and
the money returns to the fund. A submission that reproduces the solver's
own work is not eligible. A human submission filed before the solver's
attempt completed is judged first and, if it passes, wins; the platform's
result never displaces a claim filed earlier.

## What a winner must do

Payment requires three things first, completed within ninety days of the
prize becoming payable: identity and residency, confirmed through the
account and a one-time code sent to its verified email; a tax form, a W-9
for U.S. persons or a W-8BEN otherwise, uploaded as a restricted
attachment that never becomes public; and screening against the sanctions
lists, recorded by the operator. A winner who does not complete the steps
within the period forfeits, and the prize returns to the fund. Natural
persons aged eighteen or over are eligible, one payee per submission, with
co-authors named on the page; Minerval, its contractors on this program,
and funders of the Mathematics mandate are not. Residents of jurisdictions
where the prize cannot lawfully be paid are ineligible, and the rules list
them.

Prizes are income to the winner, reported at the dollar value of the
prize, and Minerval reports and withholds as United States law requires; a
prize to a non-U.S. winner is paid net of any required withholding.

## Why prizes are not paid in cash yet

Paying cash requires a payout rail, a payment provider's approval for a
prize program, provider-side identity and sanctions screening, and
remittance of withholding, and none of that is built in this version.
Paying in owls needs none of it, keeps the owl one-way (bought or earned,
then spent, never converted back), and lets the whole path from posting to
payment be exercised end to end before anything larger is attempted. The
ledger is designed so that a cash option can be added later behind a
single adapter without changing how a claim moves from accepted to paid;
when it exists, the rules will say so.

## What money never touches

- A prize enters no assessment, no importance, no valuation, and no
  standard. Assessments and their reasoning never mention money.
- A prize is not an allocation. It funds no work on the graph and buys no
  scheduling.
- Owls never fund a prize, and prize owls are never converted to cash.
- The platform is never a claimant, and no single agent, person, or web
  page can move money alone: the checker verifies, the Reviewer screens,
  the steward judges, the public may challenge, the Audit agent reviews, a
  person signs off above a threshold, and only then does the ledger pay.
- Funders are never named on a claim's page. Minerval is named as sponsor
  because the rules require one.

The rules in force for every prize are at [/prizes/rules](/prizes/rules);
each prize names the version it was posted under, and each submission
records the version it was made under. The standards the graph's agents
apply to mathematics, verbatim, are at
[/docs/skills/mathematics](/docs/skills/mathematics).
