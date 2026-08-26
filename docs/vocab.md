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

## Voice discipline (§12)

Exported prose (labels, comments, reasoning) is the graph's voice: internal
`[[claim:<uuid>]]` references are resolved to display or canonical text
before export, so ids and scores live only in typed metadata triples, never
inside reader-facing literals.
