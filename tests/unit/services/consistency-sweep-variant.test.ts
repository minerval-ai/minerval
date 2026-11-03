import { describe, it, expect, vi } from "vitest";

/**
 * Which variant of a consistency sweep the General mandate buys (#756): the
 * strong one when its value per owl is at least the standard's, that is
 * when the policy's multiplier times the standard's price covers the strong
 * one's. Both prices are a partition's, so the choice is per partition.
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/services/action-service.js", () => ({
  ASSESS_GROUP: (id: string) => `assess:${id}`,
  COVERAGE_SQL: "0",
  REQUEST_GROUP: (id: string) => `request:${id}`,
  ensureAssessActions: vi.fn(),
  ensureRequestActions: vi.fn(),
}));
vi.mock("../../../src/services/allocation-policy-service.js", () => ({
  getEffectiveAllocationPolicy: vi.fn(),
  getGeneralMandate: vi.fn(),
  getMandateAllocationPolicy: vi.fn(),
}));

import { consistencySweepVariant } from "../../../src/services/allocation-service.js";

describe("consistencySweepVariant", () => {
  it("buys the standard sweep when the strong one returns less per owl", () => {
    // A 100-node partition at the default rates: 0.5 and 5 owls.
    expect(consistencySweepVariant(3, 500_000, 5_000_000)).toBe("standard");
  });

  it("buys the strong sweep once its expected gain covers its extra cost", () => {
    expect(consistencySweepVariant(10, 500_000, 5_000_000)).toBe("strong");
  });

  it("weighs each partition's own prices: where the strong cap binds the upgrade is cheaper", () => {
    // 400 nodes: the standard at 2 owls, the strong capped at 10 (not 20).
    expect(consistencySweepVariant(5, 2_000_000, 10_000_000)).toBe("strong");
    // 100 nodes: the same multiplier does not cover a tenfold price.
    expect(consistencySweepVariant(5, 500_000, 5_000_000)).toBe("standard");
  });
});
