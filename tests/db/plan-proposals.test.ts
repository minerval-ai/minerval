/**
 * A plan around a node the graph does not hold yet (#656), against a real
 * database: a `propose` item files one reviewed contribution once the
 * mandate is live, and the items and the scope that name it bind to the
 * node the accepted proposal becomes, the same way for a claim, a quantity
 * and a question. The Matcher is the only thing faked: what it decides is
 * the test's input.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const fake = vi.hoisted(() => ({
  matchTo: null as string | null,
  kind: null as string | null,
  canonical: null as string | null,
}));

vi.mock("../../src/llm/agents/matcher.js", () => ({
  matchClaim: vi.fn(async () =>
    fake.matchTo
      ? { outcome: "match", is_match: true, matched_claim_id: fake.matchTo, instance_stance: "affirms" }
      : {
          outcome: "new",
          is_match: false,
          matched_claim_id: null,
          new_canonical_form: fake.canonical,
          kind: fake.kind,
          instance_stance: "affirms",
        }
  ),
}));
vi.mock("../../src/llm/agents/domain-prior.js", () => ({
  inferDomainPrior: vi.fn(async () => []),
}));
vi.mock("../../src/services/embedding-service.js", () => ({
  generateEmbedding: vi.fn(async () => {
    throw new Error("no embeddings in tests");
  }),
}));

import { rawQuery } from "../../src/db/client.js";
import { materializePlanItems, type PlanItemLedger } from "../../src/services/action-service.js";
import { applyAcceptanceEffects } from "../../src/services/contribution-acceptance.js";
import { submitGrantContribution } from "../../src/services/contribution-service.js";
import { normalizePlanItems, validatePlanItems, type PlanItem } from "../../src/services/grant-service.js";
import { seedClaim, seedUser, seedGrantWithJob, creditOwls, OWL } from "./helpers.js";

const WHY = "The funder's question is not on the graph in any wording, and the mandate is about it.";

interface StoredItem {
  action: string;
  claim_id?: string;
  claim_ref?: string;
  contribution_id?: string;
  ledger?: PlanItemLedger;
}

async function seedMandate(items: PlanItem[], opts: { status?: string; budgetOwls?: number; scopeRef?: string } = {}) {
  expect(validatePlanItems(items)).toBeNull();
  const funder = await seedUser("proposal-funder");
  await creditOwls(funder, 1000 * OWL);
  const { grantId, jobId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: (opts.budgetOwls ?? 500) * OWL,
    grantStatus: opts.status ?? "active",
  });
  await rawQuery(`UPDATE grants SET plan = $2::jsonb, mandate = $3::jsonb WHERE id = $1`, [
    grantId,
    JSON.stringify({ strategy: "s", items: normalizePlanItems(items) }),
    JSON.stringify({ title: "t", ...(opts.scopeRef ? { scope_ref: opts.scopeRef } : {}) }),
  ]);
  return { grantId, jobId, funder };
}

async function plan(grantId: string): Promise<{ items: StoredItem[]; scope: string | null }> {
  const [row] = await rawQuery<{ plan: { items: StoredItem[] }; scope_claim_id: string | null }>(
    `SELECT plan, scope_claim_id FROM grants WHERE id = $1`,
    [grantId]
  );
  return { items: row!.plan.items, scope: row!.scope_claim_id };
}

async function contributionsOf(grantId: string) {
  return rawQuery<{
    id: string;
    contribution_type: string;
    proposed_canonical_form: string;
    content: string;
    funded_by_job_id: string;
    claim_id: string | null;
  }>(
    `SELECT id, contribution_type, proposed_canonical_form, content, funded_by_job_id, claim_id
       FROM contributions WHERE grant_id = $1 ORDER BY submitted_at`,
    [grantId]
  );
}

/** The Reviewer's decision, recorded the way record_review_decision records it. */
async function review(contributionId: string, decision: "accept" | "reject", reasoning = "db test"): Promise<void> {
  if (decision === "accept") {
    const effects = await applyAcceptanceEffects(contributionId, {});
    expect(effects.ok).toBe(true);
  }
  await rawQuery(
    `INSERT INTO contribution_reviews (contribution_id, decision, reasoning, confidence) VALUES ($1, $2, $3, 0.9)`,
    [contributionId, decision, reasoning]
  );
  await rawQuery(`UPDATE contributions SET review_status = $2 WHERE id = $1`, [
    contributionId,
    decision === "accept" ? "accepted" : "rejected",
  ]);
}

beforeEach(() => {
  fake.matchTo = null;
  fake.kind = null;
  fake.canonical = null;
});

describe("a plan around a node the graph does not hold (#656)", () => {
  const cases = [
    { kind: "question", type: "propose_question", text: "What limits the supply of new housing in large cities?" },
    { kind: "claim", type: "propose_claim", text: "Zoning rules are the main limit on new housing in large cities." },
    { kind: "quantity", type: "propose_quantity", text: "Share of urban residential land zoned for single-family homes in the United States, in percent" },
  ] as const;

  for (const c of cases) {
    it(`files a proposed ${c.kind} once the mandate is live, then binds the plan and the scope to its node`, async () => {
      const { grantId, jobId } = await seedMandate(
        [
          { action: "propose", kind: c.kind, text: c.text, ref: "root", rationale: WHY },
          { action: "deepen", claim_ref: "root", rationale: "work it down" },
          { action: "ingest", url: `https://example.org/${c.kind}`, rationale: "a source" },
        ],
        { status: "pending_approval", scopeRef: "root" }
      );

      // Before the mandate is live nothing is filed and nothing is owed.
      await materializePlanItems(grantId);
      expect(await contributionsOf(grantId)).toHaveLength(0);
      let p = await plan(grantId);
      expect(p.items[0]!.ledger!.status).toBe("waiting");
      expect(p.items[1]!.ledger!.status).toBe("waiting");

      // Live: one contribution, through the mandate's own door, however
      // often the plan is materialized.
      await rawQuery(`UPDATE grants SET status = 'active' WHERE id = $1`, [grantId]);
      await Promise.all([materializePlanItems(grantId), materializePlanItems(grantId)]);
      await materializePlanItems(grantId);
      const filed = await contributionsOf(grantId);
      expect(filed).toHaveLength(1);
      expect(filed[0]).toMatchObject({
        contribution_type: c.type,
        proposed_canonical_form: c.text,
        content: WHY,
        funded_by_job_id: jobId,
        claim_id: null,
      });
      p = await plan(grantId);
      expect(p.items[0]!.contribution_id).toBe(filed[0]!.id);
      expect(p.items[0]!.ledger!.status).toBe("waiting");
      expect(p.items[0]!.ledger!.reason).toContain("awaits the Contribution Reviewer");
      expect(p.items[1]!.claim_id).toBeUndefined();
      expect(p.items[1]!.ledger!.status).toBe("waiting");
      expect(p.scope).toBeNull();
      // Nothing is commissioned for a node that does not exist yet (#849).
      const ordersOf = () =>
        rawQuery<{ claim_id: string }>(
          `SELECT claim_id FROM action_allocations
            WHERE grant_id = $1 AND commissioned_by = 'plan' AND released_at IS NULL`,
          [grantId]
        );
      expect(await ordersOf()).toHaveLength(0);

      // Accepted: the Matcher mints the node under its own wording.
      fake.canonical = `${c.text} (canonical)`;
      await review(filed[0]!.id, "accept");
      const outcomes = await materializePlanItems(grantId);
      p = await plan(grantId);
      const nodeId = p.items[0]!.claim_id!;
      const [node] = await rawQuery<{ kind: string; text: string }>(`SELECT kind, text FROM claims WHERE id = $1`, [nodeId]);
      expect(node).toEqual({ kind: c.kind, text: `${c.text} (canonical)` });
      expect(p.items[0]!.ledger!.status).toBe("done");
      expect(p.items[0]!.ledger!.reason).toContain("entered the graph");
      // The dependent is an ordinary deepen item on that node now.
      expect(p.items[1]!.claim_id).toBe(nodeId);
      expect(p.items[1]!.ledger!.exclusion_group).toBe(`assess:${nodeId}`);
      expect(outcomes[1]!.claim_id).toBe(nodeId);
      // ...and its pass is commissioned from the mandate the moment the
      // node exists, once.
      expect(p.items[1]!.ledger!.status).toBe("open");
      expect(p.items[1]!.ledger!.order).toBeTruthy();
      await materializePlanItems(grantId);
      expect(await ordersOf()).toEqual([{ claim_id: nodeId }]);
      expect(p.scope).toBe(nodeId);

      // The public view shows what was proposed and what it became.
      const rows = await rawQuery<Record<string, unknown>>(
        `SELECT action, node_id, proposed_kind, proposed_text, proposal_ref, node_ref, contribution_id
           FROM public_read.plan_items WHERE mandate_id = $1 ORDER BY item_index`,
        [grantId]
      );
      expect(rows[0]).toEqual({
        action: "propose",
        node_id: nodeId,
        proposed_kind: c.kind,
        proposed_text: c.text,
        proposal_ref: "root",
        node_ref: null,
        contribution_id: filed[0]!.id,
      });
      expect(rows[1]).toMatchObject({ action: "deepen", node_id: nodeId, node_ref: "root" });
    });
  }

  it("binds to the node the graph already held when the Matcher finds one, whatever its kind", async () => {
    const held = await seedClaim("the same question in other words");
    const { grantId } = await seedMandate(
      [
        { action: "propose", kind: "question", text: "Why is housing scarce?", ref: "q", rationale: WHY },
        { action: "assess", claim_ref: "q", rationale: "first pass" },
      ],
      { scopeRef: "q" }
    );
    await materializePlanItems(grantId);
    const [filed] = await contributionsOf(grantId);
    fake.matchTo = held;
    await review(filed!.id, "accept");
    await materializePlanItems(grantId);
    const p = await plan(grantId);
    expect(p.items[0]!.claim_id).toBe(held);
    expect(p.items[0]!.ledger!.reason).toContain("already held it");
    expect(p.items[0]!.ledger!.reason).toContain("the Matcher settled its kind");
    expect(p.items[1]!.claim_id).toBe(held);
    expect(p.scope).toBe(held);
  });

  it("leaves the dependent work unspent when the Reviewer rejects the proposal", async () => {
    const { grantId } = await seedMandate(
      [
        { action: "propose", kind: "claim", text: "Everyone knows rents are too high.", ref: "c", rationale: WHY },
        { action: "assess", claim_ref: "c", rationale: "first pass" },
      ],
      { scopeRef: "c" }
    );
    await materializePlanItems(grantId);
    const [filed] = await contributionsOf(grantId);
    await review(filed!.id, "reject", "A sentiment, not a proposition that evidence could bear on.");
    await materializePlanItems(grantId);
    const p = await plan(grantId);
    expect(p.items[0]!.ledger!.status).toBe("blocked");
    expect(p.items[0]!.ledger!.reason).toContain("A sentiment, not a proposition");
    expect(p.items[1]!.ledger!.status).toBe("blocked");
    expect(p.items[1]!.claim_id).toBeUndefined();
    expect(p.scope).toBeNull();
    const rows = await rawQuery(
      `SELECT a.id FROM actions a JOIN action_allocations al ON al.exclusion_group = a.exclusion_group
        WHERE al.grant_id = $1`,
      [grantId]
    );
    expect(rows).toHaveLength(0);
    // Still one contribution: a rejected proposal is not filed again.
    expect(await contributionsOf(grantId)).toHaveLength(1);
  });

  it("files nothing the escrow cannot pay the review of, and says so", async () => {
    const { grantId } = await seedMandate(
      [{ action: "propose", kind: "question", text: "What is the question?", rationale: WHY }],
      { budgetOwls: 0 }
    );
    await materializePlanItems(grantId);
    expect(await contributionsOf(grantId)).toHaveLength(0);
    const p = await plan(grantId);
    expect(p.items[0]!.ledger!.status).toBe("blocked");
    expect(p.items[0]!.ledger!.reason).toContain("does not cover a review");
  });

  it("adopts an identical proposal the mandate already filed rather than paying for a second review", async () => {
    const text = "How much new housing would upzoning add?";
    const { grantId } = await seedMandate([{ action: "assess", claim_id: await seedClaim("x"), rationale: "r" }]);
    const first = await submitGrantContribution({
      grantId,
      input: { contribution_type: "propose_quantity", proposed_text: text, content: WHY },
    });
    expect(first.success).toBe(true);
    await rawQuery(
      `UPDATE grants SET plan = jsonb_set(plan, '{items}', plan->'items' || $2::jsonb) WHERE id = $1`,
      [grantId, JSON.stringify(normalizePlanItems([{ action: "propose", kind: "quantity", text, rationale: WHY }]))]
    );
    await materializePlanItems(grantId);
    expect(await contributionsOf(grantId)).toHaveLength(1);
    expect((await plan(grantId)).items[1]!.contribution_id).toBe(first.contribution_id);
  });
});
