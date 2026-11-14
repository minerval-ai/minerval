/**
 * The database's backstop for a version of a judgment on a node at another
 * label (MVL07), after the test for attached material was removed.
 *
 *  - A version at a label is recorded on a node that label reads, with
 *    nothing at the label attached to the node, whether it is inserted
 *    current or made current by an update. Whether to record one is the
 *    Steward's judgment (tests/db/left-standing.test.ts has the other
 *    outcome).
 *  - A version on a node the writer's label does not read is refused, in
 *    the same words as one on a node that does not exist, and the words
 *    name no label but the writer's own.
 *  - A source detached after a version was recorded reopens nothing.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { openReassessmentsForJudgmentsLeftStanding, openReassessmentsForVersionsMadeBesideEarlier } from "../../src/services/version-upkeep.js";
import { A, B, asPerson, at, attachSource, caught, seedNode, sqlState, system, unwall, wall } from "./review-3-common.js";

beforeAll(wall, 120_000);
afterAll(() => unwall(), 120_000);

const REFUSAL = `this version was not recorded: the label "${A}" does not read this node`;
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
  it("is recorded with nothing at its label attached to the node, inserted current or made current by an update", async () => {
    const node = await seedNode("public", "PUBLIC: the bridge is open");
    await at(A, () => insertVersion(node, true));
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessments WHERE claim_id = $1 AND is_current`, [node]))
    ).toEqual([{ l: A }]);
    const other = await seedNode("public", "PUBLIC: the viaduct is open");
    const [row] = await at(A, () => insertVersion(other, false));
    await at(A, () => rawQuery(`UPDATE assessments SET is_current = true WHERE id = $1`, [row!.id]));
    expect(
      await system(() => rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM assessments WHERE claim_id = $1 AND is_current`, [other]))
    ).toEqual([{ l: A }]);
    // The function that tested for attached material is gone.
    expect(await system(() => rawQuery(`SELECT 1 FROM pg_proc WHERE proname = 'minerval_material_at'`))).toEqual([]);
  });

  it("is refused in the same words for a node the writer's label does not read and a node that does not exist, by an insert and by an update", async () => {
    const hidden = await seedNode(B, "B-ONLY: partner B will acquire Zeta");
    expect(await at(A, () => rawQuery(`SELECT 1 FROM claims WHERE id = $1`, [hidden]))).toEqual([]);
    const errors = [];
    for (const node of [hidden, randomUUID()]) errors.push(await caught(() => at(A, () => insertVersion(node, true))));
    const [row] = await at(A, () => insertVersion(hidden, false));
    errors.push(await caught(() => at(A, () => rawQuery(`UPDATE assessments SET is_current = true WHERE id = $1`, [row!.id]))));
    expect(errors.map(sqlState)).toEqual(["MVL07", "MVL07", "MVL07"]);
    expect(errors.map(messageOf)).toEqual([REFUSAL, REFUSAL, REFUSAL]);
    const hints = errors.map((e) => (e as { hint?: string; cause?: { hint?: string } }).cause?.hint ?? (e as { hint?: string }).hint);
    expect(new Set(hints).size).toBe(1);
    expect(JSON.stringify([errors.map(messageOf), hints])).not.toContain(B);
    expect(await system(() => rawQuery(`SELECT 1 FROM assessments WHERE claim_id = $1 AND is_current`, [hidden]))).toEqual([]);
  });
});

describe("a version with a source at its own label that is detached afterwards", () => {
  it("stands, and nothing opens a reassessment for it", async () => {
    const node = await seedNode("public", "PUBLIC: the ferry runs on Sundays");
    const { instance } = await attachSource(node, A, "A-ONLY passage");
    const [v] = await at(A, () => insertVersion(node, true));
    await at(A, () => rawQuery(`DELETE FROM claim_instances WHERE id = $1`, [instance]));
    expect(await system(() => rawQuery(`SELECT 1 FROM assessments WHERE id = $1 AND is_current`, [v!.id]))).toHaveLength(1);
    await openReassessmentsForVersionsMadeBesideEarlier({ claimIds: [node] });
    await openReassessmentsForJudgmentsLeftStanding({ claimIds: [node] });
    expect(await system(() => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [node]))).toEqual([]);
    expect(await asPerson(["public"], () => rawQuery(`SELECT 1 FROM node_messages WHERE node_id = $1`, [node]))).toEqual([]);
  });
});
