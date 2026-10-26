/**
 * Archive a pipeline-epoch cohort of claims (graph epochs — see
 * docs/graph-epochs.md).
 *
 * When prompts/constitution change materially (a new pipeline epoch), claims
 * minted under the old rules usually should not stay live: they were held to a
 * different claim bar and importance standard. Rather than deleting them, this
 * sets state='archived' — they leave search, matching, browse, trees, and the
 * steward queue (all read paths filter state='active'), but keep their rows,
 * provenance, assessments, and embeddings, and stay readable by direct id.
 * Fully reversible with --restore.
 *
 * Cohort selection:
 *   default          claims with pipeline_epoch IS NULL (the legacy cohort
 *                    from before epoch stamping existed)
 *   --epoch=<tag>    claims stamped with a specific epoch
 *
 * Safe by default: prints what it WOULD do and exits. Pass --confirm to write.
 * Take a snapshot first (pg_dump) — the script reminds you, but cannot verify.
 *
 *   npx tsx scripts/archive-legacy-claims.ts                     # dry run
 *   npx tsx scripts/archive-legacy-claims.ts --confirm           # archive
 *   npx tsx scripts/archive-legacy-claims.ts --restore --confirm # undo
 */
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const restore = process.argv.includes("--restore");
  const epoch = argValue("epoch");

  // In restore mode we flip archived → active for the same cohort selection.
  const fromState = restore ? "archived" : "active";
  const toState = restore ? "active" : "archived";
  const epochClause = epoch ? "pipeline_epoch = $1" : "pipeline_epoch IS NULL";
  const epochParams = epoch ? [epoch] : [];

  const cohort = await rawQuery<{
    n: number;
    with_instances: number;
    assessed: number;
  }>(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM claim_instances i WHERE i.claim_id = c.id
            ))::int AS with_instances,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM assessments a WHERE a.claim_id = c.id AND a.is_current
            ))::int AS assessed
       FROM claims c
      WHERE c.state = '${fromState}' AND ${epochClause}`,
    epochParams
  );
  const stats = cohort[0]!;

  const cohortLabel = epoch ? `epoch '${epoch}'` : "legacy (pipeline_epoch IS NULL)";
  console.log(`Cohort: ${cohortLabel}, state='${fromState}'`);
  console.log(`  claims: ${stats.n}`);
  console.log(`  with source instances: ${stats.with_instances}`);
  console.log(`  with current assessment: ${stats.assessed}`);

  if (stats.n === 0) {
    console.log("Nothing to do.");
    await closeDb();
    return;
  }

  if (!confirm) {
    const samples = await rawQuery<{ text: string }>(
      `SELECT text FROM claims c
        WHERE c.state = '${fromState}' AND ${epochClause}
        ORDER BY importance DESC LIMIT 8`,
      epochParams
    );
    console.log(`\nSample (highest importance first):`);
    for (const s of samples) console.log(`  · ${s.text.slice(0, 90)}`);
    console.log(
      `\nDry run — re-run with --confirm to set these to '${toState}'.` +
        (restore
          ? ""
          : `\nBEFORE confirming: snapshot the database (pg_dump) so the epoch is` +
            `\npreserved in cold storage. See docs/graph-epochs.md.`)
    );
    await closeDb();
    return;
  }

  await rawQuery(
    `UPDATE claims c
        SET state = '${toState}', updated_at = now()
      WHERE c.state = '${fromState}' AND ${epochClause}`,
    epochParams
  );
  console.log(
    `\n${restore ? "Restored" : "Archived"} ${stats.n} claims (${fromState} → ${toState}).`
  );
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
