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

/** A self-funded action row as fundGrantSelfActions' query returns it. */
interface SelfActionRow {
  exclusion_group: string;
  action_id: string;
  claim_id: string | null;
  grant_id: string;
  needed: number;
  headroom: number;
  day_room: number | null;
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
    // What grantCommittedMicroUsd reports: the four terms that are gone from
    // an escrow. The allocator subtracts all four (it used to see only the
    // first two, and would re-promise regranted money).
    committed: { shares: 0, outstanding: 0, nonledger: 0, regrants: 0 },
    valued: [] as ValuedRow[],
    selfActions: [] as SelfActionRow[],
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
    // Must precede the date_trunc branch: the self-actions query counts
    // today's allocations too, so it would otherwise match that one.
    if (q.includes("AS day_room")) {
      return state.selfActions;
    }
    if (q.includes("created_at >= date_trunc('day'")) {
      return [{ placed: state.placedToday }];
    }
    if (q.includes("AS nonledger")) {
      return [state.committed];
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

import {
  runMandateAllocator,
  fundGrantSelfActions,
} from "../../../src/services/allocation-service.js";

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
  state.committed = { shares: 0, outstanding: 0, nonledger: 0, regrants: 0 };
  state.valued = [];
  state.selfActions = [];
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
    // 50k headroom against a 150k need.
    state.committed = {
      shares: 60_000_000,
      outstanding: 39_950_000,
      nonledger: 0,
      regrants: 0,
    };
    state.valued = [row({})];
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(0);
  });

  it("counts money regranted away: it is gone from the escrow", async () => {
    // The old accounting saw allocation exposure only, so a mandate that had
    // regranted almost its whole escrow to a peer still looked solvent and
    // the allocator promised the same owls twice.
    state.committed = {
      shares: 0,
      outstanding: 0,
      nonledger: 0,
      regrants: 99_950_000,
    };
    state.valued = [row({})];
    expect((await runMandateAllocator("g1")).allocated).toBe(0);
  });

  it("counts metered spend that never passed through an allocation", async () => {
    state.committed = {
      shares: 0,
      outstanding: 0,
      nonledger: 99_950_000,
      regrants: 0,
    };
    state.valued = [row({})];
    expect((await runMandateAllocator("g1")).allocated).toBe(0);
  });

  it("does nothing for a paused or missing mandate", async () => {
    state.grant = null;
    const r = await runMandateAllocator("g1");
    expect(r.allocated).toBe(0);
  });
});

/**
 * Self-funded work (grant_planning, mandate_review, a plan's ingest items)
 * draws on the mandate's DAILY RATE, not on room beside it. It always cost
 * the mandate its rate on the spending side — runMandateAllocator counts
 * every allocation placed today, self-funded ones included — but the
 * funding side used to check escrow headroom only, so a day of chained
 * review passes could commit the rate and leave the substantive allocator
 * with no room to assess anything.
 */
describe("fundGrantSelfActions (deliberation pays its own way)", () => {
  const selfRow = (over: Partial<SelfActionRow> = {}): SelfActionRow => ({
    exclusion_group: "review:g1",
    action_id: "a-review",
    claim_id: null,
    grant_id: "g1",
    needed: 150_000,
    headroom: 100_000_000,
    day_room: 1_000_000,
    ...over,
  });

  it("funds a self-action that fits the day's remaining room", async () => {
    state.selfActions = [selfRow()];
    expect(await fundGrantSelfActions()).toBe(1);
    expect(state.placed).toEqual([
      { group: "review:g1", actionId: "a-review", amount: 150_000 },
    ]);
  });

  it("skips a pass the day's rate can no longer afford", async () => {
    state.selfActions = [selfRow({ needed: 150_000, day_room: 40_000 })];
    expect(await fundGrantSelfActions()).toBe(0);
    expect(state.placed).toEqual([]);
  });

  it("draws the shared room down across several self-actions in one pass", async () => {
    // One query, one snapshot of day_room: without per-pass drawdown each of
    // these three 150k rows sees the full 300k and all three get funded —
    // 450k against a 300k rate. Only the first two fit.
    state.selfActions = [
      selfRow({ exclusion_group: "review:g1", action_id: "a1", day_room: 300_000 }),
      selfRow({ exclusion_group: "ingest:u2", action_id: "a2", day_room: 300_000 }),
      selfRow({ exclusion_group: "ingest:u3", action_id: "a3", day_room: 300_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(2);
    expect(state.placed.map((p) => p.actionId)).toEqual(["a1", "a2"]);
  });

  it("draws escrow headroom down the same way", async () => {
    state.selfActions = [
      selfRow({ action_id: "a1", headroom: 250_000, day_room: null }),
      selfRow({ exclusion_group: "ingest:u2", action_id: "a2", headroom: 250_000, day_room: null }),
    ];
    expect(await fundGrantSelfActions()).toBe(1);
    expect(state.placed.map((p) => p.actionId)).toEqual(["a1"]);
  });

  it("leaves an unpaced mandate (no daily rate) bounded by escrow alone", async () => {
    state.selfActions = [selfRow({ needed: 9_000_000, day_room: null })];
    expect(await fundGrantSelfActions()).toBe(1);
  });

  it("does not let one grant's drawdown bound another's", async () => {
    state.selfActions = [
      selfRow({ grant_id: "g1", action_id: "a1", day_room: 150_000 }),
      selfRow({ grant_id: "g2", action_id: "a2", exclusion_group: "review:g2", day_room: 150_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(2);
  });
});
