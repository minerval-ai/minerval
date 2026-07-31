/**
 * Backfill for issue #213 (part 2): before PR #212, applyReviewOutcome's
 * inner `JOIN claims` silently applied nothing for claim-less contributions —
 * every rejected intake contribution (propose_claim, propose_source),
 * including suspected-bad-faith ones, cost its contributor no reputation, no
 * flag, no standing change, and left no ledger row.
 *
 * This finds contributions whose live review rejected them but whose
 * reputation ledger is empty, and applies the outcome late through
 * applyReviewOutcome — now claim-tolerant — with the decision the review
 * actually recorded, bad-faith flag included.
 *
 * Consequences apply IN FULL, including late must-pay standing and the
 * auto-suspension check for old bad-faith flags. That is a deliberate
 * decision (#213 asked for one): the ledger, flag counts, and standing stay
 * mutually consistent, and reverseReviewOutcome can still undo the whole
 * pair if a late flag is appealed and overturned.
 *
 * Scope guards: only contributions still standing 'rejected' (an overturned
 * or re-arbitrated case has moved on — #212 made those self-heal), only
 * non-superseded reviews (a superseded decision is not the live one), and
 * only truly empty ledgers (applyReviewOutcome is not idempotent by itself;
 * the empty-ledger predicate is what makes reruns safe).
 *
 * Safe by default: prints what it WOULD apply and exits. Pass `--confirm`
 * to actually apply.
 *
 *   npx tsx scripts/backfill-review-outcomes.ts            # dry run
 *   npx tsx scripts/backfill-review-outcomes.ts --confirm  # apply
 */
import "dotenv/config";
import { rawQuery, closeDb } from "../src/db/client.js";
import { applyReviewOutcome } from "../src/services/reputation-service.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  const rows = await rawQuery<{
    contribution_id: string;
    contribution_type: string;
    contributor_id: string;
    review_id: string;
    suspected_bad_faith: boolean;
    bad_faith_category: string | null;
    reviewed_at: string;
  }>(
    `SELECT c.id AS contribution_id, c.contribution_type, c.contributor_id,
            r.id AS review_id, r.suspected_bad_faith, r.bad_faith_category,
            r.reviewed_at
       FROM contributions c
       JOIN contribution_reviews r
         ON r.contribution_id = c.id
        AND r.decision = 'reject'
        AND r.superseded = false
      WHERE c.review_status = 'rejected'
        AND NOT EXISTS (
          SELECT 1 FROM reputation_events e WHERE e.contribution_id = c.id
        )
      ORDER BY r.reviewed_at`
  );

  console.log(`Rejected contributions with an empty reputation ledger: ${rows.length}`);
  for (const r of rows) {
    console.log(
      `  ${r.contribution_id}  ${r.contribution_type}  contributor ${r.contributor_id}` +
        `  reviewed ${r.reviewed_at}` +
        (r.suspected_bad_faith ? `  BAD FAITH (${r.bad_faith_category})` : "")
    );
  }

  if (rows.length === 0 || !confirm) {
    if (rows.length > 0) {
      console.log("\nDry run — re-run with --confirm to apply the outcomes.");
    }
    await closeDb();
    return;
  }

  for (const r of rows) {
    const outcome = await applyReviewOutcome({
      contributionId: r.contribution_id,
      reviewId: r.review_id,
      decision: "reject",
      suspectedBadFaith: r.suspected_bad_faith,
      badFaithCategory: r.bad_faith_category,
    });
    if (!outcome) {
      console.log(`  ${r.contribution_id}: SKIPPED (contribution or contributor missing)`);
      continue;
    }
    console.log(
      `  ${r.contribution_id}: ${outcome.previousScore} -> ${outcome.newScore}` +
        `, standing ${outcome.standing}` +
        (outcome.suspended ? ", SUSPENDED" : "")
    );
  }
  console.log(`\nApplied ${rows.length} late review outcomes.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
