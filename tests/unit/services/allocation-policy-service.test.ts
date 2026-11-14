import { describe, it, expect, beforeEach, vi } from "vitest";

// The allocation policy's framework: every knob bounded, unknown keys
// refused, and a stored policy from before a key existed reading back with
// the shipped default filled in. The mathematics keys (docs/mathematics.md
// §10.5) join the framework here.

const { calls, state } = vi.hoisted(() => ({
  calls: [] as Array<{ q: string; params: unknown[] }>,
  state: { stored: null as Record<string, unknown> | null },
}));

vi.mock("../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (q: string, params: unknown[] = []) => {
    calls.push({ q, params });
    if (q.includes("UPDATE grants")) {
      const merged = {
        ...(state.stored ?? {}),
        ...(JSON.parse(params[1] as string) as Record<string, unknown>),
      };
      state.stored = merged;
      return [{ allocation_policy: merged }];
    }
    if (q.includes("SELECT allocation_policy FROM grants")) {
      return [{ allocation_policy: state.stored }];
    }
    return [];
  }),
}));

import {
  POLICY_BOUNDS,
  overlayPolicy,
  getMandateAllocationPolicy,
  type AllocationPolicy,
} from "../../../src/services/allocation-policy-service.js";

beforeEach(() => {
  calls.length = 0;
  state.stored = null;
});

const MATH_KEYS = [
  "est_formalize_cost_owls",
  "est_attempt_standard_cost_owls",
  "est_attempt_max_cost_owls",
  "est_prize_review_cost_owls",
  "attempt_cooldown_days",
  "attempt_claim_lifetime_cap_owls",
] as const;

describe("POLICY_BOUNDS (mathematics keys, §10.5)", () => {
  it("bounds every mathematics key as the design states", () => {
    expect(POLICY_BOUNDS.est_formalize_cost_owls).toEqual({ min: 0.1, max: 100 });
    expect(POLICY_BOUNDS.est_attempt_standard_cost_owls).toEqual({ min: 1, max: 1000 });
    expect(POLICY_BOUNDS.est_attempt_max_cost_owls).toEqual({ min: 1, max: 2000 });
    expect(POLICY_BOUNDS.est_prize_review_cost_owls).toEqual({ min: 0.1, max: 200 });
    expect(POLICY_BOUNDS.attempt_cooldown_days).toEqual({ min: 0, max: 365 });
    expect(POLICY_BOUNDS.attempt_claim_lifetime_cap_owls).toEqual({ min: 0, max: 10000 });
  });

  it("holds exactly the keys that have a reader", () => {
    expect(Object.keys(POLICY_BOUNDS).sort()).toEqual(
      [
        "est_steward_run_cost_owls",
        "est_steward_run_cost_strong_owls",
        "staleness_base_days",
        ...MATH_KEYS,
        ...MAINTENANCE_KEYS,
        ...REQUEST_KEYS,
        ...INGEST_KEYS,
      ].sort()
    );
  });
});

// Requests (Part VIII): the work on a request is a ledger row costed at the
// request's own budget; a request with none gets a scoping pass, and this
// is that pass's cost prior.
const REQUEST_KEYS = ["est_request_scope_cost_owls"];
// An ingest row's cost prior, until the ledger holds enough finished ingests.
const INGEST_KEYS = ["est_ingest_cost_owls"];

describe("POLICY_BOUNDS (request keys, Part VIII)", () => {
  it("bounds the scoping pass's cost prior", () => {
    expect(POLICY_BOUNDS.est_request_scope_cost_owls).toEqual({ min: 0.01, max: 20 });
  });
});

// Maintenance and audit (#363): curation and audit are bought through the
// same policy, so their knobs are bounded like every other.
const MAINTENANCE_KEYS = [
  "est_curate_cost_owls",
  "est_audit_cost_owls",
  "reconcile_candidates_max_per_sweep",
  "reconcile_candidate_min_similarity",
  // The strong consistency sweep's expected gain over the standard, and the
  // per-node cost prior for an unpriced reader (#756).
  "consistency_strong_expected_gain",
  "est_consistency_node_cost_owls",
];

describe("POLICY_BOUNDS (maintenance and audit keys, #363)", () => {
  it("a stored policy from before the maintenance keys reads back with their defaults", async () => {
    state.stored = { est_steward_run_cost_owls: 2 };
    const policy = await getMandateAllocationPolicy("g-1");
    expect(policy.est_curate_cost_owls).toBe(0.25);
    expect(policy.est_audit_cost_owls).toBe(0.5);
    // The scan ships off: a similarity scan's pairs are requests, and the
    // mandate turns it on deliberately.
    expect(policy.reconcile_candidates_max_per_sweep).toBe(0);
  });
});

describe("defaults", () => {
  it("a stored policy from before the mathematics keys reads back with the design's defaults", async () => {
    state.stored = { staleness_base_days: 30, est_steward_run_cost_owls: 2 };
    const policy = await getMandateAllocationPolicy("g-1");
    expect(policy.staleness_base_days).toBe(30);
    expect(policy.est_steward_run_cost_owls).toBe(2);
    expect(policy.est_formalize_cost_owls).toBe(8);
    expect(policy.est_attempt_standard_cost_owls).toBe(60);
    expect(policy.est_attempt_max_cost_owls).toBe(150);
    expect(policy.est_prize_review_cost_owls).toBe(12);
    expect(policy.attempt_cooldown_days).toBe(30);
    expect(policy.attempt_claim_lifetime_cap_owls).toBe(500);
  });

  it("a null policy yields the defaults for every key", async () => {
    state.stored = null;
    const policy = await getMandateAllocationPolicy("g-2");
    for (const key of Object.keys(POLICY_BOUNDS) as (keyof AllocationPolicy)[]) {
      expect(typeof policy[key]).toBe("number");
      expect(Number.isFinite(policy[key])).toBe(true);
    }
    // Every default sits inside its own bounds — a default the agent could
    // not itself set would be a hole in the framework.
    for (const key of Object.keys(POLICY_BOUNDS) as (keyof AllocationPolicy)[]) {
      expect(policy[key]).toBeGreaterThanOrEqual(POLICY_BOUNDS[key].min);
      expect(policy[key]).toBeLessThanOrEqual(POLICY_BOUNDS[key].max);
    }
  });
});

// Keys the policy held until nothing read them. The value formula and the
// allocator that read them were retired in #855; staleness_saturation_days
// went first (#943) and the rest followed. Until #855 a mandate's
// Grantmaker had a tool that set policy keys, so a stored policy may still
// hold any of these.
const REMOVED_KEYS: Record<string, number> = {
  staleness_saturation_days: 45,
  contestation_floor: 0.5,
  user_provenance_boost: 0.3,
  strong_gain_multiplier: 2,
  maintenance_share: 0.2,
  curate_candidate_weight: 0.7,
  curate_matcher_quiet_days: 3,
  audit_value_prize: 2,
  audit_value_bad_faith: 1.5,
  audit_value_overturn: 1.2,
  audit_value_anomaly: 0.9,
  audit_value_suspension: 0.7,
  audit_value_sweep: 0.4,
  request_value_weight: 5,
  request_reviewed_weight: 0.6,
  request_untargeted_importance: 0.4,
  request_wait_days: 10,
};

describe("removed keys", () => {
  it("none is a policy key", () => {
    for (const key of Object.keys(REMOVED_KEYS)) {
      expect(POLICY_BOUNDS, key).not.toHaveProperty(key);
    }
  });

  // Such a policy loads, the removed keys are left out, and the keys it
  // holds that are still read apply.
  it("a stored policy that holds every removed key loads without them", async () => {
    state.stored = { ...REMOVED_KEYS, staleness_base_days: 30, est_curate_cost_owls: 0.4 };
    const policy = await getMandateAllocationPolicy("g-old");
    expect(policy.staleness_base_days).toBe(30);
    expect(policy.est_curate_cost_owls).toBe(0.4);
    for (const key of Object.keys(REMOVED_KEYS)) {
      expect(policy, key).not.toHaveProperty(key);
    }
    expect(Object.keys(policy).sort()).toEqual(Object.keys(POLICY_BOUNDS).sort());
  });

  it("a stored policy that holds only removed keys loads as the defaults", async () => {
    state.stored = null;
    const defaults = await getMandateAllocationPolicy("g-none");
    state.stored = { ...REMOVED_KEYS };
    expect(await getMandateAllocationPolicy("g-old")).toEqual(defaults);
  });
});

describe("overlayPolicy", () => {
  it("clamps a stored mathematics value to its bounds and ignores junk", async () => {
    const base = await getMandateAllocationPolicy("g-3");
    const out = overlayPolicy(base, {
      est_attempt_max_cost_owls: 5000,
      attempt_cooldown_days: -4,
      est_formalize_cost_owls: Number.NaN,
    });
    expect(out.est_attempt_max_cost_owls).toBe(2000);
    expect(out.attempt_cooldown_days).toBe(0);
    expect(out.est_formalize_cost_owls).toBe(8);
  });
});
