/**
 * Decomposition edges and their argument membership (#437).
 *
 * `claim_relationships` is the dependency graph propagation walks: one row
 * per (parent, child, relation). Which named argument(s) an edge belongs to
 * is a separate relation, `argument_subclaims`, so a subclaim can be grouped
 * under several arguments of the same claim (constitution §7) and an edge
 * with no membership row is part of the claim's ungrouped basis.
 *
 * Both writers here are honest about what they did: a duplicate edge or a
 * duplicate membership is reported as `created: false` / `grouped: false`,
 * and every other failure (a missing claim, a foreign-key violation, an
 * outage) propagates instead of being swallowed as success.
 */
import { rawQuery } from "../db/client.js";
import { currentLabel } from "../llm/usage-context.js";
import { RELATION_TYPES } from "../schemas/common.js";
import { KIND_RELATION_TYPES } from "../schemas/kinds.js";
import { asRunner, type Runner } from "./query-runner.js";

/** Every relation an edge may carry: the decomposition relations and the kinds' own (§7a). */
export const EDGE_RELATION_TYPES: readonly string[] = [...RELATION_TYPES, ...KIND_RELATION_TYPES];

/** An edge write named a relation outside EDGE_RELATION_TYPES. */
export class UnknownRelationError extends Error {
  constructor(relation: string) {
    super(`Unknown relation "${relation}". Use one of: ${RELATION_TYPES.join(", ")}.`);
    this.name = "UnknownRelationError";
  }
}

export interface InsertEdgeInput {
  parentId: string;
  childId: string;
  relationType: string;
  reasoning: string;
  confidence?: number;
  createdBy: string;
}

export interface EdgeIdentity {
  id: string;
  parent_claim_id: string;
  child_claim_id: string;
  relation_type: string;
}

/**
 * Insert a decomposition edge, or find the one already there. The unique
 * index on (parent, child, relation) is the conflict target, so only a true
 * duplicate reads as `created: false`; a parent or child that does not exist
 * throws (foreign key), as does a self-edge (check constraint). An off-enum
 * relation throws UnknownRelationError (#658): the column is plain text, and
 * a tool's enum is advisory to a model, so such an edge would be stored as
 * given and read by nothing.
 */
export async function insertRelationshipEdge(
  input: InsertEdgeInput,
  tx?: Runner
): Promise<{ id: string; created: boolean }> {
  const run = asRunner(tx);
  const relationType = input.relationType.toLowerCase();
  if (!EDGE_RELATION_TYPES.includes(relationType)) {
    throw new UnknownRelationError(input.relationType);
  }
  const inserted = await run.query<{ id: string }>(
    `INSERT INTO claim_relationships
       (parent_claim_id, child_claim_id, relation_type, reasoning, confidence, created_by, sensitivity_label)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (parent_claim_id, child_claim_id, relation_type) DO NOTHING
     RETURNING id`,
    [
      input.parentId,
      input.childId,
      relationType,
      input.reasoning,
      input.confidence ?? 1.0,
      input.createdBy,
      // The edge is the writing run's, whatever labels its two nodes carry
      // (src/labels.ts). An edge already there keeps the label it has.
      currentLabel(),
    ]
  );
  if (inserted[0]) return { id: inserted[0].id, created: true };

  const [existing] = await run.query<{ id: string }>(
    `SELECT id FROM claim_relationships
      WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
    [input.parentId, input.childId, relationType]
  );
  if (!existing) {
    // ON CONFLICT DO NOTHING fired but the row is gone: a concurrent delete
    // between the two statements. Rare enough to surface, not paper over.
    throw new Error(
      `Edge ${input.parentId} -> ${input.childId} (${relationType}) neither inserted nor found`
    );
  }
  return { id: existing.id, created: false };
}

/** The edge for a (parent, child, relation) triple, if it exists. */
export async function findRelationshipEdge(
  parentId: string,
  childId: string,
  relationType: string
): Promise<EdgeIdentity | null> {
  const [row] = await rawQuery<EdgeIdentity>(
    `SELECT id, parent_claim_id, child_claim_id, relation_type
       FROM claim_relationships
      WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
    [parentId, childId, relationType.toLowerCase()]
  );
  return row ?? null;
}

/**
 * Group an existing edge under a named argument. Idempotent: an edge already
 * in the argument reads as `grouped: false`. The argument must belong to the
 * edge's parent claim — grouping a claim's edge under another claim's
 * argument is a structural error, reported as a thrown Error so the caller
 * can relay it verbatim.
 */
export async function attachEdgeToArgument(
  argumentId: string,
  relationshipId: string,
  tx?: Runner
): Promise<{ grouped: boolean }> {
  const run = asRunner(tx);
  const [check] = await run.query<{
    argument_claim_id: string | null;
    argument_retired: boolean | null;
    edge_parent_id: string | null;
  }>(
    `SELECT a.claim_id AS argument_claim_id, a.retired_at IS NOT NULL AS argument_retired,
            cr.parent_claim_id AS edge_parent_id
       FROM (SELECT $1::uuid AS argument_id, $2::uuid AS relationship_id) ids
       LEFT JOIN arguments a ON a.id = ids.argument_id
       LEFT JOIN claim_relationships cr ON cr.id = ids.relationship_id`,
    [argumentId, relationshipId]
  );
  if (!check?.argument_claim_id) {
    throw new Error(`Argument not found: ${argumentId}`);
  }
  if (check.argument_retired) {
    throw new Error(
      `Argument ${argumentId} was retired; group the subclaim under a live ` +
        `argument, or add a new one`
    );
  }
  if (!check.edge_parent_id) {
    throw new Error(`Relationship edge not found: ${relationshipId}`);
  }
  if (check.argument_claim_id !== check.edge_parent_id) {
    throw new Error(
      `Argument ${argumentId} belongs to claim ${check.argument_claim_id}, ` +
        `but the edge's parent is ${check.edge_parent_id}; an argument groups ` +
        `only edges of its own claim`
    );
  }
  const rows = await run.query<{ argument_id: string }>(
    `INSERT INTO argument_subclaims (argument_id, relationship_id, sensitivity_label)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING argument_id`,
    [argumentId, relationshipId, currentLabel()]
  );
  return { grouped: rows.length > 0 };
}

/** Remove an edge from an argument (the edge itself stays). */
export async function detachEdgeFromArgument(
  argumentId: string,
  relationshipId: string,
  tx?: Runner
): Promise<{ detached: boolean }> {
  const rows = await asRunner(tx).query<{ argument_id: string }>(
    `DELETE FROM argument_subclaims
      WHERE argument_id = $1 AND relationship_id = $2
      RETURNING argument_id`,
    [argumentId, relationshipId]
  );
  return { detached: rows.length > 0 };
}

/** The named arguments an edge is grouped under, oldest membership first. */
export async function getEdgeArguments(
  relationshipId: string
): Promise<{ id: string; name: string | null }[]> {
  return rawQuery<{ id: string; name: string | null }>(
    `SELECT a.id, a.name
       FROM argument_subclaims am
       JOIN arguments a ON a.id = am.argument_id
      WHERE am.relationship_id = $1
      ORDER BY am.created_at, a.id`,
    [relationshipId]
  );
}

/**
 * A claim's ungrouped basis (#434): the subclaims of its edges that no named
 * argument groups — the dependencies it rests on directly, before any are
 * gathered under an argument (constitution §7).
 */
export async function getClaimBasisSubclaims(
  claimId: string
): Promise<{ id: string; text: string }[]> {
  return rawQuery<{ id: string; text: string }>(
    `SELECT c.id, c.text
       FROM claim_relationships cr
       JOIN claims c ON c.id = cr.child_claim_id
      WHERE cr.parent_claim_id = $1
        AND NOT EXISTS (SELECT 1 FROM argument_subclaims am
                         WHERE am.relationship_id = cr.id)
      ORDER BY cr.created_at, cr.id`,
    [claimId]
  );
}

/** An edge as a removal or retype reports it, with the arguments it was grouped under. */
export interface EdgeRecord extends EdgeIdentity {
  reasoning: string;
  argument_ids: string[];
}

/** The edges from `parentId` to `childId` (of one relation, when given), with their argument memberships. */
export async function getEdgesBetween(
  parentId: string,
  childId: string,
  relationType?: string,
  tx?: Runner
): Promise<EdgeRecord[]> {
  const run = asRunner(tx);
  return run.query<EdgeRecord>(
    `SELECT cr.id, cr.parent_claim_id, cr.child_claim_id, cr.relation_type, cr.reasoning,
            COALESCE(array_agg(am.argument_id ORDER BY am.created_at)
                       FILTER (WHERE am.argument_id IS NOT NULL), '{}') AS argument_ids
       FROM claim_relationships cr
       LEFT JOIN argument_subclaims am ON am.relationship_id = cr.id
      WHERE cr.parent_claim_id = $1 AND cr.child_claim_id = $2
        ${relationType ? "AND cr.relation_type = $3" : ""}
      GROUP BY cr.id
      ORDER BY cr.created_at, cr.id`,
    relationType ? [parentId, childId, relationType.toLowerCase()] : [parentId, childId]
  );
}

/**
 * Delete edges by id. Their argument memberships cascade with them, so read
 * them first (getEdgesBetween) when the caller must say what was lost.
 */
export async function deleteEdges(edgeIds: string[], tx?: Runner): Promise<number> {
  if (edgeIds.length === 0) return 0;
  const rows = await asRunner(tx).query<{ id: string }>(
    `DELETE FROM claim_relationships WHERE id = ANY($1::uuid[]) RETURNING id`,
    [edgeIds]
  );
  return rows.length;
}

/**
 * Rewrite an edge's reasoning note, keeping its relation and argument
 * groupings (#833): the note can go stale when the subclaim's role in the
 * parent changes while the relation stays right.
 */
export async function setEdgeReasoning(edgeId: string, reasoning: string, tx?: Runner): Promise<void> {
  const rows = await asRunner(tx).query<{ id: string }>(
    `UPDATE claim_relationships SET reasoning = $2 WHERE id = $1 RETURNING id`,
    [edgeId, reasoning]
  );
  if (rows.length === 0) throw new Error(`Relationship edge not found: ${edgeId}`);
}

/**
 * Change an edge's relation in place (#741). The (parent, child, relation)
 * key is unique, so when an edge of the new relation already exists the old
 * edge is folded into it instead: its argument memberships move across and
 * it is deleted. Either way one edge of the new relation remains, grouped
 * under every argument either edge was in.
 */
export async function retypeEdge(
  edgeId: string,
  relationType: string,
  reasoning: string,
  tx?: Runner
): Promise<{ id: string; merged: boolean }> {
  const run = asRunner(tx);
  const relation = relationType.toLowerCase();
  const [edge] = await run.query<{ parent_claim_id: string; child_claim_id: string }>(
    `SELECT parent_claim_id, child_claim_id FROM claim_relationships WHERE id = $1 FOR UPDATE`,
    [edgeId]
  );
  if (!edge) throw new Error(`Relationship edge not found: ${edgeId}`);
  const [existing] = await run.query<{ id: string }>(
    `SELECT id FROM claim_relationships
      WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
    [edge.parent_claim_id, edge.child_claim_id, relation]
  );
  if (!existing) {
    await run.query(
      `UPDATE claim_relationships SET relation_type = $2, reasoning = $3 WHERE id = $1`,
      [edgeId, relation, reasoning]
    );
    return { id: edgeId, merged: false };
  }
  if (existing.id === edgeId) return { id: edgeId, merged: false };
  await run.query(
    `INSERT INTO argument_subclaims (argument_id, relationship_id, sensitivity_label)
     SELECT argument_id, $2, $3 FROM argument_subclaims WHERE relationship_id = $1
     ON CONFLICT DO NOTHING`,
    [edgeId, existing.id, currentLabel()]
  );
  await run.query(`DELETE FROM claim_relationships WHERE id = $1`, [edgeId]);
  return { id: existing.id, merged: true };
}
