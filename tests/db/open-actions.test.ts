/**
 * The open ledger as a mandate's agents see it from the graph, against real
 * Postgres: each node a graph read returns carries the work open on it and
 * whether someone has commissioned it. Nothing on it is a price or a value.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";

import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedAllocation, seedClaim, seedUser } from "./helpers.js";
import { annotateOpenActions } from "../../src/services/open-actions-service.js";

async function territory() {
  const root = await seedClaim("oa root");
  const child = await seedClaim("oa child");
  const g = (c: string) => `assess:${c}:${randomUUID().slice(0, 6)}`;
  const rootGroup = g(root);
  const childGroup = g(child);
  await seedAction({ group: rootGroup, variant: "standard", claimId: root, costMicroUsd: 1_000_000 });
  await seedAction({ group: rootGroup, variant: "strong", claimId: root, costMicroUsd: 4_000_000 });
  const childStd = await seedAction({ group: childGroup, claimId: child, costMicroUsd: 1_000_000 });
  // Someone has commissioned the child's pass.
  const al = await seedAllocation({ group: childGroup, actionId: childStd, claimId: child, userId: await seedUser("oa-other"), amountMicroUsd: 1_000_000 });
  await rawQuery(`UPDATE action_allocations SET commissioned_by = 'person' WHERE id = $1`, [al]);
  return { root, child, childStd };
}

describe("open actions on graph reads", () => {
  it("put each node's open actions, and whether they are commissioned, on a decomposition", async () => {
    const t = await territory();
    const tree = JSON.stringify({ claim_id: t.root, tree: { id: t.root, children: [{ id: t.child, children: [] }] } });
    const out = JSON.parse(await annotateOpenActions("get_decomposition", tree));
    expect(out.tree.open_actions.map((a: { variant: string }) => a.variant).sort()).toEqual(["standard", "strong"]);
    expect(out.tree.open_actions.every((a: { commissioned: boolean }) => a.commissioned === false)).toBe(true);
    expect(out.tree.open_actions[0]).not.toHaveProperty("cost_owls");
    expect(out.tree.children[0].open_actions[0]).toMatchObject({ action_id: t.childStd, commissioned: true });
    // A tool that reads no nodes passes through untouched.
    expect(await annotateOpenActions("update_workspace", '{"success":true}')).toBe('{"success":true}');
  });
});
