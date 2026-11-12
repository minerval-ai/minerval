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
 * Every node it moves gets a record in claim_state_changes, in the same
 * statement as the move (#962): who ran it (--actor), why (--reason, or the
 * cohort file's `reason`), the cohort, and the successors the cohort file
 * names for it, if any. That record is what the node's history, the changes
 * stream and get_claim's `retired` section show, and what a write refused for
 * the node quotes. Before it, an archive left nothing to say who retired a
 * node or why.
 *
 * Cohort selection:
 *   default          claims with pipeline_epoch IS NULL (the legacy cohort
 *                    from before epoch stamping existed)
 *   --epoch=<tag>    claims stamped with a specific epoch
 *   --ids-file=<p>   the claims listed in a cohort file (scripts/cohorts/),
 *                    for a cohort no epoch tag picks out, e.g. one topic's
 *                    claims minted before a change that shipped without an
 *                    epoch bump. The file is JSON: an array of claim ids, or
 *                    an object whose `ids` is one (its other keys record how
 *                    the cohort was chosen: `reason` is used as the record's
 *                    reason, and `successors`, an object from a claim id to
 *                    the ids that carry on what it stated, as its successors).
 *                    Restoring with the same file undoes exactly that archive.
 *
 * Writing needs --confirm and --actor=<who is running it>; an archive also
 * needs a reason (--reason=<text>, or the cohort file's `reason`).
 *
 *   --record-only --at=<ISO time>
 *                    write the record for nodes of the cohort that are
 *                    already archived (or, with --restore, already active)
 *                    and have none, dated --at, without changing any state:
 *                    for an archive run before records were kept. The Oct 29
 *                    2026 AI cohort was archived at 2026-10-29T22:07:53.917Z
 *                    (the nodes' updated_at).
 *
 * Safe by default: prints what it WOULD do and exits. Pass --confirm to write.
 * Take a snapshot first (pg_dump) — the script reminds you, but cannot verify.
 *
 *   npx tsx scripts/archive-legacy-claims.ts                     # dry run
 *   npx tsx scripts/archive-legacy-claims.ts --confirm --actor=jackson --reason="..."
 *   npx tsx scripts/archive-legacy-claims.ts --restore --confirm --actor=jackson --reason="..."
 *   npx tsx scripts/archive-legacy-claims.ts \
 *     --ids-file=scripts/cohorts/<name>.json --confirm --actor=jackson  # a listed cohort
 */
import { readFileSync } from "fs";
import { basename } from "path";
import "../src/load-env.js";
import { rawQuery, closeDb } from "../src/db/client.js";
import { changeClaimsState } from "../src/services/claim-lifecycle-service.js";

function argValue(name: string): string | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg?.split("=").slice(1).join("=");
}

interface CohortFile {
  ids: string[];
  reason?: string;
  successors?: Record<string, string[]>;
}

function readCohortFile(path: string): CohortFile {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const obj = Array.isArray(parsed) ? { ids: parsed } : (parsed as Record<string, unknown>);
  const ids = obj.ids;
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string")) {
    throw new Error(`${path}: expected an array of claim ids, or an object with one under "ids".`);
  }
  const successors = obj.successors;
  if (
    successors !== undefined &&
    (typeof successors !== "object" ||
      successors === null ||
      !Object.values(successors).every((v) => Array.isArray(v) && v.every((s) => typeof s === "string")))
  ) {
    throw new Error(`${path}: "successors" must map a claim id to an array of claim ids.`);
  }
  return {
    ids: ids as string[],
    reason: typeof obj.reason === "string" ? obj.reason : undefined,
    successors: successors as Record<string, string[]> | undefined,
  };
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const restore = process.argv.includes("--restore");
  const recordOnly = process.argv.includes("--record-only");
  const epoch = argValue("epoch");
  const idsFile = argValue("ids-file");
  const actorName = argValue("actor");
  const atArg = argValue("at");
  if (epoch && idsFile) {
    throw new Error("Pass --epoch or --ids-file, not both.");
  }
  const at = atArg ? new Date(atArg) : null;
  if (atArg && Number.isNaN(at!.getTime())) throw new Error(`--at=${atArg} is not a time.`);
  if (recordOnly && !at) throw new Error("--record-only needs --at=<when the change was made>.");

  // In restore mode we flip archived → active for the same cohort selection.
  const fromState = restore ? "archived" : "active";
  const toState = restore ? "active" : "archived";
  // With --record-only the nodes are already in toState: that is what is selected.
  const selectState = recordOnly ? toState : fromState;
  let epochClause = "pipeline_epoch IS NULL";
  let epochParams: unknown[] = [];
  let cohortLabel = "legacy (pipeline_epoch IS NULL)";
  let cohortName = "pipeline_epoch IS NULL";
  let cohort: CohortFile | null = null;
  if (epoch) {
    epochClause = "pipeline_epoch = $1";
    epochParams = [epoch];
    cohortLabel = `epoch '${epoch}'`;
    cohortName = `epoch:${epoch}`;
  } else if (idsFile) {
    cohort = readCohortFile(idsFile);
    epochClause = "id = ANY($1::uuid[])";
    epochParams = [cohort.ids];
    cohortLabel = `${cohort.ids.length} claims listed in ${idsFile}`;
    cohortName = basename(idsFile, ".json");
  }
  // A restore states its own reason; the cohort file's is why it was archived.
  const reason = argValue("reason") ?? (restore ? undefined : cohort?.reason);

  const rows = await rawQuery<{ id: string; with_instances: boolean; assessed: boolean }>(
    `SELECT c.id,
            EXISTS (SELECT 1 FROM claim_instances i WHERE i.claim_id = c.id) AS with_instances,
            EXISTS (SELECT 1 FROM assessments_in_force a WHERE a.claim_id = c.id) AS assessed
       FROM claims c
      WHERE c.state = '${selectState}' AND ${epochClause}`,
    epochParams
  );

  console.log(`Cohort: ${cohortLabel}, state='${selectState}'`);
  console.log(`  claims: ${rows.length}`);
  console.log(`  with source instances: ${rows.filter((r) => r.with_instances).length}`);
  console.log(`  with current assessment: ${rows.filter((r) => r.assessed).length}`);
  const withSuccessors = rows.filter((r) => (cohort?.successors?.[r.id]?.length ?? 0) > 0).length;
  if (cohort?.successors) console.log(`  naming successors: ${withSuccessors}`);
  console.log(`  record: ${toState} by operator:${actorName ?? "<--actor>"}, cohort ${cohortName}`);
  console.log(`  reason: ${reason ?? "<none: pass --reason>"}`);
  if (recordOnly) console.log(`  record only, dated ${at!.toISOString()}; no state changes`);

  if (rows.length === 0) {
    console.log("Nothing to do.");
    await closeDb();
    return;
  }

  if (!confirm) {
    const samples = await rawQuery<{ text: string }>(
      `SELECT text FROM claims c
        WHERE c.state = '${selectState}' AND ${epochClause}
        ORDER BY importance DESC LIMIT 8`,
      epochParams
    );
    console.log(`\nSample (highest importance first):`);
    for (const s of samples) console.log(`  · ${s.text.slice(0, 90)}`);
    console.log(
      `\nDry run — re-run with --confirm --actor=<you> to ` +
        (recordOnly ? `record these as '${toState}'.` : `set these to '${toState}'.`) +
        (restore || recordOnly
          ? ""
          : `\nBEFORE confirming: snapshot the database (pg_dump) so the epoch is` +
            `\npreserved in cold storage. See docs/graph-epochs.md.`)
    );
    await closeDb();
    return;
  }

  if (!actorName) throw new Error("--confirm needs --actor=<who is running this>, for the record.");
  if (!reason) throw new Error("--confirm needs --reason=<why>, for the record (an archive can take the cohort file's).");

  const moved = await changeClaimsState({
    ids: rows.map((r) => r.id),
    fromState,
    toState,
    actor: `operator:${actorName}`,
    reason,
    cohort: cohortName,
    successors: cohort?.successors,
    recordOnly,
    at,
  });
  console.log(
    recordOnly
      ? `\nRecorded ${moved.length} claims as '${toState}' (${rows.length - moved.length} already had a record).`
      : `\n${restore ? "Restored" : "Archived"} ${moved.length} claims (${fromState} → ${toState}), each with its record.`
  );
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
