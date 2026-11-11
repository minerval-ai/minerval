import { describe, it, expect, beforeEach, vi } from "vitest";

// A mandate paying for its own work (fundGrantSelfActions): planning,
// review passes, lookouts and planned ingests, within the day's room and
// the escrow's headroom, drawn down across one pass. DB mocked; the SQL
// runs live in the DB suite.

/** A self-funded action row as fundGrantSelfActions' query returns it. */
interface SelfActionRow {
  exclusion_group: string;
  action_id: string;
  claim_id: string | null;
  grant_id: string;
  kind?: string;
  cost_est?: number;
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
    // an escrow.
    committed: { shares: 0, outstanding: 0, nonledger: 0, regrants: 0 },
    selfActions: [] as SelfActionRow[],
    placed: [] as Array<{
      group: string;
      actionId: string | null;
      amount: number;
    }>,
    estimates: [] as Array<{ actionId: string; estimate: number }>,
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
    if (q.includes("INSERT INTO action_allocations")) {
      state.placed.push({
        group: params[0] as string,
        actionId: params[1] as string | null,
        amount: params[4] as number,
      });
      return [{ id: `al-${state.placed.length}` }];
    }
    if (q.includes("UPDATE actions SET cost_est_micro_usd")) {
      state.estimates.push({ actionId: params[0] as string, estimate: params[1] as number });
      return [];
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

import { fundGrantSelfActions, shortPassFunding } from "../../../src/services/allocation-service.js";

beforeEach(() => {
  state.grant = {
    daily_budget_micro_usd: 1_000_000,
    budget_micro_usd: 100_000_000,
    job_status: "running",
  };
  state.placedToday = 0;
  state.exposure = { spent: 0, outstanding: 0 };
  state.committed = { shares: 0, outstanding: 0, nonledger: 0, regrants: 0 };
  state.selfActions = [];
  state.placed = [];
  state.estimates = [];
});

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

  // #820: the Grantmaker's own pass starts short rather than not at all,
  // since it is the one thing that can fix what keeps it from running.
  it("starts a review pass with what the day has left, and lowers its estimate to that", async () => {
    state.selfActions = [
      selfRow({ kind: "mandate_review", cost_est: 5_000_000, needed: 5_000_000, day_room: 3_000_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(1);
    expect(state.placed).toEqual([{ group: "review:g1", actionId: "a-review", amount: 3_000_000 }]);
    expect(state.estimates).toEqual([{ actionId: "a-review", estimate: 3_000_000 }]);
  });

  it("starts a planning pass with what the escrow has left", async () => {
    state.selfActions = [
      selfRow({
        kind: "grant_planning", exclusion_group: "planning:g1", action_id: "a-plan",
        cost_est: 5_000_000, needed: 5_000_000, headroom: 2_000_000, day_room: null,
      }),
    ];
    expect(await fundGrantSelfActions()).toBe(1);
    expect(state.placed[0]!.amount).toBe(2_000_000);
    expect(state.estimates).toEqual([{ actionId: "a-plan", estimate: 2_000_000 }]);
  });

  it("leaves a pass waiting when less than the floor can be found", async () => {
    state.selfActions = [
      selfRow({ kind: "mandate_review", cost_est: 5_000_000, needed: 5_000_000, day_room: 400_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(0);
    expect(state.placed).toEqual([]);
    expect(state.estimates).toEqual([]);
  });

  it("funds other work whole or not at all", async () => {
    state.selfActions = [
      selfRow({ kind: "ingest", exclusion_group: "ingest:u1", cost_est: 5_000_000, needed: 5_000_000, day_room: 3_000_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(0);
  });

  it("leaves a fully funded pass's estimate alone", async () => {
    state.selfActions = [
      selfRow({ kind: "mandate_review", cost_est: 5_000_000, needed: 5_000_000, day_room: 9_000_000 }),
    ];
    expect(await fundGrantSelfActions()).toBe(1);
    expect(state.placed[0]!.amount).toBe(5_000_000);
    expect(state.estimates).toEqual([]);
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

describe("shortPassFunding", () => {
  const floorMicroUsd = 1_000_000;
  it("places the room there is when the pass would start at or above the floor", () => {
    expect(shortPassFunding({ costEstMicroUsd: 5_000_000, neededMicroUsd: 5_000_000, roomMicroUsd: 1_000_000, floorMicroUsd })).toBe(1_000_000);
  });
  it("counts what already backs the row toward the floor", () => {
    expect(shortPassFunding({ costEstMicroUsd: 5_000_000, neededMicroUsd: 4_200_000, roomMicroUsd: 300_000, floorMicroUsd })).toBe(300_000);
  });
  it("is null with no room, and below the floor", () => {
    expect(shortPassFunding({ costEstMicroUsd: 5_000_000, neededMicroUsd: 5_000_000, roomMicroUsd: 0, floorMicroUsd })).toBeNull();
    expect(shortPassFunding({ costEstMicroUsd: 5_000_000, neededMicroUsd: 5_000_000, roomMicroUsd: -10, floorMicroUsd })).toBeNull();
    expect(shortPassFunding({ costEstMicroUsd: 5_000_000, neededMicroUsd: 5_000_000, roomMicroUsd: 999_999, floorMicroUsd })).toBeNull();
  });
});
