/**
 * One-shot recovery for claims parked as `steward_state='error'` by a TRANSIENT
 * failure (#97). The late-June credit-balance outage parked 81 of 142 production
 * claims as `error`; the pipeline now requeues transient failures automatically,
 * but claims parked BEFORE that fix landed still need a manual reset.
 *
 * This resets matching `error` claims back to `pending` (clearing the error and
 * the attempt counter) so the drain re-drives them. It does NOT touch claims
 * whose error looks like a genuine logic failure.
 *
 * Safe by default: prints what it WOULD reset and exits. Pass `--confirm` to
 * actually write. Re-driving costs real model spend and (until #98's stop-rule
 * fix is deployed) may regenerate over-decomposed trees — run it deliberately.
 *
 *   npx tsx scripts/recover-parked-stewards.ts            # dry run
 *   npx tsx scripts/recover-parked-stewards.ts --confirm  # apply
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { isTransientApiError } from "../src/llm/errors.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  const parked = await rawQuery<{ id: string; steward_error: string | null }>(
    `SELECT id, steward_error FROM claims
      WHERE state = 'active' AND steward_state = 'error'`
  );

  // Reuse the exact same classifier the pipeline uses, so "what we recover" and
  // "what we would auto-requeue going forward" can never drift apart.
  const transient = parked.filter((c) =>
    isTransientApiError(new Error(c.steward_error ?? ""))
  );
  const genuine = parked.length - transient.length;

  console.log(`Parked 'error' claims: ${parked.length}`);
  console.log(`  transient (recoverable): ${transient.length}`);
  console.log(`  genuine logic errors (left as-is): ${genuine}`);

  if (transient.length === 0) {
    console.log("Nothing to recover.");
    await closeDb();
    return;
  }

  if (!confirm) {
    console.log("\nDry run — re-run with --confirm to reset these to 'pending'.");
    for (const c of transient.slice(0, 10)) {
      console.log(`  ${c.id}  ${(c.steward_error ?? "").slice(0, 80)}`);
    }
    if (transient.length > 10) console.log(`  … and ${transient.length - 10} more`);
    await closeDb();
    return;
  }

  const ids = transient.map((c) => c.id);
  await rawQuery(
    `UPDATE claims
        SET steward_state = 'pending', steward_error = NULL,
            steward_attempts = 0, updated_at = now()
      WHERE id = ANY($1::uuid[])`,
    [ids]
  );
  console.log(`\nReset ${ids.length} claims to 'pending'. The drain will re-drive them.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
