# The MIRA export

`GET /claims/:claim_id/mira` (MCP: `export_claim_mira`) serializes a node of
the graph, and the structure around it, as a [MIRA](https://www.mira.science/)
graph (Modular Interoperable Research Attribution) in JSON-LD: questions,
claims, evidence, source documents, and requests, each with its creator.
Since questions (§7a) and requests (Part VIII) became first-class here,
every one of those MIRA classes has a counterpart in our graph.

It sits beside the nanopublication export (#292, docs/vocab.md) and reads
the same evidence record (`assembleEvidenceRecord` in
`src/services/citation-service.ts`), so the two cannot disagree about what
the graph holds. Code: `src/services/mira-service.ts`. Free and unmetered,
like every export.

## The schema, pinned

MIRA's schema is [MIRA-science/schema](https://github.com/MIRA-science/schema),
written in LinkML: vocabulary `http://purl.org/mira-science/mira#`, transport
format JSON-LD under the context `https://purl.org/mira-science/mira.jsonld`,
and SHACL shapes as the validator. The export targets **MIRA 0.1
(tentative)**, as `mira.ttl` states it at commit
[`365d404`](https://github.com/MIRA-science/schema/tree/365d40403498da5c3c6698f21680696b25f1c2c8)
(2026-10-21). That commit's `mira.jsonld`, `mira.ttl`, and `mira.shacl` are
vendored in [`docs/mira/`](mira/) (Apache-2.0, see its README), and every
export shape is validated against them in the unit and DB tests
(`tests/mira-shacl.ts`), as the schema repo's own `make validate_data` does
with pyshacl. Each export names the version and commit it was built for on
its `mv:MiraExport` node.

The schema is a draft. When it moves, re-vendor the three files, update
`MIRA_SCHEMA_COMMIT`, and let the tests say what changed.

## Shape of an export

```json
{
  "@context": [
    "https://purl.org/mira-science/mira.jsonld",
    { "mv": "https://w3id.org/minerval/vocab#", "xsd": "http://www.w3.org/2001/XMLSchema#" }
  ],
  "@graph": [
    { "@id": "https://minerval.ai/#minerval", "@type": "UserAccount", "accountName": "Minerval" },
    { "@id": "https://w3id.org/minerval/claim/<id>#mira", "@type": "mv:MiraExport", "dct:license": { "@id": "https://creativecommons.org/publicdomain/zero/1.0/" }, ... },
    { "@id": "https://w3id.org/minerval/claim/<id>", "@type": "Claim", "title": "...", "creator": "https://minerval.ai/#minerval", ... },
    { "@id": "https://w3id.org/minerval/claim/<id>#record", "@type": "mv:NodeRecord", "mv:describes": { "@id": "https://w3id.org/minerval/claim/<id>" }, "mv:status": "supported", ... },
    ...
  ]
}
```

## Two layers

MIRA's shapes are **closed**: a `Claim` may carry only MIRA's properties
(title, content, description, creator, created, modified, supports,
opposes, addresses). So the export has two layers:

1. **MIRA nodes**, carrying only MIRA terms. A MIRA consumer reads a valid
   MIRA graph and can ignore everything else.
2. **`mv:` nodes beside them**, pointing at the MIRA nodes they describe,
   for what MIRA has no term for. Nothing Minerval holds is dropped or
   forced onto a MIRA property that means something else.

## Mapping

| Minerval | MIRA | Notes |
| --- | --- | --- |
| Node of kind `question` | `Question` | |
| Node of kind `claim` or `quantity` | `Claim` | The kind is on its `mv:NodeRecord`. |
| An answer of a question | `Claim` `addresses` the `Question` | Why it is in the set (`answer_basis`) is on an `mv:Edge`; how two answers bear on each other on an `mv:AnswerRelation`. A claim exported on its own `addresses` each question it answers. |
| Premise of an argument for / against the claim | premise `supports` / `opposes` the claim | MIRA's Argument relations. The argument itself is an `mv:Argument`; the edge's kind (`requires`, `assumes`, ...) is an `mv:Edge`. |
| Subquestion, presupposition | — | `mv:Edge` with relation `part_of` / `presupposes`. |
| Instance where a source states a claim | `Evidence` | `observationStatement` is the claim stated, `sourceDocument` the source, `content` the verbatim quote, `description` the context. `affirms` → `supports`, `denies` → `opposes`; `poses` and a quantity's `states` take no side. An answering instance is Evidence for the answer it matches. |
| Every instance | `mv:Instance` | Stance, quote, `prov:wasQuotedFrom`, and `mv:evidence` → its Evidence. A source that asks a question states no claim, so it has an `mv:Instance` and no Evidence. |
| Source | `SourceDocument` | Named by its document URL where it has one (as MIRA's sample data does), otherwise by its page here. |
| Request bearing on the node | `Request` | `title` is the ask, `description` the why, `request_target` the claims it bears on. A question or source it bears on, what would satisfy it, its state, keeper, and work are on its `mv:RequestRecord` and `mv:RequestWork`. MIRA's `request_for` (a Study) has no counterpart yet. |
| Assessment: status, confidence, credence, summary, reasoning | `mv:NodeRecord` | With `mv:assessmentId` and `mv:assessmentVersion`, the reproducible reference. A question's standing, favored answers, and incompleteness note likewise. |
| Who made it | `creator` (`UserAccount`) | Minerval on every node; a request also names its filer: an administrator role, a contributor's display name, or "a funded mandate", which names no party (§12/§19). |

Neighbouring nodes (premises, answers, subquestions, presuppositions, the
questions a claim answers, a request's other targets) are included with
their title and, on their record, their status or standing. Each is a full
export of its own. The export is one hop deep.

MIRA's `Study`, `Protocol`, and `observationBase` (the data an observation
rests on) have no counterpart in our graph yet and are not emitted. A
Minerval instance is a source's statement of a claim, which is looser than
MIRA's "empirical observation from a particular application of a research
method"; it is the nearest MIRA class, and the `mv:Instance` beside it says
exactly what was recorded.

### No synthetic questions

A claim is not exported as the question it poses ("is X the case?").
Questions are nodes of their own now, with their own answers and standing;
a claim `addresses` the real ones.

## Export rules

The nanopub export's rules hold here too:

- **Credence is omitted exactly where the graph omits it (§10).** No
  `mv:credence`, never a null or 0 standing in for one.
- **No machinery in prose (§12).** `[[claim:<uuid>]]` references in
  summaries, reasoning, arguments, and requests resolve to display or
  canonical text.
- **CC0.** The `mv:MiraExport` node states the content license
  (`dct:license`). Importance, prizes, bounties, and how work was funded are
  not exported (docs/vocab.md, "What is not exported").

## Signing and publishing

MIRA records are meant to be signed by whoever made them. This export names
every node's creator but signs nothing: we publish no signing keys yet, and
a Minerval signature over records the Steward made would claim more than
the attribution does. The export is read-only; pushing to a MIRA host or an
ATProto binding would be a separate, outward-facing step.
