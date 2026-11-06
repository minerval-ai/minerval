import { describe, it, expect, vi } from "vitest";

/**
 * A mandate's sweep plan items (#831), the pure half: what a well-formed
 * one carries (a partition, optionally a reader), and its stored form.
 * Opening and funding its rows is the DB suite's (tests/db/consistency).
 */

vi.mock("../../../src/db/client.js", () => ({ rawQuery: vi.fn(async () => []) }));

import {
  normalizePlanItems,
  validatePlanItems,
  PLAN_ITEM_SCHEMA,
  type PlanItem,
} from "../../../src/services/grant-service.js";

const sweep = (extra: Record<string, unknown>) =>
  [{ action: "sweep", rationale: "read the region for coherence", ...extra }] as unknown as PlanItem[];

describe("sweep plan items", () => {
  it("is a plan kind the Grantmaker's tools offer, with a partition field", () => {
    const props = PLAN_ITEM_SCHEMA.properties as Record<string, { enum?: string[] }>;
    expect(props.action!.enum).toContain("sweep");
    expect(props.partition).toBeDefined();
    expect(props.variant!.enum).toContain("strong");
  });

  it("needs a partition, a tag's slug or residual, and no claim id", () => {
    expect(validatePlanItems(sweep({ partition: "climate-science" }))).toBeNull();
    expect(validatePlanItems(sweep({ partition: "residual" }))).toBeNull();
    expect(validatePlanItems(sweep({}))).toMatch(/needs a partition/);
    expect(validatePlanItems(sweep({ partition: "not a slug!" }))).toMatch(/needs a partition/);
  });

  it("takes a standard or strong reader, or none, and never the solver's max", () => {
    expect(validatePlanItems(sweep({ partition: "residual", variant: "strong" }))).toBeNull();
    expect(validatePlanItems(sweep({ partition: "residual", variant: "standard" }))).toBeNull();
    expect(validatePlanItems(sweep({ partition: "residual", variant: "max" }))).toMatch(/standard or strong/);
    const attempt = [
      { action: "attempt_proof", claim_id: "00000000-0000-4000-8000-000000000000", rationale: "r", variant: "strong" },
    ] as unknown as PlanItem[];
    expect(validatePlanItems(attempt)).toMatch(/standard or max/);
  });

  it("stores the partition lowercased and trimmed, and only on a sweep", () => {
    const [stored] = normalizePlanItems(sweep({ partition: "  Climate-Science ", variant: "strong" }));
    expect(stored).toEqual({
      action: "sweep",
      rationale: "read the region for coherence",
      partition: "climate-science",
      variant: "strong",
    });
    const [ingest] = normalizePlanItems([
      { action: "ingest", url: "https://example.org", rationale: "r", partition: "x" } as unknown as PlanItem,
    ]);
    expect(ingest).not.toHaveProperty("partition");
  });
});
