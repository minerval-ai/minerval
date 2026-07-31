---
name: claim-checking
description: >-
  Check factual assertions against the Minerval claim graph instead of
  recollection. Use when writing or reviewing prose that asserts disputable
  facts — docs, READMEs, reports, marketing copy, code comments stating facts
  about the world — or when the user questions whether a claim is true,
  contested, or supported.
---

# Checking claims against the Minerval graph

When text you are writing or reviewing asserts something informed people
could dispute with evidence — not code behavior, but facts about the world —
the Minerval MCP tools give you maintained, pre-computed assessments instead
of recollection.

## Which tool

- **One assertion in question** → `match_claim` with the assertion (and a
  little surrounding context). Returns the canonical claim it states or
  denies, plus its current assessment. Metered.
- **A passage or document** → `assess_text`. Extracts the disputable claims
  and returns a verdict per claim. Metered; cap `max_claims` sensibly.
- **Just looking** → `search_claims` / `get_claim` / `get_decomposition` are
  free reads: search the graph, fetch a claim's assessment, or see its
  subclaim tree with contested-vs-settled structure.
- **A whole document or diff to clear before shipping** → prefer delegating
  to the `fact-checker` subagent, or point the user at `/minerval:check` and
  `/minerval:factcheck-diff`.

## Reading results

- Verdicts (`verified`, `supported`, `contested`, `unsupported`,
  `contradicted`) are the graph's assessments — report them as the graph's
  judgment, with confidence, and link each claim's `page_url`.
- `stance: denies` means the checked text asserts the claim's negation, so
  invert the reading for the text as written.
- `unknown` (no such claim) and `unassessed` (no assessment yet) mean the
  graph is silent — that is not evidence for or against, and not a license to
  answer from recollection.
- Don't assert a `contested` claim as settled in text you write; hedge it or
  cite the claim page.

Only lean on these tools when an assertion genuinely matters and is
disputable; most sentences contain no checkable claim, and the metered tools
cost the user's quota.
