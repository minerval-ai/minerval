/**
 * Curation and audit as funded ledger actions (#363), against real Postgres:
 * the request table's live-uniqueness and per-claim bound, the curate row's
 * open/reopen/cancel lifecycle, a fresh curation or audit put in front of
 * the mandate that pays for that kind of work (with recusal from an audit
 * of oneself), a prize audit paid from the bounty's reserve, and the
 * reconcile-candidate scan's bounds and memory.
 */
import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";

import { rawQuery } from "../../src/db/client.js";
import { OWL, seedClaim, seedGrantWithJob, seedUser } from "./helpers.js";
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

/** What is waiting in a mandate's inbox about a ledger row. */
async function raised(grantId: string, actionId: string) {
  return rawQuery<{ source: string; summary: string }>(
    `SELECT source, summary FROM mandate_inbox
      WHERE grant_id = $1 AND detail->>'action_id' = $2 AND handled_at IS NULL`,
    [grantId, actionId]
  );
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
  // is the only one prompt funding sees. The 'governance' row stands for a
  // database seeded before Governance was folded into General: nothing is
  // routed to it any more.
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
      defect: "duplicate",
      concern: "likely duplicate",
    });
    expect(first).toMatchObject({ ok: true, repeat: false });
    const again = await requestCuration({
      anchorClaimId: anchor,
      otherClaimId: other,
      source: "steward_escalation",
      defect: "duplicate",
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

  it("takes every distinct escalation from one claim: the ledger, not a count, decides what runs", async () => {
    const escalator = await claim("escalator");
    const anchors = await Promise.all([1, 2, 3, 4].map((i) => claim(`bounded ${i}`)));
    const results = [];
    for (const a of anchors) {
      results.push(
        await requestCuration({
          anchorClaimId: a,
          source: "steward_escalation",
          defect: "duplicate",
          concern: "conflated",
          requestedByClaimId: escalator,
        })
      );
    }
    expect(results.map((r) => r.ok)).toEqual([true, true, true, true]);
    // Repeating a live one is a repeat, not a second request.
    const repeat = await requestCuration({
      anchorClaimId: anchors[0]!,
      source: "steward_escalation",
      defect: "duplicate",
      concern: "conflated",
      requestedByClaimId: escalator,
    });
    expect(repeat).toMatchObject({ ok: true, repeat: true });
  });

  it("refuses an anchor that is not an active claim", async () => {
    const gone = await claim("merged away");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [gone]);
    const r = await requestCuration({ anchorClaimId: gone, source: "operator", defect: "other", concern: "x" });
    expect(r.ok).toBe(false);
  });

  it("reopens a done row on a fresh request, and leaves a running one alone", async () => {
    const anchor = await claim("reopen");
    await requestCuration({ anchorClaimId: anchor, source: "operator", defect: "other", concern: "first" });
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
    await requestCuration({ anchorClaimId: anchor, source: "operator", defect: "other", concern: "second" });
    expect(await curateRow(anchor)).toMatchObject({ id: row.id, status: "open" });
  });

  it("cancels a curate row whose anchor was merged, releasing the mandate's placement", async () => {
    const anchor = await claim("cancel");
    await requestCuration({ anchorClaimId: anchor, source: "operator", defect: "other", concern: "x" });
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

describe("a fresh curation (#363)", () => {
  it("is put in front of the General mandate's officers, and funds nothing by itself", async () => {
    const anchor = await claim("escalated", { importance: 0.8 });
    await requestCuration({ anchorClaimId: anchor, source: "steward_escalation", defect: "duplicate", concern: "dup" });
    const row = (await curateRow(anchor))!;
    expect(await raised(general.grantId, row.id)).toHaveLength(1);
    expect(await raised(governance.grantId, row.id)).toHaveLength(0);
    expect(await placements(CURATE_GROUP(anchor))).toEqual([]);
  });
});

describe("what opened a curation, in front of the officers (#955)", () => {
  it("refuses a request that names no defect: nothing is recorded and no row opens", async () => {
    const anchor = await claim("no defect");
    const r = await requestCuration({
      anchorClaimId: anchor,
      source: "steward_escalation",
      defect: "unassessed" as never,
      concern: "This node has not been assessed yet.",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("duplicate, conflation");
    const [n] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM curation_requests WHERE anchor_claim_id = $1`,
      [anchor]
    );
    expect(n!.n).toBe(0);
    expect(await curateRow(anchor)).toBeNull();
  });

  it("opens no curate row for an anchor with no live request", async () => {
    const anchor = await claim("nothing asked");
    expect(await ensureCurateAction(anchor)).toBeNull();
    expect(await curateRow(anchor)).toBeNull();
  });

  it("records the defect and puts the defect, who raised it, the other node's text and the concern in the inbox item", async () => {
    const escalator = await claim("the escalating node");
    const anchor = await claim("anchor A, worded one way");
    const other = await claim("anchor A, worded another way");
    await requestCuration({
      anchorClaimId: anchor,
      otherClaimId: other,
      source: "steward_escalation",
      defect: "duplicate",
      concern: "Both state the same proposition.",
      requestedByClaimId: escalator,
    });
    const [req] = await rawQuery<{ defect: string }>(
      `SELECT defect FROM curation_requests WHERE anchor_claim_id = $1`,
      [anchor]
    );
    expect(req!.defect).toBe("duplicate");
    const row = (await curateRow(anchor))!;
    const [item] = await rawQuery<{ summary: string; detail: Record<string, unknown> }>(
      `SELECT summary, detail FROM mandate_inbox WHERE grant_id = $1 AND detail->>'action_id' = $2`,
      [general.grantId, row.id]
    );
    expect(item!.summary).toContain("suspected duplicate");
    expect(item!.summary).toContain(`raised by the Steward of ${escalator}`);
    expect(item!.summary).toContain(`the other node: ${other} ("DB-test claim (anchor A, worded another way`);
    expect(item!.summary).toContain("Concern: Both state the same proposition.");
    expect(item!.detail).toMatchObject({ kind: "curate", defects: ["duplicate"], raised_by: ["steward_escalation"] });
  });

  it("raises nothing for a curate row on a claim with no live request", async () => {
    const anchor = await claim("bare row");
    const [row] = await rawQuery<{ id: string }>(
      `INSERT INTO actions (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd)
       VALUES ('curate', $1, 'standard', $2, 'Curate around: bare row', 500000) RETURNING id`,
      [CURATE_GROUP(anchor), anchor]
    );
    const { fundCurationNow } = await import("../../src/services/maintenance-funding.js");
    await fundCurationNow(row!.id);
    expect(await raised(general.grantId, row!.id)).toHaveLength(0);
  });

  it("rewrites a waiting item raised before requests were rendered, and retires one whose row closed", async () => {
    const { refreshCurationInboxItems, CURATION_ITEM_RETIRED_REASON } = await import(
      "../../src/services/maintenance-funding.js"
    );
    // A request recorded before defects were, under an item that carries only
    // the anchor's text: what the officers read on 2026-11-11.
    const legacy = await claim("legacy anchor");
    await rawQuery(
      `INSERT INTO curation_requests (anchor_claim_id, source, concern)
       VALUES ($1, 'audit', 'Audit finding f: these two were merged but differ.')`,
      [legacy]
    );
    const legacyRow = (await ensureCurateAction(legacy))!;
    const [legacyItem] = await rawQuery<{ id: string }>(
      `INSERT INTO mandate_inbox (grant_id, kind, target_node_id, source, summary, detail)
       VALUES ($1, 'raised', $2, 'the system', 'A curation is wanted: Curate around: legacy anchor',
               jsonb_build_object('action_id', $3::text, 'kind', 'curate'))
       RETURNING id`,
      [general.grantId, legacy, legacyRow]
    );
    // A waiting item whose row a run already finished.
    const done = await claim("finished anchor");
    await requestCuration({ anchorClaimId: done, source: "operator", defect: "other", concern: "x" });
    const doneRow = (await curateRow(done))!;
    await rawQuery(`UPDATE actions SET status = 'done' WHERE id = $1`, [doneRow.id]);

    const res = await refreshCurationInboxItems(general.grantId);
    expect(res.retired).toBeGreaterThanOrEqual(1);
    expect(res.rewritten).toBeGreaterThanOrEqual(1);

    const [rewritten] = await rawQuery<{ summary: string; handled_at: Date | null }>(
      `SELECT summary, handled_at FROM mandate_inbox WHERE id = $1`,
      [legacyItem!.id]
    );
    expect(rewritten!.handled_at).toBeNull();
    expect(rewritten!.summary).toContain("defect not classified");
    expect(rewritten!.summary).toContain("raised by the Audit Agent");
    expect(rewritten!.summary).toContain("these two were merged but differ");

    const [retired] = await rawQuery<{ handled_by: string; detail: Record<string, unknown> }>(
      `SELECT handled_by, detail FROM mandate_inbox WHERE detail->>'action_id' = $1`,
      [doneRow.id]
    );
    expect(retired).toMatchObject({ handled_by: "ledger" });
    expect(retired!.detail.retired).toBe(CURATION_ITEM_RETIRED_REASON);
    // Nothing was deleted.
    const [count] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM mandate_inbox WHERE id = $1`,
      [legacyItem!.id]
    );
    expect(count!.n).toBe(1);
  });

  it("retires the waiting item when the reconcile sweep cancels its row", async () => {
    const anchor = await claim("merged before decided");
    await requestCuration({ anchorClaimId: anchor, source: "operator", defect: "conflation", concern: "x" });
    const row = (await curateRow(anchor))!;
    expect(await raised(general.grantId, row.id)).toHaveLength(1);
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [anchor]);
    await reconcileActions();
    expect((await curateRow(anchor))!.status).toBe("cancelled");
    expect(await raised(general.grantId, row.id)).toHaveLength(0);
  });
});

describe("audits on the ledger (#363)", () => {
  async function auditAction(runId: string): Promise<string> {
    const [run] = await rawQuery<{ action_id: string }>(`SELECT action_id FROM audit_runs WHERE id = $1`, [runId]);
    expect(run!.action_id).toBeTruthy();
    return run!.action_id;
  }

  it("opens an audit row and puts it in front of the General mandate's officers", async () => {
    const runId = (await requestAudit({
      auditType: "decision_audit",
      triggeredBy: "bad_faith_flag",
      context: "A bad-faith flag on contribution X.",
    }))!;
    const actionId = await auditAction(runId);
    const items = await raised(general.grantId, actionId);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain("An audit is wanted");
    expect(await raised(governance.grantId, actionId)).toHaveLength(0);
    expect(await placements(`audit:${runId}`)).toEqual([]);
  });

  it("never puts an audit of General to General: it waits on the ledger for anyone else", async () => {
    const runId = (await requestAudit({
      auditType: "anomaly_investigation",
      triggeredBy: "manual",
      context: "General's officers declined a run of overturn audits.",
      subjectGrantId: general.grantId,
    }))!;
    const actionId = await auditAction(runId);
    expect(await raised(general.grantId, actionId)).toHaveLength(0);
    expect(await raised(governance.grantId, actionId)).toHaveLength(0);
    expect(await placements(`audit:${runId}`)).toEqual([]);
  });

  it("funds a prize audit from the bounty's reserve, and asks General for what a short reserve cannot cover", async () => {
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
    const [reserveShare] = await rawQuery<{ amount_micro_usd: string; commissioned_by: string | null }>(
      `SELECT amount_micro_usd, commissioned_by FROM action_allocations
        WHERE exclusion_group = $1 AND user_id = $2 AND released_at IS NULL`,
      [group, reserve.user_id]
    );
    expect(Number(reserveShare!.amount_micro_usd)).toBe(200_000);
    // Short of the whole: not a commission by itself.
    expect(reserveShare!.commissioned_by).toBeNull();
    expect((await reserveRoomMicroUsd(b!.id)).room).toBe(0);
    const actionId = await auditAction(runId);
    const items = await raised(general.grantId, actionId);
    expect(items).toHaveLength(1);
    expect(items[0]!.summary).toContain("review reserve holds");
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
    const pairs = await rawQuery<{ anchor_claim_id: string; other_claim_id: string; signal: number; defect: string }>(
      `SELECT anchor_claim_id, other_claim_id, signal, defect FROM curation_requests
        WHERE source = 'reconcile_candidate' AND (anchor_claim_id = ANY($1::uuid[]))`,
      [[a, b, loner]]
    );
    expect(pairs).toHaveLength(1);
    expect([pairs[0]!.anchor_claim_id, pairs[0]!.other_claim_id].sort()).toEqual([a, b].sort());
    expect(Number(pairs[0]!.signal)).toBeGreaterThan(0.99);
    // A scan's pair is a suspected duplicate, with its score (#955).
    expect(pairs[0]!.defect).toBe("duplicate");

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
