/**
 * Plan-to-ledger materialization against a real database (#416): every
 * plan item becomes a priced ledger row or carries a stated reason why it
 * cannot, written back onto the item, for all six kinds. The mocked unit
 * suite string-matches SQL and so cannot see the jsonb_set write-back, the
 * ON CONFLICT reopen rules, or the claims/formalizations joins the
 * standing is read from; this suite exists for exactly that.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import {
  materializePlanItems,
  reconcileActions,
  type PlanItemLedger,
} from "../../src/services/action-service.js";
import { fundGrantSelfActions } from "../../src/services/allocation-service.js";
import { getPublicMandate } from "../../src/services/mandate-service.js";
import { collectMandateEvents, pendingMandateEvents } from "../../src/services/mandate-event-service.js";
import { loadConfig } from "../../src/config.js";
import { seedClaim, seedUser, seedGrantWithJob, creditOwls, OWL } from "./helpers.js";

async function seedPublishedFormalization(claimId: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_formalizations
       (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
        namespace, statement_source, source_hash, expr_hash, pp_type,
        constants, definitions_axioms, witness_present, status, authored_by,
        correspondence, published_at)
     VALUES ($1, 1, 'mathlib-v4.33.1', 'leanprover/lean4:v4.33.1', $2,
             'sha256:img', $3, 'def Statement : Prop := True', $4, $5,
             'True', '[]', '[]', false, 'published', 'claim_steward', 'exact', now())
     RETURNING id`,
    [
      claimId,
      randomUUID().replace(/-/g, ""),
      `Minerval.S${randomUUID().slice(0, 8)}_v1`,
      `src-${randomUUID()}`,
      `expr-${randomUUID()}`,
    ]
  );
  return rows[0]!.id;
}

async function planLedger(grantId: string): Promise<Array<PlanItemLedger | undefined>> {
  const [row] = await rawQuery<{ plan: { items: Array<{ ledger?: PlanItemLedger }> } }>(
    `SELECT plan FROM grants WHERE id = $1`,
    [grantId]
  );
  return row!.plan.items.map((i) => i.ledger);
}

/** A current assessment on the claim, dated `offsetSeconds` from now. */
async function seedCurrentAssessment(claimId: string, offsetSeconds = 0): Promise<void> {
  await rawQuery(
    `INSERT INTO assessments
       (claim_id, status, confidence, reasoning_trace, is_current, assessed_at)
     VALUES ($1, 'contradicted', 0.8, 'db test', true, now() + make_interval(secs => $2))`,
    [claimId, offsetSeconds]
  );
}

async function claimState(id: string): Promise<{ steward_state: string }> {
  const [row] = await rawQuery<{ steward_state: string }>(
    `SELECT steward_state FROM claims WHERE id = $1`,
    [id]
  );
  return row!;
}

describe("plan-to-ledger materialization (#416)", () => {
  it("gives every kind a row or a reason, written onto the plan item", async () => {
    const funder = await seedUser("plan-funder");
    await creditOwls(funder, 1000 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500 * OWL });

    const plain = await seedClaim("plain pending");
    const assessed = await seedClaim("already assessed");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [assessed]);
    const deferredChild = await seedClaim("deferred child");
    await rawQuery(`UPDATE claims SET steward_state = 'deferred' WHERE id = $1`, [deferredChild]);
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, relation_type, reasoning)
       VALUES ($1, $2, 'requires', 'db test')`,
      [assessed, deferredChild]
    );
    const math = await seedClaim("mathematics domain");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [math]);
    const published = await seedClaim("published statement");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [published]);
    const formalizationId = await seedPublishedFormalization(published);
    const archived = await seedClaim("archived");
    await rawQuery(`UPDATE claims SET state = 'archived' WHERE id = $1`, [archived]);

    const url = `https://example.org/${randomUUID()}`;
    const items = [
      { action: "assess", claim_id: plain, rationale: "first pass", variant: "standard" }, // 0
      { action: "reassess", claim_id: assessed, rationale: "fresh look", variant: "standard" }, // 1
      { action: "deepen", claim_id: assessed, rationale: "and its subtree", variant: "standard" }, // 2
      { action: "ingest", url, rationale: "a source" }, // 3
      { action: "formalize", claim_id: plain, rationale: "no domain" }, // 4
      { action: "formalize", claim_id: math, rationale: "math domain" }, // 5
      { action: "formalize", claim_id: published, rationale: "already published" }, // 6
      { action: "attempt_proof", claim_id: math, rationale: "no statement yet" }, // 7
      { action: "attempt_proof", claim_id: published, variant: "standard", rationale: "first" }, // 8
      { action: "attempt_proof", claim_id: published, variant: "max", rationale: "second" }, // 9
      { action: "assess", claim_id: archived, rationale: "not active", variant: "standard" }, // 10
    ];
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items }),
    ]);

    const result = await reconcileActions();
    expect(result.plansFailed).toBe(0);
    const ledger = await planLedger(grantId);
    expect(ledger).toHaveLength(items.length);
    for (const l of ledger) expect(l?.checked_at).toBeTruthy();

    // Stewarding items: a row in the claim's assess group, the claim queued.
    expect(ledger[0]!.status).toBe("open");
    expect(ledger[0]!.exclusion_group).toBe(`assess:${plain}`);
    expect(ledger[1]!.status).toBe("open");
    expect(ledger[1]!.exclusion_group).toBe(`assess:${assessed}`);
    expect(ledger[2]!.status).toBe("open");
    expect((await claimState(assessed)).steward_state).toBe("pending");
    // deepen released the deferred subclaim into the queue.
    expect((await claimState(deferredChild)).steward_state).toBe("pending");

    // ingest: its own row, funded from the escrow.
    expect(ledger[3]!.status).toBe("open");
    expect(ledger[3]!.exclusion_group).toBe(`ingest:${url}`);

    // formalize: blocked without the publishing tool, open with it, done
    // when the statement is already published.
    expect(ledger[4]!.status).toBe("blocked");
    expect(ledger[4]!.reason).toContain("publish_formalization");
    expect(ledger[5]!.status).toBe("open");
    expect(ledger[5]!.exclusion_group).toBe(`formalize:${math}`);
    expect(ledger[6]!.status).toBe("done");
    expect(ledger[6]!.reason).toContain("already carries a published");

    // attempt_proof: waiting without a statement; the first item on the
    // published one opens group 1; the second waits behind it.
    expect(ledger[7]!.status).toBe("waiting");
    expect(ledger[7]!.reason).toContain("no published formal statement");
    expect(ledger[8]!.status).toBe("open");
    expect(ledger[8]!.exclusion_group).toBe(`attempt:${formalizationId}:1`);
    expect(ledger[9]!.status).toBe("waiting");
    expect(ledger[9]!.reason).toContain("earlier groups on the statement have closed");

    // A claim that left the graph.
    expect(ledger[10]!.status).toBe("blocked");
    expect(ledger[10]!.reason).toContain("archived");

    // What the mandate's agents see when they look at the ledger.
    const open = await rawQuery<{ kind: string; claim_id: string | null }>(
      `SELECT kind, claim_id FROM actions WHERE status = 'open' AND kind IN ('formalize', 'attempt_proof')`
    );
    expect(open.some((a) => a.kind === "formalize")).toBe(true);
    expect(open.some((a) => a.kind === "attempt_proof" && a.claim_id === published)).toBe(true);

    // What the dashboard shows: state words derived from the ledger.
    const detail = await getPublicMandate(grantId);
    const states = detail!.plan_items.map((i) => i.state);
    expect(states).toEqual([
      "queued", "queued", "queued", "queued", "blocked", "queued",
      "done", "waiting", "queued", "waiting", "blocked",
    ]);
    expect(detail!.plan_items[4]!.ledger?.reason).toContain("publish_formalization");

    // A second sweep is stable: nothing is re-enqueued and nothing rewritten.
    const before = await planLedger(grantId);
    await reconcileActions();
    const after = await planLedger(grantId);
    expect(after.map((l) => [l?.status, l?.action_id])).toEqual(
      before.map((l) => [l?.status, l?.action_id])
    );
  });

  it("keeps a finished stewarding item finished instead of re-queueing the claim every sweep", async () => {
    const funder = await seedUser("plan-funder-2");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const claim = await seedClaim("one pass");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "reassess", claim_id: claim, rationale: "r", variant: "standard" }] }),
    ]);
    const [first] = await materializePlanItems(grantId);
    expect(first!.ledger.status).toBe("open");
    expect((await claimState(claim)).steward_state).toBe("pending");

    // The pass runs: the row closes and the claim settles.
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [first!.ledger.action_id]);
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    const [second] = await materializePlanItems(grantId);
    expect(second!.ledger.status).toBe("done");
    expect(second!.ledger.action_id).toBe(first!.ledger.action_id);
    expect((await claimState(claim)).steward_state).toBe("done");
  });

  it("materializes the appended items in the same call, for extend_plan", async () => {
    const funder = await seedUser("plan-funder-3");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const a = await seedClaim("appended a");
    const b = await seedClaim("appended b");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [b]);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({
        strategy: "s",
        items: [
          { action: "assess", claim_id: a, rationale: "r", variant: "standard" },
          { action: "formalize", claim_id: b, rationale: "r" },
          { action: "attempt_proof", claim_id: b, rationale: "r" },
        ],
      }),
    ]);
    const outcomes = await materializePlanItems(grantId, [1, 2]);
    expect(outcomes.map((o) => o.index)).toEqual([1, 2]);
    expect(outcomes[0]!.ledger.status).toBe("open");
    expect(outcomes[1]!.ledger.status).toBe("waiting");
    // Written back for the sweep and the dashboard alike.
    const ledger = await planLedger(grantId);
    expect(ledger[0]!.status).toBe("open");
    expect(ledger[2]!.status).toBe("waiting");
  });

  it("holds strong-tier items as waiting while the mandate is not yet active", async () => {
    const funder = await seedUser("plan-funder-4");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 50 * OWL,
      grantStatus: "planning",
    });
    const c = await seedClaim("planning claim");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [c]);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "formalize", claim_id: c, rationale: "r" }] }),
    ]);
    const [o] = await materializePlanItems(grantId);
    expect(o!.ledger.status).toBe("waiting");
    expect(o!.ledger.reason).toContain("planning");
    const [row] = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM actions WHERE exclusion_group = $1`,
      [`formalize:${c}`]
    );
    expect(Number(row!.n)).toBe(0);
  });

  // A plan written while mathematics was on, in a deployment that has since
  // switched it off (src/features.ts): its formalize and attempt_proof items
  // open no rows, and say why. New plans are refused such items where they
  // are written (validatePlanItems).
  it("opens no row for an item whose feature is switched off, and says why", async () => {
    const funder = await seedUser("plan-funder-features");
    await creditOwls(funder, 1000 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 500 * OWL });
    const plain = await seedClaim("features: plain pending");
    const math = await seedClaim("features: mathematics domain");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [math]);
    const published = await seedClaim("features: published statement");
    await rawQuery(`UPDATE claims SET domains = ARRAY['mathematics'] WHERE id = $1`, [published]);
    const formalizationId = await seedPublishedFormalization(published);
    const items = [
      { action: "assess", claim_id: plain, rationale: "first pass", variant: "standard" }, // 0
      { action: "formalize", claim_id: math, rationale: "math domain" }, // 1
      { action: "formalize", claim_id: published, rationale: "already published" }, // 2
      { action: "attempt_proof", claim_id: published, variant: "standard", rationale: "first" }, // 3
    ];
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items }),
    ]);
    const rows = () =>
      rawQuery<{ kind: string }>(
        `SELECT kind FROM actions WHERE exclusion_group = $1 OR exclusion_group LIKE $2`,
        [`formalize:${math}`, `attempt:${formalizationId}:%`]
      );

    const config = loadConfig() as { featuresOff: string[] };
    const saved = config.featuresOff;
    config.featuresOff = ["mathematics"];
    try {
      const outcomes = await materializePlanItems(grantId);
      const ledger = outcomes.map((o) => o.ledger);
      // Work of the core product is untouched.
      expect(ledger[0]!.status).toBe("open");
      // A formalize item opens nothing and carries the reason.
      expect(ledger[1]!.status).toBe("blocked");
      expect(ledger[1]!.reason).toBe(
        "formalize is not available in this deployment: mathematics is switched off, " +
          "so the item opens no work; it becomes work if that is switched on"
      );
      // What the record already holds still reads as it is.
      expect(ledger[2]!.status).toBe("done");
      expect(ledger[2]!.reason).toContain("already carries a published");
      // An attempt opens no group, though the statement is published.
      expect(ledger[3]!.status).toBe("blocked");
      expect(ledger[3]!.reason).toContain(
        "attempt_proof is not available in this deployment: mathematics is switched off"
      );
      expect(await rows()).toEqual([]);
    } finally {
      config.featuresOff = saved;
    }

    // Switched back on, the same items become work.
    const ledger = (await materializePlanItems(grantId)).map((o) => o.ledger);
    expect(ledger[1]!.status).toBe("open");
    expect(ledger[1]!.exclusion_group).toBe(`formalize:${math}`);
    expect(ledger[3]!.status).toBe("open");
    expect(ledger[3]!.exclusion_group).toBe(`attempt:${formalizationId}:1`);
    expect((await rows()).map((r) => r.kind).sort()).toEqual(["attempt_proof", "attempt_proof", "formalize"]);
  });

  it("reads an assess item on an already-assessed claim as done instead of queueing a pass (#427)", async () => {
    const funder = await seedUser("plan-funder-5");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const claim = await seedClaim("assessed before the plan");
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    await seedCurrentAssessment(claim, -60);
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({
        strategy: "s",
        items: [
          { action: "assess", claim_id: claim, rationale: "first pass", variant: "standard" },
          { action: "reassess", claim_id: claim, rationale: "a fresh look", variant: "standard" },
        ],
      }),
    ]);
    const [assess, reassess] = await materializePlanItems(grantId);
    expect(assess!.ledger.status).toBe("done");
    expect(assess!.ledger.reason).toContain("already carries an assessment");
    // The reassess item is the ask for a fresh pass: it queues the claim.
    expect(reassess!.ledger.status).toBe("open");
    expect((await claimState(claim)).steward_state).toBe("pending");
    const detail = await getPublicMandate(grantId);
    expect(detail!.plan_items.map((i) => i.state)).toEqual(["done", "queued"]);
  });

  // #628: a quantity's estimate and a question's standing are their
  // assessment, kept in their own tables, so the standing must read them.
  it("reads an assess item on an estimated quantity or an assessed question as done (#628)", async () => {
    const funder = await seedUser("plan-funder-kinds");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const quantity = await seedClaim("an estimated quantity");
    const question = await seedClaim("an assessed question");
    await rawQuery(`UPDATE claims SET kind = 'quantity', steward_state = 'done' WHERE id = $1`, [quantity]);
    await rawQuery(`UPDATE claims SET kind = 'question', steward_state = 'done' WHERE id = $1`, [question]);
    await rawQuery(
      `INSERT INTO quantity_estimates (claim_id, estimate, work, assessed_at)
       VALUES ($1, '{"form":"point","central":1}', 'db test', now() - interval '1 minute')`,
      [quantity]
    );
    await rawQuery(
      `INSERT INTO question_assessments (claim_id, standing, reasoning_trace, assessed_at)
       VALUES ($1, 'open', 'db test', now() - interval '1 minute')`,
      [question]
    );
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({
        strategy: "s",
        items: [
          { action: "assess", claim_id: quantity, rationale: "first estimate", variant: "standard" },
          { action: "assess", claim_id: question, rationale: "first standing", variant: "standard" },
        ],
      }),
    ]);
    const [q, qn] = await materializePlanItems(grantId);
    expect(q!.ledger.status).toBe("done");
    expect(qn!.ledger.status).toBe("done");
  });

  it("reads a stewarding item as done when its pass ran on another lane while the row sat open (#427)", async () => {
    const funder = await seedUser("plan-funder-6");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const claim = await seedClaim("run on the direct lane");
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "assess", claim_id: claim, rationale: "r", variant: "standard" }] }),
    ]);
    const [opened] = await materializePlanItems(grantId);
    expect(opened!.ledger.status).toBe("open");
    expect((await claimState(claim)).steward_state).toBe("pending");

    // Another lane runs the pass: the claim settles with an assessment, the
    // row never closes (only the ledger's own drain closes rows).
    await rawQuery(`UPDATE claims SET steward_state = 'done' WHERE id = $1`, [claim]);
    await seedCurrentAssessment(claim, 5);

    const result = await reconcileActions();
    expect(result.plansFailed).toBe(0);
    let [ledger] = await planLedger(grantId);
    expect(ledger!.status).toBe("done");
    expect(ledger!.reason).toContain("another lane");
    expect(ledger!.action_id).toBe(opened!.ledger.action_id);
    // The claim was not queued again for a pass that already ran.
    expect((await claimState(claim)).steward_state).toBe("done");

    // The sweep retired the row as assessed elsewhere; the item keeps
    // reading done across later sweeps rather than flipping to cancelled.
    const [row] = await rawQuery<{ status: string }>(
      `SELECT status FROM actions WHERE id = $1`,
      [opened!.ledger.action_id]
    );
    expect(row!.status).toBe("cancelled");
    await reconcileActions();
    [ledger] = await planLedger(grantId);
    expect(ledger!.status).toBe("done");
    expect((await claimState(claim)).steward_state).toBe("done");
    expect((await getPublicMandate(grantId))!.plan_items[0]!.state).toBe("done");
  });

  it("keeps an ingest item the cursor passed before its row ran queued and funded (#427)", async () => {
    const funder = await seedUser("plan-funder-7");
    await creditOwls(funder, 100 * OWL);
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const claim = await seedClaim("claim item after the ingest");
    const url = `https://example.org/${randomUUID()}`;
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({
        strategy: "s",
        items: [
          { action: "ingest", url, rationale: "a source" },
          { action: "assess", claim_id: claim, rationale: "r", variant: "standard" },
        ],
      }),
    ]);
    const [before] = await materializePlanItems(grantId);
    expect(before!.ledger.status).toBe("open");

    // The direct steward lane runs the claim item and moves the cursor to
    // 2, past the ingest whose row is still open.
    await rawQuery(`UPDATE grants SET plan_cursor = 2 WHERE id = $1`, [grantId]);
    const [after] = await materializePlanItems(grantId);
    expect(after!.ledger.status).toBe("open");
    expect(after!.ledger.action_id).toBe(before!.ledger.action_id);
    const detail = await getPublicMandate(grantId);
    expect(detail!.plan_items[0]!.state).toBe("queued");

    // Still the mandate's own work: the escrow funds it wherever the cursor stands.
    await fundGrantSelfActions();
    const [alloc] = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM action_allocations
        WHERE exclusion_group = $1 AND grant_id = $2 AND released_at IS NULL`,
      [`ingest:${url}`, grantId]
    );
    expect(Number(alloc!.n)).toBe(1);
  });

  it("attributes a URL someone else already ingested to the mandate whose item reads done (#657)", async () => {
    const funder = await seedUser("plan-funder-657");
    const { grantId } = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 50 * OWL });
    const url = `https://example.org/${randomUUID()}`;
    // Another reader's ingest of the URL ran and finished.
    const [src] = await rawQuery<{ id: string }>(`INSERT INTO sources (title, url) VALUES ('Earlier', $1) RETURNING id`, [url]);
    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO jobs (type, status, input, completed_at)
       VALUES ('url_extraction', 'completed', jsonb_build_object('sourceId', $1::text, 'url', $2::text), now()) RETURNING id`,
      [src!.id, url]
    );
    await rawQuery(
      `INSERT INTO actions (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, status)
       VALUES ('ingest', $1, 'standard', $2, 'Ingest', 1000000, 'done')`,
      [`ingest:${url}`, url]
    );
    await rawQuery(`UPDATE grants SET plan = $2::jsonb WHERE id = $1`, [
      grantId,
      JSON.stringify({ strategy: "s", items: [{ action: "ingest", url, rationale: "a source" }] }),
    ]);

    await rawQuery(`UPDATE grants SET events_scanned_at = now() - interval '1 minute' WHERE id = $1`, [grantId]);
    const [item] = await materializePlanItems(grantId);
    expect(item!.ledger.status).toBe("done");
    // Its review is told the source was already in the graph, once (#898).
    expect(await collectMandateEvents(grantId)).toBe(1);
    const { events } = await pendingMandateEvents(grantId);
    expect(events[0]!.payload).toMatchObject({ outcome: "completed", already_extracted: true });
    const detail = await getPublicMandate(grantId);
    expect(detail!.pipeline).toHaveLength(1);
    expect(detail!.pipeline[0]).toMatchObject({ source_id: src!.id, extraction_status: "completed" });

    // Every later sweep leaves it at one row.
    await materializePlanItems(grantId);
    const rows = await rawQuery(`SELECT job_id FROM grant_sources WHERE grant_id = $1`, [grantId]);
    expect(rows).toEqual([{ job_id: job!.id }]);
  });
});
