---
description: Look up a claim in the Minerval graph and show its decomposition and assessment
argument-hint: <claim id or a free-text assertion>
---

Look up one claim in the Minerval claim graph and present its standing: the
canonical form, the current assessment, and the decomposition that shows where
agreement ends and dispute begins.

Input: `$ARGUMENTS`

## Steps

1. Identify the claim.
   - If the input is a UUID (or a minerval claim page URL containing one), use
     it directly.
   - Otherwise, run the assertion through `match_claim` (Minerval MCP; metered)
     to find the canonical claim it states or denies. If `matched` is false,
     fall back to `search_claims` (free) and show the nearest results instead
     — then stop, noting the graph does not yet hold this claim and that
     `/minerval:contribute` can propose additions to existing claims.
2. Fetch the claim in full with `get_claim`, including `provenance`,
   `arguments`, and `dependents`.
3. Fetch the subclaim tree with `get_decomposition`.

## Report

- **Canonical form**, claim type, state, importance, and the `page_url` link.
- **Assessment**: status, confidence (how sure the assessor is of the status),
  `claim_credence` (probability the claim is true — may be `null` where one
  number would be false precision), the summary, the assessing model, and the
  assessment date. If there is no assessment, say the claim is unassessed.
- If the input was a free-text assertion, state the `stance`: whether the
  input **affirms** or **denies** the canonical claim, and what the assessment
  therefore means for the input as written.
- **Decomposition**: render the subclaim tree compactly, marking each node's
  assessment status so contested-vs-settled structure is visible at a glance.
  Point out where the live disagreement sits, if anywhere.
- **Arguments and dependents**, briefly, when they exist: the named arguments
  bearing on the claim and the claims that rest on this one.

Report only what the graph returns; where the graph is silent, say so rather
than filling the gap from recollection.
