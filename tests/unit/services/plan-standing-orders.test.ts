import { describe, it, expect, vi } from "vitest";

// What a stewarding plan item may say about the pass it orders (#849): a
// budget and a tier, checked when the plan is written, kept in the stored
// form, and counted in the planning pass's cost floor. The commission
// itself runs against Postgres in tests/db/standing-orders.test.ts.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: vi.fn(async () => ({ standardMicroUsd: 400_000, strongMicroUsd: 2_000_000 })),
}));

import { normalizePlanItems, validatePlanItems, type PlanItem } from "../../../src/services/grant-service.js";
import { orderTier } from "../../../src/services/standing-order-service.js";
import { planCostFloorOwls } from "../../../src/llm/tools/mandate-tools.js";

const CLAIM = "a1111111-1111-4111-8111-111111111111";
const item = (extra: Record<string, unknown>): PlanItem =>
  ({ action: "assess", claim_id: CLAIM, rationale: "r", ...extra }) as PlanItem;

describe("a stewarding item's budget and tier", () => {
  it("accepts a budget above zero and a standard or strong variant", () => {
    expect(validatePlanItems([item({ budget_owls: 2.5, variant: "standard" })])).toBeNull();
    expect(validatePlanItems([item({ action: "deepen", variant: "strong" })])).toBeNull();
    expect(validatePlanItems([item({})])).toBeNull();
  });

  it("refuses a budget that is not a number of owls above zero, saying what to do", () => {
    for (const bad of [0, -1, "3", Number.NaN]) {
      const problem = validatePlanItems([item({ action: "reassess", budget_owls: bad })]);
      expect(problem).toMatch(/a reassess item's budget_owls is a number of owls above zero/);
      expect(problem).toMatch(/omit it for the pass's estimate/);
    }
  });

  it("refuses the solver's variant on a Steward pass", () => {
    expect(validatePlanItems([item({ variant: "max" })])).toMatch(/an assess item's variant is standard or strong/);
  });

  it("keeps the budget in the stored form, on stewarding items only", () => {
    const stored = normalizePlanItems([
      item({ budget_owls: 3, variant: "standard" }),
      { action: "ingest", url: "https://example.org/a", rationale: "r", budget_owls: 3 } as PlanItem,
      item({ action: "deepen" }),
    ]);
    expect(stored[0]).toMatchObject({ action: "assess", budget_owls: 3, variant: "standard" });
    expect(stored[1]).not.toHaveProperty("budget_owls");
    expect(stored[2]).not.toHaveProperty("budget_owls");
  });

  it("buys the strong tier unless the item says standard", () => {
    expect(orderTier(undefined)).toBe("strong");
    expect(orderTier("strong")).toBe("strong");
    expect(orderTier("standard")).toBe("standard");
    // A legacy or foreign value falls to the default, never throws.
    expect(orderTier("max")).toBe("strong");
  });

  it("prices each item in the plan's cost floor at what its order would commission", async () => {
    const floor = await planCostFloorOwls([
      { action: "assess" }, // strong estimate: 2
      { action: "reassess", variant: "standard" }, // 0.4
      { action: "deepen", budget_owls: 5 }, // its own budget
      { action: "propose" },
    ]);
    expect(floor.floor_owls).toBe(7.4);
  });
});
