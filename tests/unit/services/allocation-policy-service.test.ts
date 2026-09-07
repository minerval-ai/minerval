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
  updateAllocationPolicy,
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

  it("keeps the original keys and their bounds", () => {
    expect(Object.keys(POLICY_BOUNDS).sort()).toEqual(
      [
        "contestation_floor",
        "staleness_saturation_days",
        "user_provenance_boost",
        "strong_gain_multiplier",
        "est_steward_run_cost_owls",
        "est_steward_run_cost_strong_owls",
        "staleness_base_days",
        "staleness_max_per_sweep",
        ...MATH_KEYS,
      ].sort()
    );
  });
});

describe("defaults", () => {
  it("a stored policy from before the mathematics keys reads back with the design's defaults", async () => {
    state.stored = { contestation_floor: 0.5, est_steward_run_cost_owls: 2 };
    const policy = await getMandateAllocationPolicy("g-1");
    expect(policy.contestation_floor).toBe(0.5);
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

describe("updateAllocationPolicy", () => {
  it("accepts the mathematics keys, clamped, and rejects unknown ones", async () => {
    const ok = await updateAllocationPolicy("g-4", {
      est_attempt_standard_cost_owls: 75,
      attempt_claim_lifetime_cap_owls: 50_000,
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.policy.est_attempt_standard_cost_owls).toBe(75);
      expect(ok.policy.attempt_claim_lifetime_cap_owls).toBe(10_000);
      expect(ok.changed).toEqual([
        "est_attempt_standard_cost_owls",
        "attempt_claim_lifetime_cap_owls",
      ]);
    }
    const bad = await updateAllocationPolicy("g-4", { bounty_multiplier: 2 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.problem).toContain('unknown policy key "bounty_multiplier"');
      for (const key of MATH_KEYS) expect(bad.problem).toContain(key);
    }
  });
});
