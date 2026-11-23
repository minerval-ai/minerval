# Safety cases

A safety case is an artifact (constitution §7b) that argues one conclusion
about one system in one deployment, to a stated standard. It is the second
kind of artifact with a suggested structure, after lists. Its Steward builds
it from what the graph holds and keeps it current as that changes.

Two things set it apart from the rest of the graph, and both are deliberate.

- **It has a formal structure where a standard requires one.** The framework
  is Assurance 2.0 in Claims, Arguments, Evidence (CAE) form. A case that
  names that framework follows it, has its form checked, and can be exported
  in it.
- **It takes a safety case's attitude.** The graph reports where the evidence
  stands on each claim and leaves the burden with no one. A safety case does
  not: the case has to establish its conclusion, a doubt counts against it
  until it is answered, and what cannot be answered is recorded as a residual
  doubt someone has to accept. That attitude belongs to the case and stays
  inside it. The claims the case draws on keep the graph's own assessments.

This document describes what is built. What is not is listed at the end.

## What a case is, in rows

A case is a `claims` row of kind `artifact`, as a list is
(`src/services/safety-case-service.ts`).

| Part | Where | What it holds |
| --- | --- | --- |
| Specification | `artifact_specs`, `subtype = 'safety_case'` | `system`, `deployment`, `conclusion_claim_id`, `standard`, `standard_of`, `framework` (`assurance_2_cae` or `none`), `not_covered` |
| Structure | `case_elements` | One row for each element: its type, what it hangs under, the graph node it presents, and what is the case's own (below) |
| What it draws on | `claim_relationships`, `relation_type = 'draws_on'` | One edge from the case to each node an element presents, kept beside the elements by the service |
| Judgment | `artifact_assessments` | `fidelity`, as every artifact has, and `verdict` with `verdict_basis` and `would_change` |

The specification is the case's identity. A later model, another deployment
or another conclusion is another case: `restate_case_spec` rewords the
system, the deployment, the standard and what is not covered, and changes
neither the conclusion nor the framework.

The conclusion is a claim the graph already holds. Whoever proposes a case
proposes the conclusion as a claim first, through the Matcher like any other
claim, and names it. The conclusion keeps its own Steward and its own
assessment.

Nothing in a case is computed over the graph. Propagation tells the Steward
that a node the case draws on has changed (the `draws_on` edges, and
`judgment_inputs` for what a judgment was made against, which is how the
page says a case is stale). What the change means for the case is the
Steward's judgment, written down with its reasons.

## Structure

Under Assurance 2.0 CAE a case is a tree.

| Element (`element_type`) | Hangs under | In the graph |
| --- | --- | --- |
| `claim` | The step it is a premise of, or the defeater its subcase answers. The top claim hangs under nothing and is the conclusion | A claim |
| `step` | The claim (or side claim) it argues for | An argument (§7), named in `argument_id` where the graph holds one. Its `block` is the case's own reading of it |
| `side_claim` | Its step | The premise the inference needs, stated as a proposition about the world |
| `evidence` | An evidence incorporation step | An evidence claim, with its source as an instance on that claim |
| `defeater` | The claim, step, side claim or evidence it doubts | An ordinary claim |

A step's `block` is one of the framework's five building blocks:
`decomposition`, `substitution`, `concretion`, `calculation`,
`evidence_incorporation`. Each step carries a side claim that says why the
step is legitimate: that the parts of a decomposition together suffice and
do not fail together, that what was shown of one thing holds of another,
that a measurement means what it is taken to mean.

Every element but a step presents a node the graph holds. Where the case
needs a node the graph lacks, a side claim nobody has stated or a doubt
nobody has raised, the Steward proposes it through the Matcher, worded to
stand on its own, so it is assessed where evidence can reach it. Each
element's `statement` says what the case needs of the node, and the page
shows it beside the graph's judgment of the node, which is shown unchanged.

**The graph has no defeaters.** A defeater exists only inside a case, as a
row of `case_elements`. The claim it presents is a claim like any other:
worded to the same standard, matched, assessed on its evidence, related to
its neighbours by the relations every claim uses. There is no defeater
kind, edge, field or count in the graph, and a claim's page says nothing
about being one. What the case keeps is its own: what the defeater doubts
(its parent), where it stands in the case (`standing`: `open`, `answered`,
`sustained`), why (`standing_reason`), and, for a sustained defeater the
case proceeds past, who accepted it as a residual doubt and why
(`accepted_by`, `acceptance`). The Steward decides the standing with the
claim's assessment in front of it, and the assessment is not the standing:
a doubt the graph finds inconclusive is still open against a case that
carries the burden.

A defeater is answered by a subcase: a claim under the defeater, with the
step and evidence that argue for it. The service refuses to record a
defeater as answered while it has none. It also refuses an acceptance on
anything but a sustained defeater. Acceptance is the act of a party with
standing to accept the risk. The Steward records it only where that party
has said so, and accepts nothing on anyone's behalf.

Two things that were separate issues are places in this structure, kept by
the Steward.

- **Legs that share a premise (#544).** A decomposition's side claim is
  where the case says its legs are independent. The Steward checks that
  against the premises the legs rest on and records a shared one as a
  defeater of the side claim.
- **Transfer (#545).** Using evidence about an evaluation for deployment, or
  about an earlier model for this one, is a substitution step, and its side
  claim is the transfer premise. A substitution with no side claim is a step
  the case has not justified, and the check of form reports it.

Where the developer has published its own case or a system card, it comes
in as a source like any other. Each element records whether that document
raises it (`raised_in_published`), and the page lists what the structure
adds that the published document never raised.

### Labels

Every row of a case carries the label of the run that wrote it. A run at
another label adds elements of its own, a defeater of an element it doubts
among them, and does not change or remove a row another label wrote. A
reader sees the elements their label reads.

`case_elements` is mirrored with the specification
(`src/services/mirror-manifest.ts`), so a private deployment reads a public
case whole.

## Form is checked; content is judged

Whether a case is well formed under its framework is a check of form
(`src/services/case-form.ts`, `checkCaseForm`), and it reads no database.
Under `assurance_2_cae` it reports:

| Rule | What it found |
| --- | --- |
| `unknown_block` | A step that is none of the five building blocks |
| `no_side_claim` | A step with no side claim |
| `no_subclaims` | A step, other than evidence incorporation, that argues from no claims |
| `no_evidence` | An evidence incorporation step that names no evidence |
| `evidence_outside_incorporation` | Evidence under a step that is another block |
| `undeveloped_claim` | A claim or side claim that no step argues for, so it does not bottom out in evidence |

Whatever the framework, it also reports what would not be a structure at
all: no top claim or several, an element under something it cannot hang
under, a defeater recorded as answered with no subcase.

The tools that write the structure answer with where the form now fails,
and refuse nothing for it. Whether a step is sound, a side claim holds or a
defeater is answered is the Steward's judgment. A Steward may depart from
the framework where the subject needs it: it says where in the element's
`departure`, the failure is still reported with the departure beside it,
and the page and the export say the same.

## Burden and verdict

The case's judgment has two parts, recorded together
(`update_case_assessment`, `recordCaseAssessment`).

- **How far the case can be relied on as a piece of work**: `fidelity`, in
  the words every artifact uses (`faithful`, `incomplete`, `misleading`,
  `ill_specified`).
- **Whether the case establishes its conclusion to the standard in its
  specification**: `verdict`, `established` or `not_established`, with what
  it rests on (`verdict_basis`) and what would change it (`would_change`).
  There is no third word. The burden is on the case, so a case that has not
  shown its conclusion has not established it.

What counts against a case, as far as its structure shows it
(`countsAgainst`): a defeater still open, a sustained defeater nobody has
accepted, and a failure of form with no stated departure. Evidence asked
for and not supplied is on the case's page as its open requests, and the
Steward weighs it.

`established` is refused while anything in that list remains. This refuses
a record that contradicts itself, and decides nothing a Steward would
deliberate over: which standing a defeater has, whether a doubt has been
accepted, and whether a departure is warranted are settled first, by the
Steward, and each is recorded with its reason.

The verdict is a statement about the case under its standard. The
conclusion is still an ordinary claim with its own assessment, which
reports the evidence as the graph does everywhere. The two can differ, and
the case's page shows both: "the evidence supports X" and "the case does
not yet establish X to the standard P requires" are both true of many real
cases. Recording a case's verdict writes nothing to the conclusion's
assessment or to any other node's.

## The Steward

The Artifact Steward keeps a case as it keeps a list: one role, given the
prompt and tools of the kind of artifact it owns
(`src/llm/prompts/artifact-steward.ts`, `src/llm/tools/case-tools.ts`).

| Tool | What it does |
| --- | --- |
| `restate_case_spec` | Rewords the specification under the same identity |
| `write_case_element` | Adds an element or revises one, and answers with where the form now fails |
| `remove_case_element` | Takes an element out with what hangs under it |
| `set_defeater_standing` | Records where a defeater stands, and for a residual doubt who accepted it and why |
| `check_case_form` | Reads the structure with each element's id, the form's failures and what counts against the case |
| `update_case_assessment` | Records the fidelity and the verdict |

The Steward thinks the structure through; it does not transcribe the
developer's document. It starts from the conclusion and asks what would have
to be true, and what would have to have been looked for. A set of starting
questions is kept for the kind (`src/llm/prompts/safety-case-questions.ts`)
and carried in the role, each with where in a structure it usually lands
and the publications it is drawn from. They are a starting
point and not a template.

No tool counts or caps what a case may hold. The run's budget bounds it,
and the run is told its budget (docs/allocation.md).

## Routes and tools

| Route | MCP tool | |
| --- | --- | --- |
| `POST /claims/propose-case` | `propose_safety_case` | Proposes a case by its specification. Priced and charged as proposing a claim or a list is. Where a case with a very close specification exists nothing is minted unless `confirm_new`. The Assistant holds it for its user |
| `GET /claims/:claim_id/cae` | `export_safety_case` | The export, below |
| `GET /claims/:claim_id` | `get_claim` | Carries `safety_case` on a case: the specification, the conclusion with the graph's assessment of it, the elements, the form, what counts against the case, the fidelity and the verdict, and whether it is stale |

A proposed case is a new node, so the request names the label it is written
at where a deployment has more than one (`src/server/request-labels.ts`).

## Export

`GET /claims/:claim_id/cae` returns the case as one JSON document, format
`minerval-cae/1` (`CaseExport` in `src/services/case-form.ts`):

- `case`: the specification, and `conclusion` as the graph holds it with
  its own judgment.
- `judgment`: the fidelity, the verdict with its basis and what would
  change it, or null where the case has not been judged.
- `elements`: every claim, step with its `block`, side claim, evidence item
  and defeater with its `standing`, each with `parent`, its `statement`,
  any `departure`, and `node`: the graph node it presents with that node's
  judgment at the time of export.
- `form`: the framework, and the failures of form as checked when the
  export was made.

`readCaseExport` reads a document back and checks its form afresh from its
elements, so an export can be checked wherever it has gone.

The export is read with the caller's clearance, as the case's page is. A
reader who does not read a case's label is not served it. What reaches such
a reader is the case's page released through the gate.

## Through the gate

A case's page is released to readers who do not read its label as any
node's page is (docs/releasing-a-page.md). An artifact's judgment is a
judgment a release can carry (`release_pages.judgment_kind =
'artifact_assessment'`), which also lets a list's page be released.

- What is always shown carries the case's judgment as its verdict: the
  fidelity, and whether the case establishes its conclusion.
- Each element written at the page's label is a part of kind
  `case_element`, in the case's order, saying what it is, what it hangs
  under by its number on the page, what the case needs of the node, a
  defeater's standing and any acceptance, and any departure. The node an
  element presents is named by its wording only where the node itself is at
  the page's label, and by its public id where the public graph holds it,
  as a subclaim is.
- What the verdict rests on is released with the summary, and what would
  change it with the gaps.

Each part can be let through, have a passage removed, be held or be delayed
like any other part of a page.

## Not built

- **ASCE and SACM.** The export is this project's own documented form. An
  export in ASCE's schema for Assurance 2.0 cases waits on settling that
  format with its maintainers, and SACM has not been looked at.
- **s(CASP).** A case is not exported as a logic program. The claim export
  (docs/scasp.md) is unchanged.
- **Import.** A case cannot be read in from ASCE or from an export.
- **An export assembled from a released page.** A reader on the other side
  of a gate has the released page with its parts, not a `minerval-cae/1`
  document.
- **Reusing a structure.** A case for a later model starts empty. There is
  no copy of another case's structure and no relation between two cases.
- **Acceptance by a stated view.** Who accepted a residual doubt is the
  Steward's record of what that party said, in words. It is not tied to a
  stated view (§4) by that party.
- **`query_sql`.** The read-only SQL views do not show artifacts, lists or
  cases.
