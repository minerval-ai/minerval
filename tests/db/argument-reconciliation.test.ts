/**
 * Merging and splitting arguments (§5, §7, #541), against real SQL.
 *
 *  - merge_arguments moves the absorbed argument's instances and premise
 *    groupings to the survivor, keeps the written form the Curator names,
 *    leaves the absorbed row as a retired alias, and refuses arguments on
 *    different nodes or opposite sides. Its undo restores all of it.
 *  - split_argument creates the parts with the named edges and instances,
 *    takes the original's evaluation out of currency, and its undo retires
 *    the parts and restores the original.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { addArgument, getArgumentsForClaim, setArgumentEvaluation } from "../../src/services/argument-service.js";
import { insertArgumentInstance } from "../../src/services/argument-instance-service.js";
import { mergeArguments, reverseReconciliation, splitArgument } from "../../src/services/reconciliation-service.js";
import { executeCuratorTool } from "../../src/llm/tools/curator-tools.js";

async function edge(parent: string, child: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, confidence, reasoning)
     VALUES ($1, $2, 'supports', 1, 'Bears on it.') RETURNING id`,
    [parent, child]
  );
  return row!.id;
}

async function group(argumentId: string, relationshipId: string) {
  await rawQuery(`INSERT INTO argument_subclaims (argument_id, relationship_id) VALUES ($1, $2)`, [
    argumentId,
    relationshipId,
  ]);
}

async function instance(argumentId: string): Promise<string> {
  const [src] = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, 'S', 'journal_article') RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`]
  );
  return insertArgumentInstance({
    argumentId,
    sourceId: src!.id,
    verbatimText: "A passage.",
    stance: "advances",
    reading: "full",
    statedShows: null,
    createdBy: "claim_steward",
  });
}

const groupedUnder = async (argumentId: string) =>
  (
    await rawQuery<{ relationship_id: string }>(
      `SELECT relationship_id FROM argument_subclaims WHERE argument_id = $1 ORDER BY relationship_id`,
      [argumentId]
    )
  ).map((r) => r.relationship_id);

const instancesOf = async (argumentId: string) =>
  (await rawQuery<{ id: string }>(`SELECT id FROM argument_instances WHERE argument_id = $1 ORDER BY id`, [argumentId])).map(
    (r) => r.id
  );

describe("merge_arguments", () => {
  it("moves instances and premises, keeps the better written form, and undoes cleanly", async () => {
    const claim = await seedClaim("merge-args");
    const [p1, p2] = [await seedClaim("p1"), await seedClaim("p2")];
    const [e1, e2] = [await edge(claim, p1), await edge(claim, p2)];
    const survivor = await addArgument({ claimId: claim, stance: "for", name: "A", content: "Survivor's form." });
    const absorbed = await addArgument({ claimId: claim, stance: "for", name: "A'", content: "The clearer form." });
    await group(survivor.id, e1);
    await group(absorbed.id, e1);
    await group(absorbed.id, e2);
    const i1 = await instance(survivor.id);
    const i2 = await instance(absorbed.id);

    const { eventId } = await mergeArguments({
      survivorId: survivor.id,
      absorbedId: absorbed.id,
      writtenFormFrom: "absorbed",
      reasoning: "Same inference from the same premises.",
    });

    expect(await instancesOf(survivor.id)).toEqual([i1, i2].sort());
    expect(await groupedUnder(survivor.id)).toEqual([e1, e2].sort());
    expect(await groupedUnder(absorbed.id)).toEqual([]);
    const live = await getArgumentsForClaim(claim);
    expect(live.map((a) => a.id)).toEqual([survivor.id]);
    expect(live[0]!.content).toBe("The clearer form.");
    const [alias] = await rawQuery<{ merged_into: string; retired_reason: string }>(
      `SELECT merged_into, retired_reason FROM arguments WHERE id = $1`,
      [absorbed.id]
    );
    expect(alias!.merged_into).toBe(survivor.id);
    expect(alias!.retired_reason).toContain("Merged into");

    expect((await reverseReconciliation(eventId!)).reversed).toBe(true);
    expect(await instancesOf(survivor.id)).toEqual([i1]);
    expect(await instancesOf(absorbed.id)).toEqual([i2]);
    expect(await groupedUnder(survivor.id)).toEqual([e1]);
    expect(await groupedUnder(absorbed.id)).toEqual([e1, e2].sort());
    const restored = await getArgumentsForClaim(claim);
    expect(restored.map((a) => a.id).sort()).toEqual([survivor.id, absorbed.id].sort());
    expect(restored.find((a) => a.id === survivor.id)!.content).toBe("Survivor's form.");
  });

  it("refuses arguments on different nodes or opposite sides", async () => {
    const a = await seedClaim("a");
    const b = await seedClaim("b");
    const forA = await addArgument({ claimId: a, stance: "for", name: "x", content: "x" });
    const againstA = await addArgument({ claimId: a, stance: "against", name: "y", content: "y" });
    const forB = await addArgument({ claimId: b, stance: "for", name: "z", content: "z" });
    await expect(
      mergeArguments({ survivorId: forA.id, absorbedId: forB.id, writtenFormFrom: "survivor", reasoning: "r" })
    ).rejects.toThrow(/different nodes/);
    await expect(
      mergeArguments({ survivorId: forA.id, absorbedId: againstA.id, writtenFormFrom: "survivor", reasoning: "r" })
    ).rejects.toThrow(/opposite conclusions/);
  });

  it("is reachable as the Curator's tool", async () => {
    const claim = await seedClaim("tool");
    const s = await addArgument({ claimId: claim, stance: "for", name: "s", content: "s" });
    const a = await addArgument({ claimId: claim, stance: "for", name: "a", content: "a" });
    const out = JSON.parse(
      await executeCuratorTool("merge_arguments", {
        survivor_id: s.id,
        absorbed_id: a.id,
        written_form_from: "survivor",
        reasoning: "One inference.",
      })
    );
    expect(out.success).toBe(true);
    expect(out.event_id).toBeTruthy();
  });
});

describe("split_argument", () => {
  it("creates the parts with their edges and instances, and the undo retires them", async () => {
    const claim = await seedClaim("split-args");
    const [p1, p2] = [await seedClaim("q1"), await seedClaim("q2")];
    const [e1, e2] = [await edge(claim, p1), await edge(claim, p2)];
    const original = await addArgument({ claimId: claim, stance: "for", name: "both", content: "Two lines." });
    await group(original.id, e1);
    await group(original.id, e2);
    const i1 = await instance(original.id);
    const i2 = await instance(original.id);
    await setArgumentEvaluation({ argumentId: original.id, verdict: "likely", content: "Rated." });

    const { eventId, partIds } = await splitArgument({
      argumentId: original.id,
      parts: [{ name: "from q2", writtenForm: `Because [[claim:${p2}]].`, relationshipIds: [e2], instanceIds: [i2] }],
      reasoning: "q2 carries a separate line.",
    });
    const part = partIds[0]!;
    expect(await groupedUnder(original.id)).toEqual([e1]);
    expect(await groupedUnder(part)).toEqual([e2]);
    expect(await instancesOf(original.id)).toEqual([i1]);
    expect(await instancesOf(part)).toEqual([i2]);
    const [current] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM argument_evaluations WHERE argument_id = $1 AND is_current`,
      [original.id]
    );
    expect(current!.n).toBe(0);

    expect((await reverseReconciliation(eventId!)).reversed).toBe(true);
    expect(await groupedUnder(original.id)).toEqual([e1, e2].sort());
    expect(await instancesOf(original.id)).toEqual([i1, i2].sort());
    const [retired] = await rawQuery<{ retired_at: Date | null }>(`SELECT retired_at FROM arguments WHERE id = $1`, [part]);
    expect(retired!.retired_at).not.toBeNull();
    const [back] = await rawQuery<{ n: number }>(
      `SELECT count(*)::int AS n FROM argument_evaluations WHERE argument_id = $1 AND is_current`,
      [original.id]
    );
    expect(back!.n).toBe(1);
  });

  it("refuses an edge or instance that is not the argument's", async () => {
    const claim = await seedClaim("split-bad");
    const other = await seedClaim("other");
    const e = await edge(claim, other);
    const original = await addArgument({ claimId: claim, stance: "for", name: "o", content: "o" });
    await expect(
      splitArgument({
        argumentId: original.id,
        parts: [{ name: "p", writtenForm: "p", relationshipIds: [e], instanceIds: [] }],
        reasoning: "r",
      })
    ).rejects.toThrow(/not grouped/);
  });
});
