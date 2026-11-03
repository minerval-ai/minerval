import { describe, it, expect, vi } from "vitest";

/**
 * Which variant of a consistency sweep the General mandate buys (#756): the
 * strong one when its value per owl is at least the standard's, that is
 * when the policy's multiplier times the standard's cost covers the strong
 * one's.
 */

const { state } = vi.hoisted(() => ({ state: { multiplier: 3 } }));

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/services/action-service.js", () => ({
  ASSESS_GROUP: (id: string) => `assess:${id}`,
  COVERAGE_SQL: "0",
  REQUEST_GROUP: (id: string) => `request:${id}`,
  ensureAssessActions: vi.fn(),
  ensureRequestActions: vi.fn(),
  consistencySweepCostMicroUsd: (variant: "standard" | "strong") =>
    variant === "strong" ? 500_000 : 50_000,
}));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: vi.fn(async () => ({
    consistency_strong_gain_multiplier: state.multiplier,
  })),
  getGeneralMandate: vi.fn(),
  getMandateAllocationPolicy: vi.fn(),
}));

import { consistencySweepVariant } from "../../../src/services/allocation-service.js";

describe("consistencySweepVariant", () => {
  it("buys the standard sweep when the strong one returns less per owl", async () => {
    state.multiplier = 3;
    expect(await consistencySweepVariant()).toBe("standard");
  });

  it("buys the strong sweep once its expected gain covers its extra cost", async () => {
    state.multiplier = 10;
    expect(await consistencySweepVariant()).toBe("strong");
  });
});
