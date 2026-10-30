# The MIRA export

`GET /claims/:claim_id/mira` (MCP: `export_claim_mira`) serializes a node of
the graph, and the structure around it, as records in the shape of
[MIRA](https://www.mira.science/) (Modular Interoperable Research
Attribution): an open architecture that publishes research as a graph of
questions, claims, evidence, sources, and requests, each attributed to
whoever made it. Since questions (§7a) and requests (Part VIII) became
first-class in our graph, every MIRA record type has a counterpart here.

It sits beside the nanopublication export (#292, docs/vocab.md) and reads
the same evidence record (`assembleEvidenceRecord` in
`src/services/citation-service.ts`), so the two cannot disagree about what
the graph holds. Code: `src/services/mira-service.ts`. Free and unmetered,
like every export.

## Version: profile 0.1, provisional

MIRA describes its record types publicly but had not published a formal
schema (JSON Schema, JSON-LD context, or versioned spec) when this export
was written (2026-10). So we pin our own profile of it, versioned and
schema-checked, rather than wait or claim conformance to a spec we have not
seen:

- Profile IRI: `https://w3id.org/minerval/mira/0.1`, in every bundle's
  `mira_profile` field.
- JSON Schema: [`docs/mira/minerval-mira-0.1.schema.json`](mira/minerval-mira-0.1.schema.json),
  also at `https://w3id.org/minerval/mira/0.1/schema.json` once the w3id
  registration (infra/w3id/) merges. The unit tests validate every bundle
  shape against it.

When MIRA publishes its schema, the mapping below becomes a new profile
version (or MIRA's own version), and this one keeps resolving for bundles
that cite it.

## The bundle

```json
{
  "mira_profile": "https://w3id.org/minerval/mira/0.1",
  "profile_version": "0.1",
  "generated_at": "2026-10-30T12:00:00.000Z",
  "license": "https://creativecommons.org/publicdomain/zero/1.0/",
  "publisher": { "name": "Minerval", "url": "https://minerval.ai" },
  "root": "https://w3id.org/minerval/claim/<id>",
  "records": [ { "type": "claim", ... }, { "type": "evidence", ... }, ... ]
}
```

`records` begins with the root node and holds each record once. Every
record has an `id` (an IRI), a `type`, an `attribution` list, and, where
Minerval has something MIRA has no field for, `extensions.mv`.

## Mapping

| Minerval | MIRA record | Notes |
| --- | --- | --- |
| A node of kind `question` | `question` | `answered_by` links to its answers, `has_part` to its subquestions, `presupposes` to its presuppositions. |
| A node of kind `claim` or `quantity` | `claim` | The kind is in `extensions.mv.kind`. |
| Decomposition edge (`requires`, `assumes`, `supports`, `contradicts`, `specifies`, `defines`) | claim → claim link | `requires`, `assumes`, `supported_by`, `contradicted_by`, `specified_by`, `defined_by`; anything unmapped is `related_to`, as the nanopub degrades to `mv:relatedTo`. |
| An answer of a question | `claim` linked `answers` → the question | Answer relations become `excludes` / `compatible_with` links between the answers. A claim exported on its own links `answers` to each question it answers. |
| Instance (verbatim quote + stance) | `evidence` | `relation` is the stance: `affirms` → `supports`, `denies` → `disputes`, `poses` → `discusses`, and the kinds' `asks`, `answers`, `states` as themselves. An answering instance names its matched answer in `answer`. |
| Source document | `source` | `id` is the source's page; `url` is the document itself, or null. |
| Request bearing on the node | `request` | `ask`, `why`, `satisfied_by`, `addressed_to`, `state`, `bears_on` (nodes and sources). Who could meet it, the keeper, and the work done are in `extensions.mv`. |
| Assessment (status, confidence, credence, reasoning) | `extensions.mv` on the root | With `assessment_id` and `assessment_version`, the reproducible reference. A question's standing, favored answers, and incompleteness note likewise. |
| Assessing model or Steward | `attribution`, role `assessor` | |
| Request filer | `attribution`, role `filer` | `agent` (an administrator role), `contributor` (display name), or `mandate`, which names no party (§12/§19): its label is "a funded mandate". |
| Minerval itself | `attribution`, role `publisher` | On every record. |

Neighbouring nodes (premises, answers, subquestions, the questions a claim
answers) are included as stubs: text, kind, and status or standing, marked
`extensions.mv.stub: true`. Each is a full record in its own export. The
export is one hop deep; a subgraph walk can be added when a consumer needs
one.

### Minerval terms with no MIRA equivalent

These travel under `extensions.mv`, named as in the `mv:` vocabulary
(docs/vocab.md), rather than being dropped or forced onto a MIRA field:

- the six-status assessment, verdict confidence, and credence;
- arguments as named groupings of premises, with the Steward's verdict,
  decisiveness, and evaluation;
- a question's standing (`answered`, `leaning`, `open`, `ill_posed`,
  `unknown`), favored answers, and why an answer is in the set
  (`answer_basis`);
- the claim type and the node's page.

Importance is not exported: it is the graph's allocation of attention, not
a fact about the claim. As in the nanopub export, prizes, bounties, and how
work was funded are left out (docs/vocab.md, "What is not exported").

### No synthetic questions

A claim is not exported as the question it poses ("is X the case?").
Questions are nodes of their own now, with their own answers and standing.
A claim exports as a claim, linked to the real questions it answers.

## Export rules

The nanopub export's rules hold here too:

- **Credence is omitted exactly where the graph omits it (§10).** No
  `credence` key, never a null or 0 standing in for one.
- **No machinery in prose (§12).** `[[claim:<uuid>]]` references in
  summaries, reasoning, arguments, and requests resolve to display or
  canonical text; ids live only in `id`, `target`, and the typed extension
  fields.
- **CC0.** Every bundle states the content license in `license`.

## Signing and ingest

MIRA records are signed by whoever made them. This export attributes every
record but does not sign it: we publish no signing keys yet, and a signature
from Minerval over records the Steward made would claim more than the
attribution does. The export is read-only. Pushing to a MIRA ingest API
would be a separate, outward-facing step, taken once MIRA publishes one.
