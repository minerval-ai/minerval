import { describe, it, expect, beforeEach, vi } from "vitest";

// The action ledger's mechanical rules, as JS control flow over a mocked
// DB: exclusion-group resolution (most backing wins, tie → cheapest),
// completion (losing pinned allocations released with user refunds, the
// metered cost consumed pro rata from the winner's covering allocations).
// The SQL itself runs live in the preview/corpus harness.

interface MockAction {
  id: string;
  kind: string;
  exclusion_group: string;
  variant: string;
  claim_id: string | null;
  target_ref: string | null;
  cost_est_micro_usd: number;
  coverage_micro_usd: number;
}

const { state } = vi.hoisted(() => ({
  state: {
    runnable: [] as MockAction[],
    released: [] as Array<{
      id: string;
      user_id: string | null;
      claim_id: string | null;
      remainder: number;
    }>,
    covering: [] as Array<{ id: string; unspent: number }>,
    refunds: [] as Array<{ userId: string; amount: number; key: string }>,
    consumed: [] as Array<{ id: string; take: number }>,
    superseded: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    if (q.includes("coverage_micro_usd") && q.includes("FROM actions a")) {
      return state.runnable;
    }
    if (q.includes("UPDATE actions") && q.includes("metered_cost_micro_usd = $2")) {
      return [{ id: params[0], exclusion_group: "assess:c1" }];
    }
    if (q.includes("'superseded'")) {
      state.superseded.push(params[0] as string);
      return [];
    }
    if (q.includes("SET released_at = now()")) {
      return state.released;
    }
    if (q.includes("INSERT INTO owl_ledger")) {
      state.refunds.push({
        userId: params[0] as string,
        amount: params[1] as number,
        key: params[3] as string,
      });
      return [{ id: "led-1" }];
    }
    if (q.includes("FOR UPDATE SKIP LOCKED") && q.includes("action_allocations")) {
      return state.covering;
    }
    if (q.includes("SET spent_micro_usd = spent_micro_usd + $2")) {
      state.consumed.push({ id: params[0] as string, take: params[1] as number });
      return [];
    }
    return [];
  }),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardStrongModel: "", owlCostMicroUsd: 1_000_000 }),
}));

import {
  nextRunnableAction,
  completeAction,
} from "../../../src/services/action-service.js";

const act = (over: Partial<MockAction>): MockAction => ({
  id: "a1",
  kind: "assess",
  exclusion_group: "assess:c1",
  variant: "standard",
  claim_id: "c1",
  target_ref: null,
  cost_est_micro_usd: 150_000,
  coverage_micro_usd: 150_000,
  ...over,
});

beforeEach(() => {
  state.runnable = [];
  state.released = [];
  state.covering = [];
  state.refunds = [];
  state.consumed = [];
  state.superseded = [];
});

describe("nextRunnableAction (exclusion-group resolution)", () => {
  it("returns null when nothing is covered", async () => {
    expect(await nextRunnableAction(["assess"])).toBeNull();
  });

  it("the most-backed sibling wins within a group", async () => {
    state.runnable = [
      act({ id: "std", coverage_micro_usd: 200_000 }),
      act({
        id: "strong",
        variant: "strong",
        cost_est_micro_usd: 900_000,
        coverage_micro_usd: 950_000,
      }),
    ];
    const winner = await nextRunnableAction(["assess"]);
    expect(winner?.id).toBe("strong");
  });

  it("backing ties resolve to the cheapest sibling", async () => {
    state.runnable = [
      act({
        id: "strong",
        variant: "strong",
        cost_est_micro_usd: 900_000,
        coverage_micro_usd: 900_000,
      }),
      act({ id: "std", coverage_micro_usd: 900_000 }),
    ];
    const winner = await nextRunnableAction(["assess"]);
    expect(winner?.id).toBe("std");
  });

  it("across groups, the most-backed winner runs first", async () => {
    state.runnable = [
      act({ id: "g1", coverage_micro_usd: 150_000 }),
      act({
        id: "g2",
        exclusion_group: "assess:c2",
        claim_id: "c2",
        coverage_micro_usd: 400_000,
      }),
    ];
    const winner = await nextRunnableAction(["assess"]);
    expect(winner?.id).toBe("g2");
  });
});

describe("completeAction", () => {
  it("supersedes siblings and refunds released user allocations", async () => {
    state.released = [
      { id: "al-user", user_id: "u1", claim_id: "c1", remainder: 120_000 },
      { id: "al-grant", user_id: null, claim_id: "c1", remainder: 300_000 },
    ];
    await completeAction("winner", 0);
    expect(state.superseded).toEqual(["assess:c1"]);
    // The person's losing pinned allocation returns to their ledger,
    // idempotently; the mandate's simply drops from its exposure.
    expect(state.refunds).toEqual([
      { userId: "u1", amount: 120_000, key: "release:al-user" },
    ]);
  });

  it("consumes the metered cost pro rata across covering allocations", async () => {
    state.covering = [
      { id: "al-1", unspent: 100_000 },
      { id: "al-2", unspent: 300_000 },
    ];
    const consumed = await completeAction("winner", 200_000);
    expect(consumed).toBe(200_000);
    // 1/4 and 3/4 of the pot: each funder pays their share, never more.
    expect(state.consumed).toEqual([
      { id: "al-1", take: 50_000 },
      { id: "al-2", take: 150_000 },
    ]);
  });

  it("caps consumption at the pot; overage is absorbed by the platform", async () => {
    state.covering = [{ id: "al-1", unspent: 100_000 }];
    const consumed = await completeAction("winner", 500_000);
    expect(consumed).toBe(100_000);
  });
});
