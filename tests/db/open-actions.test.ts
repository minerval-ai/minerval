/**
 * The open ledger as a Grantmaker sees it, against real Postgres: open
 * actions on graph-read nodes with the gap left to fund, and
 * listOpenActions filtered by territory (meaning, tag, subtree, node kind,
 * assessment state) and money (unfunded, cost ceiling, valued or not), with
 * alternatives grouped and curate rows saying what they are about.
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";

const searchMock = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock("../../src/services/search-service.js", () => ({
  hybridSearch: vi.fn(async () => ({ results: searchMock.ids.map((id) => ({ id })), total: searchMock.ids.length })),
}));

import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser, seedValuation } from "./helpers.js";
import { annotateOpenActions, listOpenActions } from "../../src/services/open-actions-service.js";

async function territory() {
  const funder = await seedUser("oa-funder");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100_000_000 });
  const root = await seedClaim("oa root");
  const child = await seedClaim("oa child");
  const elsewhere = await seedClaim("oa elsewhere");
  await rawQuery(`INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'dbtest')`, [root, child]);
  const g = (c: string) => `assess:${c}:${randomUUID().slice(0, 6)}`;
  const rootGroup = g(root);
  const rootStd = await seedAction({ group: rootGroup, variant: "standard", claimId: root, costMicroUsd: 1_000_000 });
  const rootStrong = await seedAction({ group: rootGroup, variant: "strong", claimId: root, costMicroUsd: 4_000_000 });
  const childStd = await seedAction({ group: g(child), claimId: child, costMicroUsd: 1_000_000 });
  const elsewhereStd = await seedAction({ group: g(elsewhere), claimId: elsewhere, costMicroUsd: 1_000_000 });
  // The child is fully backed by someone else already.
  await seedAllocation({ group: (await rawQuery<{ g: string }>(`SELECT exclusion_group AS g FROM actions WHERE id = $1`, [childStd]))[0]!.g, actionId: childStd, claimId: child, userId: await seedUser("oa-other"), amountMicroUsd: 1_000_000 });
  await seedValuation({ grantId, actionId: rootStd, valueEst: 8 });
  return { grantId, root, child, elsewhere, rootStd, rootStrong, childStd, elsewhereStd };
}

describe("open actions on graph reads", () => {
  it("put each node's open actions, with the gap left to fund, on a decomposition", async () => {
    const t = await territory();
    const tree = JSON.stringify({ claim_id: t.root, tree: { id: t.root, children: [{ id: t.child, children: [] }] } });
    const out = JSON.parse(await annotateOpenActions("get_decomposition", tree, t.grantId));
    expect(out.tree.open_actions.map((a: { variant: string }) => a.variant).sort()).toEqual(["standard", "strong"]);
    expect(out.tree.open_actions.find((a: { variant: string }) => a.variant === "standard")).toMatchObject({ cost_owls: 1, my_value: 8, gap_owls: 1 });
    expect(out.tree.children[0].open_actions[0]).toMatchObject({ action_id: t.childStd, backing_owls: 1, gap_owls: 0 });
    // A tool that reads no nodes passes through untouched.
    expect(await annotateOpenActions("update_workspace", '{"success":true}', t.grantId)).toBe('{"success":true}');
  });
});

describe("listOpenActions", () => {
  it("filters to a subtree, groups alternatives, and orders by this mandate's value", async () => {
    const t = await territory();
    const res = await listOpenActions({ grantId: t.grantId, within: t.root });
    const ids = res.actions.map((a) => a.action_id);
    expect(ids).toContain(t.rootStd);
    expect(ids).toContain(t.childStd);
    expect(ids).not.toContain(t.elsewhereStd);
    expect(res.actions[0]!.action_id).toBe(t.rootStd);
    expect(res.actions[0]!.alternatives).toEqual([{ action_id: t.rootStrong, variant: "strong", cost_owls: 4 }]);
    expect(res.actions[0]!.node_kind).toBe("claim");
  });

  it("filters by money: unfunded only, a cost ceiling, and valued or not by this mandate", async () => {
    const t = await territory();
    const unfunded = (await listOpenActions({ grantId: t.grantId, within: t.root, unfundedOnly: true })).actions.map((a) => a.action_id);
    expect(unfunded).not.toContain(t.childStd);
    const cheap = (await listOpenActions({ grantId: t.grantId, within: t.root, maxCostOwls: 2 })).actions.map((a) => a.action_id);
    expect(cheap).not.toContain(t.rootStrong);
    const mine = (await listOpenActions({ grantId: t.grantId, within: t.root, valued: "mine" })).actions.map((a) => a.action_id);
    expect(mine).toEqual([t.rootStd]);
    const notMine = (await listOpenActions({ grantId: t.grantId, within: t.root, valued: "not_mine" })).actions.map((a) => a.action_id);
    expect(notMine).not.toContain(t.rootStd);
  });

  it("finds rows by meaning in the search's rank order, and by tag", async () => {
    const t = await territory();
    searchMock.ids = [t.elsewhere, t.root];
    const res = await listOpenActions({ grantId: t.grantId, query: "anything" });
    const order = res.actions.map((a) => a.claim_id).filter((c) => c === t.elsewhere || c === t.root);
    expect(order[0]).toBe(t.elsewhere);
    expect(res.actions.map((a) => a.action_id)).not.toContain(t.childStd);

    const slug = `oa-${randomUUID().slice(0, 8)}`;
    const [tag] = await rawQuery<{ id: string }>(`INSERT INTO tags (slug, name) VALUES ($1, $1) RETURNING id`, [slug]);
    await rawQuery(`INSERT INTO taggings (tag_id, subject_kind, subject_id, source) VALUES ($1, 'claim', $2, 'operator')`, [tag!.id, t.child]);
    const tagged = await listOpenActions({ grantId: t.grantId, tag: slug });
    expect(tagged.actions.map((a) => a.action_id)).toEqual([t.childStd]);
    expect(tagged.actions[0]!.tags).toEqual([slug]);
    expect((await listOpenActions({ grantId: t.grantId, tag: "no-such-tag" })).note).toMatch(/no tag/);
  });

  it("reads assessment across kinds, says what a curate row is about, and pages", async () => {
    const t = await territory();
    await rawQuery(`INSERT INTO assessments (claim_id, status, confidence, reasoning_trace) VALUES ($1, 'supported', 0.7, 't')`, [t.child]);
    const unassessed = (await listOpenActions({ grantId: t.grantId, within: t.root, assessed: "unassessed" })).actions.map((a) => a.claim_id);
    expect(unassessed).not.toContain(t.child);
    const assessed = await listOpenActions({ grantId: t.grantId, within: t.root, assessed: "assessed" });
    expect(assessed.actions.map((a) => a.claim_id)).toEqual([t.child]);
    expect(assessed.actions[0]!.days_since_assessed).toBe(0);

    await rawQuery(
      `INSERT INTO curation_requests (anchor_claim_id, source, concern) VALUES ($1, 'operator', 'Duplicates the claim about pandemic origin.')`,
      [t.elsewhere]
    );
    const curate = await seedAction({ group: `curate:${t.elsewhere}`, kind: "curate", claimId: t.elsewhere, costMicroUsd: 250_000 });
    const rows = (await listOpenActions({ grantId: t.grantId, kind: "curate", limit: 50 })).actions;
    expect(rows.find((r) => r.action_id === curate)!.about).toContain("Duplicates");

    const page = await listOpenActions({ grantId: t.grantId, within: t.root, limit: 1 });
    expect(page.total).toBeGreaterThanOrEqual(3);
    expect(page.next_offset).toBe(1);
    expect((await listOpenActions({ grantId: t.grantId, within: "not-a-uuid" })).note).toMatch(/full node id/);
  });
});
