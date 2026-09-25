/**
 * Argument membership as a relation (#437), against real Postgres: the
 * migration's table and cascades, the honest write helpers, the tree's
 * per-argument occurrences, and the merge/reversal bookkeeping that carries
 * memberships across a reconciliation — none of which the mocked suite can
 * see.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import {
  attachEdgeToArgument,
  detachEdgeFromArgument,
  getClaimBasisSubclaims,
  getEdgeArguments,
  insertRelationshipEdge,
} from "../../src/services/relationship-service.js";
import { getArgumentSubclaims } from "../../src/services/argument-service.js";
import {
  mergeClaims,
  removeRelationshipEdge,
  reverseReconciliation,
} from "../../src/services/reconciliation-service.js";
import { getClaimTree } from "../../src/services/tree-service.js";
import { executeGovernanceTool } from "../../src/llm/tools/governance-tools.js";

const FK_VIOLATION = "23503";

async function seedArgument(claimId: string, name: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO arguments (claim_id, name, stance, content, evidence_urls, created_by)
     VALUES ($1, $2, 'for', $2, '{}', 'dbtest') RETURNING id`,
    [claimId, name]
  );
  return rows[0]!.id;
}

async function memberships(edgeId: string): Promise<string[]> {
  return (await getEdgeArguments(edgeId)).map((a) => a.id);
}

async function edgeId(parentId: string, childId: string, relation = "requires") {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_relationships
      WHERE parent_claim_id = $1 AND child_claim_id = $2 AND relation_type = $3`,
    [parentId, childId, relation]
  );
  return row?.id ?? null;
}

async function edge(parentId: string, childId: string, relation = "requires") {
  return insertRelationshipEdge({
    parentId,
    childId,
    relationType: relation,
    reasoning: "dbtest",
    createdBy: "dbtest",
  });
}

describe("argument_subclaims (#437)", () => {
  it("groups one edge under two arguments of the same claim, idempotently", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    const basisOnly = await seedClaim("basis");
    const argA = await seedArgument(parent, "A");
    const argB = await seedArgument(parent, "B");

    const { id, created } = await edge(parent, child);
    expect(created).toBe(true);
    await edge(parent, basisOnly, "assumes");

    expect(await attachEdgeToArgument(argA, id)).toEqual({ grouped: true });
    expect(await attachEdgeToArgument(argB, id)).toEqual({ grouped: true });
    // Same grouping again: reported as already there, not as a fresh write.
    expect(await attachEdgeToArgument(argA, id)).toEqual({ grouped: false });

    expect(await memberships(id)).toEqual([argA, argB]);
    expect((await getArgumentSubclaims(argA)).map((s) => s.id)).toEqual([child]);
    expect((await getArgumentSubclaims(argB)).map((s) => s.id)).toEqual([child]);
    // The ungrouped edge is the claim's basis; the grouped one is not.
    expect((await getClaimBasisSubclaims(parent)).map((s) => s.id)).toEqual([basisOnly]);

    expect(await detachEdgeFromArgument(argB, id)).toEqual({ detached: true });
    expect(await detachEdgeFromArgument(argB, id)).toEqual({ detached: false });
    expect(await memberships(id)).toEqual([argA]);
  });

  it("reports a duplicate edge as not created, and lets a missing claim fail loudly", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    const first = await edge(parent, child);
    const again = await edge(parent, child);
    expect(again).toEqual({ id: first.id, created: false });

    await expect(edge(parent, randomUUID())).rejects.toMatchObject({ code: FK_VIOLATION });
  });

  it("refuses to group an edge under another claim's argument", async () => {
    const parent = await seedClaim("parent");
    const other = await seedClaim("other");
    const child = await seedClaim("child");
    const foreignArg = await seedArgument(other, "elsewhere");
    const { id } = await edge(parent, child);

    await expect(attachEdgeToArgument(foreignArg, id)).rejects.toThrow(/belongs to claim/);
    await expect(attachEdgeToArgument(randomUUID(), id)).rejects.toThrow(/Argument not found/);
    await expect(attachEdgeToArgument(foreignArg, randomUUID())).rejects.toThrow(
      /edge not found/
    );
    expect(await memberships(id)).toEqual([]);
  });

  it("cascades membership away with the edge and with the argument", async () => {
    const parent = await seedClaim("parent");
    const c1 = await seedClaim("c1");
    const c2 = await seedClaim("c2");
    const arg = await seedArgument(parent, "A");
    const e1 = await edge(parent, c1);
    const e2 = await edge(parent, c2);
    await attachEdgeToArgument(arg, e1.id);
    await attachEdgeToArgument(arg, e2.id);

    await rawQuery(`DELETE FROM claim_relationships WHERE id = $1`, [e1.id]);
    expect((await getArgumentSubclaims(arg)).map((s) => s.id)).toEqual([c2]);

    await rawQuery(`DELETE FROM arguments WHERE id = $1`, [arg]);
    expect(await memberships(e2.id)).toEqual([]);
    // The edge itself is untouched: it is now part of the basis.
    expect((await getClaimBasisSubclaims(parent)).map((s) => s.id)).toEqual([c2]);
  });

  it("lists a shared subclaim once per argument in the tree", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    const argA = await seedArgument(parent, "A");
    const argB = await seedArgument(parent, "B");
    const { id } = await edge(parent, child);
    await attachEdgeToArgument(argA, id);
    await attachEdgeToArgument(argB, id);

    const tree = await getClaimTree(parent, 2);
    expect(tree!.children.map((c) => [c.id, c.argument_id, c.argument_name])).toEqual([
      [child, argA, "A"],
      [child, argB, "B"],
    ]);
  });

  it("counts a shared subclaim once in children_total while listing it per argument (#417)", async () => {
    const parent = await seedClaim("parent");
    const shared = await seedClaim("shared");
    const basis = await seedClaim("basis");
    const argA = await seedArgument(parent, "A");
    const argB = await seedArgument(parent, "B");
    const { id } = await edge(parent, shared);
    await edge(parent, basis, "assumes");
    await attachEdgeToArgument(argA, id);
    await attachEdgeToArgument(argB, id);

    const out = JSON.parse(
      await executeGovernanceTool("get_claim_with_context", { claim_id: parent })
    );
    // Two edges, so two children — the shared one is not counted per argument.
    expect(out.claim.children_total).toBe(2);
    expect(out.claim.children_assessed).toBe(0);
    // ...but the listing shows the shared subclaim under each argument.
    expect(
      out.subclaims.map((sc: { id: string; argument_id: string | null }) => [sc.id, sc.argument_id])
    ).toEqual([
      [shared, argA],
      [shared, argB],
      [basis, null],
    ]);
  });

  it("carries memberships through a merge and restores them on reversal", async () => {
    // Child-side duplicate: P -> S exists, P -> L is grouped under P's
    // argument; merging L into S deletes P -> L, so its grouping must land
    // on P -> S. Parent-side duplicate: L -> X is grouped under L's
    // argument and S -> X exists; the argument moves to S and its grouping
    // must land on S -> X.
    const P = await seedClaim("P");
    const S = await seedClaim("S");
    const L = await seedClaim("L");
    const X = await seedClaim("X");
    const argOfP = await seedArgument(P, "P's argument");
    const argOfL = await seedArgument(L, "L's argument");

    const pS = await edge(P, S);
    const pL = await edge(P, L);
    const sX = await edge(S, X);
    const lX = await edge(L, X);
    await attachEdgeToArgument(argOfP, pL.id);
    await attachEdgeToArgument(argOfL, lX.id);

    const { eventId } = await mergeClaims({
      survivorId: S,
      loserId: L,
      stanceRelation: "same",
      reasoning: "dbtest merge",
    });
    expect(await edgeId(P, L)).toBeNull();
    expect(await edgeId(L, X)).toBeNull();
    expect(await memberships(pS.id)).toEqual([argOfP]);
    expect(await memberships(sX.id)).toEqual([argOfL]);

    const reversed = await reverseReconciliation(eventId!);
    expect(reversed.reversed).toBe(true);
    // The merge's own memberships are gone; the deleted edges are back with
    // theirs; the argument is back on the loser.
    expect(await memberships(pS.id)).toEqual([]);
    expect(await memberships(sX.id)).toEqual([]);
    const restoredPL = await edgeId(P, L);
    const restoredLX = await edgeId(L, X);
    expect(restoredPL).not.toBeNull();
    expect(restoredLX).not.toBeNull();
    expect(await memberships(restoredPL!)).toEqual([argOfP]);
    expect(await memberships(restoredLX!)).toEqual([argOfL]);
    const [arg] = await rawQuery<{ claim_id: string }>(
      `SELECT claim_id FROM arguments WHERE id = $1`,
      [argOfL]
    );
    expect(arg!.claim_id).toBe(L);
  });

  it("restores a removed edge's memberships when the removal is reversed", async () => {
    const parent = await seedClaim("parent");
    const child = await seedClaim("child");
    const arg = await seedArgument(parent, "A");
    const { id } = await edge(parent, child);
    await attachEdgeToArgument(arg, id);

    const { removed, eventId } = await removeRelationshipEdge({
      parentId: parent,
      childId: child,
    });
    expect(removed).toBe(1);
    expect(await edgeId(parent, child)).toBeNull();

    expect((await reverseReconciliation(eventId!)).reversed).toBe(true);
    const restored = await edgeId(parent, child);
    expect(restored).not.toBeNull();
    expect(await memberships(restored!)).toEqual([arg]);
  });
});
