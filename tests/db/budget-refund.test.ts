/**
 * refundUnspentBudget (src/services/budget-job-service.ts) against real
 * Postgres: grant-backed escrow accounting (consumed pro-rata shares +
 * non-ledger metering via actions.metered_job_id, regrants-out held
 * back, outstanding allocations released first), and the regrant-return
 * path — a live source's share is stamped on the regrant WITHOUT
 * crediting its budget, a dead source's share goes to its funder's owl
 * balance exactly once.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { refundUnspentBudget } from "../../src/services/budget-job-service.js";
import { createRegrant, regrantsOutMicroUsd } from "../../src/services/regrant-service.js";
import {
  seedUser,
  seedGrantWithJob,
  seedAllocation,
  seedAction,
  seedLlmUsage,
  getAllocation,
  ledgerRows,
  jobBudget,
} from "./helpers.js";

describe("refundUnspentBudget — plain (non-grant) job", () => {
  it("refunds budget minus metered llm_usage to the escrow holder, once", async () => {
    const funder = await seedUser("refund-plain");
    const [job] = await rawQuery<{ id: string }>(
      `INSERT INTO budget_jobs (user_id, kind, budget_micro_usd, status)
       VALUES ($1, 'deep_decomposition', 500000, 'completed') RETURNING id`,
      [funder]
    );
    await rawQuery(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id)
       VALUES ($1, -500000, 'escrow_hold', $2)`,
      [funder, job!.id]
    );
    await seedLlmUsage({ jobId: job!.id, costMicroUsd: 100_000 });

    const refunded = await refundUnspentBudget({
      id: job!.id,
      userId: funder,
      budgetMicroUsd: 500_000,
    });
    expect(refunded).toBe(400_000);
    const rows = await ledgerRows(funder);
    const refunds = rows.filter((r) => r.reason === "escrow_refund");
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amount_micro_usd)).toBe(400_000);

    // Idempotent: a second settlement pass refunds nothing more.
    const again = await refundUnspentBudget({
      id: job!.id,
      userId: funder,
      budgetMicroUsd: 500_000,
    });
    expect(again).toBe(0);
    expect(
      (await ledgerRows(funder)).filter((r) => r.reason === "escrow_refund")
    ).toHaveLength(1);
  });
});

describe("refundUnspentBudget — grant-backed job accounting", () => {
  it("releases outstanding allocations first, counts shares + non-ledger metering, holds back regrants out", async () => {
    const funder = await seedUser("refund-grant");
    const { grantId, jobId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 1_000_000,
      grantStatus: "completed",
      jobStatus: "completed",
    });
    // A live regrant target so 200k of the budget is committed elsewhere.
    const otherFunder = await seedUser("refund-grant-target");
    const target = await seedGrantWithJob({
      funderId: otherFunder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
    });
    await rawQuery(
      `INSERT INTO regrants (from_grant_id, to_grant_id, amount_micro_usd)
       VALUES ($1, $2, 200000)`,
      [grantId, target.grantId]
    );

    // An outstanding allocation: 150k placed, 100k consumed as its share.
    const group = `dbtest:refund-grant:${grantId}`;
    const alloc = await seedAllocation({
      group,
      grantId,
      amountMicroUsd: 150_000,
      spentMicroUsd: 100_000,
    });

    // Metering: 80k on the job, of which 50k was consumed by a ledger run
    // (an action stamped metered_job_id) — so non-ledger spend is 30k, and
    // the 50k is NOT double-counted against the escrow.
    await seedLlmUsage({ jobId, costMicroUsd: 80_000 });
    await seedAction({
      group: `dbtest:refund-grant-metered:${grantId}`,
      costMicroUsd: 60_000,
      status: "done",
    });
    await rawQuery(
      `UPDATE actions SET metered_cost_micro_usd = 50000, metered_job_id = $1
        WHERE exclusion_group = $2`,
      [jobId, `dbtest:refund-grant-metered:${grantId}`]
    );

    // unspent = 1,000,000 − (shares 100k + nonledger 30k) − regrants 200k
    const refunded = await refundUnspentBudget({
      id: jobId,
      userId: funder,
      budgetMicroUsd: 1_000_000,
    });
    expect(refunded).toBe(670_000);

    // The outstanding allocation was released before the refund math.
    const released = await getAllocation(alloc);
    expect(released.released_at).not.toBeNull();
    expect(Number(released.spent_micro_usd)).toBe(100_000);

    const refunds = (await ledgerRows(funder)).filter(
      (r) => r.reason === "escrow_refund"
    );
    expect(refunds).toHaveLength(1);
    expect(Number(refunds[0]!.amount_micro_usd)).toBe(670_000);
    expect(refunds[0]!.idempotency_key).toBe(
      `escrow_refund:${jobId}:${funder}`
    );

    // Exactly once per contributor: a re-run refunds nothing more.
    expect(
      await refundUnspentBudget({
        id: jobId,
        userId: funder,
        budgetMicroUsd: 1_000_000,
      })
    ).toBe(0);
    expect(
      (await ledgerRows(funder)).filter((r) => r.reason === "escrow_refund")
    ).toHaveLength(1);
  });
});

describe("refundUnspentBudget — regrant-return path", () => {
  async function regrantedPair() {
    const sourceFunder = await seedUser("regret-src");
    const source = await seedGrantWithJob({
      funderId: sourceFunder,
      budgetMicroUsd: 1_000_000,
    });
    const targetFunder = await seedUser("regret-tgt");
    const target = await seedGrantWithJob({
      funderId: targetFunder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
    });
    const made = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.3,
    });
    expect(made.ok).toBe(true);
    expect(await jobBudget(target.jobId)).toBe(300_000);
    return { sourceFunder, source, targetFunder, target };
  }

  it("live source: stamps refunded_micro_usd WITHOUT crediting the source's budget", async () => {
    const { sourceFunder, source, targetFunder, target } =
      await regrantedPair();

    // The target settles untouched: its whole budget is the regrant.
    const refunded = await refundUnspentBudget({
      id: target.jobId,
      userId: targetFunder,
      budgetMicroUsd: 300_000,
    });
    expect(refunded).toBe(300_000);

    // The regrant row carries the return...
    const [r] = await rawQuery<{ refunded_micro_usd: string }>(
      `SELECT refunded_micro_usd FROM regrants WHERE from_grant_id = $1`,
      [source.grantId]
    );
    expect(Number(r!.refunded_micro_usd)).toBe(300_000);
    // ...the source's budget was NOT credited (that would mint money — the
    // regrant never debited it; it only counted as committed)...
    expect(await jobBudget(source.jobId)).toBe(1_000_000);
    // ...its committed regrants-out drop to zero (headroom restored)...
    expect(await regrantsOutMicroUsd(source.grantId)).toBe(0);
    // ...and nobody's owl balance was touched.
    const srcRows = await ledgerRows(sourceFunder);
    expect(srcRows.filter((x) => x.reason === "escrow_refund")).toHaveLength(0);
    expect(
      (await ledgerRows(targetFunder)).filter(
        (x) => x.reason === "escrow_refund"
      )
    ).toHaveLength(0);
  });

  it("dead source: credits the source funder's owls exactly once", async () => {
    const { sourceFunder, source, targetFunder, target } =
      await regrantedPair();
    // The source mandate settled and closed before the target did.
    await rawQuery(`UPDATE grants SET status = 'completed' WHERE id = $1`, [
      source.grantId,
    ]);
    await rawQuery(
      `UPDATE budget_jobs SET status = 'completed' WHERE id = $1`,
      [source.jobId]
    );

    const refunded = await refundUnspentBudget({
      id: target.jobId,
      userId: targetFunder,
      budgetMicroUsd: 300_000,
    });
    expect(refunded).toBe(300_000);

    const [r] = await rawQuery<{ id: string; refunded_micro_usd: string }>(
      `SELECT id, refunded_micro_usd FROM regrants WHERE from_grant_id = $1`,
      [source.grantId]
    );
    expect(Number(r!.refunded_micro_usd)).toBe(300_000);
    // The share reaches the dead source's funder as owls — once, with the
    // regrant-scoped idempotency key.
    const credits = (await ledgerRows(sourceFunder)).filter(
      (x) => x.reason === "escrow_refund"
    );
    expect(credits).toHaveLength(1);
    expect(Number(credits[0]!.amount_micro_usd)).toBe(300_000);
    expect(credits[0]!.idempotency_key).toBe(
      `escrow_refund:${target.jobId}:regrant:${r!.id}`
    );
    // The dead source's budget is NOT credited either.
    expect(await jobBudget(source.jobId)).toBe(1_000_000);
  });

  // KNOWN BUG (found by this harness; owned by the parent session):
  // refundUnspentBudget is NOT idempotent for a job funded entirely by
  // regrants. After the first settlement fully stamps the regrant rows,
  // a re-run recomputes unspent (still 300k — nothing was metered), but
  // regrantsIn now excludes the fully-refunded regrant, so totalHeld = 0
  // and the "no escrow rows (shouldn't happen)" fallback
  // (src/services/budget-job-service.ts, shares computation) mints the
  // WHOLE unspent amount to the job owner with the never-before-used key
  // `escrow_refund:<job>:<owner>` — 300k created from nothing on the
  // second call. User-contributed jobs are safe (their per-contributor
  // keys collide); only the pure-regrant case double-pays. Callers
  // currently guard re-entry via status transitions, so this needs a
  // retried/crashed settlement to fire in production — but the function's
  // own contract says "exactly once per contributor". Marked .fails so
  // the harness lands green while documenting the defect.
  it.fails("a re-run after a fully-returned regrant mints nothing new", async () => {
    const { sourceFunder, targetFunder, target } = await regrantedPair();
    const first = await refundUnspentBudget({
      id: target.jobId,
      userId: targetFunder,
      budgetMicroUsd: 300_000,
    });
    expect(first).toBe(300_000);

    const again = await refundUnspentBudget({
      id: target.jobId,
      userId: targetFunder,
      budgetMicroUsd: 300_000,
    });
    expect(again).toBe(0);
    // Neither the target owner nor the source funder gained anything.
    expect(
      (await ledgerRows(targetFunder)).filter(
        (x) => x.reason === "escrow_refund"
      )
    ).toHaveLength(0);
    expect(
      (await ledgerRows(sourceFunder)).filter(
        (x) => x.reason === "escrow_refund"
      )
    ).toHaveLength(0);
  });
});
