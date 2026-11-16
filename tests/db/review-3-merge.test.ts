/**
 * Third review, finding 3: a merge made here, by a run at one label, of a
 * node that another label recorded on.
 *
 * The run moves the rows it reads. The rows at a label it does not read
 * used to stay on the merged node, where nobody reads them, with their
 * stances the wrong way round after a merge with the claim's denial, and
 * nobody at that label was told. Now the merge carries them: each label's
 * rows move to the node the merge ended in, at their own label, by that
 * label's own work (reconciliation-service.ts, carryMergeToOtherLabels),
 * and that label's Steward on the surviving node is told in words composed
 * from what that label reads. The undo of the merge puts them back.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { executeCuratorTool } from "../../src/llm/tools/curator-tools.js";
import { runAtLabel, withAgent } from "../../src/llm/usage-context.js";
import { getClaimView } from "../../src/services/claim-view-service.js";
import { A, B, C, asPerson, attachSource, seedNode, system, unwall, version, wall } from "./review-3-common.js";

beforeAll(wall, 120_000);
afterAll(() => unwall(), 120_000);

type Answer = { success: boolean; message: string; event_id?: string };
const curatorAt = async (label: string, name: string, input: Record<string, unknown>) =>
  JSON.parse(await runAtLabel(label, "a review test", () => withAgent("curator", () => executeCuratorTool(name, input)))) as Answer;

const state = (loser: string, survivor: string) =>
  system(async () => ({
    loser: (await rawQuery<{ state: string; merged_into: string | null }>(`SELECT state, merged_into FROM claims WHERE id = $1`, [loser]))[0]!,
    instances: await rawQuery<{ on_loser: boolean; l: string; stance: string }>(
      `SELECT claim_id = $1 AS on_loser, sensitivity_label AS l, stance FROM claim_instances WHERE claim_id IN ($1, $2) ORDER BY 2, 3`,
      [loser, survivor]
    ),
    arguments: await rawQuery<{ on_loser: boolean; l: string; stance: string }>(
      `SELECT claim_id = $1 AS on_loser, sensitivity_label AS l, stance FROM arguments WHERE claim_id IN ($1, $2) ORDER BY 2, 3`,
      [loser, survivor]
    ),
    messages: await rawQuery<{ on_loser: boolean; l: string; trigger: string; body: string }>(
      `SELECT node_id = $1 AS on_loser, sensitivity_label AS l, trigger, body FROM node_messages WHERE node_id IN ($1, $2) ORDER BY created_at`,
      [loser, survivor]
    ),
    slots: await rawQuery<{ l: string; steward_state: string }>(
      `SELECT sensitivity_label AS l, steward_state FROM steward_slots WHERE claim_id = $1 ORDER BY 1`,
      [survivor]
    ),
    events: await rawQuery<{ operation: string; l: string; reversed: boolean }>(
      `SELECT operation, sensitivity_label AS l, reversed FROM reconciliation_events
        WHERE payload->>'loser_id' = $1 ORDER BY created_at`,
      [loser]
    ),
  }));

const versionsFor = async (clearance: string[], node: string) => {
  const view = (await asPerson(clearance, () => getClaimView(node))) as { claim: { id: string }; versions?: Array<{ label: string; status: string }> } | null;
  return view ? { id: view.claim.id, versions: (view.versions ?? []).map((v) => `${v.label}:${v.status}`).sort() } : null;
};

describe("a merge made here under rows at a label the run does not read", () => {
  it("moves a's rows with the node, reverses their stances with a merge by denial, tells a's Steward, and says nothing at public or at b", async () => {
    const loser = await seedNode("public", "PUBLIC: the reservoir is NOT safe to drink from");
    const survivor = await seedNode("public", "PUBLIC: the reservoir is safe to drink from");
    await version(loser, "public", "supported", "Public reading of the denial.");
    await version(survivor, "public", "doubtful", "Public reading.");
    await attachSource(loser, "public", "A public passage", "affirms");
    await attachSource(loser, A, "A-ONLY passage: the lab found contamination", "affirms");
    await system(() =>
      rawQuery(
        `INSERT INTO arguments (claim_id, name, stance, content, created_by, sensitivity_label)
         VALUES ($1, 'A-ONLY argument from the lab results', 'for', 'A-ONLY: the lab found contamination.', 'claim_steward', $2)`,
        [loser, A]
      )
    );
    await version(loser, A, "verified", "A-ONLY: our lab results verify that it is NOT safe.");

    const merged = await curatorAt("public", "merge_claims", { survivor_id: survivor, loser_id: loser, stance_relation: "opposed", reasoning: "One is the other's denial." });
    expect(merged.success, merged.message).toBe(true);
    // What the public Curator is told names nothing of a's.
    expect(JSON.stringify(merged)).not.toMatch(/A-ONLY|r3-a/);

    const after = await state(loser, survivor);
    expect(after.loser).toEqual({ state: "merged", merged_into: survivor });
    // Every instance and argument is on the survivor, at the label it had, the other way round.
    expect(after.instances).toEqual([
      { on_loser: false, l: "public", stance: "denies" },
      { on_loser: false, l: A, stance: "denies" },
    ]);
    expect(after.arguments).toEqual([{ on_loser: false, l: A, stance: "against" }]);
    expect(after.events).toEqual([
      { operation: "merge", l: "public", reversed: false },
      { operation: "merge_carried", l: A, reversed: false },
    ]);

    // a's Steward on the survivor is told, at a, in words made of what a reads.
    const told = after.messages.filter((m) => m.trigger === "merge_carried");
    expect(told.map((m) => [m.on_loser, m.l])).toEqual([[false, A]]);
    const body = told[0]!.body;
    expect(body).toContain(`Another node has been merged into this one: ${loser}`);
    expect(body).toContain("as this node's denial");
    expect(body).toContain(`has moved here with it, and is still at \`${A}\`: 1 source passage, 1 argument.`);
    expect(body).toContain("each moved passage that affirmed now denies");
    expect(body).toContain(`The version of the merged node's judgment at \`${A}\`, recorded`);
    expect(body).toContain("verified");
    expect(body).toContain(`This node has no version of its judgment at \`${A}\`.`);
    expect(after.slots.filter((s) => s.l === A && s.steward_state === "pending")).toHaveLength(1);
    // Nothing of it at public or at b.
    expect(after.messages.filter((m) => m.l !== A && /A-ONLY|merge_carried/.test(m.body + m.trigger))).toEqual([]);
    const publicReads = await asPerson(["public"], () =>
      rawQuery<{ n: number }>(
        `SELECT (SELECT count(*) FROM node_messages WHERE node_id = $1 AND trigger = 'merge_carried')
              + (SELECT count(*) FROM reconciliation_events WHERE operation = 'merge_carried' AND payload->>'loser_id' = $2) AS n`,
        [survivor, loser]
      )
    );
    expect(Number(publicReads[0]!.n)).toBe(0);
    const bReads = await asPerson([B, "public"], () => rawQuery(`SELECT 1 FROM claim_instances WHERE claim_id = $1 AND sensitivity_label <> 'public'`, [survivor]));
    expect(bReads).toEqual([]);

    // A reader at a who asks for either id is given the survivor, with a's passage on it.
    const forA = await versionsFor([A, "public"], loser);
    expect(forA?.id).toBe(survivor);
    const instancesForA = await asPerson([A, "public"], () =>
      rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM claim_instances WHERE claim_id = $1 ORDER BY 1`, [survivor])
    );
    expect(instancesForA.map((r) => r.l)).toEqual(["public", A]);

    // The undo of the merge puts a's rows back as they were, and tells a's Steward on the restored node.
    const undone = await curatorAt("public", "reverse_reconciliation", { event_id: merged.event_id, reasoning: "They are not one claim." });
    expect(undone.success, undone.message).toBe(true);
    const back = await state(loser, survivor);
    expect(back.loser).toEqual({ state: "active", merged_into: null });
    expect(back.instances).toEqual([
      { on_loser: true, l: "public", stance: "affirms" },
      { on_loser: true, l: A, stance: "affirms" },
    ]);
    expect(back.arguments).toEqual([{ on_loser: true, l: A, stance: "for" }]);
    expect(back.events.filter((e) => e.operation !== "reverse")).toEqual([
      { operation: "merge", l: "public", reversed: true },
      { operation: "merge_carried", l: A, reversed: true },
    ]);
    const toldBack = back.messages.filter((m) => m.trigger === "merge_carried" && m.on_loser);
    expect(toldBack.map((m) => m.l)).toEqual([A]);
    expect(toldBack[0]!.body).toContain(`The merge of this node into ${survivor}`);
    expect(toldBack[0]!.body).toContain("has been undone");
  });

  it("moves c's rows when a Curator at a folds an a node into a public node, and tells c's Steward", async () => {
    const loser = await seedNode(A, "A-ONLY: partner A will miss the deadline");
    const survivor = await seedNode("public", "PUBLIC: partner A will miss the deadline");
    await version(loser, A, "supported", "A reading.");
    await attachSource(loser, A, "A-ONLY passage");
    await attachSource(loser, C, "C-ONLY passage: the board minutes say so");
    await version(loser, C, "verified", "C-ONLY: board minutes verify it.");

    const merged = await curatorAt(A, "merge_claims", { survivor_id: survivor, loser_id: loser, stance_relation: "same", reasoning: "They are one claim." });
    expect(merged.success, merged.message).toBe(true);
    expect(JSON.stringify(merged)).not.toMatch(/C-ONLY|r3-c/);
    const after = await state(loser, survivor);
    expect(after.instances).toEqual([
      { on_loser: false, l: A, stance: "affirms" },
      { on_loser: false, l: C, stance: "affirms" },
    ]);
    const told = after.messages.filter((m) => m.trigger === "merge_carried");
    expect(told.map((m) => [m.on_loser, m.l])).toEqual([[false, C]]);
    expect(told[0]!.body).toContain(`is still at \`${C}\`: 1 source passage.`);
    expect(told[0]!.body).not.toContain("denial");
    expect(told[0]!.body).toContain("C-ONLY: board minutes verify it.");
    // A reader at a, who does not read c, is given nothing of c's on the survivor.
    const forA = await asPerson([A, "public"], () =>
      rawQuery<{ l: string }>(
        `SELECT sensitivity_label AS l FROM claim_instances WHERE claim_id = $1
         UNION ALL SELECT sensitivity_label FROM node_messages WHERE node_id = $1`,
        [survivor]
      )
    );
    expect(forA.map((r) => r.l)).not.toContain(C);
    // A reader at c finds c's passage on the node the merge ended in.
    const forC = await asPerson([A, C, "public"], () =>
      rawQuery<{ l: string }>(`SELECT sensitivity_label AS l FROM claim_instances WHERE claim_id = $1 ORDER BY 1`, [survivor])
    );
    expect(forC.map((r) => r.l)).toEqual([A, C]);
  });
});
