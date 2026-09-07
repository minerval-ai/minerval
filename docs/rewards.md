# Contributor rewards — paying for epistemic work

Design note for the payout side of Minerval: how the company pays money to
contributors for work the graph wanted, without breaking the one-way owl
economy (docs/allocation.md) or the constitution's rule that money buys
scheduling and never conclusions. The public-facing terms are
docs/rewards-policy.md (rendered at `/rewards`); this note is the mechanism
behind them. Nothing here is implemented yet.

## The shape

- **Minerval pays, from its own funds, for services rendered to Minerval.**
  A reward is consideration for a Contribution the Contribution Reviewer
  accepted and the review window did not undo. It is not a prize, not a
  contest, and not a share of anyone's mandate. Funders buy scheduling;
  their mandates inform which work the Grantmaker judges worth inviting,
  and that is the whole of their influence. No funder money is held for,
  earmarked to, or passed through to a contributor. This is what keeps
  Minerval out of the money-transmission analysis and is why Stripe Global
  Payouts (send from our own balance to a third party who need not hold a
  Stripe account) fits, rather than Connect.
- **Owls stay one-way.** Rewards are denominated and paid in USD. Owls never
  convert to rewards or cash; rewards never convert to owls. The
  contribution award (owls for accepted work, docs/accounts.md) continues
  unchanged and separately.
- **Agents recommend; the mechanism pays.** The Grantmaker (in a mandate's
  review pass) or the Claim Steward may propose an offer: "this claim wants
  primary evidence on X; up to N dollars." The proposal is a ledger row,
  bounded by config, never a payment. Acceptance is the Reviewer's ordinary
  judgment. Payment is a worker, on a schedule, holding a key no agent tool
  can reach.

## The invariant: every offer is fully backed

    reserved(open offers) + pending + payable  <=  REWARD_BUDGET

The reward budget is a config number (`REWARD_BUDGET_MICRO_USD`, replenished
per period by `REWARD_BUDGET_PERIOD`), deliberately small and deliberately
less than the company's bank balance. An offer reserves its full maximum at
creation; the reservation follows the reward through pending and payable;
paid releases it. When the budget is committed, `propose_offer` returns a
budget error and the agent moves on, exactly as an allocator does when its
daily rate is spent. There is no path by which the sum of what Minerval has
promised exceeds what it set aside, so "everything gets claimed at once" is
survivable by construction. Per-offer and per-contributor caps
(`REWARD_MAX_PER_CONTRIBUTION_MICRO_USD`,
`REWARD_MAX_PER_CONTRIBUTOR_MONTH_MICRO_USD`) keep any single decision
small; they are mechanical bounds like `POLICY_BOUNDS`, not prompt text.

## The ledger

A `reward_offers` table (claim/scope, kind of work invited, max amount,
proposed_by agent run, mandate that informed it if any, reserved amount,
state open/closed/void) and a `rewards` table (offer, contribution,
contributor, amount, state, timestamps, ground for any denial/reversal,
payout provider reference). States and transitions follow the policy's
Section 6 exactly:

    accepted  -> pending   (Reviewer accepts; amount set within the offer's max)
    pending   -> denied    (appeal overturns, audit supersedes, ground in §7)
    pending   -> payable   (review window elapses, contributor eligible)
    payable   -> paid      (payout worker; idempotency key = reward id)
    payable   -> reversed  (ground in §7 before payment)
    paid      -> reversed  (ground in §7 after payment; recovery per §7.3)

The review window is the clawback period (`REWARD_REVIEW_DAYS`, 30): the
same interval in which the existing appeal, audit-supersession, and
contribution-award clawback paths already operate, so a reward is never
payable while the acceptance it rests on can still be undone cheaply.
Pending and payable amounts are visible on the account page as
information, not balance.

## Payout

Payable rewards accrue per contributor and pay out on a cycle
(`REWARD_PAYOUT_CYCLE`, monthly) once the balance clears a threshold
(`REWARD_PAYOUT_THRESHOLD_MICRO_USD`, 25 USD), because the provider charges
a flat fee per payout (1.50 USD domestic on Global Payouts); any balance
pays at least once a year regardless. Recipients onboard through the
provider's hosted flow (identity, bank, tax forms); Minerval stores only
the recipient id and onboarding status. The payout worker uses a separate
restricted Stripe key scoped to payouts; the existing key stays scoped to
Checkout Sessions. Every payout is idempotent on the reward id and records
the provider reference on the reward row.

## What the agents can and cannot do

- Grantmaker (review mode) and Claim Steward: `propose_offer` within caps
  and budget; `close_offer`. Never amounts above the cap, never a payment.
- Contribution Reviewer: accepts on the merits exactly as today; the reward
  amount is set from the offer, not by the Reviewer, so an offer cannot
  become a thumb on the acceptance scale.
- Dispute Arbitrator and Audit: the ordinary appeal and supersession paths
  are the denial/reversal paths; no new powers.
- No agent holds or can call the payout key.

## Open items

- Stripe: confirm Global Payouts covers 1099 filing for its recipients;
  read the preview terms; decide NEC vs MISC with counsel.
- Terms of Service does not exist yet; the policy assumes it. The
  contribution license is docs/contributor-terms.md (CC0 in, CC0 out).
- Whether rewarded contributions should be marked on the public record
  (the policy says yes, for transparency) and how.
