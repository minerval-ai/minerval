-- Money reconciliation for the two migrations that touched balances.
--
-- (1) Migration 0035 cleared action_allocations wholesale ("dev/preview
-- only") — but the claim-contribution flow existed before it, and nothing
-- enforced that no real DB had rows. A cleared allocation left its funder's
-- owl_ledger debit (reason 'claim_contribution') with nothing that could
-- ever run, settle, or refund it: confiscated money. Compensate: refund
-- every claim_contribution debit that has NO allocation row (live, spent,
-- or released) backing it for that user on that claim's assess group.
-- Post-0035 contributions always have their allocation row (settled rows
-- are kept, not deleted), so only the orphans match. Idempotent per debit.
INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
SELECT ol.user_id, -ol.amount_micro_usd, 'refund', ol.claim_id,
       'm0039:orphaned_contribution:' || ol.id
  FROM owl_ledger ol
 WHERE ol.reason = 'claim_contribution'
   AND ol.amount_micro_usd < 0
   AND NOT EXISTS (
         SELECT 1 FROM action_allocations al
          WHERE al.user_id = ol.user_id
            AND al.exclusion_group = 'assess:' || ol.claim_id::text)
ON CONFLICT (idempotency_key) DO NOTHING;--> statement-breakpoint

-- (2) Migration 0028 renamed credits_ledger to owl_ledger in place. Under
-- the old model the spendable balance was DERIVED: purchases minus metered
-- usage billed at the usage markup; under the owl model the balance is
-- SUM(owl_ledger) and usage is charged as explicit rows. The rename
-- therefore did two things to any pre-existing account: it forgave all
-- usage consumed before the cutover (no debit rows were backfilled), and
-- it revalued the remaining balance at raw-cost owls (1 owl = $1 of
-- metered cost) instead of marked-up credits (~4x purchasing power).
--
-- DECISION, made explicit here rather than left implicit in a rename:
-- pre-cutover usage is FORGIVEN and surviving balances keep their face
-- value in owls. Rationale: the historical markup multiplier lived in
-- config (deleted at the cutover) and cannot be reconstructed reliably in
-- SQL, a retroactive debit could push accounts negative, and the affected
-- population is the pre-launch cohort. The cost of the forgiveness is
-- bounded by that cohort's total prior usage and is accepted as a launch
-- write-off. If a production deployment with material legacy balances ever
-- runs this chain, revisit BEFORE migrating: replace this note with a
-- per-user backfill debit of (metered usage x the markup then in effect),
-- floored at each user's purchased total.
SELECT 1;
