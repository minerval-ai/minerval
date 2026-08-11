/**
 * completeAction (src/services/action-service.ts) against real Postgres:
 * the one-transaction close of an exclusion group. Losing pinned
 * allocations release with owl refunds, the metered cost consumes pro
 * rata across the winner's covering allocations, remainders settle back
 * exactly once, siblings supersede — and a second completion of the same
 * action is a total no-op. Plus: the whole close is genuinely atomic (an
 * induced mid-flight failure leaves no partial state), and two racing
 * completers converge on one consumption.
 */
import { describe, it, expect } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { completeAction } from "../../src/services/action-service.js";
import {
  seedUser,
  seedClaim,
  seedGrantWithJob,
  seedAction,
  seedAllocation,
  getAction,
  getAllocation,
  ledgerRows,
  owlBalance,
  OWL,
} from "./helpers.js";

/** The canonical scenario: standard (running) + strong (open) siblings,
 * two unpinned covering allocations (user A, grant G) and one allocation
 * pinned to the losing strong sibling (user B). */
async function seedScenario() {
  const userA = await seedUser("complete-A");
  const userB = await seedUser("complete-B");
  const funder = await seedUser("complete-funder");
  const { grantId, jobId } = await seedGrantWithJob({
    funderId: funder,
    budgetMicroUsd: 10 * OWL,
  });
  const claimId = await seedClaim("complete");
  const group = `assess:${claimId}`;
  const std = await seedAction({
    group,
    variant: "standard",
    costMicroUsd: 100_000,
    status: "running",
    claimId,
  });
  const strong = await seedAction({
    group,
    variant: "strong",
    costMicroUsd: 300_000,
    status: "open",
    claimId,
  });
  const allocA = await seedAllocation({
    group,
    claimId,
    userId: userA,
    amountMicroUsd: 60_000,
  });
  const allocG = await seedAllocation({
    group,
    claimId,
    grantId,
    amountMicroUsd: 60_000,
  });
  const allocB = await seedAllocation({
    group,
    claimId,
    userId: userB,
    actionId: strong,
    amountMicroUsd: 200_000,
  });
  return {
    userA,
    userB,
    grantId,
    jobId,
    claimId,
    group,
    std,
    strong,
    allocA,
    allocG,
    allocB,
  };
}

describe("completeAction", () => {
  it("consumes pro rata, releases the losing pin with a refund, settles remainders once, supersedes siblings", async () => {
    const s = await seedScenario();
    const consumed = await completeAction(s.std, 50_000, {
      meteredJobId: s.jobId,
    });
    expect(consumed).toBe(50_000);

    // Winner closed with its metered cost and job attribution.
    const std = await getAction(s.std);
    expect(std!.status).toBe("done");
    expect(Number(std!.metered_cost_micro_usd)).toBe(50_000);
    expect(std!.metered_job_id).toBe(s.jobId);

    // Sibling superseded.
    const strong = await getAction(s.strong);
    expect(strong!.status).toBe("superseded");

    // Pro-rata consumption: 50k across two equal 60k coverers = 25k each,
    // and every covering allocation settled (released) after consumption.
    const a = await getAllocation(s.allocA);
    const g = await getAllocation(s.allocG);
    expect(Number(a.spent_micro_usd)).toBe(25_000);
    expect(Number(g.spent_micro_usd)).toBe(25_000);
    expect(a.released_at).not.toBeNull();
    expect(g.released_at).not.toBeNull();

    // The losing pinned allocation released, nothing consumed from it.
    const b = await getAllocation(s.allocB);
    expect(Number(b.spent_micro_usd)).toBe(0);
    expect(b.released_at).not.toBeNull();

    // User B refunded their full pin; user A refunded their unspent 35k.
    const rowsB = await ledgerRows(s.userB);
    expect(rowsB).toHaveLength(1);
    expect(Number(rowsB[0]!.amount_micro_usd)).toBe(200_000);
    expect(rowsB[0]!.reason).toBe("refund");
    expect(rowsB[0]!.idempotency_key).toBe(`release:${s.allocB}`);
    const rowsA = await ledgerRows(s.userA);
    expect(rowsA).toHaveLength(1);
    expect(Number(rowsA[0]!.amount_micro_usd)).toBe(35_000);
    expect(rowsA[0]!.idempotency_key).toBe(`settle:${s.allocA}`);
  });

  it("a second completeAction on the same action is a total no-op", async () => {
    const s = await seedScenario();
    const first = await completeAction(s.std, 50_000, {
      meteredJobId: s.jobId,
    });
    expect(first).toBe(50_000);
    const balanceA = await owlBalance(s.userA);
    const balanceB = await owlBalance(s.userB);

    const second = await completeAction(s.std, 50_000, {
      meteredJobId: s.jobId,
    });
    expect(second).toBe(0);

    // No extra consumption, no extra refunds, no status churn.
    expect(await owlBalance(s.userA)).toBe(balanceA);
    expect(await owlBalance(s.userB)).toBe(balanceB);
    const a = await getAllocation(s.allocA);
    const g = await getAllocation(s.allocG);
    expect(Number(a.spent_micro_usd)).toBe(25_000);
    expect(Number(g.spent_micro_usd)).toBe(25_000);
    expect((await ledgerRows(s.userA)).length).toBe(1);
    expect((await ledgerRows(s.userB)).length).toBe(1);
  });

  it("caps consumption at the covering total when the meter overruns", async () => {
    const userA = await seedUser("complete-overrun");
    const claimId = await seedClaim("complete-overrun");
    const group = `assess:${claimId}`;
    const std = await seedAction({
      group,
      costMicroUsd: 100_000,
      status: "running",
      claimId,
    });
    const alloc = await seedAllocation({
      group,
      claimId,
      userId: userA,
      amountMicroUsd: 80_000,
    });
    const consumed = await completeAction(std, 150_000);
    expect(consumed).toBe(80_000);
    const a = await getAllocation(alloc);
    expect(Number(a.spent_micro_usd)).toBe(80_000);
    // Fully consumed: settlement releases nothing, no refund row.
    expect((await ledgerRows(userA)).length).toBe(0);
  });

  it("records a MANDATE's overage as a settled allocation, so the escrow sees it", async () => {
    // The money is already gone when completeAction runs — the LLM calls
    // happened and are metered against the grant's job. Clamping consumption
    // and saying nothing left 23.57 owls of real spend in no term of
    // grantCommittedMicroUsd on the first live epoch, which is how an escrow
    // reporting 112 owls left actually had 79.
    const funder = await seedUser("overage-mandate");
    const { grantId } = await seedGrantWithJob({
      funderId: funder,
      budgetMicroUsd: 100 * OWL,
    });
    const claimId = await seedClaim("overage-mandate");
    const group = `assess:${claimId}`;
    const std = await seedAction({
      group,
      costMicroUsd: 2 * OWL,
      status: "running",
      claimId,
    });
    await seedAllocation({
      group,
      claimId,
      grantId,
      amountMicroUsd: 2 * OWL,
    });

    // Ran 3x its allocation, the shape the live epoch kept producing.
    const consumed = await completeAction(std, 6 * OWL);

    // Consumption is the truth now, not the promise.
    expect(consumed).toBe(6 * OWL);
    const [shares] = await rawQuery<{ spent: number }>(
      `SELECT COALESCE(SUM(spent_micro_usd), 0)::bigint AS spent
         FROM action_allocations WHERE grant_id = $1`,
      [grantId]
    );
    expect(Number(shares!.spent)).toBe(6 * OWL);

    // The overage is its own row, already settled, so it never blocks a
    // future live placement on this group.
    const overage = await rawQuery<{
      amount_micro_usd: number;
      spent_micro_usd: number;
      released_at: string | null;
    }>(
      `SELECT amount_micro_usd, spent_micro_usd, released_at
         FROM action_allocations
        WHERE grant_id = $1 AND amount_micro_usd = spent_micro_usd
          AND amount_micro_usd = $2`,
      [grantId, 4 * OWL]
    );
    expect(overage).toHaveLength(1);
    expect(overage[0]!.released_at).not.toBeNull();
  });

  it("splits an overage across co-funding mandates pro rata to what each promised", async () => {
    const funder = await seedUser("overage-split");
    const big = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL });
    const small = await seedGrantWithJob({ funderId: funder, budgetMicroUsd: 100 * OWL });
    const claimId = await seedClaim("overage-split");
    const group = `assess:${claimId}`;
    const std = await seedAction({
      group,
      costMicroUsd: 4 * OWL,
      status: "running",
      claimId,
    });
    await seedAllocation({ group, claimId, grantId: big.grantId, amountMicroUsd: 3 * OWL });
    await seedAllocation({ group, claimId, grantId: small.grantId, amountMicroUsd: 1 * OWL });

    // 4 owls promised, 8 spent: 4 owls of overage, split 3:1.
    await completeAction(std, 8 * OWL);

    const spentFor = async (grantId: string) => {
      const [row] = await rawQuery<{ spent: number }>(
        `SELECT COALESCE(SUM(spent_micro_usd), 0)::bigint AS spent
           FROM action_allocations WHERE grant_id = $1`,
        [grantId]
      );
      return Number(row!.spent);
    };
    expect(await spentFor(big.grantId)).toBe(6 * OWL);
    expect(await spentFor(small.grantId)).toBe(2 * OWL);
  });

  it("never bills a USER past their cap: no overage row on a user-funded group", async () => {
    // A person's allocation is a ceiling they were shown and can rely on. The
    // platform eats the overrun; only mandates carry their own overspend.
    const userA = await seedUser("overage-user");
    const claimId = await seedClaim("overage-user");
    const group = `assess:${claimId}`;
    const std = await seedAction({
      group,
      costMicroUsd: 1 * OWL,
      status: "running",
      claimId,
    });
    await seedAllocation({ group, claimId, userId: userA, amountMicroUsd: 1 * OWL });

    const consumed = await completeAction(std, 5 * OWL);

    expect(consumed).toBe(1 * OWL);
    const rows = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM action_allocations
        WHERE exclusion_group = $1 AND user_id = $2`,
      [group, userA]
    );
    expect(Number(rows[0]!.n)).toBe(1); // still just their one allocation
  });

  it("rolls back completely when a mid-flight write fails (real transaction)", async () => {
    const s = await seedScenario();
    // Induce a failure INSIDE the close, after the done-transition and the
    // supersede: a trigger that rejects the loser's refund insert.
    await rawQuery(
      `CREATE OR REPLACE FUNCTION dbtest_fail_refund() RETURNS trigger AS $$
       BEGIN
         IF NEW.reason = 'refund' AND NEW.user_id = '${s.userB}'::uuid THEN
           RAISE EXCEPTION 'dbtest: induced mid-transaction failure';
         END IF;
         RETURN NEW;
       END $$ LANGUAGE plpgsql`
    );
    await rawQuery(
      `CREATE TRIGGER dbtest_fail_refund_trigger
         BEFORE INSERT ON owl_ledger
         FOR EACH ROW EXECUTE FUNCTION dbtest_fail_refund()`
    );
    try {
      await expect(
        completeAction(s.std, 50_000, { meteredJobId: s.jobId })
      ).rejects.toThrow(/induced mid-transaction failure/);
    } finally {
      await rawQuery(`DROP TRIGGER dbtest_fail_refund_trigger ON owl_ledger`);
      await rawQuery(`DROP FUNCTION dbtest_fail_refund()`);
    }

    // NOTHING happened: the done-transition, the supersede, and any spent
    // increments must all have rolled back together.
    const std = await getAction(s.std);
    expect(std!.status).toBe("running");
    expect(std!.metered_cost_micro_usd).toBeNull();
    const strong = await getAction(s.strong);
    expect(strong!.status).toBe("open");
    for (const id of [s.allocA, s.allocG, s.allocB]) {
      const row = await getAllocation(id);
      expect(Number(row.spent_micro_usd)).toBe(0);
      expect(row.released_at).toBeNull();
    }
    expect((await ledgerRows(s.userA)).length).toBe(0);
    expect((await ledgerRows(s.userB)).length).toBe(0);

    // And the group is still completable afterwards.
    const consumed = await completeAction(s.std, 50_000);
    expect(consumed).toBe(50_000);
  });

  it("CONCURRENCY: two parallel completions of one action — exactly one consumes", async () => {
    const s = await seedScenario();
    const [r1, r2] = await Promise.all([
      completeAction(s.std, 50_000, { meteredJobId: s.jobId }),
      completeAction(s.std, 50_000, { meteredJobId: s.jobId }),
    ]);
    // One winner, one no-op — in either order.
    expect([r1, r2].sort((x, y) => x - y)).toEqual([0, 50_000]);

    const a = await getAllocation(s.allocA);
    const g = await getAllocation(s.allocG);
    expect(Number(a.spent_micro_usd) + Number(g.spent_micro_usd)).toBe(50_000);
    // Refunds landed exactly once each.
    expect((await ledgerRows(s.userA)).length).toBe(1);
    expect((await ledgerRows(s.userB)).length).toBe(1);
    expect(await owlBalance(s.userB)).toBe(200_000);
  });
});
