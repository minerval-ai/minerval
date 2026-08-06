import { describe, it, expect, beforeEach, vi } from "vitest";

// Escrow settlement accounting (refundUnspentBudget): a grant-backed job
// spends through the action ledger (pro-rata shares) plus non-ledger
// metering, regrants still out are NOT refundable, outstanding allocations
// release before the refund is computed, and a returning regrant share
// STAMPS the source (restoring headroom) without also crediting its budget
// — the double-credit that used to mint money on A→B→A round trips.

const { state, handleQuery } = vi.hoisted(() => {
  const state = {
    grantForJob: null as null | { id: string },
    releasedAllocations: [] as unknown[][],
    accounting: { shares: 0, nonledger: 0, regrants: 0 },
    llmSpent: 0,
    contributions: [] as Array<{ user_id: string; held: number }>,
    regrantsIn: [] as Array<{ id: string; from_grant_id: string; amount: number }>,
    stamps: [] as Array<{ regrantId: string; amount: number }>,
    stampAccepted: true,
    sourceLive: true,
    sourceFunder: "funder-src",
    budgetCredits: [] as unknown[][],
  };
  const handleQuery = async (q: string, params: unknown[] = []) => {
    if (q.includes("SELECT id FROM grants WHERE budget_job_id")) {
      return state.grantForJob ? [state.grantForJob] : [];
    }
    if (q.includes("UPDATE action_allocations SET released_at")) {
      state.releasedAllocations.push(params);
      return [];
    }
    if (q.includes("AS nonledger")) {
      return [state.accounting];
    }
    if (q.includes("FROM llm_usage WHERE job_id")) {
      return [{ total: state.llmSpent }];
    }
    if (q.includes("reason = 'escrow_hold'")) {
      return state.contributions.map((c) => ({ user_id: c.user_id, held: c.held }));
    }
    if (q.includes("JOIN grants g ON g.id = r.to_grant_id")) {
      return state.regrantsIn;
    }
    if (q.includes("UPDATE regrants")) {
      if (!state.stampAccepted) return [];
      state.stamps.push({
        regrantId: params[0] as string,
        amount: params[1] as number,
      });
      return [{ id: params[0] }];
    }
    if (q.includes("UPDATE budget_jobs") && q.includes("budget_micro_usd + $2")) {
      state.budgetCredits.push(params);
      return [{ id: "job-x" }];
    }
    if (q.includes("g.status IN ('planning', 'pending_approval', 'active')")) {
      return state.sourceLive ? [{ id: params[0] }] : [];
    }
    if (q.includes("SELECT funder_user_id FROM grants")) {
      return [{ funder_user_id: state.sourceFunder }];
    }
    return [];
  };
  return { state, handleQuery };
});

const { ledger } = vi.hoisted(() => ({
  ledger: [] as Array<{ userId: string; amountMicroUsd: number; key: string | null }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(handleQuery),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: handleQuery })
  ),
  getDb: () => {
    throw new Error("these tests exercise rawQuery paths only");
  },
}));

vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  OWL_REASONS: { escrowRefund: "escrow_refund", escrowHold: "escrow_hold" },
  recordOwlEntry: vi.fn(
    async (input: {
      userId: string;
      amountMicroUsd: number;
      idempotencyKey?: string | null;
    }) => {
      ledger.push({
        userId: input.userId,
        amountMicroUsd: input.amountMicroUsd,
        key: input.idempotencyKey ?? null,
      });
      return true;
    }
  ),
}));

import { refundUnspentBudget } from "../../../src/services/budget-job-service.js";

beforeEach(() => {
  state.grantForJob = null;
  state.releasedAllocations = [];
  state.accounting = { shares: 0, nonledger: 0, regrants: 0 };
  state.llmSpent = 0;
  state.contributions = [];
  state.regrantsIn = [];
  state.stamps = [];
  state.stampAccepted = true;
  state.sourceLive = true;
  state.budgetCredits = [];
  ledger.length = 0;
});

describe("refundUnspentBudget", () => {
  it("plain job: refunds budget minus metered llm_usage to the contributor", async () => {
    state.llmSpent = 3_000_000;
    state.contributions = [{ user_id: "u-1", held: 10_000_000 }];
    const refunded = await refundUnspentBudget({
      id: "job-1",
      userId: "u-1",
      budgetMicroUsd: 10_000_000,
    });
    expect(refunded).toBe(7_000_000);
    expect(ledger).toEqual([
      { userId: "u-1", amountMicroUsd: 7_000_000, key: "escrow_refund:job-1:u-1" },
    ]);
  });

  it("grant job: spends via ledger shares + non-ledger metering, holds back regrants out", async () => {
    state.grantForJob = { id: "g-1" };
    // 10 budget: 2 consumed shares + 1 conversation metering + 3 regranted
    // out (still in the target) → 4 refundable.
    state.accounting = { shares: 2_000_000, nonledger: 1_000_000, regrants: 3_000_000 };
    state.contributions = [{ user_id: "u-1", held: 10_000_000 }];
    const refunded = await refundUnspentBudget({
      id: "job-1",
      userId: "u-1",
      budgetMicroUsd: 10_000_000,
    });
    // Outstanding allocations released BEFORE the refund is computed.
    expect(state.releasedAllocations).toEqual([["g-1"]]);
    expect(refunded).toBe(4_000_000);
    expect(ledger[0]).toMatchObject({ userId: "u-1", amountMicroUsd: 4_000_000 });
  });

  it("returning regrant share: stamps the live source, never credits its budget too", async () => {
    // The target settles with 5 unspent; its only funder is a 5-owl regrant.
    state.regrantsIn = [{ id: "rg-1", from_grant_id: "g-src", amount: 5_000_000 }];
    const refunded = await refundUnspentBudget({
      id: "job-t",
      userId: "owner-t",
      budgetMicroUsd: 5_000_000,
    });
    expect(refunded).toBe(5_000_000);
    expect(state.stamps).toEqual([{ regrantId: "rg-1", amount: 5_000_000 }]);
    // The source's budget was never debited at regrant time; the stamp
    // alone restores its headroom. A budget credit here would mint ~2x.
    expect(state.budgetCredits).toEqual([]);
    // Live source → no direct owl credit either.
    expect(ledger).toEqual([]);
  });

  it("returning regrant share to a DEAD source credits its funder's owls", async () => {
    state.regrantsIn = [{ id: "rg-1", from_grant_id: "g-src", amount: 5_000_000 }];
    state.sourceLive = false;
    const refunded = await refundUnspentBudget({
      id: "job-t",
      userId: "owner-t",
      budgetMicroUsd: 5_000_000,
    });
    expect(refunded).toBe(5_000_000);
    expect(ledger).toEqual([
      {
        userId: "funder-src",
        amountMicroUsd: 5_000_000,
        key: "escrow_refund:job-t:regrant:rg-1",
      },
    ]);
  });

  it("an already-stamped regrant share is not paid twice", async () => {
    state.regrantsIn = [{ id: "rg-1", from_grant_id: "g-src", amount: 5_000_000 }];
    state.stampAccepted = false; // refunded_micro_usd already at amount
    state.sourceLive = false;
    const refunded = await refundUnspentBudget({
      id: "job-t",
      userId: "owner-t",
      budgetMicroUsd: 5_000_000,
    });
    expect(refunded).toBe(0);
    expect(ledger).toEqual([]);
  });
});
