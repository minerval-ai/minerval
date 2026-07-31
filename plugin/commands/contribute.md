---
description: File a challenge, evidence, or proposal on a Minerval claim
argument-hint: <claim id or assertion, and what you want to contribute>
---

Help the user file a contribution on an existing Minerval claim. A
contribution gets a hearing, not automatic admission: the Contribution
Reviewer evaluates it on its merits, the exchange is recorded on the claim,
and the graph changes only if it succeeds.

Input: `$ARGUMENTS`

## Steps

1. Identify the target claim. Resolve a UUID or claim page URL directly;
   otherwise use `match_claim` or `search_claims` (Minerval MCP) to find it.
   Contributions require an existing target claim — if the graph has no such
   claim, say so; proposing brand-new claims is not available over MCP yet.
2. Fetch it with `get_claim` (include `arguments` and `provenance`) so the
   contribution engages what is already on record rather than repeating it.
3. Settle the contribution type with the user:
   - `challenge` — dispute the claim or its current assessment
   - `support` — supporting evidence or reasoning
   - `add_instance` — a new source where the claim appears
   - `propose_argument` — a named argument for or against
   - `propose_merge` (needs `merge_target_claim_id`), `propose_split`,
     `propose_edit` (usually with `proposed_canonical_form`)
4. Draft the contribution: a clear, self-contained `content` body that engages
   the existing assessment/arguments, plus `evidence_urls` for any sources.
   Strong contributions cite evidence; bare assertions rarely survive review.
5. **Show the user the exact draft — target claim, type, content, evidence
   URLs — and get their explicit confirmation before submitting.** This is a
   public, attributed write to an external service; never submit without
   sign-off on the final text.
6. Submit via `submit_contribution` and report the returned contribution `id`
   and `review_status`.

## Afterwards

Tell the user the contribution is queued for review and that
`get_contribution_status` (with the contribution id) returns the decision —
accept, reject, or escalate — with the reviewer's reasoning and policy
citations once ruled. Offer to check it later in the session.

If submission is refused, relay the reason plainly: rate limits for new or
low-reputation accounts (`CONTRIBUTION_RATE_LIMITED`), suspended or must-pay
standing (`DEPOSIT_REQUIRED` — appealable), or a credential not bound to a
contributor identity (`NO_CONTRIBUTOR_IDENTITY` — sign in via OAuth or use a
key minted from the account dashboard).
