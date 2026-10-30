# /minerval/

Permanent identifiers for [Minerval](https://minerval.ai), a knowledge graph
of canonicalized claims with transparent, versioned validity assessments.

Redirects:

- `https://w3id.org/minerval/claim/<claim-id>` → the claim's page at
  `https://minerval.ai/claims/<claim-id>`. Claim ids are stable UUIDs; these
  identifiers appear in scholarly citations of claims and their assessments,
  so the namespace is expected to be long-lived.
- `https://w3id.org/minerval/vocab` → the documentation of the `mv:` RDF
  vocabulary (`https://w3id.org/minerval/vocab#...`) used by the graph's
  nanopublication export.
- `https://w3id.org/minerval/mira/<version>` → the documentation of the
  graph's MIRA export profile, and `.../mira/<version>/schema.json` → that
  profile's JSON Schema.
- `https://w3id.org/minerval/` → `https://minerval.ai/`.

Maintainers / contact:

- Jackson Hurley — jackson@minerval.ai — GitHub: [jacksonqueenking](https://github.com/jacksonqueenking)

Source: [minerval-ai/minerval](https://github.com/minerval-ai/minerval)
