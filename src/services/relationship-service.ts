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
import { asRunner, type Runner } from "./query-runner.js";

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
 * throws (foreign key), as does a self-edge (check constraint).
 */
export async function insertRelationshipEdge(
  input: InsertEdgeInput,
  tx?: Runner
): Promise<{ id: string; created: boolean }> {
  const run = asRunner(tx);
  const relationType = input.relationType.toLowerCase();
  const inserted = await run.query<{ id: string }>(
    `INSERT INTO claim_relationships
       (parent_claim_id, child_claim_id, relation_type, reasoning, confidence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (parent_claim_id, child_claim_id, relation_type) DO NOTHING
     RETURNING id`,
    [
      input.parentId,
      input.childId,
      relationType,
      input.reasoning,
      input.confidence ?? 1.0,
      input.createdBy,
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
    edge_parent_id: string | null;
  }>(
    `SELECT a.claim_id AS argument_claim_id, cr.parent_claim_id AS edge_parent_id
       FROM (SELECT $1::uuid AS argument_id, $2::uuid AS relationship_id) ids
       LEFT JOIN arguments a ON a.id = ids.argument_id
       LEFT JOIN claim_relationships cr ON cr.id = ids.relationship_id`,
    [argumentId, relationshipId]
  );
  if (!check?.argument_claim_id) {
    throw new Error(`Argument not found: ${argumentId}`);
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
    `INSERT INTO argument_subclaims (argument_id, relationship_id)
     VALUES ($1, $2)
     ON CONFLICT DO NOTHING
     RETURNING argument_id`,
    [argumentId, relationshipId]
  );
  return { grouped: rows.length > 0 };
}

/** Remove an edge from an argument (the edge itself stays). */
export async function detachEdgeFromArgument(
  argumentId: string,
  relationshipId: string
): Promise<{ detached: boolean }> {
  const rows = await rawQuery<{ argument_id: string }>(
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
