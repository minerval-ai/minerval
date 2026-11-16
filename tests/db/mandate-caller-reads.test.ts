/**
 * What an outside agent reads of a mandate it funded, against real Postgres:
 * the reads carry the site's links, a list answers short rows, a single
 * mandate or grant answers a summary that pages its plan, the three reads
 * of a mandate's money agree, plan items say who added them, the
 * operations view says what its Grantmaker is watching for (public
 * subscriptions only), and a quantity's or question's judgment can be
 * traced to its run and found in its history.
 */
import { describe, it, expect } from "vitest";
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedAllocation, seedClaim, seedGrantWithJob, seedLlmUsage, seedUser } from "./helpers.js";
import {
  getMandateAllocationView,
  getPublicMandate,
  listMandatesPage,
  type MandateCompactRow,
} from "../../src/services/mandate-service.js";
import { shapeMandateDetail } from "../../src/services/read-detail.js";
import { getGrant, serializeGrant, serializeGrantRow, normalizePlanItems, type PlanItem } from "../../src/services/grant-service.js";
import { runWithUsageContext } from "../../src/llm/usage-context.js";
import { getKindJudgmentHistory } from "../../src/services/assessment-service.js";
import { getCurrentEstimate } from "../../src/services/quantity-service.js";

async function mandateWithPlan(items: number) {
  const funder = await seedUser("caller-reads");
  const { grantId, jobId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50_000_000 });
  const plan: PlanItem[] = Array.from({ length: items }, (_, i) => ({
    action: "ingest" as const,
    url: `https://example.test/${i}`,
    rationale: `source ${i}`,
  }));
  const stamped = normalizePlanItems(plan, { by: "grantmaker_review", at: new Date("2026-11-01T00:00:00Z"), runId: null });
  await rawQuery(
    `UPDATE grants SET plan = $2::jsonb,
            mandate = jsonb_build_object('title', 'Caller reads', 'objective', repeat('A long objective. ', 40))
      WHERE id = $1`,
    [grantId, JSON.stringify({ strategy: "Read them all.", items: stamped })]
  );
  return { funder, grantId, jobId };
}

describe("a mandate as a caller reads it", () => {
  it("carries its page and, for its funder, the funder's page", async () => {
    const { funder, grantId } = await mandateWithPlan(1);
    const pub = (await getPublicMandate(grantId, null))!;
    expect(pub.page_url).toMatch(new RegExp(`/mandates/${grantId}$`));
    expect(pub).not.toHaveProperty("funder_url");
    const mine = (await getPublicMandate(grantId, funder))!;
    expect(mine.funder_url).toMatch(new RegExp(`/ask/mandates/${grantId}$`));

    const grant = await serializeGrant((await getGrant(grantId))!);
    expect(grant.page_url).toBe(pub.page_url);
    expect(grant.funder_url).toBe(mine.funder_url);
  });

  it("lists short rows by default, with the objective cut, and every field on request", async () => {
    const { funder, grantId } = await mandateWithPlan(1);
    const page = await listMandatesPage({ scope: "mine", viewerUserId: funder, state: "any" });
    expect(page.detail).toBe("compact");
    const row = page.mandates.find((m) => m.id === grantId) as MandateCompactRow;
    expect(row.objective!.length).toBeLessThanOrEqual(201);
    expect(row.objective_cut).toBe(true);
    expect(row.page_url).toMatch(/\/mandates\//);
    expect(row.funder_url).toMatch(/\/ask\/mandates\//);
    expect(row).not.toHaveProperty("funder");
    expect(row).not.toHaveProperty("action_mix");

    const full = await listMandatesPage({ scope: "mine", viewerUserId: funder, state: "any", detail: "full" });
    const fullRow = full.mandates.find((m) => m.id === grantId)!;
    expect(fullRow).toHaveProperty("funder");
    expect(fullRow).toHaveProperty("action_mix");
    expect((fullRow as { objective: string }).objective.length).toBeGreaterThan(500);
  });

  it("pages the plan in a summary, says how long each list is, and gives everything in full", async () => {
    const { funder, grantId } = await mandateWithPlan(45);
    const mandate = (await getPublicMandate(grantId, funder))!;
    const summary = shapeMandateDetail(mandate, {});
    expect(summary.detail).toBe("summary");
    expect(summary.plan_items).toHaveLength(20);
    expect(summary.plan_item_counts.total).toBe(45);
    expect(summary.collections.plan_items).toEqual({ total: 45, returned: 20, offset: 0 });
    // Items keep their place in the plan, and say who added them and when.
    expect(summary.plan_items[0]).toMatchObject({
      index: 0,
      added_by: "grantmaker_review",
      added_at: "2026-11-01T00:00:00.000Z",
    });

    const next = shapeMandateDetail(mandate, { items_offset: 40, items_limit: 20 });
    expect(next.plan_items.map((i) => i.index)).toEqual([40, 41, 42, 43, 44]);

    const full = shapeMandateDetail(mandate, { detail: "full" });
    expect(full.plan_items).toHaveLength(45);
    expect(full).not.toHaveProperty("detail_note");

    const grant = await serializeGrant((await getGrant(grantId))!, { items_limit: 5 });
    expect(grant.plan!.items).toHaveLength(5);
    expect(grant.collections.plan_items.total).toBe(45);
    expect(grant.plan!.items[0]).toMatchObject({ index: 0, added_by: "grantmaker_review" });

    const row = await serializeGrantRow((await getGrant(grantId))!);
    expect(row).toMatchObject({ id: grantId, plan_items: 45, title: "Caller reads" });
    expect(row).not.toHaveProperty("plan");
  });

  it("counts spent and held owls the same way on get_grant, get_mandate and the operations view", async () => {
    const { funder, grantId, jobId } = await mandateWithPlan(1);
    const claim = await seedClaim("caller-reads spend");
    // A run that spent 3 of 5 and is still running, one that settled at 1.4,
    // and 0.2 metered to the job outside any allocation.
    await seedAllocation({ group: `g-${randomUUID()}`, claimId: claim, grantId, amountMicroUsd: 5_000_000, spentMicroUsd: 3_000_000 });
    await seedAllocation({ group: `g-${randomUUID()}`, claimId: claim, grantId, amountMicroUsd: 1_400_000, spentMicroUsd: 1_400_000, released: true });
    await seedLlmUsage({ jobId, costMicroUsd: 4_600_000 });

    const grant = await serializeGrant((await getGrant(grantId))!);
    const mandate = (await getPublicMandate(grantId, funder))!;
    const ops = (await getMandateAllocationView(grantId))!;
    expect(grant.spent_owls).toBeCloseTo(4.6, 6);
    expect(mandate.spent_owls).toBe(grant.spent_owls);
    expect(ops.budget.spent_owls).toBe(grant.spent_owls);
    expect(grant.held_owls).toBeCloseTo(2, 6);
    expect(mandate.held_owls).toBe(grant.held_owls);
    expect(ops.budget.held_owls).toBe(grant.held_owls);
  });

  it("stamps items with the run that added them", async () => {
    const runId = randomUUID();
    const items = await runWithUsageContext({ runId }, async () =>
      normalizePlanItems([{ action: "ingest", url: "https://x.test/a", rationale: "r", added_by: "grantmaker_chat" } as PlanItem], {
        by: "grantmaker_review",
      })
    );
    // The writer's stamp wins over whatever the author put there.
    expect(items[0]).toMatchObject({ added_by: "grantmaker_review", added_run_id: runId });
    expect(Date.parse(items[0]!.added_at!)).not.toBeNaN();
  });

  it("serves who added each plan item through public_read.plan_items", async () => {
    const { grantId } = await mandateWithPlan(2);
    const rows = await rawQuery<{ added_by: string; added_at: Date; added_run_id: string | null }>(
      `SELECT added_by, added_at, added_run_id FROM public_read.plan_items WHERE mandate_id = $1 ORDER BY item_index`,
      [grantId]
    );
    expect(rows.map((r) => r.added_by)).toEqual(["grantmaker_review", "grantmaker_review"]);
    expect(new Date(rows[0]!.added_at).toISOString()).toBe("2026-11-01T00:00:00.000Z");
    expect(rows[0]!.added_run_id).toBeNull();
  });

  it("says what its Grantmaker is watching for, public subscriptions only", async () => {
    const { grantId } = await mandateWithPlan(1);
    const [session] = await rawQuery<{ id: string }>(
      `INSERT INTO agent_sessions (id, role, status, transcript, model, suspended_at)
       VALUES ($1, 'grantmaker', 'waiting', '[]'::jsonb, 'm', now()) RETURNING id`,
      [randomUUID()]
    );
    await rawQuery(`UPDATE grants SET grantmaker_session_id = $2 WHERE id = $1`, [grantId, session!.id]);
    await rawQuery(
      `INSERT INTO subscriptions (subscriber_kind, subscriber_ref, filter, due_at, reason, created_by)
       VALUES ('session', $1, '{}'::jsonb, now() + interval '2 days', 'check the first results', 'grantmaker'),
              ('session', $1, '{"grant_ids": ["${grantId}"]}'::jsonb, NULL, 'money committed', 'grantmaker'),
              ('mandate_inbox', $2, '{"kinds": ["assessed"]}'::jsonb, NULL, 'new assessments', 'grantmaker')`,
      [session!.id, grantId]
    );
    await rawQuery(
      `INSERT INTO labels (name, description) VALUES ('internal', 'Readable inside the organization.')
       ON CONFLICT (name) DO NOTHING`
    );
    await rawQuery(
      `INSERT INTO subscriptions (subscriber_kind, subscriber_ref, filter, due_at, reason, created_by, sensitivity_label)
       VALUES ('session', $1, '{}'::jsonb, now() + interval '1 hour', 'a private check-in', 'grantmaker', 'internal')`,
      [session!.id]
    );

    const ops = (await getMandateAllocationView(grantId))!;
    expect(ops.watching.grantmaker_session).toEqual({ id: session!.id, status: "waiting" });
    expect(ops.watching.subscriptions.map((s) => s.reason).sort()).toEqual([
      "check the first results",
      "money committed",
      "new assessments",
    ]);
    expect(ops.watching.subscriptions.find((s) => s.reason === "new assessments")!.subscriber).toBe("mandate_inbox");
    // The private check-in, an hour off, is neither listed nor the next one.
    const next = new Date(ops.watching.next_check_in_at!).getTime();
    expect(next).toBeGreaterThan(Date.now() + 24 * 3_600_000);
  });
});

describe("a quantity's and a question's judgments", () => {
  it("record the run that wrote an estimate, and list every judgment with its run", async () => {
    const quantity = await seedClaim("caller-reads quantity");
    const question = await seedClaim("caller-reads question");
    await rawQuery(`UPDATE claims SET kind = 'quantity' WHERE id = $1`, [quantity]);
    await rawQuery(`UPDATE claims SET kind = 'question' WHERE id = $1`, [question]);
    const runId = randomUUID();
    await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work, run_id, is_current, assessed_at)
       VALUES ($1, '{"form": "none"}'::jsonb, 'old work', NULL, false, now() - interval '2 days'),
              ($1, '{"form": "none"}'::jsonb, 'new work', $2, true, now())`,
      [quantity, runId]
    );
    await rawQuery(
      `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, run_id)
       VALUES ($1, 'open', 'why', $2)`,
      [question, runId]
    );

    const current = await getCurrentEstimate(quantity);
    expect(current!.assessed.run_id).toBe(runId);

    const history = await getKindJudgmentHistory(quantity, "quantity");
    expect(history.total).toBe(2);
    expect(history.rows.map((r) => [r.reasoning_trace, r.run_id, r.is_current])).toEqual([
      ["new work", runId, true],
      ["old work", null, false],
    ]);
    const asked = await getKindJudgmentHistory(question, "question", { limit: 1 });
    expect(asked.rows[0]).toMatchObject({ kind: "question", standing: "open", run_id: runId });

    // The route answers them, where it once answered a quantity empty.
    const { claimRoutes } = await import("../../src/routes/claims.js");
    const app = Fastify();
    app.decorateRequest("auth", null);
    app.decorate("authenticate", async () => {});
    app.decorate("requireUser", async () => {});
    (app.decorate.bind(app) as (name: string, value: unknown) => void)("requireAgenticQuota", () => async () => {});
    await app.register(claimRoutes, { prefix: "/claims" });
    try {
      const res = await app.inject({ method: "GET", url: `/claims/${quantity}/assessments` });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ kind: "quantity", total: 2 });
      expect(res.json().assessments[0]).toMatchObject({ run_id: runId, is_current: true });
    } finally {
      await app.close();
    }
  });
});

describe("a node's event record", () => {
  it("narrows to kinds and a window of time, and counts what it kept", async () => {
    const claimId = await seedClaim("caller-reads events");
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
       VALUES ($1, 'supported', 0.6, 'old', false, now() - interval '3 days'),
              ($1, 'supported', 0.8, 'new', true, now())`,
      [claimId]
    );
    const { getClaimEvents } = await import("../../src/services/claim-events-service.js");
    const { getClaimById } = await import("../../src/services/claim-service.js");
    const claim = (await getClaimById(claimId))!;
    const all = await getClaimEvents(claim);
    expect(all.total).toBeGreaterThanOrEqual(3);
    const judged = await getClaimEvents(claim, { kinds: ["assessment"] });
    expect(judged.total).toBe(2);
    expect(judged.events.every((e) => e.kind === "assessment")).toBe(true);
    const recent = await getClaimEvents(claim, { kinds: ["assessment"], since: new Date(Date.now() - 86_400_000) });
    expect(recent.total).toBe(1);
  });
});
