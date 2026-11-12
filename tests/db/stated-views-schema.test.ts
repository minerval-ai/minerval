/**
 * The stated_views table (constitution §4) against real SQL: one row per
 * contribution, a probability held to 0..1, gone with its contribution, and
 * left standing with no instance when its instance is deleted.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, seedUser } from "./helpers.js";

async function contribution(claimId: string, contributorId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO contributions (claim_id, contributor_id, contribution_type, content)
     VALUES ($1, $2, 'state_view', 'This is so.') RETURNING id`,
    [claimId, contributorId]
  );
  return row!.id;
}

const insert = (contributionId: string, probability: number | null = null) =>
  rawQuery<{ id: string }>(
    `INSERT INTO stated_views (contribution_id, stance, stated_probability, statement)
     VALUES ($1, 'affirms', $2, 'This is so.') RETURNING id`,
    [contributionId, probability]
  );

describe("stated_views", () => {
  it("holds one row per contribution, with its probability between 0 and 1", async () => {
    const claim = await seedClaim("stated-views-schema");
    const user = await seedUser("stated-views-schema");
    const c = await contribution(claim, user);
    const [row] = await insert(c, 0.8);
    expect(row!.id).toBeTruthy();
    await expect(insert(c)).rejects.toThrow(/idx_stated_views_contribution/);
    const other = await contribution(claim, user);
    await expect(insert(other, 1.2)).rejects.toThrow(/ck_stated_views_probability/);
    const [stored] = await rawQuery<{ instance_id: string | null; reasons: string | null; stake: string | null }>(
      `SELECT instance_id, reasons, stake FROM stated_views WHERE id = $1`,
      [row!.id]
    );
    expect(stored).toEqual({ instance_id: null, reasons: null, stake: null });
  });

  it("goes with its contribution, and outlives its instance", async () => {
    const claim = await seedClaim("stated-views-schema-fk");
    const user = await seedUser("stated-views-schema-fk");
    const c = await contribution(claim, user);
    const [row] = await insert(c);
    const [source] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (title) VALUES ('Statement to the graph') RETURNING id`
    );
    const [instance] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'This is so.') RETURNING id`,
      [claim, source!.id]
    );
    await rawQuery(`UPDATE stated_views SET instance_id = $2 WHERE id = $1`, [row!.id, instance!.id]);
    await rawQuery(`DELETE FROM claim_instances WHERE id = $1`, [instance!.id]);
    const [kept] = await rawQuery<{ instance_id: string | null }>(
      `SELECT instance_id FROM stated_views WHERE id = $1`,
      [row!.id]
    );
    expect(kept!.instance_id).toBeNull();
    await rawQuery(`DELETE FROM contributions WHERE id = $1`, [c]);
    expect(await rawQuery(`SELECT 1 FROM stated_views WHERE id = $1`, [row!.id])).toEqual([]);
  });
});
