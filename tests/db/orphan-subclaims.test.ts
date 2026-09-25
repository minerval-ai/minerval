/**
 * A subclaim exists only as part of a decomposition (#451): the claim row,
 * its edge, and its argument membership are written in one transaction, so
 * an edge that cannot be written takes the claim row down with it. Against
 * real Postgres because the guarantee is the rollback, which mocks cannot see.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { rawQuery, withTransaction } from "../../src/db/client.js";
import { claims } from "../../src/db/schema.js";
import { seedClaim } from "./helpers.js";
import {
  attachEdgeToArgument,
  insertRelationshipEdge,
} from "../../src/services/relationship-service.js";

async function claimExists(id: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1`, [id]);
  return rows.length > 0;
}

describe("subclaim creation is atomic with its edge", () => {
  it("rolls the claim row back when the edge insert fails", async () => {
    const missingParent = randomUUID();
    let childId: string | null = null;
    await expect(
      withTransaction(async (tx) => {
        const [created] = await tx.db
          .insert(claims)
          .values({ text: `orphan-test ${randomUUID()}`, createdBy: "dbtest" })
          .returning();
        childId = created!.id;
        await insertRelationshipEdge(
          {
            parentId: missingParent,
            childId: created!.id,
            relationType: "supports",
            reasoning: "dbtest",
            createdBy: "dbtest",
          },
          tx
        );
      })
    ).rejects.toMatchObject({ code: "23503" });
    expect(childId).not.toBeNull();
    expect(await claimExists(childId!)).toBe(false);
  });

  it("rolls the claim row and edge back when the membership fails", async () => {
    const parent = await seedClaim("parent");
    let childId: string | null = null;
    await expect(
      withTransaction(async (tx) => {
        const [created] = await tx.db
          .insert(claims)
          .values({ text: `orphan-test ${randomUUID()}`, createdBy: "dbtest" })
          .returning();
        childId = created!.id;
        const edge = await insertRelationshipEdge(
          { parentId: parent, childId: created!.id, relationType: "supports", reasoning: "dbtest", createdBy: "dbtest" },
          tx
        );
        await attachEdgeToArgument(randomUUID(), edge.id, tx);
      })
    ).rejects.toThrow(/Argument not found/);
    expect(await claimExists(childId!)).toBe(false);
    const edges = await rawQuery(`SELECT 1 FROM claim_relationships WHERE parent_claim_id = $1`, [parent]);
    expect(edges).toHaveLength(0);
  });

  it("commits claim, edge, and membership together on success", async () => {
    const parent = await seedClaim("parent");
    const [arg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, name, stance, content, evidence_urls, created_by)
       VALUES ($1, 'A', 'for', 'A', '{}', 'dbtest') RETURNING id`,
      [parent]
    );
    const childId = await withTransaction(async (tx) => {
      const [created] = await tx.db
        .insert(claims)
        .values({ text: `orphan-test ${randomUUID()}`, createdBy: "dbtest" })
        .returning();
      const edge = await insertRelationshipEdge(
        { parentId: parent, childId: created!.id, relationType: "supports", reasoning: "dbtest", createdBy: "dbtest" },
        tx
      );
      await attachEdgeToArgument(arg!.id, edge.id, tx);
      return created!.id;
    });
    expect(await claimExists(childId)).toBe(true);
    const members = await rawQuery<{ n: string }>(
      `SELECT count(*) AS n FROM argument_subclaims am
        JOIN claim_relationships cr ON cr.id = am.relationship_id
       WHERE am.argument_id = $1 AND cr.child_claim_id = $2`,
      [arg!.id, childId]
    );
    expect(Number(members[0]!.n)).toBe(1);
  });
});
