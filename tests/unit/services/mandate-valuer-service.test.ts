import { describe, it, expect, beforeEach, vi } from "vitest";

// The valuation layer's two writers: the General mandate's bulk formula
// refresh (its scope genuinely is the whole graph and its formula is its
// published policy), and setMandateValuations — the agent valuer's pen,
// used by every other mandate's review pass with its own judgment.

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; params: unknown[] }>,
  state: {
    knownActionIds: new Set<string>(),
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    calls.push({ q, params });
    if (q.includes("INSERT INTO mandate_valuations")) {
      if (q.includes("WHERE a.id = $2")) {
        // setMandateValuations single-action upsert: known ids only.
        return state.knownActionIds.has(params[1] as string)
          ? [{ action_id: params[1] }]
          : [];
      }
      // The General bulk refresh.
      return [{ action_id: "a-1" }, { action_id: "a-2" }];
    }
    return [];
  }),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getGeneralMandate: vi.fn(async () => ({ grantId: "g-general" })),
  getEffectiveAllocationPolicy: vi.fn(async () => ({
    contestation_floor: 0.25,
    staleness_saturation_days: 90,
    user_provenance_boost: 0.15,
    strong_gain_multiplier: 1.3,
    est_steward_run_cost_owls: 0.15,
    est_steward_run_cost_strong_owls: 0.9,
    staleness_base_days: 60,
    staleness_max_per_sweep: 5,
  })),
}));

import {
  refreshGeneralValuations,
  setMandateValuations,
} from "../../../src/services/mandate-valuer-service.js";

beforeEach(() => {
  calls.length = 0;
  state.knownActionIds = new Set();
});

describe("refreshGeneralValuations", () => {
  it("bulk-writes the formula over open actions, strong variants multiplied", async () => {
    const n = await refreshGeneralValuations();
    expect(n).toBe(2);
    const upsert = calls.find((c) =>
      c.q.includes("INSERT INTO mandate_valuations")
    );
    expect(upsert).toBeDefined();
    // The published formula's knobs ride as parameters, in policy order.
    expect(upsert!.q).toContain("WHEN a.variant = 'strong' THEN $4");
    expect(upsert!.params).toEqual([0.25, 90, 0.15, 1.3, "g-general"]);
    // The queue_priority display cache mirrors the standard-variant value.
    const mirror = calls.find((c) =>
      c.q.includes("SET queue_priority = mv.value_est")
    );
    expect(mirror).toBeDefined();
    expect(mirror!.q).toContain("a.variant = 'standard'");
  });
});

describe("setMandateValuations (the agent valuer's pen)", () => {
  it("writes known actions, clamps values, reports unknown ids", async () => {
    state.knownActionIds = new Set(["a-1"]);
    const res = await setMandateValuations("g-math", [
      { action_id: "a-1", value: 42, rationale: "central to the field" },
      { action_id: "a-ghost", value: 1 },
    ]);
    expect(res.written).toBe(1);
    expect(res.unknownActionIds).toEqual(["a-ghost"]);
    const write = calls.find(
      (c) =>
        c.q.includes("INSERT INTO mandate_valuations") &&
        c.params[1] === "a-1"
    );
    // 42 clamps to the framework's ceiling of 10.
    expect(write!.params[2]).toBe(10);
    expect(write!.params[3]).toBe("central to the field");
  });

  it("prunes judgments about closed actions after writing", async () => {
    await setMandateValuations("g-math", []);
    expect(
      calls.some(
        (c) =>
          c.q.includes("DELETE FROM mandate_valuations") &&
          c.q.includes("a.status <> 'open'")
      )
    ).toBe(true);
  });
});
