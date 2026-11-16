import { beforeEach, describe, expect, it, vi } from "vitest";

const state: { row: Record<string, unknown> | null; queries: Array<{ q: string; params: unknown[] }> } = {
  row: null,
  queries: [],
};

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    state.queries.push({ q, params });
    return state.row ? [state.row] : [];
  }),
}));

import { lookoutWindow, lookoutWindowRefusal, lookoutWindowSentence } from "../../../src/services/lookout-window.js";

beforeEach(() => {
  state.row = null;
  state.queries = [];
});

describe("a lookout's commission window (#1043)", () => {
  it("reads what the lookout's own allocations hold in its window, across labels, as a pace window counts", async () => {
    state.row = { window_micro_usd: "8000000", hours: 24, used: "6500000" };
    const w = await lookoutWindow("l-1");
    expect(w).toEqual({ windowMicroUsd: 8_000_000, hours: 24, usedMicroUsd: 6_500_000, leftMicroUsd: 1_500_000 });
    const q = state.queries[0]!.q;
    // The whole-money view, so allocations at every label count.
    expect(q).toContain("minerval_whole.allocation_money");
    expect(q).toContain("al.lookout_id = l.id");
    // Amount while live, spend once settled: allocationDayUseSql.
    expect(q).toContain("CASE WHEN al.released_at IS NULL THEN al.amount_micro_usd ELSE al.spent_micro_usd END");
    expect(q).toContain("make_interval(hours => l.commission_window_hours)");
  });

  it("leaves no bound with no window, and never reports less than nothing left", async () => {
    state.row = { window_micro_usd: "0", hours: 24, used: "4000000" };
    expect((await lookoutWindow("l-1"))!.leftMicroUsd).toBe(Number.POSITIVE_INFINITY);
    state.row = { window_micro_usd: "3000000", hours: 12, used: "4000000" };
    expect((await lookoutWindow("l-1"))!.leftMicroUsd).toBe(0);
    state.row = null;
    expect(await lookoutWindow("l-1")).toBeNull();
  });

  it("states the window with its running state, and a refusal with the figures and where the item goes", () => {
    const w = { windowMicroUsd: 8_000_000, hours: 24, usedMicroUsd: 6_500_000, leftMicroUsd: 1_500_000 };
    expect(lookoutWindowSentence(w)).toContain("hold 6.5 of your 8 owls for any 24 hours (1.5 left)");
    const refusal = lookoutWindowRefusal(w, 3_000_000);
    expect(refusal).toContain("A budget of 3 owls");
    expect(refusal).toContain("1.5 of 8 owls for any 24 hours");
    expect(refusal).toContain("program officers");
    expect(lookoutWindowSentence({ ...w, windowMicroUsd: 0 })).toBe("");
  });
});
