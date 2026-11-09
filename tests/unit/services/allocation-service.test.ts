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
    return [];
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(handleQuery),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: handleQuery })
  ),
}));

import { fundGrantSelfActions } from "../../../src/services/allocation-service.js";

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
