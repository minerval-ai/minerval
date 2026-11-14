/**
 * Third review, finding 6: a refusal by the wall reaches an agent as the
 * refusal, however the statement was made.
 *
 * A statement made with the query builder is refused inside an error of the
 * builder's own, which reads "Failed query: ..." with the statement and its
 * parameters, and carries the database's refusal as its cause. A tool that
 * returned that told the agent nothing it could act on. The refusal is
 * taken from the cause, once, where a tool's error is turned into what the
 * agent is told (refusalForCaller in src/db/clearance.ts).
 *
 * Driven here against a public node that is not mirrored, so that the
 * mirror's own refusal is no part of it: a run at `r3-a` on what `public`
 * recorded, and a run at `r3-c` on what `r3-a` recorded.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { executeStewardTool } from "../../src/llm/tools/steward-tools.js";
import { A, C, attachSource, seedNode, stewardAt, system, unwall, wall } from "./review-3-common.js";

const id: Record<string, string> = {};

beforeAll(async () => {
  await wall();
  id.parent = await seedNode("public", "A public claim a run at a would change");
  id.child = await seedNode("public", "A public claim under it");
  id.anode = await seedNode(A, "A node at a that a run at c would change");
  await system(async () => {
    await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning, sensitivity_label) VALUES ($1, $2, 'requires', 'The public reason.', 'public')`, [id.parent, id.child]);
    const [arg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, 'for', 'A public argument', 'Because [[claim:' || $2 || ']], it grows.', 'steward', 'public') RETURNING id`,
      [id.parent, id.child]
    );
    id.argument = arg!.id;
    const [aarg] = await rawQuery<{ id: string }>(
      `INSERT INTO arguments (claim_id, stance, name, content, created_by, sensitivity_label) VALUES ($1, 'for', 'An argument at a', 'Reasoning at a.', 'steward', $2) RETURNING id`,
      [id.anode, A]
    );
    id.aargument = aarg!.id;
  });
  id.instance = (await attachSource(id.parent!, "public", "A public passage.")).instance;
  id.ainstance = (await attachSource(id.anode!, A, "A passage at a.")).instance;
}, 120_000);

afterAll(() => unwall(), 120_000);

describe("a refusal by the wall, on a statement the query builder made", () => {
  const cases: Array<[string, string, () => Record<string, unknown>]> = [
    [A, "write_argument", () => ({ argument_id: id.argument, content: `A rewriting from a: because [[claim:${id.child}]], the stock grows.` })],
    [A, "update_claim_instance", () => ({ claim_id: id.parent, instance_id: id.instance, stance: "denies", reasoning: "It reads otherwise." })],
    [C, "write_argument", () => ({ argument_id: id.aargument, content: "A rewriting from c, which states how the premises reach the conclusion." })],
    [C, "update_claim_instance", () => ({ claim_id: id.anode, instance_id: id.ainstance, stance: "denies", reasoning: "It reads otherwise." })],
  ];
  for (const [label, name, input] of cases) {
    it(`tells a run at ${label} that ${name} was refused, why, and what to do, and shows it no statement`, async () => {
      const before = await system(() => rawQuery(`SELECT content FROM arguments WHERE id = ANY($1::uuid[]) ORDER BY id`, [[id.argument, id.aargument]]));
      const raw = await stewardAt(label, () => executeStewardTool(name, input()));
      expect(raw).not.toMatch(/Failed query|params:|update "/i);
      const answer = JSON.parse(raw) as { success: boolean; message: string };
      expect(answer.success).toBe(false);
      const rowLabel = label === A ? "public" : A;
      expect(answer.message).toBe(
        `This was not changed: the row is at the label "${rowLabel}" and this work is at "${label}". Work changes and ` +
          `deletes only rows at its own label. What another label holds is that label's to change: record what this ` +
          `label has to say as a row of its own. Nothing was changed.`
      );
      expect(await system(() => rawQuery(`SELECT content FROM arguments WHERE id = ANY($1::uuid[]) ORDER BY id`, [[id.argument, id.aargument]]))).toEqual(before);
    });
  }
});
