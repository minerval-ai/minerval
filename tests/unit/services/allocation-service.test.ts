import { describe, it, expect, beforeEach, vi } from "vitest";

// The mandate allocator's judgment-to-money translation: marginal
// increments (cover the standard sibling; upgrade to the strong one only
// when Δvalue/Δcost also clears), best-first funding under the daily rate
// and escrow headroom, co-funding (cost minus existing backing), and the
// emergent bar. DB mocked; the SQL runs live in the preview harness.

interface ValuedRow {
  action_id: string;
  exclusion_group: string;
  variant: string;
  claim_id: string | null;
  cost_est_micro_usd: number;
  value_est: number;
  pinned: number;
  unpinned: number;
}

const { state } = vi.hoisted(() => ({
  state: {
    grant: {
      daily_budget_micro_usd: 1_000_000,
      budget_micro_usd: 100_000_000,
      job_status: "running",
    } as Record<string, unknown> | null,
    placedToday: 0,
    exposure: { spent: 0, outstanding: 0 },
    valued: [] as ValuedRow[],
    placed: [] as Array<{
      group: string;
      actionId: string | null;
      amount: number;
    }>,
  },
}));

const { handleQuery } = vi.hoisted(() => ({
  handleQuery: async (q: string, params: unknown[] = []) => {
    if (q.includes("pg_advisory_xact_lock")) {
      return [];
    }
    if (q.includes("FROM grants g JOIN budget_jobs")) {
      return state.grant ? [state.grant] : [];
    }
    if (q.includes("created_at >= date_trunc('day', now())")) {
      return [{ placed: state.placedToday }];
    }
    if (q.includes("FILTER (WHERE released_at IS NULL)")) {
      return [state.exposure];
    }
    if (q.includes("FROM mandate_valuations mv")) {
      return state.valued;
    }
    if (q.includes("INSERT INTO action_allocations")) {
      state.placed.push({
        group: params[0] as string,
        actionId: params[1] as string | null,
        amount: params[4] as number,
      });
      return [{ id: `al-${state.placed.length}` }];
    }
    return [];
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(handleQuery),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: handleQuery })
  ),
}));

import { runMandateAllocator } from "../../../src/services/allocation-service.js";

const row = (over: Partial<ValuedRow>): ValuedRow => ({
  action_id: "a-std",
  exclusion_group: "assess:c1",
  variant: "standard",
  claim_id: "c1",
  cost_est_micro_usd: 150_000,
  value_est: 0.9,
  pinned: 0,
  unpinned: 0,
  ...over,
});

beforeEach(() => {
  state.grant = {
    daily_budget_micro_usd: 1_000_000,
    budget_micro_usd: 100_000_000,
    job_status: "running",
  };
  state.placedToday = 0;
  state.exposure = { spent: 0, outstanding: 0 };
  state.valued = [];
  state.placed = [];
});

describe("runMandateAllocator (marginal increments)", () => {
  it("covers the base variant unpinned, best value-per-cost first", async () => {
    state.valued = [
      row({ action_id: "low", exclusion_group: "assess:c2", claim_id: "c2", value_est: 0.2 }),
      row({ action_id: "high", value_est: 0.9 }),
    ];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(2);
    expect(state.placed[0]).toEqual({
      group: "assess:c1",
      actionId: null,
      amount: 150_000,
    });
    // The bar is the LAST (weakest) increment funded.
    expect(r.thresholdRatio).toBeCloseTo(0.2 / 150_000, 10);
  });

  it("funds the strong upgrade pinned, only after the base and only on its marginal return", async () => {
    state.valued = [
      row({ action_id: "std", value_est: 1.0 }),
      row({
        action_id: "strong",
        variant: "strong",
        cost_est_micro_usd: 900_000,
        value_est: 4.0, // Δv=3.0 over Δc=750k clears; both increments fund
      }),
    ];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(2);
    expect(state.placed).toEqual([
      { group: "assess:c1", actionId: null, amount: 150_000 },
      { group: "assess:c1", actionId: "strong", amount: 750_000 },
    ]);
  });

  it("skips an upgrade whose marginal gain is nothing", async () => {
    state.valued = [
      row({ action_id: "std", value_est: 1.0 }),
      row({
        action_id: "strong",
        variant: "strong",
        cost_est_micro_usd: 900_000,
        value_est: 1.0, // no Δvalue: the dearer way adds nothing
      }),
    ];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(1);
    expect(state.placed).toEqual([
      { group: "assess:c1", actionId: null, amount: 150_000 },
    ]);
  });

  it("co-funds: allocates cost minus existing backing, never duplicating", async () => {
    state.valued = [row({ unpinned: 100_000 })];
    await runMandateAllocator("g1");
    expect(state.placed).toEqual([
      { group: "assess:c1", actionId: null, amount: 50_000 },
    ]);
  });

  it("places nothing on an already-covered group", async () => {
    state.valued = [row({ unpinned: 150_000 })];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(0);
  });

  it("stops at the daily rate, counting what today already placed", async () => {
    state.placedToday = 900_000; // 100k of the 1M rate remains
    state.valued = [
      row({ value_est: 0.9 }), // needs 150k: does not fit
      row({
        action_id: "cheap",
        exclusion_group: "assess:c3",
        claim_id: "c3",
        cost_est_micro_usd: 80_000,
        value_est: 0.1, // needs 80k: fits
      }),
    ];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(1);
    expect(state.placed[0]!.group).toBe("assess:c3");
  });

  it("never promises money the escrow does not hold", async () => {
    state.exposure = { spent: 60_000_000, outstanding: 39_950_000 }; // 50k headroom
    state.valued = [row({})];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(0);
  });

  it("does nothing for a paused or missing mandate", async () => {
    state.grant = null;
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(0);
  });
});
