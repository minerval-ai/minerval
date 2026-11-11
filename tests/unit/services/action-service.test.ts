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

const { state, handleQuery } = vi.hoisted(() => {
  const state = {
    runnable: [] as MockAction[],
    // Every live (unreleased, not fully spent) allocation on the group,
    // as the locked SELECT inside completeAction's transaction sees it.
    allocations: [] as Array<{
      id: string;
      user_id: string | null;
      claim_id: string | null;
      action_id: string | null;
      unspent: number;
    }>,
    refunds: [] as Array<{ userId: string; amount: number; key: string }>,
    consumed: [] as Array<{ id: string; take: number }>,
    releasedIds: [] as string[],
    superseded: [] as string[],
  };
  const handleQuery = async (q: string, params: unknown[] = []) => {
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
    if (q.includes("FOR UPDATE") && q.includes("action_allocations")) {
      return state.allocations;
    }
    if (q.includes("SET released_at = now()")) {
      state.releasedIds.push(params[0] as string);
      return [];
    }
    if (q.includes("INSERT INTO owl_ledger")) {
      state.refunds.push({
        userId: params[0] as string,
        amount: params[1] as number,
        key: params[3] as string,
      });
      return [{ id: "led-1" }];
    }
    if (q.includes("SET spent_micro_usd = spent_micro_usd + $2")) {
      state.consumed.push({ id: params[0] as string, take: params[1] as number });
      return [];
    }
    return [];
  };
  return { state, handleQuery };
});

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(handleQuery),
  withTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({ query: handleQuery })
  ),
}));

vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ stewardStrongModel: "", owlCostMicroUsd: 1_000_000 }),
}));

import {
  LABEL_ON_REOPEN_SQL,
  claimAction,
  ensureCurateAction,
  nextRunnableAction,
  completeAction,
} from "../../../src/services/action-service.js";
import { rawQuery } from "../../../src/db/client.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

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
  state.allocations = [];
  state.refunds = [];
  state.consumed = [];
  state.releasedIds = [];
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

// A row carries the label of the work that opened it, and the executor runs
// it at that label (src/labels.ts).
describe("the label on a ledger row", () => {
  const calls = () => vi.mocked(rawQuery).mock.calls as Array<[string, unknown[]?]>;
  beforeEach(() => {
    vi.mocked(rawQuery).mockClear();
  });

  it("is read with the row the executor is handed", async () => {
    await nextRunnableAction(["assess"]);
    expect(calls()[0]![0]).toContain("a.sensitivity_label");
  });

  it("is checked by the claim when the executor names the label it is about to run at", async () => {
    await claimAction("a1", "internal");
    expect(calls()[0]![0]).toContain("status = 'open' AND sensitivity_label = $2");
    expect(calls()[0]![1]).toEqual(["a1", "internal"]);
    // A caller that runs the row itself, in its own context, claims by id alone.
    await claimAction("a1");
    expect(calls()[1]![0]).not.toContain("sensitivity_label");
    expect(calls()[1]![1]).toEqual(["a1"]);
  });

  it("is the opening work's on a new row, and a reopened row's only once the row had finished", async () => {
    vi.mocked(rawQuery).mockResolvedValueOnce([{ text: "A claim" }]);
    await runWithUsageContext({ label: "internal" }, () => ensureCurateAction("c1"));
    const insert = calls().find(([q]) => q.includes("INSERT INTO actions"))!;
    expect(insert[0]).toContain("sensitivity_label)");
    expect(insert[0]).toContain(LABEL_ON_REOPEN_SQL);
    expect(insert[1]!.at(-1)).toBe("internal");
    // An open or running row keeps the label of the work already waiting on it.
    expect(LABEL_ON_REOPEN_SQL).toContain("WHEN actions.status IN ('open', 'running') THEN actions.sensitivity_label");
    expect(LABEL_ON_REOPEN_SQL).toContain("ELSE EXCLUDED.sensitivity_label");
  });
});

describe("completeAction", () => {
  it("supersedes siblings and refunds released user allocations", async () => {
    state.allocations = [
      // Pinned to a losing sibling: released, the person refunded.
      {
        id: "al-user",
        user_id: "u1",
        claim_id: "c1",
        action_id: "loser",
        unspent: 120_000,
      },
      {
        id: "al-grant",
        user_id: null,
        claim_id: "c1",
        action_id: "loser2",
        unspent: 300_000,
      },
    ];
    await completeAction("winner", 0);
    expect(state.superseded).toEqual(["assess:c1"]);
    expect(state.releasedIds).toEqual(["al-user", "al-grant"]);
    // The person's losing pinned allocation returns to their ledger,
    // idempotently; the mandate's simply drops from its exposure.
    expect(state.refunds).toEqual([
      { userId: "u1", amount: 120_000, key: "release:al-user" },
    ]);
  });

  it("consumes the metered cost pro rata across covering allocations", async () => {
    state.allocations = [
      { id: "al-1", user_id: null, claim_id: "c1", action_id: null, unspent: 100_000 },
      { id: "al-2", user_id: null, claim_id: "c1", action_id: null, unspent: 300_000 },
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
    state.allocations = [
      { id: "al-1", user_id: null, claim_id: "c1", action_id: null, unspent: 100_000 },
    ];
    const consumed = await completeAction("winner", 500_000);
    expect(consumed).toBe(100_000);
    // Fully spent: nothing to settle, the row stays as consumed history.
    expect(state.releasedIds).toEqual([]);
  });

  it("settles the covering remainders: a reader's overage refunds to their balance", async () => {
    // Estimates run high on purpose; without settlement the difference
    // would strand as outstanding exposure forever.
    state.allocations = [
      {
        id: "al-user",
        user_id: "u1",
        claim_id: "c1",
        action_id: null,
        unspent: 150_000,
      },
    ];
    await completeAction("winner", 90_000);
    expect(state.consumed).toEqual([{ id: "al-user", take: 90_000 }]);
    expect(state.releasedIds).toEqual(["al-user"]);
    expect(state.refunds).toEqual([
      { userId: "u1", amount: 60_000, key: "settle:al-user" },
    ]);
  });
});
