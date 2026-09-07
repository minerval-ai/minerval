# The Minerval RDF vocabulary (`mv:`)

Namespace: `https://w3id.org/minerval/vocab#` — minted under the prepared
w3id namespace (`infra/w3id/`) so the IRIs survive any future domain move;
until that registration merges they are valid, non-resolving IRIs, which
linked-data practice permits. Used by the nanopublication export (#292):
`GET /claims/:id/nanopub` serializes a claim's evidence record as
assertion / provenance / publication-info graphs in TriG or JSON-LD.

Established ontologies are reused where they fit; `mv:` covers only what is
ours. PROV-O carries provenance (`prov:wasDerivedFrom`, `prov:wasQuotedFrom`,
`prov:generatedAtTime`), CiTO carries a source's stance toward a claim
(`cito:supports` / `cito:disputes`), Dublin Core carries publication info
(`dct:creator`, `dct:title`, `dct:source`, `dct:license`), and the nanopub
schema (`np:`) carries the graph structure. Every nanopub's publication-info
graph declares the content license — [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
— via `dct:license`, so each publication permanently records the terms it went
out under.

## Classes

| Term | Meaning |
| --- | --- |
| `mv:Claim` | A canonicalized claim node. |
| `mv:Instance` | One place a claim is actually made: a verbatim quote in a source. |
| `mv:Argument` | A distinct line of reasoning for or against a claim. |
| `mv:FormalStatement` | A published formal statement of a claim: the graph's rendering of the proposition in Lean 4, elaborated against a pinned Mathlib. |

## Claim properties (assertion graph)

| Term | Range | Meaning |
| --- | --- | --- |
| `mv:claimType` | string | The claim-type ontology label (e.g. `empirical_derived`). |
| `mv:status` | string | The current assessment status (e.g. `supported`, `contested`). |
| `mv:confidence` | `xsd:decimal` | Verdict confidence — how sure the Steward is of the status, not P(true). |
| `mv:credence` | `xsd:decimal` | The Steward's probability the claim is true. **Omitted exactly where the graph declines to state one (§10)** — an absent triple is information, never a gap to fill with 0. |

## Decomposition relations (assertion graph)

One predicate per relation type, claim → subclaim. A relation the enum grows
to that isn't mapped yet degrades to `mv:relatedTo` rather than minting an
undocumented predicate.

`mv:requires` · `mv:assumes` · `mv:supports` · `mv:contradicts` ·
`mv:specifies` · `mv:defines` · `mv:relatedTo`

## Provenance properties

| Term | Meaning |
| --- | --- |
| `mv:reasoningTrace` | The assessment's full defensible chain, as prose (on the assertion graph node). |
| `mv:quote` | An instance's verbatim quote. |
| `mv:stance` | Whether an instance/argument affirms or denies (`affirms` / `denies`; arguments: `for` / `against`). |
| `mv:hasArgument` | Assertion → an argument carried on the claim. |
| `mv:hasPremise` | Argument → a basis subclaim it rests on. |
| `mv:verdict` | The Steward's evaluation of an argument's inference (`holds` / `holds_with_caveats` / `fails` / `contested`). |
| `mv:evaluation` | The prose of that evaluation. |

## Publication-info properties

| Term | Meaning |
| --- | --- |
| `mv:claimId` | The stable claim UUID (survives re-canonicalization). |
| `mv:assessmentId` | The pinned assessment row's UUID. |
| `mv:assessmentVersion` | 1-based ordinal in the claim's assessment history — with `mv:claimId`, the reproducible reference. |
| `mv:assessedAt` | When the pinned assessment was made. |
| `mv:assessmentModel` | The model that produced the assessment (#294). |

## Formal statement properties (assertion graph)

A claim with a published formal statement (docs/prizes.md) carries one
`mv:FormalStatement` node. The statement is exported because it is
epistemic content: it fixes, mechanically, what proposition the claim's
machine-checked arguments are about, and an outside reader can recompute
`mv:sourceHash` from `mv:formalSource` and `mv:formalPin`.

| Term | Range | Meaning |
| --- | --- | --- |
| `mv:hasFormalStatement` | `mv:FormalStatement` | Claim → its published formal statement (at most one). |
| `mv:formalLanguage` | string | `lean4`. |
| `mv:formalVersion` | `xsd:integer` | The statement's version on the claim; a republished statement is a new version. |
| `mv:formalSource` | string | The statement file, verbatim. |
| `mv:formalPin` | string | The pin id (`mathlib-v4.33.0`): the Lean toolchain and Mathlib revision the statement was elaborated against. |
| `mv:toolchain` | string | The Lean toolchain (`leanprover/lean4:v4.33.0`). |
| `mv:mathlibRevision` | string | The full Mathlib commit. |
| `mv:sourceHash` | string | sha256 over the normalized source and the pin, for the public record. |
| `mv:exprHash` | string | The structural hash of the elaborated proposition, which the checker compares. |
| `mv:correspondence` | string | The correspondence note, in the graph's voice: how the formal and informal statements relate and what the formal one leaves out. |

## Machine-checked arguments (provenance graph)

An argument whose evidence is a checker-accepted proof or disproof of the
formal statement carries, beside `mv:stance`, `mv:verdict`, and
`mv:evaluation`:

| Term | Meaning |
| --- | --- |
| `mv:machineChecked` | `proof` or `disproof`: the checker accepted a Lean proof of the statement, or of its negation, under the allowed axioms. |
| `mv:checkedUnder` | The pin the check ran under; a check is valid for that pin, never a newer one. |
| `mv:checkRecord` | The IRI of the public check record (`/lean-checks/:id`), from which any verdict can be reproduced. |
| `mv:checkedAt` | When the check finished. |
| `mv:axiomsUsed` | The axiom closure of the proof, always within `propext`, `Classical.choice`, and `Quot.sound`. |

`mv:machineChecked` says the proof checks against the statement. Whether
the statement is faithful to the claim is the Steward's judgment, carried
by `mv:status`, `mv:verdict`, and the reasoning as for any other argument.

## What is not exported

Prizes, bounties, and prize claims are not exported, and no `mv:` term
names them. A nanopublication records epistemic content: the claim, its
assessment, the evidence and arguments it rests on, and their provenance.
A prize is an allocation fact, a liability of the platform to a future
claimant that enters no assessment and no valuation (docs/allocation.md),
and exporting it beside the assertion would suggest a bearing it does not
have. A solver attempt likewise enters the export only through what it
produced, a machine-checked argument, never as a fact of its own.

## Voice discipline (§12)

Exported prose (labels, comments, reasoning) is the graph's voice: internal
`[[claim:<uuid>]]` references are resolved to display or canonical text
before export, so ids and scores live only in typed metadata triples, never
inside reader-facing literals.
