/**
 * One-shot repair for orphaned Steward subclaims (#451).
 *
 * During the #447 rollout the old code's add_decomposition_edge inserted the
 * claim row, then lost the edge insert to a column the migration had already
 * dropped, inside a catch that swallowed the error and reported success. The
 * result: subclaims with no parent edge (and no argument membership) whose
 * parent's assessment still cites them. The handler is transactional now, so
 * this cannot recur; this script puts the edges back for the rows it left.
 *
 * The Steward's intent is not guessed. Every add_decomposition_edge call is
 * recorded in agent_steps with its input (parent_id, relation, reasoning,
 * argument_id) and its result (child_claim_id), so each orphan is matched to
 * the exact call that minted it and re-attached with the same relation and
 * grouping. An orphan with no recorded call is reported and skipped.
 *
 * Safe by default: prints what it WOULD do and exits. Pass `--confirm` to
 * write. After writing, a parent whose named arguments still lack a written
 * form (write_argument failed in the same window) is re-enqueued with the
 * argument_written_form_backfill trigger; that costs a Steward run per parent.
 *
 *   npx tsx scripts/repair-orphaned-subclaims.ts            # dry run
 *   npx tsx scripts/repair-orphaned-subclaims.ts --confirm  # apply
 */
import "dotenv/config";
import { closeDb, rawQuery, withTransaction } from "../src/db/client.js";
import {
  attachEdgeToArgument,
  insertRelationshipEdge,
} from "../src/services/relationship-service.js";
import { enqueueSteward } from "../src/services/queue-service.js";

interface Orphan {
  id: string;
  text: string;
  created_at: string;
  seed_source_claim_id: string | null;
}

interface RecordedCall {
  parent_id: string;
  relation: string;
  reasoning: string;
  argument_id: string | null;
}

interface Plan {
  orphan: Orphan;
  call: RecordedCall | null;
  problem: string | null;
}

/** Steward-created active claims with no parent edge and no source instance. */
async function findOrphans(): Promise<Orphan[]> {
  return rawQuery<Orphan>(
    `SELECT c.id, c.text, c.created_at, c.seed_source_claim_id
       FROM claims c
      WHERE c.state = 'active' AND c.merged_into IS NULL
        AND c.created_by = 'claim_steward'
        AND NOT EXISTS (SELECT 1 FROM claim_relationships r WHERE r.child_claim_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM claim_instances i WHERE i.claim_id = c.id)
      ORDER BY c.created_at`
  );
}

/**
 * The add_decomposition_edge call that minted this claim: a tool_results step
 * whose item reports this child_claim_id. The text filter narrows the scan;
 * the parsed result is what identifies the call.
 */
async function findRecordedCall(claimId: string): Promise<RecordedCall | null> {
  const steps = await rawQuery<{ content: unknown }>(
    `SELECT content FROM agent_steps
      WHERE kind = 'tool_results' AND content::text LIKE '%' || $1 || '%'
      ORDER BY created_at`,
    [claimId]
  );
  for (const step of steps) {
    const items = Array.isArray(step.content) ? step.content : [];
    for (const item of items as Array<Record<string, unknown>>) {
      if (item.name !== "add_decomposition_edge") continue;
      // Each item is { name, input, output }; output is the tool's JSON text.
      let result: Record<string, unknown> = {};
      try {
        result = JSON.parse(String(item.output ?? "{}"));
      } catch {
        continue;
      }
      if (result.child_claim_id !== claimId) continue;
      const input = (item.input ?? {}) as Record<string, unknown>;
      if (typeof input.parent_id !== "string" || typeof input.relation !== "string") continue;
      return {
        parent_id: input.parent_id,
        relation: input.relation.toLowerCase(),
        reasoning: typeof input.reasoning === "string" ? input.reasoning : "",
        argument_id: typeof input.argument_id === "string" ? input.argument_id : null,
      };
    }
  }
  return null;
}

async function checkCall(orphan: Orphan, call: RecordedCall): Promise<string | null> {
  const [parent] = await rawQuery<{ state: string }>(
    `SELECT state FROM claims WHERE id = $1`,
    [call.parent_id]
  );
  if (!parent) return `recorded parent ${call.parent_id} no longer exists`;
  if (parent.state !== "active") return `recorded parent ${call.parent_id} is ${parent.state}`;
  if (orphan.seed_source_claim_id && orphan.seed_source_claim_id !== call.parent_id) {
    return `seed_source_claim_id ${orphan.seed_source_claim_id} disagrees with recorded parent ${call.parent_id}`;
  }
  if (call.argument_id) {
    const [arg] = await rawQuery<{ claim_id: string }>(
      `SELECT claim_id FROM arguments WHERE id = $1`,
      [call.argument_id]
    );
    if (!arg) return `recorded argument ${call.argument_id} no longer exists`;
    if (arg.claim_id !== call.parent_id) {
      return `recorded argument ${call.argument_id} belongs to ${arg.claim_id}, not the parent`;
    }
  }
  return null;
}

async function repair(plan: Plan): Promise<void> {
  const call = plan.call!;
  await withTransaction(async (tx) => {
    const edge = await insertRelationshipEdge(
      {
        parentId: call.parent_id,
        childId: plan.orphan.id,
        relationType: call.relation,
        reasoning: call.reasoning,
        confidence: 1.0,
        createdBy: "claim_steward",
      },
      tx
    );
    if (call.argument_id) await attachEdgeToArgument(call.argument_id, edge.id, tx);
    await tx.query(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by)
       VALUES ($1, 'repair_orphaned_subclaim', $2, 'repair-orphaned-subclaims')`,
      [
        call.parent_id,
        `Re-attached subclaim ${plan.orphan.id} (${call.relation}` +
          (call.argument_id ? `, argument ${call.argument_id}` : "") +
          `) from the Steward's recorded add_decomposition_edge call; the edge ` +
          `insert was lost during the #447 rollout (#451).`,
      ]
    );
  });
}

/** Parents whose named arguments still read as a label, not a written form. */
async function parentsNeedingWrittenForms(parentIds: string[]): Promise<string[]> {
  if (parentIds.length === 0) return [];
  const rows = await rawQuery<{ claim_id: string }>(
    `SELECT DISTINCT a.claim_id FROM arguments a
      WHERE a.claim_id = ANY($1::uuid[]) AND a.name IS NOT NULL
        AND a.content NOT LIKE '%[[claim:%'`,
    [parentIds]
  );
  return rows.map((r) => r.claim_id);
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");

  const orphans = await findOrphans();
  console.log(`Orphaned Steward subclaims: ${orphans.length}`);

  const plans: Plan[] = [];
  for (const orphan of orphans) {
    const call = await findRecordedCall(orphan.id);
    const problem = call
      ? await checkCall(orphan, call)
      : "no recorded add_decomposition_edge call minted this claim";
    plans.push({ orphan, call, problem });
    const head = `  ${orphan.id}  "${orphan.text.slice(0, 70)}"`;
    if (problem) console.log(`${head}\n      SKIP: ${problem}`);
    else
      console.log(
        `${head}\n      -> ${call!.parent_id} (${call!.relation}` +
          (call!.argument_id ? `, argument ${call!.argument_id}` : ", ungrouped") +
          `)`
      );
  }

  const ready = plans.filter((p) => !p.problem);
  if (ready.length === 0 || !confirm) {
    if (ready.length > 0) {
      console.log(`\nDry run: ${ready.length} to re-attach. Re-run with --confirm to write.`);
    }
    await closeDb();
    return;
  }

  let repaired = 0;
  for (const plan of ready) {
    try {
      await repair(plan);
      repaired++;
      console.log(`  re-attached ${plan.orphan.id} -> ${plan.call!.parent_id}`);
    } catch (err) {
      console.error(`  FAILED ${plan.orphan.id}: ${(err as Error).message}`);
    }
  }

  const parents = [...new Set(ready.map((p) => p.call!.parent_id))];
  const needForms = await parentsNeedingWrittenForms(parents);
  for (const claimId of needForms) {
    await enqueueSteward({
      claimId,
      trigger: "argument_written_form_backfill",
      context:
        "Subclaims re-attached after the #447 rollout lost their edges (#451). " +
        "Named arguments on this claim lack a written form because write_argument " +
        "failed in the same window; write one for each from its grouped subclaims.",
    });
    console.log(`  enqueued argument_written_form_backfill for ${claimId}`);
  }

  console.log(`\nRe-attached ${repaired} of ${ready.length}; ${needForms.length} parent(s) enqueued.`);
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
