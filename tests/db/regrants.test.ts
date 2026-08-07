/**
 * createRegrant (src/services/regrant-service.ts) against real Postgres:
 * headroom enforcement over the source's real committed money, the
 * guarded target credit (a dead target leaves NO regrant row at all),
 * and racing regrants serialized by the per-source advisory lock.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { createRegrant } from "../../src/services/regrant-service.js";
import {
  seedUser,
  seedGrantWithJob,
  seedAllocation,
  jobBudget,
  OWL,
} from "./helpers.js";

async function regrantRowsFrom(grantId: string) {
  return rawQuery<{ id: string; amount_micro_usd: string }>(
    `SELECT id, amount_micro_usd FROM regrants WHERE from_grant_id = $1`,
    [grantId]
  );
}

describe("createRegrant", () => {
  it("rejects bad amounts and self-regrants without touching the DB", async () => {
    const funder = await seedUser("regrant-guards");
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: OWL,
    });
    const zero = await createRegrant({
      fromGrantId: grantId,
      toGrantId: grantId,
      owls: 0,
    });
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.code).toBe("BAD_AMOUNT");
    const self = await createRegrant({
      fromGrantId: grantId,
      toGrantId: grantId,
      owls: 0.1,
    });
    expect(self.ok).toBe(false);
    if (!self.ok) expect(self.code).toBe("SELF_REGRANT");
    expect(await regrantRowsFrom(grantId)).toHaveLength(0);
  });

  it("enforces headroom against committed money (outstanding allocations + prior regrants)", async () => {
    const funder = await seedUser("regrant-headroom");
    const source = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 500_000,
    });
    const target = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
    });
    // 400k of the 500k budget is already riding on an open action.
    await seedAllocation({
      group: `dbtest:regrant-headroom:${source.grantId}`,
      grantId: source.grantId,
      amountMicroUsd: 400_000,
    });

    // 0.2 owls = 200k > 100k headroom → refused, nothing written.
    const over = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.2,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.code).toBe("INSUFFICIENT_BUDGET");
    expect(await regrantRowsFrom(source.grantId)).toHaveLength(0);
    expect(await jobBudget(target.jobId)).toBe(0);

    // 0.1 owls = exactly the headroom → lands.
    const ok = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.1,
    });
    expect(ok.ok).toBe(true);
    expect(await jobBudget(target.jobId)).toBe(100_000);
    const rows = await regrantRowsFrom(source.grantId);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]!.amount_micro_usd)).toBe(100_000);

    // The landed regrant is itself committed money: headroom is now 0.
    const exhausted = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.1,
    });
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.code).toBe("INSUFFICIENT_BUDGET");
  });

  it("dead target: no regrant row at all, no phantom commitment", async () => {
    const funder = await seedUser("regrant-dead-target");
    const source = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: OWL,
    });
    const target = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
      grantStatus: "cancelled",
    });
    const res = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.1,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TARGET_NOT_FOUND");
    // The guarded credit returned zero rows, so NO regrant row exists —
    // the source is not left committed to money that reached nobody.
    expect(await regrantRowsFrom(source.grantId)).toHaveLength(0);
    expect(await jobBudget(target.jobId)).toBe(0);
  });

  it("a target whose job is paused at its floor resumes on the credit", async () => {
    const funder = await seedUser("regrant-resume");
    const source = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: OWL,
    });
    const target = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
      jobStatus: "paused_budget",
    });
    const res = await createRegrant({
      fromGrantId: source.grantId,
      toGrantId: target.grantId,
      owls: 0.1,
    });
    expect(res.ok).toBe(true);
    const [job] = await rawQuery<{ status: string }>(
      `SELECT status FROM budget_jobs WHERE id = $1`,
      [target.jobId]
    );
    expect(job!.status).toBe("running");
  });

  it("CONCURRENCY: racing regrants serialize on headroom — the escrow is never overcommitted", async () => {
    const funder = await seedUser("regrant-race");
    const source = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 500_000,
    });
    const target = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 0,
      withEscrowHold: false,
    });
    // Five parallel 0.2-owl (200k) regrants against 500k of headroom:
    // exactly two can fit.
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        createRegrant({
          fromGrantId: source.grantId,
          toGrantId: target.grantId,
          owls: 0.2,
        })
      )
    );
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(2);
    const rows = await regrantRowsFrom(source.grantId);
    expect(rows).toHaveLength(2);
    const total = rows.reduce((s, r) => s + Number(r.amount_micro_usd), 0);
    expect(total).toBe(400_000);
    expect(await jobBudget(target.jobId)).toBe(400_000);
  });
});
