/**
 * Backfill for issue #173: named arguments created before evaluate_argument
 * existed carry no evaluation (whether the inference goes through granting
 * its premises, and which premises bear the weight).
 *
 * Rather than composing evaluations here, this re-enqueues each affected
 * claim's Steward — the prompt instructs it to evaluate every named argument
 * against the current premise assessments (and it owns the claim, so it can
 * also refresh anything else that is stale while it's there). Detection: a
 * named argument on an active claim with no is_current row in
 * argument_evaluations.
 *
 * Safe by default: prints what it WOULD enqueue and exits. Pass `--confirm`
 * to actually enqueue. Re-driving stewards costs real model spend — run it
 * deliberately, after the evaluate_argument deploy has settled.
 *
 *   npx tsx scripts/backfill-argument-evaluations.ts            # dry run
 *   npx tsx scripts/backfill-argument-evaluations.ts --confirm  # apply
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { enqueueSteward } from "../src/services/queue-service.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  // One row per claim, with the named arguments lacking a current evaluation.
  // Only active claims — the steward queue ignores the rest anyway.
  const rows = await rawQuery<{
    claim_id: string;
    claim_text: string;
    argument_names: string[];
  }>(
    `SELECT c.id AS claim_id, c.text AS claim_text,
            array_agg(coalesce(a.name, a.id::text) ORDER BY a.created_at) AS argument_names
       FROM arguments a
       JOIN claims c ON c.id = a.claim_id
       LEFT JOIN argument_evaluations ae
              ON ae.argument_id = a.id AND ae.is_current = true
      WHERE c.state = 'active'
        AND a.name IS NOT NULL
        AND ae.id IS NULL
      GROUP BY c.id, c.text`
  );

  console.log(`Claims with named arguments lacking an evaluation: ${rows.length}`);
  for (const r of rows.slice(0, 15)) {
    console.log(
      `  ${r.claim_id}  "${r.claim_text.slice(0, 60)}" — ${r.argument_names.join(", ")}`
    );
  }
  if (rows.length > 15) console.log(`  … and ${rows.length - 15} more`);

  if (rows.length === 0 || !confirm) {
    if (rows.length > 0) {
      console.log("\nDry run — re-run with --confirm to enqueue their Stewards.");
    }
    await closeDb();
    return;
  }

  for (const r of rows) {
    await enqueueSteward({
      claimId: r.claim_id,
      trigger: "argument_evaluation_backfill",
      context:
        `Named argument(s) on this claim lack an evaluation: ` +
        `${r.argument_names.join(", ")}. For each, record with ` +
        `evaluate_argument whether the inference goes through granting its ` +
        `premises and which premises, given their current assessments, bear ` +
        `the weight, referencing the load-bearing subclaims inline as ` +
        `[[claim:<uuid>]].`,
    });
  }
  console.log(`\nEnqueued ${rows.length} Stewards. The drain will re-drive them.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
