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
import { claims } from "../db/schema.js";
import { generateEmbedding } from "./embedding-service.js";
import { loadConfig } from "../config.js";
import { insertRelationshipEdge } from "./relationship-service.js";
import {
  linkClaims as insertClaimLink,
  unlinkClaims as deleteClaimLinks,
  type ClaimLinkKind,
  type ClaimLinkRow,
} from "./claim-link-service.js";

/** One argument_subclaims row, as recorded in a reversible payload. */
interface MembershipRef {
  argument_id: string;
  relationship_id: string;
}

interface EdgeRow {
  parent_claim_id: string;
  child_claim_id: string;
  relation_type: string;
  reasoning: string;
  confidence: number;
  created_by: string;
  /**
   * The named arguments the edge was grouped under when it was deleted
   * (argument_subclaims, #437), so a reversal can restore the grouping.
   * Absent on payloads logged before membership moved off the edge.
   */
  argument_ids?: string[];
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

/**
 * Capture edges (with their argument memberships) and delete them, in that
 * order: membership rows cascade away with the edge, so they must be read
 * first for the reversal payload.
 */
async function captureAndDeleteEdges(edgeIds: string[]): Promise<EdgeRow[]> {
  if (edgeIds.length === 0) return [];
  const captured = await rawQuery<EdgeRow>(
    `SELECT cr.parent_claim_id, cr.child_claim_id, cr.relation_type,
            cr.reasoning, cr.confidence, cr.created_by,
            COALESCE(
              array_agg(am.argument_id) FILTER (WHERE am.argument_id IS NOT NULL),
              '{}'
            ) AS argument_ids
       FROM claim_relationships cr
       LEFT JOIN argument_subclaims am ON am.relationship_id = cr.id
      WHERE cr.id = ANY($1::uuid[])
      GROUP BY cr.id`,
    [edgeIds]
  );
  await rawQuery(`DELETE FROM claim_relationships WHERE id = ANY($1::uuid[])`, [
    edgeIds,
  ]);
  return captured;
}

/**
 * Restore captured edges and their argument memberships. Idempotent: an edge
 * already present is reused, and a membership is re-added only while its
 * argument still exists on the edge's parent claim (the invariant
 * relationship-service enforces on live writes).
 */
async function reinsertEdges(edges: EdgeRow[]): Promise<void> {
  for (const e of edges) {
    const { id } = await insertRelationshipEdge({
      parentId: e.parent_claim_id,
      childId: e.child_claim_id,
      relationType: e.relation_type,
      reasoning: e.reasoning,
      confidence: e.confidence,
      createdBy: e.created_by,
    });
    const argumentIds = e.argument_ids ?? [];
    if (argumentIds.length === 0) continue;
    await rawQuery(
      `INSERT INTO argument_subclaims (argument_id, relationship_id)
       SELECT a.id, cr.id
         FROM arguments a
         JOIN claim_relationships cr ON cr.id = $2
        WHERE a.id = ANY($1::uuid[])
          AND a.claim_id = cr.parent_claim_id
       ON CONFLICT DO NOTHING`,
      [argumentIds, id]
    );
  }
}

/**
 * Before a duplicate edge of the loser's is deleted in a merge, carry its
 * argument memberships over to the survivor's equivalent edge (same parent,
 * child and relation once the loser is read as the survivor), so a grouping
 * survives the merge instead of cascading away with the duplicate.
 */
async function repointMemberships(
  edgeIds: string[],
  equivalentEdgeJoin: string,
  survivorId: string
): Promise<MembershipRef[]> {
  if (edgeIds.length === 0) return [];
  // RETURNING yields only the rows this statement created, so the reversal
  // can remove exactly the memberships the merge added and nothing older.
  return rawQuery<MembershipRef>(
    `INSERT INTO argument_subclaims (argument_id, relationship_id)
     SELECT am.argument_id, e.id
       FROM argument_subclaims am
       JOIN claim_relationships cr ON cr.id = am.relationship_id
       JOIN claim_relationships e ON ${equivalentEdgeJoin}
      WHERE cr.id = ANY($2::uuid[])
     ON CONFLICT DO NOTHING
     RETURNING argument_id, relationship_id`,
    [survivorId, edgeIds]
  );
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

  // 3. Edges where the loser is the CHILD: drop self/duplicate edges (captured,
  //    with their argument memberships, so they can be restored; a duplicate's
  //    memberships move to the survivor's equivalent edge first), then repoint
  //    the rest — memberships ride along with a repointed edge, whose id is
  //    unchanged.
  const childDupIds = (
    await rawQuery<{ id: string }>(
      `SELECT cr.id FROM claim_relationships cr
        WHERE cr.child_claim_id = $2
          AND (cr.parent_claim_id = $1
               OR EXISTS (SELECT 1 FROM claim_relationships e
                            WHERE e.child_claim_id = $1
                              AND e.parent_claim_id = cr.parent_claim_id
                              AND e.relation_type = cr.relation_type))`,
      [survivorId, loserId]
    )
  ).map((r) => r.id);
  const repointedChildMemberships = await repointMemberships(
    childDupIds,
    `e.child_claim_id = $1 AND e.parent_claim_id = cr.parent_claim_id
                                  AND e.relation_type = cr.relation_type`,
    survivorId
  );
  const deletedChildEdges = await captureAndDeleteEdges(childDupIds);
  const repointedChild = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET child_claim_id = $1 WHERE child_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 4. Edges where the loser is the PARENT (same dedupe). The loser's
  //    arguments already sit on the survivor (step 2), so their memberships
  //    land on edges of their own claim.
  const parentDupIds = (
    await rawQuery<{ id: string }>(
      `SELECT cr.id FROM claim_relationships cr
        WHERE cr.parent_claim_id = $2
          AND (cr.child_claim_id = $1
               OR EXISTS (SELECT 1 FROM claim_relationships e
                            WHERE e.parent_claim_id = $1
                              AND e.child_claim_id = cr.child_claim_id
                              AND e.relation_type = cr.relation_type))`,
      [survivorId, loserId]
    )
  ).map((r) => r.id);
  const repointedParentMemberships = await repointMemberships(
    parentDupIds,
    `e.parent_claim_id = $1 AND e.child_claim_id = cr.child_claim_id
                                  AND e.relation_type = cr.relation_type`,
    survivorId
  );
  const deletedParentEdges = await captureAndDeleteEdges(parentDupIds);
  const repointedParent = await rawQuery<{ id: string }>(
    `UPDATE claim_relationships SET parent_claim_id = $1 WHERE parent_claim_id = $2 RETURNING id`,
    [survivorId, loserId]
  );

  // 4b. Lateral links (#436) touching the loser move to the survivor. Captured
  //     whole and re-created on the survivor's side (a link to the survivor
  //     itself, or one the survivor already has, simply drops), so the
  //     reversal can delete exactly what the merge created and put the
  //     originals back.
  const movedLinks = await rawQuery<ClaimLinkRow>(
    `DELETE FROM claim_links
      WHERE claim_a_id = $1 OR claim_b_id = $1
      RETURNING id, claim_a_id, claim_b_id, kind, reasoning, created_by`,
    [loserId]
  );
  const mergedLinkIds: string[] = [];
  for (const link of movedLinks) {
    const other = link.claim_a_id === loserId ? link.claim_b_id : link.claim_a_id;
    if (other === survivorId) continue;
    const { id, created } = await insertClaimLink({
      claimId: survivorId,
      otherClaimId: other,
      kind: link.kind as ClaimLinkKind,
      reasoning: link.reasoning,
      createdBy: link.created_by,
    });
    if (created) mergedLinkIds.push(id);
  }

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
    repointed_memberships: [
      ...repointedChildMemberships,
      ...repointedParentMemberships,
    ],
    moved_links: movedLinks,
    merged_link_ids: mergedLinkIds,
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
  // Only a true duplicate reads as not-added; a missing claim or any other
  // failure propagates rather than masquerading as "already existed".
  const { created } = await insertRelationshipEdge({
    parentId: input.parentId,
    childId: input.childId,
    relationType: input.relationType,
    reasoning: input.reasoning,
    confidence: input.confidence ?? 1.0,
    createdBy: input.createdBy ?? "curator",
  });
  if (!created) return { added: false };
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
  const ids = (
    await rawQuery<{ id: string }>(
      `SELECT id FROM claim_relationships
        WHERE parent_claim_id = $1 AND child_claim_id = $2
        ${input.relationType ? "AND relation_type = $3" : ""}`,
      input.relationType
        ? [input.parentId, input.childId, input.relationType.toLowerCase()]
        : [input.parentId, input.childId]
    )
  ).map((r) => r.id);
  const deleted = await captureAndDeleteEdges(ids);
  const eventId =
    deleted.length > 0
      ? await logEvent("remove_edge", "split: edge removed", { deleted_edges: deleted })
      : undefined;
  return { removed: deleted.length, eventId };
}

/**
 * Record a lateral link (#436) between two claims. Logs a reversible
 * `link_claims` event when the link is new; a duplicate is reported, not
 * re-logged.
 */
export async function linkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind: ClaimLinkKind;
  reasoning: string;
  createdBy?: string;
}): Promise<{ linked: boolean; linkId: string; eventId?: string }> {
  const { id, created } = await insertClaimLink({
    ...input,
    createdBy: input.createdBy ?? "curator",
  });
  if (!created) return { linked: false, linkId: id };
  const eventId = await logEvent("link_claims", input.reasoning, {
    link_id: id,
    claim_id: input.claimId,
    other_claim_id: input.otherClaimId,
    kind: input.kind,
  });
  return { linked: true, linkId: id, eventId };
}

/** Remove lateral link(s) between two claims. Logs a reversible `unlink_claims` event. */
export async function unlinkClaims(input: {
  claimId: string;
  otherClaimId: string;
  kind?: ClaimLinkKind;
  reasoning?: string;
}): Promise<{ removed: number; eventId?: string }> {
  const deleted = await deleteClaimLinks(input);
  const eventId =
    deleted.length > 0
      ? await logEvent("unlink_claims", input.reasoning ?? "link removed", {
          deleted_links: deleted,
        })
      : undefined;
  return { removed: deleted.length, eventId };
}

/** Restore captured lateral links; idempotent against a link already present. */
async function reinsertLinks(links: ClaimLinkRow[]): Promise<void> {
  for (const link of links) {
    await insertClaimLink({
      claimId: link.claim_a_id,
      otherClaimId: link.claim_b_id,
      kind: link.kind as ClaimLinkKind,
      reasoning: link.reasoning,
      createdBy: link.created_by,
    });
  }
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
      const repointedMemberships = (p.repointed_memberships as MembershipRef[]) ?? [];
      const movedLinks = (p.moved_links as ClaimLinkRow[]) ?? [];
      const mergedLinkIds = (p.merged_link_ids as string[]) ?? [];

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
      // Drop the memberships the merge carried onto the survivor's edges (and
      // only those), then restore the deleted duplicates with their own.
      if (repointedMemberships.length) {
        await rawQuery(
          `DELETE FROM argument_subclaims
            WHERE (argument_id, relationship_id) IN
                  (SELECT unnest($1::uuid[]), unnest($2::uuid[]))`,
          [
            repointedMemberships.map((m) => m.argument_id),
            repointedMemberships.map((m) => m.relationship_id),
          ]
        );
      }
      await reinsertEdges(deletedEdges);
      // Lateral links: drop what the merge created, restore the originals.
      if (mergedLinkIds.length) {
        await rawQuery(`DELETE FROM claim_links WHERE id = ANY($1::uuid[])`, [
          mergedLinkIds,
        ]);
      }
      await reinsertLinks(movedLinks);
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

    case "link_claims": {
      await rawQuery(`DELETE FROM claim_links WHERE id = $1`, [p.link_id as string]);
      break;
    }

    case "unlink_claims": {
      await reinsertLinks((p.deleted_links as ClaimLinkRow[]) ?? []);
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
