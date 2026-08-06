import { describe, it, expect, beforeEach, vi } from "vitest";

// Valuer scoping: a mandate values only the actions it knows and cares
// about. The General mandate values the whole graph; a scoped mandate's
// upsert is restricted to its scope; a mandate with no basis for judgment
// (no scope, not 'general') writes nothing at all.

const { calls } = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; params: unknown[] }>,
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    calls.push({ q, params });
    return [];
  }),
}));

vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getMandateAllocationPolicy: vi.fn(async () => ({
    contestation_floor: 0.25,
    staleness_saturation_days: 90,
    user_provenance_boost: 0.15,
    strong_gain_multiplier: 1.3,
    est_steward_run_cost_owls: 0.15,
    est_steward_run_cost_strong_owls: 0.9,
    staleness_base_days: 60,
    staleness_max_per_sweep: 5,
  })),
  getGeneralMandate: vi.fn(async () => null),
}));

import { refreshMandateValuations } from "../../../src/services/mandate-valuer-service.js";

beforeEach(() => {
  calls.length = 0;
});

describe("refreshMandateValuations", () => {
  it("a mandate with no scope and no general policy values nothing", async () => {
    const n = await refreshMandateValuations({
      id: "g1",
      policy: "cover",
      scope_claim_id: null,
      scope_query: null,
    });
    expect(n).toBe(0);
    expect(calls.length).toBe(0); // not even a query: no basis for judgment
  });

  it("a scoped mandate's upsert is restricted to its scope", async () => {
    await refreshMandateValuations({
      id: "g1",
      policy: "cover",
      scope_claim_id: null,
      scope_query: "mathematics theorem",
    });
    const upsert = calls.find((c) => c.q.includes("INSERT INTO mandate_valuations"));
    expect(upsert).toBeDefined();
    expect(upsert!.q).toContain("c.id IN (SELECT id FROM scope)");
    expect(upsert!.params[1]).toBe("mathematics theorem");
  });

  it("the General mandate values the whole graph, strong variants multiplied", async () => {
    await refreshMandateValuations({
      id: "g-general",
      policy: "general",
      scope_claim_id: null,
      scope_query: null,
    });
    const upsert = calls.find((c) => c.q.includes("INSERT INTO mandate_valuations"));
    expect(upsert).toBeDefined();
    expect(upsert!.q).not.toContain("c.id IN (SELECT id FROM scope)");
    // The strong-variant multiplier rides in the same statement.
    expect(upsert!.q).toContain("WHEN a.variant = 'strong' THEN $6");
    expect(upsert!.params[5]).toBe(1.3);
  });
});
