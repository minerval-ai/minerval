/**
 * Reconciliation operations: the data layer for the Curator's re-individuation
 * surgery (constitution §5). Merges combine two claims into one; splits break a
 * conflated claim apart. These mutate nodes, edges, and instances directly — that
 * is the operation.
 *
 * Every operation is recorded in `reconciliation_events` with a payload detailed
 * enough to **reverse** it (§5: every operation is logged, and reversal restores
 * the prior structure without erasing history). `reverseReconciliation`
 * undoes a logged event.
 */
import { getDb, rawQuery } from "../db/client.js";
import { claims, claimRelationships } from "../db/schema.js";
import { generateEmbedding } from "./embedding-service.js";
import { loadConfig } from "../config.js";

interface EdgeRow {
  parent_claim_id: string;
  child_claim_id: string;
  relation_type: string;
  reasoning: string;
  confidence: number;
  argument_id: string | null;
  created_by: string;
}

// SQL fragment: flip affirm/deny (instances) or for/against (arguments) when the
// merge is between a claim and its negation/counterpart ($3 = opposed boolean).
// A "poses" instance (#445) takes no side, so the ELSE keeps it as is.
const FLIP_INSTANCE_STANCE = `CASE WHEN $3::boolean
  THEN (CASE stance WHEN 'affirms' THEN 'denies' WHEN 'denies' THEN 'affirms' ELSE stance END)
  ELSE stance END`;
const FLIP_ARGUMENT_STANCE = `CASE WHEN $3::boolean
  THEN (CASE stance WHEN 'for' THEN 'against' WHEN 'against' THEN 'for' ELSE stance END)
  ELSE stance END`;

const EDGE_COLS =
  "parent_claim_id, child_claim_id, relation_type, reasoning, confidence, argument_id, created_by";

async function logEvent(
  operation: string,
  reasoning: string,
  payload: unknown
): Promise<string | undefined> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO reconciliation_events (operation, reasoning, payload, created_by)
     VALUES ($1, $2, $3::jsonb, 'curator') RETURNING id`,
    [operation, reasoning, JSON.stringify(payload)]
  );
  return rows[0]?.id;
}

async function reinsertEdges(edges: EdgeRow[]): Promise<void> {
  for (const e of edges) {
    try {
      await rawQuery(
        `INSERT INTO claim_relationships (${EDGE_COLS})
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          e.parent_claim_id,
          e.child_claim_id,
          e.relation_type,
          e.reasoning,
          e.confidence,
          e.argument_id,
          e.created_by,
        ]
      );
    } catch {
      // Edge already present (unique index) — idempotent restore, ignore.
    }
  }
}

/**
 * Merge `loserId` into `survivorId`: move the loser's instances, arguments, and
 * edges onto the survivor, then mark the loser a merged alias. On
 * `stanceRelation: "opposed"` (a claim and its negation), moved instance/argument
 * stances are flipped. Logs a reversible `merge` event.
 */
export async function mergeClaims(input: {
  survivorId: string;
  loserId: string;
  stanceRelation: "same" | "opposed";
  reasoning: string;
}): Promise<{ merged: boolean; survivorId: string; loserId: string; eventId?: string }> {
  const { survivorId, loserId, stanceRelation, reasoning } = input;
  if (survivorId === loserId) {
    throw new Error("Cannot merge a claim into itself");
  }
  const opposed = stanceRelation === "opposed";

  // Capture the loser's prior state so a reversal can restore it.
  const [loserRow] = await rawQuery<{ state: string }>(
    `SELECT state FROM claims WHERE id = $1`,
    [loserId]
  );
  const loserPrevState = loserRow?.state ?? "active";

  // 1. Instances onto the survivor (flip if opposed).
  const movedInstances = await rawQuery<{ id: string }>(
    `UPDATE claim_instances SET claim_id = $1, stance = ${FLIP_INSTANCE_STANCE}
      WHERE claim_id = $2 RETURNING id`,
    [survivorId, loserId, opposed]
  );

  // 2. Arguments onto the survivor (flip if opposed).
  const movedArguments = await rawQuery<{ id: string }>(
    `UPDATE arguments SET claim_id = $1, stance = ${FLIP_ARGUMENT_STANCE}
      WHERE claim_id = $2 RETURNING id`,
    [survivorId, loserId, opposed]
  );

  // 3. Edges where the loser is the CHILD: drop self/duplicate edges (captured so
  //    they can be restored), then repoint the rest.
  const deletedChildEdges = await rawQuery<EdgeRow>(
    `DELETE FROM claim_relationships cr
      WHERE cr.child_claim_id = $2
        AND (cr.parent_claim_id = $1
             OR EXISTS (SELECT 1 FROM claim_relationships e
                          WHERE e.child_claim_id = $1
                            AND e.parent_claim_id = cr.parent_claim_id
                            AND e.relation_type = cr.relation_type))
      RETURNING ${EDGE_COLS}`,
    [survivorId, loserId]
  );
  const repointedChild = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET child_claim_id = $1 WHERE child_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 4. Edges where the loser is the PARENT (same dedupe).
  const deletedParentEdges = await rawQuery<EdgeRow>(
    `DELETE FROM claim_relationships cr
      WHERE cr.parent_claim_id = $2
        AND (cr.child_claim_id = $1
             OR EXISTS (SELECT 1 FROM claim_relationships e
                          WHERE e.parent_claim_id = $1
                            AND e.child_claim_id = cr.child_claim_id
                            AND e.relation_type = cr.relation_type))
      RETURNING ${EDGE_COLS}`,
    [survivorId, loserId]
  );
  const repointedParent = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET parent_claim_id = $1 WHERE parent_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 5. Mark the loser a merged alias of the survivor.
  await rawQuery(
    `UPDATE claims SET merged_into = $1, state = 'merged', updated_at = now() WHERE id = $2`,
    [survivorId, loserId]
  );

  const eventId = await logEvent("merge", reasoning, {
    survivor_id: survivorId,
    loser_id: loserId,
    stance_relation: stanceRelation,
    loser_prev_state: loserPrevState,
    moved_instance_ids: movedInstances.map((r) => r.id),
    moved_argument_ids: movedArguments.map((r) => r.id),
    repointed_child_edge_ids: repointedChild.map((r) => r.id),
    repointed_parent_edge_ids: repointedParent.map((r) => r.id),
    deleted_edges: [...deletedChildEdges, ...deletedParentEdges],
  });

  return { merged: true, survivorId, loserId, eventId };
}

/** Create a new claim node (embedded). Logs a reversible `create_claim` event. */
export async function createClaim(input: {
  text: string;
  claimType?: string;
  createdBy?: string;
}): Promise<{ id: string; eventId?: string }> {
  const db = getDb();
  let embedding: number[] | undefined;
  try {
    embedding = await generateEmbedding(input.text);
  } catch {
    // Continue without embedding
  }
  const [claim] = await db
    .insert(claims)
    .values({
      text: input.text,
      claimType: input.claimType ?? "empirical_derived",
      embedding: embedding ?? undefined,
      pipelineEpoch: loadConfig().pipelineEpoch,
      createdBy: input.createdBy ?? "curator",
    })
    .returning();
  const eventId = await logEvent("create_claim", "split: new claim", {
    claim_id: claim!.id,
  });
  return { id: claim!.id, eventId };
}

/** Add a relationship edge between two existing claims. Logs an `add_edge` event. */
export async function addRelationshipEdge(input: {
  parentId: string;
  childId: string;
  relationType: string;
  reasoning: string;
  confidence?: number;
  createdBy?: string;
}): Promise<{ added: boolean; eventId?: string }> {
  if (input.parentId === input.childId) return { added: false };
  const db = getDb();
  try {
    await db.insert(claimRelationships).values({
      parentClaimId: input.parentId,
      childClaimId: input.childId,
      relationType: input.relationType.toLowerCase(),
      reasoning: input.reasoning,
      confidence: input.confidence ?? 1.0,
      createdBy: input.createdBy ?? "curator",
    });
  } catch {
    return { added: false }; // unique constraint — edge already exists
  }
  const eventId = await logEvent("add_edge", input.reasoning, {
    parent_id: input.parentId,
    child_id: input.childId,
    relation_type: input.relationType.toLowerCase(),
  });
  return { added: true, eventId };
}

/** Remove a relationship edge. Captures the deleted rows; logs a `remove_edge` event. */
export async function removeRelationshipEdge(input: {
  parentId: string;
  childId: string;
  relationType?: string;
}): Promise<{ removed: number; eventId?: string }> {
  const deleted = await rawQuery<EdgeRow>(
    `DELETE FROM claim_relationships
      WHERE parent_claim_id = $1 AND child_claim_id = $2
      ${input.relationType ? "AND relation_type = $3" : ""}
      RETURNING ${EDGE_COLS}`,
    input.relationType
      ? [input.parentId, input.childId, input.relationType.toLowerCase()]
      : [input.parentId, input.childId]
  );
  const eventId =
    deleted.length > 0
      ? await logEvent("remove_edge", "split: edge removed", { deleted_edges: deleted })
      : undefined;
  return { removed: deleted.length, eventId };
}

/** Move a source instance to another claim. Logs a reversible `reassign_instance` event. */
export async function reassignInstance(input: {
  instanceId: string;
  toClaimId: string;
}): Promise<{ reassigned: boolean; eventId?: string }> {
  // Capture the prior owner first, so the move is reversible.
  const [before] = await rawQuery<{ claim_id: string }>(
    `SELECT claim_id FROM claim_instances WHERE id = $1`,
    [input.instanceId]
  );
  if (!before || before.claim_id === input.toClaimId) return { reassigned: false };

  await rawQuery(`UPDATE claim_instances SET claim_id = $1 WHERE id = $2`, [
    input.toClaimId,
    input.instanceId,
  ]);

  const eventId = await logEvent("reassign_instance", "split: instance moved", {
    instance_id: input.instanceId,
    from_claim_id: before.claim_id,
    to_claim_id: input.toClaimId,
  });
  return { reassigned: true, eventId };
}

/**
 * Reverse a logged reconciliation event, restoring the prior state as faithfully
 * as the recorded payload allows. Idempotent: a `reversed` event is a no-op.
 */
export async function reverseReconciliation(
  eventId: string
): Promise<{ reversed: boolean; reason?: string }> {
  const [event] = await rawQuery<{
    operation: string;
    payload: Record<string, unknown>;
    reversed: boolean;
  }>(`SELECT operation, payload, reversed FROM reconciliation_events WHERE id = $1`, [eventId]);

  if (!event) return { reversed: false, reason: "event not found" };
  if (event.reversed) return { reversed: false, reason: "already reversed" };

  const p = event.payload;

  switch (event.operation) {
    case "merge": {
      const survivorId = p.survivor_id as string;
      const loserId = p.loser_id as string;
      const opposed = p.stance_relation === "opposed";
      const movedInstances = (p.moved_instance_ids as string[]) ?? [];
      const movedArguments = (p.moved_argument_ids as string[]) ?? [];
      const repointedChild = (p.repointed_child_edge_ids as string[]) ?? [];
      const repointedParent = (p.repointed_parent_edge_ids as string[]) ?? [];
      const deletedEdges = (p.deleted_edges as EdgeRow[]) ?? [];

      // Move instances/arguments back (un-flipping stance for an opposed merge).
      // Param order matches FLIP_*_STANCE, which references $3::boolean.
      if (movedInstances.length) {
        await rawQuery(
          `UPDATE claim_instances SET claim_id = $1, stance = ${FLIP_INSTANCE_STANCE}
            WHERE id = ANY($2::uuid[]) AND claim_id = $4`,
          [loserId, movedInstances, opposed, survivorId]
        );
      }
      if (movedArguments.length) {
        await rawQuery(
          `UPDATE arguments SET claim_id = $1, stance = ${FLIP_ARGUMENT_STANCE}
            WHERE id = ANY($2::uuid[]) AND claim_id = $4`,
          [loserId, movedArguments, opposed, survivorId]
        );
      }
      // Repoint the survivor-side edges back to the loser.
      if (repointedChild.length) {
        await rawQuery(
          `UPDATE claim_relationships SET child_claim_id = $1 WHERE id = ANY($2::uuid[])`,
          [loserId, repointedChild]
        );
      }
      if (repointedParent.length) {
        await rawQuery(
          `UPDATE claim_relationships SET parent_claim_id = $1 WHERE id = ANY($2::uuid[])`,
          [loserId, repointedParent]
        );
      }
      // Restore edges that were deleted as duplicates/self-edges.
      await reinsertEdges(deletedEdges);
      // Un-merge the loser.
      await rawQuery(
        `UPDATE claims SET merged_into = NULL, state = $2, updated_at = now() WHERE id = $1`,
        [loserId, (p.loser_prev_state as string) ?? "active"]
      );
      break;
    }

    case "create_claim": {
      // A split-off claim: deprecate it (excluded from search) rather than hard
      // delete, since downstream rows may reference it.
      await rawQuery(
        `UPDATE claims SET state = 'deprecated', updated_at = now() WHERE id = $1`,
        [p.claim_id as string]
      );
      break;
    }

    case "add_edge": {
      await rawQuery(
        `DELETE FROM claim_relationships
          WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
        [p.parent_id as string, p.child_id as string, p.relation_type as string]
      );
      break;
    }

    case "remove_edge": {
      await reinsertEdges((p.deleted_edges as EdgeRow[]) ?? []);
      break;
    }

    case "reassign_instance": {
      await rawQuery(`UPDATE claim_instances SET claim_id = $1 WHERE id = $2`, [
        p.from_claim_id as string,
        p.instance_id as string,
      ]);
      break;
    }

    default:
      return { reversed: false, reason: `unknown operation: ${event.operation}` };
  }

  await rawQuery(`UPDATE reconciliation_events SET reversed = true WHERE id = $1`, [eventId]);
  return { reversed: true };
}
