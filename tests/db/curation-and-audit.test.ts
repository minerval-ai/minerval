/**
 * Curation and audit as funded ledger actions (#363), against real Postgres:
 * the request table's live-uniqueness and per-claim bound, the curate row's
 * open/reopen/cancel lifecycle, the curate formula (the Matcher-quiet term
 * included), the maintenance share in the allocator (a ceiling with first
 * claim whose unused part flows back), the audit formula and its recusal on
 * every path, prompt funding of a fresh request, and the reconcile-candidate
 * scan's bounds and memory.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedAction, seedClaim, seedGrantWithJob, seedUser, seedValuation } from "./helpers.js";
import {
  requestCuration,
  consumeCurationRequests,
  scanReconcileCandidates,
} from "../../src/services/curation-service.js";
import {
  CURATE_GROUP,
  ensureCurateAction,
  reconcileActions,
} from "../../src/services/action-service.js";
import {
  refreshAuditValuations,
  refreshCurateValuations,
  setMandateValuations,
} from "../../src/services/mandate-valuer-service.js";
import { runMandateAllocator } from "../../src/services/allocation-service.js";
import { resetAllocationPolicyCache } from "../../src/services/allocation-policy-service.js";
import { requestAudit } from "../../src/services/queue-service.js";
import {
  mintPrizeReviewReserve,
  reserveRoomMicroUsd,
} from "../../src/services/bounty-service.js";

let general: { grantId: string; jobId: string };
let governance: { grantId: string; jobId: string };

/** An active claim, stewarded, of the given importance and age. */
async function claim(label: string, opts: { importance?: number; ageDays?: number } = {}): Promise<string> {
  const id = await seedClaim(label);
  await rawQuery(
    `UPDATE claims SET steward_state = 'done', importance = $2,
            created_at = now() - make_interval(days => $3)
      WHERE id = $1`,
    [id, opts.importance ?? 0.5, opts.ageDays ?? 30]
  );
  return id;
}

async function curateRow(anchor: string) {
  const [row] = await rawQuery<{ id: string; status: string; kind: string }>(
    `SELECT id, status, kind FROM actions WHERE exclusion_group = $1`,
    [CURATE_GROUP(anchor)]
  );
  return row ?? null;
}

async function valuation(grantId: string, actionId: string): Promise<number | null> {
  const [row] = await rawQuery<{ value_est: number }>(
    `SELECT value_est FROM mandate_valuations WHERE grant_id = $1 AND action_id = $2`,
    [grantId, actionId]
  );
  return row ? Number(row.value_est) : null;
}

async function placements(actionGroup: string) {
  return rawQuery<{ grant_id: string | null; amount_micro_usd: string }>(
    `SELECT grant_id, amount_micro_usd FROM action_allocations
      WHERE exclusion_group = $1 AND released_at IS NULL`,
    [actionGroup]
  );
}

beforeAll(async () => {
  // Earlier files may leave platform mandates active; this file's General
  // and Governance are the only ones the formulas and prompt funding see.
  await rawQuery(
    `UPDATE grants SET status = 'completed'
      WHERE is_platform = true OR policy IN ('general', 'governance')`
  );
  const platform = await seedUser("platform");
  general = await seedGrantWithJob({
    funderId: platform,
    budgetMicroUsd: 100 * OWL,
    dailyBudgetMicroUsd: 10 * OWL,
    policy: "general",
  });
  governance = await seedGrantWithJob({
    funderId: platform,
    budgetMicroUsd: 50 * OWL,
    dailyBudgetMicroUsd: 5 * OWL,
    policy: "governance",
  });
  await rawQuery(`UPDATE grants SET is_platform = true WHERE id = ANY($1::uuid[])`, [
    [general.grantId, governance.grantId],
  ]);
  resetAllocationPolicyCache();
});

describe("curation requests (#363)", () => {
  it("opens the anchor's curate row, and a repeat is a repeat", async () => {
    const anchor = await claim("anchor");
    const other = await claim("other");
    const first = await requestCuration({
      anchorClaimId: anchor,
      otherClaimId: other,
      source: "steward_escalation",
      concern: "likely duplicate",
    });
    expect(first).toMatchObject({ ok: true, repeat: false });
    const again = await requestCuration({
      anchorClaimId: anchor,
      otherClaimId: other,
      source: "steward_escalation",
      concern: "likely duplicate (said twice)",
    });
    expect(again).toMatchObject({ ok: true, repeat: true, requestId: null });
    const [n] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM curation_requests WHERE anchor_claim_id = $1`,
      [anchor]
    );
    expect(n!.n).toBe(1);
    expect(await curateRow(anchor)).toMatchObject({ status: "open", kind: "curate" });
  });

  it("bounds the live escalations one claim may hold", async () => {
    const escalator = await claim("escalator");
    const anchors = await Promise.all([1, 2, 3, 4].map((i) => claim(`bounded ${i}`)));
    const results = [];
    for (const a of anchors) {
      results.push(
        await requestCuration({
          anchorClaimId: a,
          source: "steward_escalation",
          concern: "conflated",
          requestedByClaimId: escalator,
        })
      );
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, true, false]);
    // Repeating a live one is never refused by the bound.
    const repeat = await requestCuration({
      anchorClaimId: anchors[0]!,
      source: "steward_escalation",
      concern: "conflated",
      requestedByClaimId: escalator,
    });
    expect(repeat).toMatchObject({ ok: true, repeat: true });
  });

  it("refuses an anchor that is not an active claim", async () => {
    const gone = await claim("merged away");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [gone]);
    const r = await requestCuration({ anchorClaimId: gone, source: "operator", concern: "x" });
    expect(r.ok).toBe(false);
  });

  it("reopens a done row on a fresh request, and leaves a running one alone", async () => {
    const anchor = await claim("reopen");
    await requestCuration({ anchorClaimId: anchor, source: "operator", concern: "first" });
    const row = (await curateRow(anchor))!;
    await rawQuery(`UPDATE actions SET status = 'running' WHERE id = $1`, [row.id]);
    await ensureCurateAction(anchor);
    expect((await curateRow(anchor))!.status).toBe("running");
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [row.id]);
    const live = await rawQuery<{ id: string }>(
      `SELECT id FROM curation_requests WHERE anchor_claim_id = $1`,
      [anchor]
    );
    await consumeCurationRequests(live.map((r) => r.id), row.id);
    await requestCuration({ anchorClaimId: anchor, source: "operator", concern: "second" });
    expect(await curateRow(anchor)).toMatchObject({ id: row.id, status: "open" });
  });

  it("cancels a curate row whose anchor was merged, releasing the mandate's placement", async () => {
    const anchor = await claim("cancel");
    await requestCuration({ anchorClaimId: anchor, source: "operator", concern: "x" });
    const row = (await curateRow(anchor))!;
    const funder = await seedUser("funder");
    const m = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 10 * OWL });
    await rawQuery(
      `INSERT INTO action_allocations (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd)
       VALUES ($1, NULL, $2, $3, 250000)`,
      [CURATE_GROUP(anchor), anchor, m.grantId]
    );
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [anchor]);
    await reconcileActions();
    expect((await curateRow(anchor))!.status).toBe("cancelled");
    expect(await placements(CURATE_GROUP(anchor))).toEqual([]);
    expect(row.id).toBeDefined();
  });
});

describe("the curate formula (#363)", () => {
  it("values an escalation at the anchor's importance, and a just-matched claim with only a scan's pair at nothing", async () => {
    const escalated = await claim("escalated", { importance: 0.8 });
    const fresh = await claim("fresh", { importance: 0.8, ageDays: 1 });
    const freshOther = await claim("fresh other", { importance: 0.8 });
    await requestCuration({ anchorClaimId: escalated, source: "steward_escalation", concern: "dup" });
    await requestCuration({
      anchorClaimId: fresh,
      otherClaimId: freshOther,
      source: "reconcile_candidate",
      signal: 0.95,
      concern: "alike",
    });
    await refreshCurateValuations(general.grantId, { scopeClaimId: null, scopeQuery: null });
    expect(await valuation(general.grantId, (await curateRow(escalated))!.id)).toBeCloseTo(0.8, 5);
    expect(await valuation(general.grantId, (await curateRow(fresh))!.id)).toBe(0);
  });

  it("weighs a scan's pair on an older claim below an escalation", async () => {
    const older = await claim("older", { importance: 0.8, ageDays: 60 });
    const olderOther = await claim("older other");
    await requestCuration({
      anchorClaimId: older,
      otherClaimId: olderOther,
      source: "reconcile_candidate",
      signal: 0.9,
      concern: "alike",
    });
    await refreshCurateValuations(general.grantId, { scopeClaimId: null, scopeQuery: null });
    // importance 0.8 × candidate weight 0.5 × similarity 0.9
    expect(await valuation(general.grantId, (await curateRow(older))!.id)).toBeCloseTo(0.36, 5);
  });
});

describe("the maintenance share (#363)", () => {
  it("funds curation first within the share, and lets its unused part flow to other work", async () => {
    const funder = await seedUser("maint");
    // A rate of 4 owls: a 10% share is 0.4 owl of curation a day.
    const m = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 100 * OWL,
      dailyBudgetMicroUsd: 4 * OWL,
    });
    const a1 = await claim("m1");
    const a2 = await claim("m2");
    const assessClaim = await claim("m-assess");
    const c1 = await seedAction({ group: CURATE_GROUP(a1), kind: "curate", claimId: a1, costMicroUsd: 250_000 });
    const c2 = await seedAction({ group: CURATE_GROUP(a2), kind: "curate", claimId: a2, costMicroUsd: 250_000 });
    const as = await seedAction({ group: `assess:${assessClaim}`, claimId: assessClaim, costMicroUsd: 1_000_000 });
    // The assessment's ratio beats both curations'; curation still goes first.
    await seedValuation({ grantId: m.grantId, actionId: c1, valueEst: 0.2 });
    await seedValuation({ grantId: m.grantId, actionId: c2, valueEst: 0.1 });
    await seedValuation({ grantId: m.grantId, actionId: as, valueEst: 5 });

    await runMandateAllocator(m.grantId);
    // One curation fits the 0.4-owl share, the better one; the second would
    // exceed it and waits.
    expect(await placements(CURATE_GROUP(a1))).toHaveLength(1);
    expect(await placements(CURATE_GROUP(a2))).toHaveLength(0);
    // The share's unused 0.15 owl stayed in the day: the assessment funded.
    expect(await placements(`assess:${assessClaim}`)).toHaveLength(1);
  });
});

describe("audits on the ledger (#363)", () => {
  it("opens an audit row the Governance mandate values and funds at once", async () => {
    const runId = (await requestAudit({
      auditType: "decision_audit",
      triggeredBy: "bad_faith_flag",
      context: "A bad-faith flag on contribution X.",
    }))!;
    const [run] = await rawQuery<{ action_id: string }>(
      `SELECT action_id FROM audit_runs WHERE id = $1`,
      [runId]
    );
    expect(run!.action_id).toBeTruthy();
    expect(await valuation(governance.grantId, run!.action_id)).toBeCloseTo(0.9, 1);
    expect(await valuation(general.grantId, run!.action_id)).toBeNull();
    const funded = await placements(`audit:${runId}`);
    expect(funded).toHaveLength(1);
    expect(funded[0]!.grant_id).toBe(governance.grantId);
  });

  it("recuses Governance from an audit of itself: General values and funds that one", async () => {
    const runId = (await requestAudit({
      auditType: "anomaly_investigation",
      triggeredBy: "manual",
      context: "Governance declined a run of overturn audits.",
      subjectGrantId: governance.grantId,
    }))!;
    const [run] = await rawQuery<{ action_id: string }>(
      `SELECT action_id FROM audit_runs WHERE id = $1`,
      [runId]
    );
    expect(await valuation(governance.grantId, run!.action_id)).toBeNull();
    expect(await valuation(general.grantId, run!.action_id)).not.toBeNull();
    const funded = await placements(`audit:${runId}`);
    expect(funded.map((f) => f.grant_id)).toEqual([general.grantId]);
  });

  it("holds recusal in the allocator and the valuer's pen, whatever valuation row exists", async () => {
    const runId = (await requestAudit({
      auditType: "decision_audit",
      triggeredBy: "manual",
      context: "An audit of the General mandate's allocation.",
      subjectGrantId: general.grantId,
    }))!;
    const [run] = await rawQuery<{ action_id: string }>(
      `SELECT action_id FROM audit_runs WHERE id = $1`,
      [runId]
    );
    // Governance funded it; now take that away and have General try.
    await rawQuery(`UPDATE action_allocations SET released_at = now() WHERE exclusion_group = $1`, [
      `audit:${runId}`,
    ]);
    const pen = await setMandateValuations(general.grantId, [
      { action_id: run!.action_id, value: 10, rationale: "fund my own audit" },
    ]);
    expect(pen.recusedActionIds).toEqual([run!.action_id]);
    // A row slipped in by any other path still buys nothing.
    await seedValuation({ grantId: general.grantId, actionId: run!.action_id, valueEst: 10 });
    await runMandateAllocator(general.grantId);
    expect(await placements(`audit:${runId}`)).toEqual([]);
  });

  it("funds a prize audit from the bounty's reserve, and has Governance co-fund what a short reserve cannot", async () => {
    const claimId = await claim("prize");
    const ns = `Minerval.S${randomUUID().slice(0, 8)}_v1`;
    const [f] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_formalizations
         (claim_id, version, pin_id, lean_toolchain, mathlib_rev, image_digest,
          namespace, statement_source, source_hash, expr_hash, pp_type,
          constants, definitions_axioms, witness_present, status, authored_by)
       VALUES ($1, 1, 'pin', 'tc', $2, 'sha256:img', $3, 'src', $4, $5, 'True',
               '[]', '[]', true, 'published', 'claim_steward')
       RETURNING id`,
      [claimId, randomUUID(), ns, `src-${randomUUID()}`, `expr-${randomUUID()}`]
    );
    const poster = await seedUser("poster");
    const posting = await seedGrantWithJob({ funderId: poster, budgetMicroUsd: 100 * OWL, policy: "cover" });
    // A 2-owl bounty mints a 0.2-owl reserve: short of one audit's 0.5.
    const [b] = await rawQuery<{ id: string; claim_id: string; amount_micro_usd: string }>(
      `INSERT INTO bounties (claim_id, formalization_id, posted_by_grant_id, amount_micro_usd, status, rules_version, rationale)
       VALUES ($1, $2, $3, $4, 'open', 'v', 'x')
       RETURNING id, claim_id, amount_micro_usd`,
      [claimId, f!.id, posting.grantId, 2 * OWL]
    );
    const reserve = (await mintPrizeReviewReserve({
      id: b!.id,
      claim_id: b!.claim_id,
      amount_micro_usd: Number(b!.amount_micro_usd),
    }))!;
    const runId = (await requestAudit({
      auditType: "decision_audit",
      triggeredBy: "prize_acceptance",
      context: "The Steward accepted a prize claim.",
      bountyId: b!.id,
      claimId,
    }))!;
    const group = `audit:${runId}`;
    const [reserveShare] = await rawQuery<{ amount_micro_usd: string }>(
      `SELECT amount_micro_usd FROM action_allocations
        WHERE exclusion_group = $1 AND user_id = $2 AND released_at IS NULL`,
      [group, reserve.user_id]
    );
    expect(Number(reserveShare!.amount_micro_usd)).toBe(200_000);
    expect((await reserveRoomMicroUsd(b!.id)).room).toBe(0);

    // The sweep: Governance values the short audit and covers the rest.
    await refreshAuditValuations();
    await runMandateAllocator(governance.grantId);
    const [gov] = await rawQuery<{ amount_micro_usd: string }>(
      `SELECT amount_micro_usd FROM action_allocations
        WHERE exclusion_group = $1 AND grant_id = $2 AND released_at IS NULL`,
      [group, governance.grantId]
    );
    expect(Number(gov!.amount_micro_usd)).toBe(300_000);
  });

  it("refreshes every open audit's value in the sweep, rising as it waits", async () => {
    const runId = (await requestAudit({
      auditType: "pattern_analysis",
      triggeredBy: "scheduled_sweep",
      context: "A periodic sweep.",
    }))!;
    const [run] = await rawQuery<{ action_id: string }>(
      `SELECT action_id FROM audit_runs WHERE id = $1`,
      [runId]
    );
    const fresh = (await valuation(governance.grantId, run!.action_id))!;
    await rawQuery(`UPDATE audit_runs SET requested_at = now() - interval '7 days' WHERE id = $1`, [runId]);
    await rawQuery(`UPDATE actions SET status = 'open' WHERE id = $1`, [run!.action_id]);
    await refreshAuditValuations();
    expect(await valuation(governance.grantId, run!.action_id)).toBeCloseTo(fresh * 2, 1);
  });
});

describe("the reconcile-candidate scan (#363)", () => {
  async function embed(id: string, axis: number): Promise<void> {
    const v = Array.from({ length: 1536 }, (_, i) => (i === axis ? 1 : i === axis + 1 ? 0.01 : 0));
    await rawQuery(`UPDATE claims SET embedding = $2::vector WHERE id = $1`, [id, `[${v.join(",")}]`]);
  }

  it("is off at a cap of 0, pairs near-duplicates when on, and never raises a pair twice", async () => {
    await rawQuery(`UPDATE claims SET embedding = NULL`);
    const a = await claim("twin a", { ageDays: 2 });
    const b = await claim("twin b", { ageDays: 3 });
    const loner = await claim("loner", { ageDays: 2 });
    await embed(a, 10);
    await embed(b, 10);
    await embed(loner, 500);

    const policy = { reconcile_candidates_max_per_sweep: 0, reconcile_candidate_min_similarity: 0.92 };
    expect(await scanReconcileCandidates(policy)).toBe(0);

    const on = { ...policy, reconcile_candidates_max_per_sweep: 5 };
    expect(await scanReconcileCandidates(on)).toBe(1);
    const pairs = await rawQuery<{ anchor_claim_id: string; other_claim_id: string; signal: number }>(
      `SELECT anchor_claim_id, other_claim_id, signal FROM curation_requests
        WHERE source = 'reconcile_candidate' AND (anchor_claim_id = ANY($1::uuid[]))`,
      [[a, b, loner]]
    );
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.anchor_claim_id, pairs[0]!.other_claim_id].sort()).toEqual([a, b].sort());
    expect(Number(pairs[0]!.signal)).toBeGreaterThan(0.99);

    // Consumed or not, a pair once asked about is not raised again.
    await rawQuery(`UPDATE curation_requests SET consumed_at = now() WHERE source = 'reconcile_candidate'`);
    expect(await scanReconcileCandidates(on)).toBe(0);
  });

  it("does not pair claims already linked by an edge", async () => {
    await rawQuery(`UPDATE claims SET embedding = NULL`);
    const parent = await claim("parent", { ageDays: 2 });
    const child = await claim("child", { ageDays: 2 });
    await embed(parent, 20);
    await embed(child, 20);
    await rawQuery(
      `INSERT INTO claim_relationships (parent_claim_id, child_claim_id, reasoning)
       VALUES ($1, $2, 'dbtest')`,
      [parent, child]
    );
    expect(
      await scanReconcileCandidates({
        reconcile_candidates_max_per_sweep: 5,
        reconcile_candidate_min_similarity: 0.92,
      })
    ).toBe(0);
  });
});
