import { describe, it, expect, vi } from "vitest";

// What a stewarding plan item may say about the pass it orders (#849): a
// budget and a tier, checked when the plan is written, kept in the stored
// form, and counted in the planning pass's cost floor. The commission
// itself runs against Postgres in tests/db/standing-orders.test.ts.

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []), withTransaction: vi.fn() }));
vi.mock("../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: vi.fn(async () => ({ standardMicroUsd: 400_000, strongMicroUsd: 2_000_000 })),
  estimateLedgerKindCostMicroUsd: vi.fn(async () => 100_000),
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

  it("stores every stewarding item with its tier: the one it names, or standard (#956)", () => {
    const stored = normalizePlanItems([
      item({}),
      item({ action: "deepen", variant: "strong" }),
      item({ action: "reassess", variant: "standard" }),
      { action: "ingest", url: "https://example.org/a", rationale: "r" } as PlanItem,
      { action: "sweep", partition: "residual", rationale: "r" } as PlanItem,
    ]);
    expect(stored.map((s) => s.variant)).toEqual(["standard", "strong", "standard", undefined, undefined]);
  });

  it("reads a tier only where the item names one: an item without is never given the strong tier by default (#956)", () => {
    expect(orderTier("strong")).toBe("strong");
    expect(orderTier("standard")).toBe("standard");
    // An item stored before items named their tier, or a foreign value.
    expect(orderTier(undefined)).toBeNull();
    expect(orderTier("max")).toBeNull();
  });

  it("tells the Grantmaker the rules it works under, in the tool text (#956, #961)", async () => {
    const { PLAN_KIND_RULES, PLAN_ITEM_SCHEMA } = await import("../../../src/services/grant-service.js");
    const { AMEND_PLAN_ITEMS } = await import("../../../src/llm/agents/program-officer.js");
    // The tier is named, and the default is the cheap one.
    expect(PLAN_KIND_RULES).toMatch(/names none is stored and commissioned as standard/);
    expect(PLAN_ITEM_SCHEMA.properties.variant.description).toMatch(/names none is stored and commissioned as standard/);
    expect(PLAN_KIND_RULES).not.toMatch(/strong when you name none/);
    // An order that does not fit does not hold the plan, and the cost of that is said.
    expect(PLAN_KIND_RULES).toMatch(/never holds the ones after it/);
    expect(PLAN_KIND_RULES).toMatch(/can be passed over/);
    // What "started" means, and what can change before then.
    expect(PLAN_KIND_RULES).toMatch(/started once its pass is running/);
    expect(AMEND_PLAN_ITEMS.description).toMatch(/started once its pass is running/);
    expect(AMEND_PLAN_ITEMS.description).toMatch(/comes straight back/);
    // Which children a deepen item orders.
    expect(PLAN_KIND_RULES).toMatch(/each direct child that carries no assessment/);
    expect(PLAN_KIND_RULES).toMatch(/never ordered a fresh pass by a deepen item/);
  });

  it("prices each item in the plan's cost floor at what its order would commission", async () => {
    const floor = await planCostFloorOwls([
      { action: "assess" }, // names no tier: standard, 0.4
      { action: "reassess", variant: "strong" }, // 2
      { action: "deepen", budget_owls: 5 }, // its own budget
      { action: "propose" },
    ]);
    expect(floor.floor_owls).toBe(7.4);
  });
});

describe("a stewarding item that waits for the plan's ingests (after)", () => {
  const URL = "https://example.org/faa-order";
  const ingest = { action: "ingest", url: URL, rationale: "the order" } as PlanItem;

  it("accepts the url of an ingest item in the same plan or the plan it joins", () => {
    expect(validatePlanItems([ingest, item({ after: [URL] })])).toBeNull();
    expect(validatePlanItems([item({ action: "deepen", after: [URL] })], [], undefined, [URL])).toBeNull();
  });

  it("refuses a url that names no ingest item, and after on any other kind", () => {
    expect(validatePlanItems([item({ after: ["https://example.org/elsewhere"] })])).toMatch(
      /not the url of an ingest item in this plan/
    );
    expect(validatePlanItems([item({ after: URL })])).toMatch(/after is a list of at most/);
    expect(
      validatePlanItems([ingest, { action: "ingest", url: "https://example.org/b", rationale: "r", after: [URL] } as PlanItem])
    ).toMatch(/after is for assess, reassess and deepen items/);
  });

  it("keeps after in the stored form, deduplicated, on stewarding items only", () => {
    const [, stored] = normalizePlanItems([ingest, item({ after: [URL, ` ${URL} `] })]);
    expect(stored).toMatchObject({ action: "assess", after: [URL] });
    const [plain] = normalizePlanItems([item({})]);
    expect(plain).not.toHaveProperty("after");
  });

  it("tells the Grantmaker why and how long an item waits, in the tool text", async () => {
    const { PLAN_KIND_RULES, PLAN_ITEM_SCHEMA, AFTER_INGESTS_MAX_WAIT_HOURS } = await import(
      "../../../src/services/grant-service.js"
    );
    expect(PLAN_KIND_RULES).toMatch(/ingests take far longer than passes/);
    expect(PLAN_KIND_RULES).toContain(`at most ${AFTER_INGESTS_MAX_WAIT_HOURS} hours`);
    expect((PLAN_ITEM_SCHEMA.properties as Record<string, { description?: string }>).after!.description).toContain(
      `${AFTER_INGESTS_MAX_WAIT_HOURS} hours`
    );
  });
});
