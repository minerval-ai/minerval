/**
 * Third review, findings 4 and 5: the database's backstop for the rule
 * that a version on a node at another label rests on material at the
 * version's own label (MVL07).
 *
 *  - It was tested when a current version was inserted and not when a row
 *    was made current by an update, which stored what the rule refuses.
 *  - Its message named the label the node carries, which the writer may
 *    not read, and told a node that does not exist from one that is hidden.
 *  - A version whose material is removed afterwards is not the trigger's to
 *    refuse. The upkeep of versions finds it and opens a reassessment at
 *    the version's label, saying the material is gone.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { openReassessmentsForVersionsWithoutMaterial, versionMaterialGoneMessage } from "../../src/services/version-upkeep.js";
import { A, B, asPerson, at, attachSource, caught, seedNode, sqlState, system, unwall, wall } from "./review-3-common.js";

beforeAll(wall, 120_000);
afterAll(() => unwall(), 120_000);

const REFUSAL = `this version was not recorded: nothing at the label "${A}" bears on the node`;
const insertVersion = (node: string, current: boolean) =>
  rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, sensitivity_label)
     VALUES ($1, 'refuted', 0.9, 'A version at a.', $2, $3) RETURNING id`,
    [node, current, A]
  );
const messageOf = (err: unknown) => {
  const e = err as { message?: string; cause?: { message?: string } } | null;
  return e?.cause?.message ?? e?.message;
};

describe("a version on a node at another label, at the database", () => {
  it("is refused when it is made current by an update, as when it is inserted current", async () => {
    const node = await seedNode("public", "PUBLIC: the bridge is open");
    const inserted = await caught(() => at(A, () => insertVersion(node, true)));
    expect(sqlState(inserted)).toBe("MVL07");
    const [row] = await at(A, () => insertVersion(node, false));
    const updated = await caught(() => at(A, () => rawQuery(`UPDATE assessments SET is_current = true WHERE id = $1`, [row!.id])));
    expect(sqlState(updated)).toBe("MVL07");
    expect(messageOf(updated)).toBe(REFUSAL);
    expect(await system(() => rawQuery(`SELECT 1 FROM assessments WHERE claim_id = $1 AND is_current`, [node]))).toEqual([]);
    // With material at a attached, the same update is accepted.
    await attachSource(node, A);
    await at(A, () => rawQuery(`UPDATE assessments SET is_current = true WHERE id = $1`, [row!.id]));
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessments WHERE claim_id = $1 AND is_current`, [node]))
    ).toEqual([{ l: A }]);
  });

  it("is refused in the same words for a node the writer reads, a node it does not read, and a node that does not exist", async () => {
    const readable = await seedNode("public", "PUBLIC: the tunnel is open");
    const hidden = await seedNode(B, "B-ONLY: partner B will acquire Zeta");
    expect(await at(A, () => rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [hidden]))).toEqual([]);
    const errors = [];
    for (const node of [readable, hidden, randomUUID()]) errors.push(await caught(() => at(A, () => insertVersion(node, true))));
    expect(errors.map(sqlState)).toEqual(["MVL07", "MVL07", "MVL07"]);
    expect(errors.map(messageOf)).toEqual([REFUSAL, REFUSAL, REFUSAL]);
    const hints = errors.map((e) => (e as { hint?: string; cause?: { hint?: string } }).cause?.hint ?? (e as { hint?: string }).hint);
    expect(new Set(hints).size).toBe(1);
    expect(JSON.stringify([errors.map(messageOf), hints])).not.toContain(B);
  });
});

describe("a version whose material at its own label is removed afterwards", () => {
  it("stands, and the upkeep of versions opens its reassessment at that label, once, saying the material is gone", async () => {
    const node = await seedNode("public", "PUBLIC: the ferry runs on Sundays");
    const { instance } = await attachSource(node, A, "A-ONLY passage");
    const [v] = await at(A, () => insertVersion(node, true));
    await at(A, () => rawQuery(`DELETE FROM claim_instances WHERE id = $1`, [instance]));
    expect(await system(() => rawQuery<{ m: boolean }>(`SELECT minerval_material_at($1, $2) AS m`, [node, A]))).toEqual([{ m: false }]);
    expect(await system(() => rawQuery(`SELECT 1 FROM assessments WHERE id = $1 AND is_current`, [v!.id]))).toHaveLength(1);

    expect(await openReassessmentsForVersionsWithoutMaterial()).toBeGreaterThanOrEqual(1);
    const messages = () =>
      system(() =>
        rawQuery<{ l: string; trigger: string; body: string; sender_ref: string }>(
          `SELECT sensitivity_label AS l, trigger, body, sender_ref FROM node_messages WHERE node_id = $1`,
          [node]
        )
      );
    expect(await messages()).toEqual([
      { l: A, trigger: "version_material_gone", body: versionMaterialGoneMessage(A), sender_ref: `material-gone:${v!.id}` },
    ]);
    expect(versionMaterialGoneMessage(A)).toContain(`no longer has anything at \`${A}\` to rest on`);
    expect(
      await system(() => rawQuery<{ l: string; s: string }>(`SELECT sensitivity_label AS l, steward_state AS s FROM steward_slots WHERE claim_id = $1`, [node]))
    ).toEqual([{ l: A, s: "pending" }]);
    // Nothing of it reaches a reader of public alone.
    expect(await asPerson(["public"], () => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [node]))).toEqual([]);
    // Asked once for each version.
    await openReassessmentsForVersionsWithoutMaterial();
    expect(await messages()).toHaveLength(1);
  });
});
