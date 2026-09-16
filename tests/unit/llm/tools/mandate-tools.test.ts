import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The mandate toolbox (llm/tools/mandate-tools.ts, #333): one
 * implementation of survey_scope, read_page, estimate_costs and
 * update_workspace for every mode of a mandate's Grantmaker. The survey
 * falls back to the mandate's declared scope hints only when a call names
 * nothing; the workspace is offered only for a live mandate and is
 * bounded; anything else is "not my tool" (null).
 */

const { state } = vi.hoisted(() => ({
  state: {
    surveys: [] as Array<Record<string, unknown>>,
    updates: [] as Array<{ sql: string; params: unknown[] }>,
    pages: [] as string[],
  },
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.updates.push({ sql, params });
    return [];
  }),
}));
vi.mock("../../../../src/services/scope-survey-service.js", () => ({
  surveyScope: vi.fn(async (input: Record<string, unknown>) => {
    state.surveys.push(input);
    return [{ id: "c1" }];
  }),
}));
vi.mock("../../../../src/services/source-watch-service.js", () => ({
  readPage: vi.fn(async (url: string) => {
    state.pages.push(url);
    return { ok: true, text: "page", chars: 4 };
  }),
}));
vi.mock("../../../../src/services/cost-estimate-service.js", () => ({
  stewardTierCostEstimates: vi.fn(async () => ({
    standardMicroUsd: 500_000,
    strongMicroUsd: 2_000_000,
  })),
}));
vi.mock("../../../../src/services/owl.js", () => ({
  microUsdToOwls: (micro: number) => micro / 1_000_000,
  capOwls: () => 0.5,
}));

import {
  createMandateTools,
  estimatePlanCosts,
  WORKSPACE_MAX_CHARS,
} from "../../../../src/llm/tools/mandate-tools.js";

beforeEach(() => {
  state.surveys = [];
  state.updates = [];
  state.pages = [];
});

describe("createMandateTools", () => {
  it("offers the workspace only for a live mandate", () => {
    expect(createMandateTools().definitions.map((t) => t.name)).toEqual([
      "survey_scope",
      "read_page",
      "estimate_costs",
    ]);
    expect(createMandateTools({ grantId: "g-1" }).definitions.map((t) => t.name)).toEqual([
      "survey_scope",
      "read_page",
      "estimate_costs",
      "update_workspace",
    ]);
  });

  it("surveys the declared scope hints when a call names nothing, and exactly what it names otherwise", async () => {
    const tools = createMandateTools({
      scopeClaimId: "root",
      scopeQuery: "nutrition",
      surveyLimit: 25,
    });
    const blank = JSON.parse((await tools.execute("survey_scope", {}))!);
    expect(blank).toEqual({ count: 1, claims: [{ id: "c1" }] });
    expect(state.surveys[0]).toMatchObject({
      scopeClaimId: "root",
      scopeQuery: "nutrition",
      offset: 0,
      limit: 25,
    });

    await tools.execute("survey_scope", { query: "vitamin d", offset: 25 });
    expect(state.surveys[1]).toMatchObject({
      scopeClaimId: null,
      scopeQuery: "vitamin d",
      offset: 25,
    });
  });

  it("reads a page, prices work, and rewrites a bounded workspace", async () => {
    const tools = createMandateTools({ grantId: "g-1" });
    expect(JSON.parse((await tools.execute("read_page", { url: "https://x.test/a" }))!)).toEqual({
      ok: true,
      text: "page",
      chars: 4,
    });
    expect(state.pages).toEqual(["https://x.test/a"]);

    const quote = JSON.parse(
      (await tools.execute("estimate_costs", { assessments: 2, deepen_claims: 1, sources_to_ingest: 4 }))!
    );
    // 2 passes at 2 owls, one deepen at 3 passes, four ingests at 0.5.
    expect(quote.subtotal_owls).toBe(12);
    expect(quote.unit_estimates).toEqual({
      assessment_each_owls: 2,
      reassessment_each_owls: 2,
      deepen_each_owls: 6,
      ingest_each_owls: 0.5,
    });
    expect(quote.suggested_total_owls).toBe(12.6);

    const res = JSON.parse(
      (await tools.execute("update_workspace", { content: "x".repeat(WORKSPACE_MAX_CHARS + 10) }))!
    );
    expect(res).toEqual({ success: true, chars: WORKSPACE_MAX_CHARS });
    expect(state.updates[0]!.sql).toContain("UPDATE grants SET workspace");
    expect(state.updates[0]!.params[0]).toBe("g-1");
  });

  it("is not the owner of any other tool, and declines the workspace without a mandate", async () => {
    expect(await createMandateTools().execute("extend_plan", {})).toBeNull();
    expect(await createMandateTools().execute("update_workspace", { content: "x" })).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it("exposes the same estimate the tool quotes, so a planner can hold its plan to it", async () => {
    const est = await estimatePlanCosts({ reassessments: 3 });
    expect(est.subtotal_owls).toBe(6);
  });
});
