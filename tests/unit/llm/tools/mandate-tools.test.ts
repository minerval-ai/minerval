import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The mandate toolbox (llm/tools/mandate-tools.ts, #333): one
 * implementation of survey_scope, read_page and update_workspace for every mode of a mandate's Grantmaker. The survey
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
  applyWorkspaceWrite,
  createMandateTools,
  planCostFloorOwls,
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
    ]);
    expect(createMandateTools({ grantId: "g-1" }).definitions.map((t) => t.name)).toEqual([
      "survey_scope",
      "read_page",
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

  it("reads a page and rewrites the workspace whole", async () => {
    const tools = createMandateTools({ grantId: "g-1" });
    expect(JSON.parse((await tools.execute("read_page", { url: "https://x.test/a" }))!)).toEqual({
      ok: true,
      text: "page",
      chars: 4,
    });
    expect(state.pages).toEqual(["https://x.test/a"]);

    const res = JSON.parse(
      (await tools.execute("update_workspace", { content: "x".repeat(150_000) }))!
    );
    // Stored whole: the workspace is the agent's own memory, paid for in tokens.
    expect(res).toEqual({ success: true, mode: "replace", chars: 150_000 });
    expect(state.updates[0]!.sql).toContain("UPDATE grants SET workspace");
    expect(state.updates[0]!.params[0]).toBe("g-1");
  });

  it("appends and rewrites one section without the agent re-sending the rest (#690)", async () => {
    const tools = createMandateTools({ grantId: "g-1" });
    const refused = JSON.parse((await tools.execute("update_workspace", { content: "x", mode: "replace_section" }))!);
    expect(refused.success).toBe(false);
    const res = JSON.parse((await tools.execute("update_workspace", { content: "more", mode: "append" }))!);
    expect(res).toMatchObject({ success: true, mode: "append" });
    expect(state.updates[0]!.sql).toContain("SELECT workspace");
    expect(state.updates[1]!.params[1]).toBe("more");
  });

  it("is not the owner of any other tool, and declines the workspace without a mandate", async () => {
    expect(await createMandateTools().execute("extend_plan", {})).toBeNull();
    expect(await createMandateTools().execute("update_workspace", { content: "x" })).toBeNull();
    expect(state.updates).toEqual([]);
  });

  it("prices a plan's floor at one pass per stewarding item and one ingestion per source", async () => {
    const floor = await planCostFloorOwls([
      { action: "assess" },
      { action: "deepen" },
      { action: "ingest" },
      { action: "formalize" },
    ]);
    // Two passes at 2 owls, one ingestion at 0.5; formalize is priced at run time.
    expect(floor).toEqual({ floor_owls: 4.5, per_item_owls: { steward_pass: 2, ingest: 0.5 } });
  });
});

describe("applyWorkspaceWrite", () => {
  const doc = "# Map\n\nintro\n\n## Backlog\n\n- a\n- b\n\n### Detail\n\nd\n\n## Next\n\nn";
  it("replaces the whole document by default", () => {
    expect(applyWorkspaceWrite(doc, "new")).toBe("new");
  });
  it("appends after the existing text, or starts an empty one", () => {
    expect(applyWorkspaceWrite("a\n\n", "b", "append")).toBe("a\n\nb");
    expect(applyWorkspaceWrite("", "b", "append")).toBe("b");
  });
  it("rewrites one section with its subsections, up to the next heading at its level", () => {
    const out = applyWorkspaceWrite(doc, "- c", "replace_section", "## Backlog");
    expect(out).toBe("# Map\n\nintro\n\n## Backlog\n- c\n\n## Next\n\nn");
  });
  it("adds a section that is not there yet at the end", () => {
    expect(applyWorkspaceWrite("x", "## New\nbody", "replace_section", "## New")).toBe("x\n\n## New\nbody");
  });
});
