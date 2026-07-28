# Contributor reputation, kudos & the good-faith policy

Implementation of [issue #71](https://github.com/minerval-ai/minerval/issues/71),
built directly on the shared account from [#70](accounts.md): a contributor
*is* a user — one `contributors` row carries both the consumer half (keys,
usage, credits) and the contributor half described here. Like #70, it stops
deliberately short of money movement: the ledgers and states exist, the
payment rail is a seam.

## The principles

- **Good faith is always free.** A sincere contribution rejected on the
  merits costs a small amount of reputation and nothing else. Contribution
  review runs as system-attributed LLM usage — never billed to the
  contributor.
- **Bad faith has a credible cost.** One suspected-bad-faith flag flips the
  account to pay-to-contribute standing (a spam/sybil deterrent, not a
  revenue play).
- **Helpfulness is recognized.** Kudos — separate from reputation — tracks
  how much accepted work mattered, structured as a ledger so it can later
  convert to payouts.

## Reputation (the privilege gate)

`contributors.reputation_score` (0–100, default 50) is now load-bearing.
Every change is an append-only `reputation_events` row (delta, score-after,
reason, contribution/review refs), so standing is auditable and reversible.
The rules are constants in `src/services/reputation-service.ts` — policy,
not deployment tuning:

| event | delta |
|---|---|
| contribution accepted | +2 |
| contribution rejected (sincere) | −1 |
| contribution escalated | 0 |
| suspected bad-faith flag | −15 (plus the standing flip below) |
| appeal overturned | compensates the above, then credits the acceptance |

Consequences by score (thresholds shared with the Contribution Reviewer's
`get_contributor_profile` tool): ≥80 trusted, ≥50 standard, ≥20
probationary, <20 restricted. Dropping below **10** auto-suspends, with a
`reputation:`-prefixed `suspension_reason` so appeals can lift exactly the
suspensions this system imposed (manual suspensions remain a human call).
From the default 50 that is ~3 bad-faith flags but ~41 sincere rejections —
abuse escalates fast, sincerity never suspends by accident.

**Sybil sandbox:** `POST /contributions` rate-limits per contributor
(`CONTRIBUTION_RATE_LIMIT_PER_HOUR`, default 10/h), tightened for
low-reputation (<50) or brand-new (<24h) accounts
(`NEW_CONTRIBUTOR_RATE_LIMIT_PER_HOUR`, default 3/h) → `429
CONTRIBUTION_RATE_LIMITED`.

## Good-faith-free / bad-faith-pay

The Contribution Reviewer's decision space is extended: alongside a
`reject`, it may set `suspected_bad_faith` with a category — `spam`,
`vandalism`, `sybil`, or `misinformation` — governed by the new **Good Faith
and Bad Faith (GF)** policy (`src/llm/prompts/policies.ts`). The bar is
deliberately high: sincere-but-wrong is a plain reject; ambiguous suspicion
escalates. The flag is persisted on `contribution_reviews`
(`suspected_bad_faith`, `bad_faith_category`).

One flag sets `contributors.contribution_standing = 'must_pay'` (and
increments `bad_faith_flags`). In must-pay standing, `POST /contributions`
returns **`402 DEPOSIT_REQUIRED`** — the payment seam. When deposits land
(post-incorporation, alongside the consumer credits ledger), this 402
becomes "pay the deposit to continue"; today it means "appeal or wait for
the rail". Reading, and crucially **appealing, stay open**.

### Appeals restore everything

Bad-faith flags and auto-suspensions are appealable through the existing
appeals → Dispute Arbitrator flow. Two changes make that real:

- Suspended contributors may appeal **their own** contributions (the
  suspension check in `POST /appeals` no longer blocks the owner).
- An `overturn` outcome now mechanically restores the contributor
  (`reverseReviewOutcome`): compensating reputation event, rejected→accepted
  counter move, bad-faith flag cleared (standing back to `good` when it was
  the only flag), reputation-imposed suspension lifted, and kudos awarded
  with a survived-scrutiny bonus. Idempotent per contribution.

## Kudos (recognition, future reward)

`kudos_events` is an append-only ledger (contributor, contribution, amount,
reason, awarded_by) with a denormalized `contributors.kudos` total — the
same shape by which `llm_usage` maps onto a future consumer credits ledger,
so payouts for top contributors become a provider swap, not a
re-architecture. No money moves in this issue.

Assignment today is deterministic (`awarded_by = 'system'`):

- **Accepted contribution**: `1 + round(claim.importance × 4)` kudos (1–5) —
  improving a load-bearing claim matters more than a peripheral one.
- **Survived appeal**: the acceptance kudos plus a +2 bonus.

This answers the issue's open question ("who assigns kudos?") with the
cheapest ungameable option; the `awarded_by` column leaves room for peer
signal or "did this change the assessment?" detection to join as additional
sources later.

## Surfaces

| surface | what |
|---|---|
| `POST /contributions` | sign-in required (key-derived identity, #70); gates: suspended → 403, must-pay → 402, sandbox → 429 |
| `GET /contributors` | public kudos leaderboard |
| `GET /contributors/:id` | public profile: reputation, trust level, kudos, accept/reject/escalate counts, standing, recent activity (no email / auth subject) |
| `GET /users/me` | adds `trust_level`, `kudos`, `contribution_standing`, `bad_faith_flags` |
| web `/contributors`, `/contributors/[id]` | leaderboard + profile pages |
| web `/account` | contributor-standing panel: kudos, reputation, and a must-pay notice with the appeal path |

Migration `0007_reputation_kudos` applies automatically at boot.

## Out of scope (deliberately)

Money in/out: deposits, per-contribution fees, and kudos payouts all wait on
incorporation + Stripe, exactly like consumer billing. What exists now is
the state machine (`contribution_standing`), the ledgers
(`reputation_events`, `kudos_events`), and the 402 seam.
