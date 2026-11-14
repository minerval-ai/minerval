/**
 * Third review: add_decomposition_edge and add_parent_claim against a node
 * at another label. Neither had been driven by the reviews because both
 * mint a node; they call no model, only the embedder, whose failure they
 * tolerate, so they are driven here directly.
 *
 * What holds: the new node and its edge are the run's own, at the run's
 * label, whatever label the named node carries; nothing at the named node's
 * label changes and no work is opened there; and a node the run does not
 * read is not found, with nothing written.
 * (tests/db/private-on-mirror.test.ts drives the same two against a
 * mirrored node.)
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embedder in this file");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { A, B, C, asPerson, seedNode, stewardAt, system, tag, unwall, wall } from "./review-3-common.js";

const id: Record<string, string> = {};
const minted: string[] = [];

beforeAll(async () => {
  await wall();
  id.pub = await seedNode("public", "A public claim that is not mirrored");
  id.anode = await seedNode(A, "A-ONLY: a node at a");
}, 120_000);
afterAll(() => unwall(minted), 120_000);

type Answer = { success: boolean; message: string };
const call = async (label: string, name: string, input: Record<string, unknown>) => {
  const raw = await stewardAt(label, () => executeStewardTool(name, input));
  try {
    return JSON.parse(raw) as Answer;
  } catch {
    return { success: false, message: raw };
  }
};
/** Every labelled row that names the node, as the owner sees it, without the node's own queue state. */
const around = (node: string) =>
  system(async () => ({
    node: (await rawQuery(`SELECT to_jsonb(c) - 'updated_at' AS row FROM claims c WHERE id = $1`, [node]))[0],
    edges: await rawQuery<{ parent: boolean; l: string; other: string; other_l: string }>(
      `SELECT r.parent_claim_id = $1 AS parent, r.sensitivity_label AS l,
              o.id AS other, o.sensitivity_label AS other_l
         FROM claim_relationships r
         JOIN claims o ON o.id = CASE WHEN r.parent_claim_id = $1 THEN r.child_claim_id ELSE r.parent_claim_id END
        WHERE r.parent_claim_id = $1 OR r.child_claim_id = $1 ORDER BY 1, 2`,
      [node]
    ),
    work: await rawQuery<{ l: string; what: string }>(
      `SELECT sensitivity_label AS l, 'action' AS what FROM actions WHERE claim_id = $1
       UNION ALL SELECT sensitivity_label, 'message' FROM node_messages WHERE node_id = $1
       UNION ALL SELECT sensitivity_label, 'slot' FROM steward_slots WHERE claim_id = $1 ORDER BY 1, 2`,
      [node]
    ),
  }));

const cases: Array<{ run: string; node: () => string; nodeLabel: string }> = [
  { run: A, node: () => id.pub!, nodeLabel: "public" },
  { run: C, node: () => id.anode!, nodeLabel: A },
];

describe("add_decomposition_edge and add_parent_claim on a node at another label", () => {
  for (const { run, node, nodeLabel } of cases) {
    it(`a run at ${run} on a node at ${nodeLabel}: the new nodes and edges are at ${run}, and nothing at ${nodeLabel} changes`, async () => {
      const before = await around(node());
      const under = await call(run, "add_decomposition_edge", {
        parent_id: node(),
        child_text: `${run.toUpperCase()}-ONLY subclaim ${tag}: what this label's material adds`,
        relation: "requires",
        reasoning: "What this label adds.",
        importance: 0.6,
      });
      expect(under.success, under.message).toBe(true);
      const above = await call(run, "add_parent_claim", {
        claim_id: node(),
        parent_text: `${run.toUpperCase()}-ONLY parent ${tag}: what this label rests on the node`,
        relation: "requires",
        reasoning: "What this label rests on it.",
      });
      expect(above.success, above.message).toBe(true);

      const after = await around(node());
      // The named node's own row is untouched.
      expect(after.node).toEqual(before.node);
      // One edge each way, at the run's label, to a node at the run's label.
      const added = after.edges.filter((e) => !before.edges.some((b) => b.other === e.other));
      minted.push(...added.map((e) => e.other));
      expect(added.map(({ other: _other, ...rest }) => rest)).toEqual([
        { parent: false, l: run, other_l: run },
        { parent: true, l: run, other_l: run },
      ]);
      // No work, message or slot at the node's own label that was not there.
      expect(after.work.filter((w) => w.l === nodeLabel)).toEqual(before.work.filter((w) => w.l === nodeLabel));
      // A reader of the node's label alone is given neither new node nor edge.
      const readers = nodeLabel === "public" ? ["public"] : [nodeLabel, "public"];
      expect(
        await asPerson(readers, () =>
          rawQuery(
            `SELECT 1 FROM claims WHERE id = ANY($1::uuid[]) UNION ALL
             SELECT 1 FROM claim_relationships WHERE parent_claim_id = ANY($1::uuid[]) OR child_claim_id = ANY($1::uuid[])`,
            [added.map((e) => e.other)]
          )
        )
      ).toEqual([]);
    });
  }

  it("a run at b on a node at a, which it does not read: neither tool finds the node, and nothing is written", async () => {
    const before = await around(id.anode!);
    const claimsBefore = await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims WHERE sensitivity_label = $1`, [B]));
    const under = await call(B, "add_decomposition_edge", {
      parent_id: id.anode,
      child_text: `B-ONLY subclaim ${tag}`,
      relation: "requires",
      reasoning: "From b.",
    });
    const above = await call(B, "add_parent_claim", {
      claim_id: id.anode,
      parent_text: `B-ONLY parent ${tag}`,
      relation: "requires",
      reasoning: "From b.",
    });
    expect(under.success).toBe(false);
    expect(above.success).toBe(false);
    // The answers say nothing of the node: not its label, not its words.
    for (const answer of [under, above]) expect(answer.message).not.toMatch(/A-ONLY|r3-a/);
    expect(await around(id.anode!)).toEqual(before);
    expect(await system(() => rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM claims WHERE sensitivity_label = $1`, [B]))).toEqual(claimsBefore);
  });
});
