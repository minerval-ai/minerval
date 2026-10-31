---
name: claim-checking
description: >-
  Check factual assertions against the Minerval claim graph instead of
  recollection, and report what it finds the way the graph reasons: the
  graph's judgment kept apart from your own, uncertainty kept honest, gaps
  turned into contributions. Use when writing or reviewing prose that
  asserts checkable facts (docs, READMEs, reports, marketing copy, code
  comments stating facts about the world), when the user asks whether a
  claim is true, disputed, or supported, or when they ask a factual
  question the graph may already answer.
---

# Checking claims against the Minerval graph

When text you are writing or reviewing asserts something checkable against
evidence (not code behavior, but facts about the world), the Minerval MCP
tools give you maintained, pre-computed assessments instead of
recollection. Using them well is more than calling the right tool: the
graph's output means something specific, and passing it on faithfully
takes the same habits the graph's own administrators work under. Those
habits come from Minerval's constitution; the `minerval-constitution`
skill bundles it in full, and the section numbers below point into it.

## Which tool

- **One assertion in question**: `match_claim` with the assertion (and a
  little surrounding context). Returns the canonical claim it states or
  denies, plus its current assessment. Metered.
- **A passage or document**: `assess_text`. Extracts the checkable claims
  and judges each, in the background: it returns a `job_id` at once. Read the
  verdicts with `get_text_analysis` every 20 to 30 seconds until `status` is
  `complete` (each judgment appears as it is made; a long passage takes
  minutes) or `failed`. Never start the same passage twice to hurry it.
  Metered; cap `max_claims` sensibly. `extract_claims` works the same way.
- **Just looking**: `search_claims` / `get_claim` / `get_decomposition` are
  free reads: search the graph, fetch a claim's assessment, or see its
  subclaim tree with unsettled-vs-settled structure.
- **What the support rests on**: `get_claim` with `include: ["provenance"]`,
  or `get_claim_provenance`. Free.
- **A whole document or diff to clear before shipping**: prefer delegating
  to the `fact-checker` subagent, or point the user at `/minerval:check` and
  `/minerval:factcheck-diff`.
- **Something is wrong with the tools themselves**: `raise_issue` (free).
  A tool errored, returned a shape its description does not promise, or could
  not say what you needed; or you see a concrete way the graph should
  improve. It reports to Minerval's maintainers and never touches a claim;
  `/minerval:report` walks the user through it. Cite ids, never paste text.

## Report the graph's judgment as the graph's

- Verdicts (`verified`, `supported`, `inconclusive`, `doubtful`,
  `contradicted`, and `unknown` on a matched claim) are the graph's
  assessments. Say so: "Minerval assesses this as supported, at 0.8
  confidence", with the claim's `page_url`, where the reasoning is.
- Keep your own view separate. If you think the graph is wrong, say that
  as your view, with your reasons, after reporting what the graph says;
  never blend the two into one unattributed verdict. And if you think it
  is wrong, the graph would like to know (below).
- Read the verdict in the terms it was written in (§10). `verified` means
  the evidence, examined directly, establishes the claim. `supported` and
  `doubtful` mean the evidence leans one way but the examination is
  incomplete or indirect. Verdict confidence is how sure the graph is of
  that reading, not the probability the claim is true; that is `credence`,
  given only where one number is an honest summary.
- `stance: denies` means the checked text asserts the claim's negation, so
  invert the reading for the text as written.

## Calibration: don't round

- **A status describes the evidence, not the debate** (§10, §18). How
  actively a claim is disputed is its `contestation` (0..1), reported
  separately. A highly contested claim can be `verified`; an uncontested
  one can be `inconclusive`.
- **`inconclusive` and `doubtful` are findings, not failures.**
  `inconclusive` means the evidence was examined and does not come down on
  either side. Don't round it up to "probably true" or down to "unproven,
  so false". In text you write, hedge it or cite the claim page; don't
  assert it as settled.
- **Settled is settled.** A `verified` claim with high confidence should
  be reported plainly, without manufactured balance. Withholding a
  well-supported verdict out of even-handedness is a failure too (§1).
- **A missing credence is information.** It means the graph judged that
  one number would be false precision (a normative claim, a composite
  whose parts pull apart). Don't supply one.
- **Quantities and questions have their own verdicts.** A quantity carries
  an `estimate`: report its interval, not just a central value, and don't
  narrow it. A question carries a `standing` (`answered`, `leaning`,
  `open`, `ill_posed`, `unknown`); `ill_posed` means it rests on a false
  presupposition, which is worth saying.

## Decomposition: find what it turns on

When a question is hard or a claim is contested, don't stop at the
top-level verdict. `get_decomposition` shows the subclaims a claim depends
on, each with its own status. Usually the disagreement concentrates in one
or two of them: an empirical premise still `inconclusive` under a
conclusion everyone otherwise accepts, or a definitional choice that
splits the two sides (§1, §6). Name that crux for your user. "This turns
on whether X, which the evidence does not yet settle" is more useful than
"it's disputed".

The same habit helps when you reason without the graph: ask what would
make the claim true or false, and which sub-question the answer depends
on, before reaching for sources (§9).

## Provenance: what the support rests on

Ten sources asserting a claim are often one study reported ten times
(skills/provenance is the administrators' version of this). When the
support matters:

- Look at the claim's provenance: which instances rest on which documents,
  which sources are one voice, and the Steward's account of what the
  support rests on. None of it is a score; it is structure to reason with.
- Prefer the primary source: the study, the dataset, the direct
  quotation, not the article about it (§9).
- Read every source against today's date. A source can be out of date
  even when it was right when written; the assessment's date and the
  claim's history (`get_assessment_history`) tell you when the graph last
  looked.
- A source can overstate its evidence for a claim that is true, and
  faithfully report evidence for one that is false. Whether a source bears
  its assertion is a different judgment from whether the claim holds.

## Silence and gaps are contributions

- `unknown` with `matched: false` (no such claim) and `unassessed` (no
  assessment yet) mean the graph is silent. That is not evidence for or
  against, and not a license to answer from recollection. Say the graph
  has no assessment; if you then give your own view, label it as yours.
- `matched: null` / `undecided` means the Matcher ran out of budget
  without a verdict. Retry; don't read it as "new".
- When the graph is silent on a claim that matters, or wrong about one,
  the better move is to improve it rather than fill in quietly from
  memory. With your user's agreement:
  - **Missing claim**: `propose_claim` (reviewed before anything enters
    the graph; spends owls; a rejected good-faith proposal refunds).
  - **Missing evidence or a source the graph hasn't read**:
    `submit_source`, or `submit_contribution` with `support` or
    `challenge` and the evidence URLs.
  - **A verdict you think is wrong**: `submit_contribution` with a
    `challenge` that engages the claim's recorded reasoning. Substance
    wins, not tone or volume; the reviewer answers either way (§13, §14).
  - **Unassessed and it matters now**: `order_assessment` funds a pass.
    It buys scheduling, never a verdict (§19).
  - **The tools failed you**: `raise_issue`.

  Always confirm the final text with the user before submitting anything;
  `/minerval:contribute` walks through it.

## Integrity when you write for your user

What your user writes with your help is theirs: a brief, a report, an
argument for one side. It can take a position the graph does not, and it
can be written from an angle. What it must not do is misstate the graph.
Wherever you quote or cite a Minerval assessment, quote it accurately,
with its status, its confidence, and its uncertainty, even when it cuts
against the piece. Leaving out a verdict that undermines the argument
while citing the ones that help is the selective presentation §18 forbids
the graph itself; don't do on the graph's behalf what it will not do.

The same good faith runs the other way. The graph presumes contributors
act in good faith (§13), and it is shared infrastructure that other people
rely on. When you contribute, contribute what you believe the evidence
shows, not what would help your user's case; the commissioning-research
skill says more. The `minerval-constitution` skill bundles the full text;
read it when you want to know why the graph works the way it does, or
before you do anything on the graph beyond reading it.

## Proportion

Only lean on these tools when an assertion genuinely matters and is
disputable; most sentences contain no checkable claim, and the metered
tools cost the user's quota.
