/**
 * Backfill for issue #129: named arguments created before write_argument
 * existed have their label copied into `content` instead of a written form
 * (brief prose with inline [[claim:<uuid>]] references stating how the
 * subclaims combine to bear on the claim).
 *
 * Rather than composing prose here, this re-enqueues each affected claim's
 * Steward — the prompt now instructs it to write the missing written forms
 * (and it owns the claim, so it can also fix stale grouping while it's there).
 * Detection matches hasWrittenForm(): content with no [[claim: links is a
 * label, not a written form.
 *
 * Safe by default: prints what it WOULD enqueue and exits. Pass `--confirm`
 * to actually enqueue. Re-driving stewards costs real model spend — run it
 * deliberately, ideally after the write_argument deploy has settled.
 *
 *   npx tsx scripts/backfill-argument-written-forms.ts            # dry run
 *   npx tsx scripts/backfill-argument-written-forms.ts --confirm  # apply
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { enqueueSteward } from "../src/services/queue-service.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  // One row per claim, with the named arguments whose content is still a
  // label. Only active claims — the steward queue ignores the rest anyway.
  const rows = await rawQuery<{
    claim_id: string;
    claim_text: string;
    argument_names: string[];
  }>(
    `SELECT c.id AS claim_id, c.text AS claim_text,
            array_agg(coalesce(a.name, a.id::text) ORDER BY a.created_at) AS argument_names
       FROM arguments a
       JOIN claims c ON c.id = a.claim_id
      WHERE c.state = 'active'
        AND a.name IS NOT NULL
        AND a.content NOT LIKE '%[[claim:%'
      GROUP BY c.id, c.text`
  );

  console.log(`Claims with named arguments lacking a written form: ${rows.length}`);
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
      trigger: "argument_written_form_backfill",
      context:
        `Named argument(s) on this claim lack a written form: ` +
        `${r.argument_names.join(", ")}. For each, state in 1–3 sentences how ` +
        `its subclaims combine to bear on the claim, referencing every ` +
        `subclaim inline as [[claim:<uuid>]], via write_argument.`,
    });
  }
  console.log(`\nEnqueued ${rows.length} Stewards. The drain will re-drive them.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
