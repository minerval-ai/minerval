import { describe, it, expect, beforeEach, vi } from "vitest";

// The valuation layer's two writers: a formula mandate's bulk refresh (its
// own policy knobs, over its own scope — the platform's General mandate is
// the unscoped instance), and setMandateValuations — the agent valuer's pen,
// used by every judgment mandate's review pass.

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; params: unknown[] }>,
  state: {
    knownActionIds: new Set<string>(),
    /** Action ids of audits whose subject is the valuing mandate. */
    ownAudits: new Set<string>(),
    governance: [] as string[],
  },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    calls.push({ q, params });
    if (q.includes("FROM audit_runs ar") && q.includes("ar.subject_grant_id = $2")) {
      return state.ownAudits.has(params[0] as string) ? [{ id: "run" }] : [];
    }
    if (q.includes("INSERT INTO mandate_valuations")) {
      // The curate and audit formulas (#363): nothing open in these tests
      // unless a test says otherwise.
      if (q.includes("a.kind = 'curate'") || q.includes("a.kind = 'audit'")) {
        return [];
      }
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
  getGovernanceMandateIds: vi.fn(async () => state.governance),
  getMandateAllocationPolicy: vi.fn(async () => ({
    curate_candidate_weight: 0.5,
    curate_matcher_quiet_days: 7,
    audit_value_prize: 1,
    audit_value_bad_faith: 0.9,
    audit_value_overturn: 0.8,
    audit_value_anomaly: 0.6,
    audit_value_suspension: 0.5,
    audit_value_sweep: 0.3,
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
  refreshFormulaValuations,
  refreshAuditValuations,
  setMandateValuations,
} from "../../../src/services/mandate-valuer-service.js";

beforeEach(() => {
  calls.length = 0;
  state.knownActionIds = new Set();
  state.ownAudits = new Set();
  state.governance = [];
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
    // The platform lane is the UNSCOPED formula mandate: null scope on both
    // terms, which the query reads as "the whole graph".
    expect(upsert!.params).toEqual([0.25, 90, 0.15, 1.3, "g-general", null, null]);
    // The display cache is recomputed as the max across mandates.
    const mirror = calls.find((c) => c.q.includes("SET queue_priority = COALESCE"));
    expect(mirror).toBeDefined();
    expect(mirror!.q).toContain("MAX(mv.value_est)");
    expect(mirror!.q).toContain("a.variant = 'standard'");
    // Only assessment rows feed it: curation or an audit about a claim is
    // not a reason to reassess the claim sooner (#363).
    expect(mirror!.q).toContain("a.kind IN ('assess', 'reassess')");
  });

  it("prices the open curate rows with the same mandate's knobs (#363)", async () => {
    await refreshGeneralValuations();
    const curate = calls.find(
      (c) => c.q.includes("INSERT INTO mandate_valuations") && c.q.includes("a.kind = 'curate'")
    );
    expect(curate).toBeDefined();
    // candidate weight, quiet days, the valuing mandate, unscoped, all rows
    expect(curate!.params).toEqual([0.5, 7, "g-general", null, null, null]);
    // A claim the Matcher just admitted, with no agent asking, is worth
    // nothing to curate: the first live epoch's 122 empty sweeps.
    expect(curate!.q).toContain("r.source <> 'reconcile_candidate'");
    expect(curate!.q).toContain("THEN 0.0 ELSE 1.0 END");
  });
});

describe("refreshAuditValuations (#363)", () => {
  it("values nothing when no Governance mandate exists", async () => {
    expect(await refreshAuditValuations()).toBe(0);
    expect(calls.some((c) => c.q.includes("INSERT INTO mandate_valuations"))).toBe(false);
  });

  it("has Governance value audits, recusing itself, and General value only audits of Governance", async () => {
    state.governance = ["g-gov"];
    await refreshAuditValuations();
    const writes = calls.filter(
      (c) => c.q.includes("INSERT INTO mandate_valuations") && c.q.includes("a.kind = 'audit'")
    );
    expect(writes).toHaveLength(2);
    // Recusal and the prize carve-out ride in the SQL for every valuer.
    for (const w of writes) {
      expect(w.q).toContain("ar.subject_grant_id IS DISTINCT FROM $7");
      expect(w.q).toContain("ar.bounty_id IS NULL");
    }
    const [gov, general] = writes;
    expect(gov!.params.slice(6, 10)).toEqual(["g-gov", false, ["g-gov"], null]);
    expect(general!.params.slice(6, 10)).toEqual(["g-general", true, ["g-gov"], null]);
    // Class weights in policy order: prize, bad faith, overturn, anomaly,
    // suspension, sweep.
    expect(gov!.params.slice(0, 6)).toEqual([1, 0.9, 0.8, 0.6, 0.5, 0.3]);
  });
});

/**
 * The formula is a KIND of mandate, not one privileged row. A second
 * formula mandate values its own scope from its own knobs; the platform's
 * General assessment is simply the instance whose scope is null.
 */
describe("refreshFormulaValuations (the formula generalised)", () => {
  it("values only what a scoped mandate's scope covers", async () => {
    await refreshFormulaValuations("g-topical", {
      scopeClaimId: "c-root",
      scopeQuery: "mathematics OR theorem",
    });
    const upsert = calls.find((c) =>
      c.q.includes("INSERT INTO mandate_valuations")
    );
    expect(upsert!.params).toEqual([
      0.25, 90, 0.15, 1.3, "g-topical", "c-root", "mathematics OR theorem",
    ]);
    // Subtree OR keyword, the same disjunction surveyScope resolves.
    expect(upsert!.q).toContain("c.id IN (SELECT id FROM subtree)");
    expect(upsert!.q).toContain("websearch_to_tsquery('english', $7)");
  });

  it("does not touch the display cache: that is the platform lane's mirror", async () => {
    await refreshFormulaValuations("g-topical", {
      scopeClaimId: "c-root",
      scopeQuery: null,
    });
    expect(calls.some((c) => c.q.includes("SET queue_priority"))).toBe(false);
  });

  it("prunes judgments about actions that have closed", async () => {
    await refreshFormulaValuations("g-topical", {
      scopeClaimId: null,
      scopeQuery: "ai",
    });
    const prune = calls.find((c) =>
      c.q.includes("DELETE FROM mandate_valuations")
    );
    expect(prune).toBeDefined();
    expect(prune!.params).toEqual(["g-topical"]);
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

  it("refuses to value an audit whose subject is the valuing mandate (#363)", async () => {
    state.knownActionIds = new Set(["a-audit", "a-other"]);
    state.ownAudits = new Set(["a-audit"]);
    const res = await setMandateValuations("g-math", [
      { action_id: "a-audit", value: 0, rationale: "decline my own audit" },
      { action_id: "a-other", value: 3 },
    ]);
    expect(res.written).toBe(1);
    expect(res.recusedActionIds).toEqual(["a-audit"]);
    expect(
      calls.some(
        (c) => c.q.includes("INSERT INTO mandate_valuations") && c.params[1] === "a-audit"
      )
    ).toBe(false);
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
