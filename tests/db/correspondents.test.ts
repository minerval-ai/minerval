/**
 * Correspondents (#563) and the change stream they read (#562) over real
 * SQL: the stream reports first assessments, status moves and material
 * credence moves in order, scoped to a subtree or a tag, and resumes from a
 * cursor; the change scan queues one wake per correspondent, not one per
 * change; the reconcile sweep opens a run once min_wake_hours have passed
 * (a heartbeat and a poke are not held by it), and the mandate's own money
 * funds the row with no count of runs; a run's window spans everything
 * since the last PUBLISHED update, so a quiet run cannot drop a change from
 * the next update's account; and the update's "not covered" lists what it
 * did not mention.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedAction, seedAllocation, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
import { listGraphChanges, runGraphChanges } from "../../src/services/graph-change-service.js";
import {
  computeNotCovered,
  correspondentWindow,
  createCorrespondent,
  getCorrespondent,
  graphChangeScanTick,
  listCorrespondentsCovering,
  publishCorrespondentUpdate,
  queueCorrespondentEvent,
  recordCorrespondentRun,
  reviseCorrespondentPractice,
  listPracticeVersions,
  updateCorrespondentPlan,
  listPlanItems,
} from "../../src/services/correspondent-service.js";
import { reconcileActions, CORRESPONDENT_GROUP } from "../../src/services/action-service.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";

let clock = Date.now() - 3_600_000;
/** Insert an assessment, a second apart, keeping is_current on the newest. */
async function assess(claimId: string, status: string, credence: number | null): Promise<string> {
  clock += 1000;
  await rawQuery(`UPDATE assessments SET is_current = false WHERE claim_id = $1 AND is_current`, [claimId]);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO assessments (claim_id, status, confidence, claim_credence, reasoning_trace, assessed_at)
     VALUES ($1, $2, 0.7, $3, 'db test', $4) RETURNING id`,
    [claimId, status, credence, new Date(clock)]
  );
  return row!.id;
}

async function child(parentId: string, label: string): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(
    `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning) VALUES ($1, $2, 'db test')`,
    [parentId, id]
  );
  return id;
}

async function mandate(): Promise<string> {
  const funder = await seedUser("correspondent");
  const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 20_000_000 });
  return grantId;
}

const brief = "Tell the readers following this question what moved in its argument and why it matters.";
const since = () => new Date(clock).toISOString();

describe("the change stream", () => {
  it("reports first assessments, status moves and material credence moves in order, and skips minor passes", async () => {
    const root = await seedClaim("stream root");
    const sub = await child(root, "stream sub");
    const start = since();
    const a1 = await assess(sub, "supported", 0.8);
    await assess(sub, "supported", 0.78); // below the 0.1 threshold
    const a3 = await assess(sub, "doubtful", 0.4);
    const a4 = await assess(sub, "doubtful", 0.25);

    const page = await listGraphChanges({ since: start, scope: { under: [root] } });
    expect(page.changes.map((c) => [c.change_id, c.kind])).toEqual([
      [a1, "first_assessment"],
      [a3, "status_moved"],
      [a4, "credence_moved"],
    ]);
    expect(page.changes[1]!.status_steps).toBe(2);
    expect(page.changes[2]!.credence_delta).toBeCloseTo(-0.15);
    expect(page.has_more).toBe(false);

    const all = await listGraphChanges({ since: start, scope: { under: [root] }, materialOnly: false });
    expect(all.changes.map((c) => c.kind)).toContain("reassessed");

    // Resuming from a cursor returns only what came after it.
    const after = await listGraphChanges({ after: page.changes[0]!.cursor, scope: { under: [root] } });
    expect(after.changes.map((c) => c.change_id)).toEqual([a3, a4]);
    const none = await listGraphChanges({ after: page.next_cursor, scope: { under: [root] } });
    expect(none.changes).toEqual([]);
  });

  it("scopes by tag and leaves other claims out; an unknown tag matches nothing", async () => {
    const tagged = await seedClaim("tagged");
    const other = await seedClaim("untagged");
    const slug = `db-corr-${randomUUID().slice(0, 8)}`;
    const [tag] = await rawQuery<{ id: string }>(
      `INSERT INTO tags (slug, name) VALUES ($1, 'DB corr tag') RETURNING id`,
      [slug]
    );
    await rawQuery(
      `INSERT INTO taggings (tag_id, subject_kind, subject_id, source, confidence, reasoning)
       VALUES ($1, 'claim', $2, 'operator', 1, 'db test')`,
      [tag!.id, tagged]
    );
    const start = since();
    await assess(tagged, "verified", 0.95);
    await assess(other, "verified", 0.95);
    const res = await runGraphChanges({ since: start, tags: [slug] });
    expect(res.ok && res.payload.changes.map((c) => c.claim_id)).toEqual([tagged]);
    const unknown = await runGraphChanges({ since: start, tags: ["no-such-tag-anywhere"] });
    expect(unknown.ok && unknown.payload.changes).toEqual([]);
  });
});

describe("Correspondents", () => {
  it("refuses graph_change with nothing to watch, and a correspondent that would never wake", async () => {
    const grantId = await mandate();
    const noScope = await createCorrespondent({
      grantId, title: "No scope", brief, audience: "followers", triggers: ["graph_change"], createdBy: "test",
    });
    expect(noScope).toMatchObject({ ok: false, code: "SCOPE" });
    const never = await createCorrespondent({
      grantId, title: "Never", brief, audience: "followers", heartbeatHours: 0, createdBy: "test",
    });
    expect(never).toMatchObject({ ok: false, code: "NEVER_WAKES" });
  });

  it("answers which correspondents cover a claim: one beneath its scope, not one beside it", async () => {
    const grantId = await mandate();
    const root = await seedClaim("cover root");
    const sub = await child(root, "cover sub");
    const elsewhere = await seedClaim("elsewhere");
    const res = await createCorrespondent({
      grantId, title: "Cover", brief, audience: "followers", scopeClaimIds: [root], createdBy: "test",
    });
    if (!res.ok) throw new Error(res.message);
    expect((await listCorrespondentsCovering(sub)).map((c) => c.id)).toContain(res.correspondentId);
    expect((await listCorrespondentsCovering(elsewhere)).map((c) => c.id)).not.toContain(res.correspondentId);
  });

  it("wakes once on changes in scope, runs after min_wake_hours, and is funded from the mandate's escrow", async () => {
    const grantId = await mandate();
    const root = await seedClaim("wake root");
    const res = await createCorrespondent({
      grantId, title: "Wake", brief, audience: "followers", scopeClaimIds: [root],
      heartbeatHours: 0, triggers: ["graph_change", "manual"], minWakeHours: 24, createdBy: "test",
    });
    if (!res.ok) throw new Error(res.message);
    const id = res.correspondentId;

    // Nothing has changed since it was posted: no wake.
    await graphChangeScanTick();
    const pending = () =>
      rawQuery(`SELECT id FROM correspondent_events WHERE correspondent_id = $1 AND consumed_at IS NULL`, [id]);
    expect(await pending()).toHaveLength(0);

    clock = Date.now();
    await assess(root, "supported", 0.7);
    await assess(root, "contradicted", 0.1);
    await graphChangeScanTick();
    await graphChangeScanTick();
    expect(await pending()).toHaveLength(1); // one wake, not one per change or per scan

    // Never run: due now. Its row opens and the mandate's own money funds it.
    await reconcileActions();
    const row = async () =>
      (
        await rawQuery<{ id: string; status: string }>(
          `SELECT id, status FROM actions WHERE exclusion_group = $1`,
          [CORRESPONDENT_GROUP(id)]
        )
      )[0];
    expect((await row())?.status).toBe("open");
    await fundGrantSelfActions();
    const [alloc] = await rawQuery<{ grant_id: string }>(
      `SELECT grant_id FROM action_allocations WHERE action_id = $1`,
      [(await row())!.id]
    );
    expect(alloc?.grant_id).toBe(grantId);

    // A run just happened: a new change wake waits out min_wake_hours...
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [(await row())!.id]);
    await rawQuery(`UPDATE correspondent_events SET consumed_at = now() WHERE correspondent_id = $1`, [id]);
    await recordCorrespondentRun({ correspondentId: id, note: "read", cursorTo: null });
    await queueCorrespondentEvent({ correspondentId: id, kind: "graph_change" });
    await reconcileActions();
    expect((await row())?.status).toBe("done");
    // ...but a poke is not held by it.
    await queueCorrespondentEvent({ correspondentId: id, kind: "manual", payload: { note: "now please" } });
    await reconcileActions();
    expect((await row())?.status).toBe("open");
  });

  it("accounts for every change since the last published update, even ones a quiet run read", async () => {
    const grantId = await mandate();
    const root = await seedClaim("window root");
    const res = await createCorrespondent({
      grantId, title: "Window", brief, audience: "followers", scopeClaimIds: [root], createdBy: "test",
    });
    if (!res.ok) throw new Error(res.message);
    const id = res.correspondentId;
    clock = Date.now();
    const a1 = await assess(root, "supported", 0.7);

    // A quiet run reads a1 and publishes nothing: its cursor moves on.
    let c = (await getCorrespondent(id))!;
    const quiet = await correspondentWindow(c);
    expect(quiet.fresh.map((x) => x.change_id)).toEqual([a1]);
    await recordCorrespondentRun({ correspondentId: id, note: "nothing yet", cursorTo: quiet.to });

    const a2 = await assess(root, "doubtful", 0.3);
    c = (await getCorrespondent(id))!;
    const next = await correspondentWindow(c);
    expect(next.seen.map((x) => x.change_id)).toEqual([a1]);
    expect(next.fresh.map((x) => x.change_id)).toEqual([a2]);

    // The update mentions only a2's node by change id; a1 shares the node, so
    // it counts as covered. A change on another node would not.
    const items = [{ claim_id: root, reason: "It moved from supported to doubtful.", change_ids: [a2] }];
    const nc = computeNotCovered(next.changes, items, next.more, "Nothing else in scope was examined.");
    expect(nc.changes_total).toBe(0);
    await publishCorrespondentUpdate({
      correspondentId: id, grantId, title: "It moved", body: "The claim moved to doubtful.",
      items, notCovered: nc, changesFrom: next.from, changesTo: next.to,
    });
    await recordCorrespondentRun({ correspondentId: id, note: "published", cursorTo: next.to });

    // After publishing, the next window starts where the update ended.
    c = (await getCorrespondent(id))!;
    const after = await correspondentWindow(c);
    expect(after.changes).toEqual([]);
    expect(c.updates).toBe(1);
  });

  it("keeps every revision of its practice with its reason, and a plan that is its own", async () => {
    const grantId = await mandate();
    const make = async (title: string) => {
      const r = await createCorrespondent({ grantId, title, brief, audience: "followers", createdBy: "test" });
      if (!r.ok) throw new Error(r.message);
      return r.correspondentId;
    };
    const id = await make("Learner");
    const other = await make("Other");

    expect(await reviseCorrespondentPractice({ correspondentId: id, text: "x", reason: "?", revisedBy: "correspondent" }))
      .toMatchObject({ ok: false });
    await reviseCorrespondentPractice({
      correspondentId: id, text: "Lead with replication news.", reason: "Readers acted on the replication item.", revisedBy: "correspondent",
    });
    await reviseCorrespondentPractice({
      correspondentId: id, text: "", reason: "It was steering selection away from the brief.", revisedBy: "grantmaker:review",
    });
    expect((await getCorrespondent(id))!.practice).toBeNull();
    const history = await listPracticeVersions(id);
    expect(history.map((v) => [v.revised_by, v.text])).toEqual([
      ["grantmaker:review", ""],
      ["correspondent", "Lead with replication news."],
    ]);

    const added = await updateCorrespondentPlan({ correspondentId: id, add: ["Follow the probe subclaims until they settle."] });
    if (!added.ok) throw new Error(added.problem);
    const itemId = added.added[0]!;
    // Another correspondent cannot touch it.
    expect(await updateCorrespondentPlan({ correspondentId: other, update: [{ id: itemId, status: "done" }] }))
      .toMatchObject({ ok: false });
    await updateCorrespondentPlan({ correspondentId: id, update: [{ id: itemId, status: "done", note: "Settled as doubtful." }] });
    expect(await listPlanItems(id, { status: "open" })).toEqual([]);
    expect((await listPlanItems(id, { status: "closed" }))[0]).toMatchObject({ status: "done", note: "Settled as doubtful." });
  });

  it("is funded even behind more than a page of covered rows waiting to run", async () => {
    // Covered self-funded rows wait for the executor. Before #838 they took
    // places in the funding pass's page of 100, so enough of them starved a
    // new row; a pass must reach every row that still needs money.
    const funder = await seedUser("covered");
    for (let i = 0; i < 105; i++) {
      const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 1_000_000 });
      const group = `review:${grantId}`;
      const actionId = await seedAction({ group, kind: "mandate_review", targetRef: grantId, costMicroUsd: 1000 });
      await seedAllocation({ group, actionId, grantId, amountMicroUsd: 1000 });
    }
    const grantId = await mandate();
    const res = await createCorrespondent({ grantId, title: "Behind the queue", brief, audience: "followers", createdBy: "test" });
    if (!res.ok) throw new Error(res.message);
    await reconcileActions();
    await fundGrantSelfActions();
    const [alloc] = await rawQuery<{ grant_id: string }>(
      `SELECT al.grant_id FROM action_allocations al JOIN actions a ON a.id = al.action_id
        WHERE a.exclusion_group = $1`,
      [CORRESPONDENT_GROUP(res.correspondentId)]
    );
    expect(alloc?.grant_id).toBe(grantId);
  });
});
