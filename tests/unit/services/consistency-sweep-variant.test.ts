import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Which variant of a consistency sweep the General mandate buys (#756): the
 * strong one when its expected gain over the standard times the standard's
 * price covers the strong one's, per partition from its two prices. The
 * expected gain is the General mandate's own override, else the evidence
 * (the variants' upheld flags per node read, once each has enough sweeps),
 * else the policy default.
 */

const { state } = vi.hoisted(() => ({
  state: {
    own: null as null | Record<string, unknown>,
    yields: [] as Array<{ variant: string; sweeps: number; nodes: number; upheld: number }>,
  },
}));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/services/action-service.js", () => ({
  ASSESS_GROUP: (id: string) => `assess:${id}`,
  COVERAGE_SQL: "0",
  REQUEST_GROUP: (id: string) => `request:${id}`,
  ensureAssessActions: vi.fn(),
  ensureRequestActions: vi.fn(),
}));
vi.mock("../../../src/services/consistency-service.js", () => ({
  sweepYieldByVariant: vi.fn(async () => state.yields),
}));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  POLICY_BOUNDS: { consistency_strong_expected_gain: { min: 1, max: 50 } },
  getEffectiveAllocationPolicy: vi.fn(async () => ({ consistency_strong_expected_gain: 5 })),
  getGeneralMandate: vi.fn(async () => ({ allocationPolicy: state.own })),
  getMandateAllocationPolicy: vi.fn(),
}));

import {
  CONSISTENCY_EVIDENCE,
  consistencyStrongExpectedGain,
  consistencySweepVariant,
} from "../../../src/services/allocation-service.js";

beforeEach(() => {
  state.own = null;
  state.yields = [];
});

describe("consistencySweepVariant", () => {
  it("buys the standard sweep when the strong one returns less per owl", () => {
    // A 100-node partition at the default estimates: 0.5 and 3.9 owls.
    expect(consistencySweepVariant(5, 500_000, 3_900_000)).toBe("standard");
  });

  it("buys the strong sweep once its expected gain covers its extra cost", () => {
    expect(consistencySweepVariant(8, 500_000, 3_900_000)).toBe("strong");
  });

  it("weighs each partition's own prices: the default reaches the strong read where both caps bind", () => {
    // 400 nodes and up: the standard capped at 2 owls, the strong at 10.
    expect(consistencySweepVariant(5, 2_000_000, 10_000_000)).toBe("strong");
  });
});

describe("consistencyStrongExpectedGain", () => {
  it("uses the policy default until there is evidence", async () => {
    expect(await consistencyStrongExpectedGain()).toEqual({ gain: 5, source: "default" });
    // Too few sweeps of one variant is not evidence yet.
    state.yields = [
      { variant: "standard", sweeps: 40, nodes: 4_000, upheld: 10 },
      { variant: "strong", sweeps: CONSISTENCY_EVIDENCE.minSweepsPerVariant - 1, nodes: 2_000, upheld: 30 },
    ];
    expect((await consistencyStrongExpectedGain()).source).toBe("default");
  });

  it("reads the ratio of upheld flags per node read once both variants have enough sweeps", async () => {
    state.yields = [
      { variant: "standard", sweeps: 40, nodes: 4_000, upheld: 9 },
      { variant: "strong", sweeps: 12, nodes: 1_000, upheld: 14 },
    ];
    // (15 / 1000) / (10 / 4000) = 6.
    const g = await consistencyStrongExpectedGain();
    expect(g.source).toBe("evidence");
    expect(g.gain).toBeCloseTo(6, 6);
  });

  it("holds the evidence to the policy's bounds", async () => {
    state.yields = [
      { variant: "standard", sweeps: 40, nodes: 1_000, upheld: 30 },
      { variant: "strong", sweeps: 12, nodes: 1_000, upheld: 0 },
    ];
    expect(await consistencyStrongExpectedGain()).toEqual({ gain: 1, source: "evidence" });
  });

  it("lets the General mandate's own policy override the evidence", async () => {
    state.own = { consistency_strong_expected_gain: 9 };
    state.yields = [
      { variant: "standard", sweeps: 40, nodes: 4_000, upheld: 9 },
      { variant: "strong", sweeps: 12, nodes: 1_000, upheld: 14 },
    ];
    expect(await consistencyStrongExpectedGain()).toEqual({ gain: 9, source: "override" });
  });
});
