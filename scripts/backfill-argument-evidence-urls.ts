/**
 * Backfill for #541: migration 0104 moved the source URLs out of the old
 * arguments.evidence_urls column into argument_evidence_backlog (Lean check
 * references became arguments.lean_check_id). This sends each argument's
 * URLs to its claim's Steward, to read the sources and record an instance
 * where one makes, attacks or mentions the argument. A message opens a
 * candidate pass; the ledger decides whether it runs.
 *
 * Safe by default: prints what it would send. Pass --confirm to send.
 *
 *   npx tsx scripts/backfill-argument-evidence-urls.ts            # dry run
 *   npx tsx scripts/backfill-argument-evidence-urls.ts --confirm  # send
 */
import "../src/load-env.js";
import { closeDb } from "../src/db/client.js";
import { sendArgumentEvidenceBacklog } from "../src/services/argument-evidence-service.js";

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const groups = await sendArgumentEvidenceBacklog({ dryRun: !confirm });
  const urls = groups.reduce((n, g) => n + g.urls.length, 0);
  console.log(`${confirm ? "Sent" : "Would send"} ${groups.length} message(s) covering ${urls} URL(s).`);
  for (const g of groups.slice(0, 15)) console.log(`  claim ${g.claimId}  argument ${g.argumentId}: ${g.urls.length} URL(s)`);
  if (groups.length > 15) console.log(`  … and ${groups.length - 15} more`);
  if (!confirm && groups.length > 0) console.log("\nDry run: re-run with --confirm to send.");
  await closeDb();
}

main().catch(async (err) => {
  console.error(err);
  await closeDb();
  process.exit(1);
});
