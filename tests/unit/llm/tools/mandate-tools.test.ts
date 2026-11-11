import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The mandate toolbox (llm/tools/mandate-tools.ts, #333): one
 * implementation of read_page and update_workspace for every mode of a
 * mandate's Grantmaker. The workspace is offered only for a live mandate
 * and is bounded; anything else is "not my tool" (null).
 */

const { state } = vi.hoisted(() => ({
  state: {
    updates: [] as Array<{ sql: string; params: unknown[] }>,
    pages: [] as string[],
    pageOpts: [] as Array<Record<string, unknown>>,
  },
}));

vi.mock("../../../../src/db/client.js", () => ({
  rawQuery: vi.fn(async (sql: string, params: unknown[] = []) => {
    state.updates.push({ sql, params });
    return [];
  }),
}));
vi.mock("../../../../src/services/source-watch-service.js", () => ({
  readPage: vi.fn(async (url: string, opts: { offset?: number; maxChars?: number } = {}) => {
    state.pages.push(url);
    state.pageOpts.push(opts);
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
  state.updates = [];
  state.pages = [];
  state.pageOpts = [];
});

describe("createMandateTools", () => {
  it("offers the workspace only for a live mandate", () => {
    expect(createMandateTools().definitions.map((t) => t.name)).toEqual([
      "read_page",
    ]);
    expect(createMandateTools({ grantId: "g-1" }).definitions.map((t) => t.name)).toEqual([
      "read_page",
      "update_workspace",
    ]);
  });

  it("reads a page and rewrites the workspace whole", async () => {
    const tools = createMandateTools({ grantId: "g-1" });
    expect(JSON.parse((await tools.execute("read_page", { url: "https://x.test/a" }))!)).toEqual({
      ok: true,
      text: "page",
      chars: 4,
    });
    expect(state.pages).toEqual(["https://x.test/a"]);
    // The next window: offset and max_chars reach the reader; junk does not.
    await tools.execute("read_page", { url: "https://x.test/a", offset: 12_000, max_chars: 5_000 });
    await tools.execute("read_page", { url: "https://x.test/a", offset: "later" });
    expect(state.pageOpts).toEqual([
      { offset: undefined, maxChars: undefined },
      { offset: 12_000, maxChars: 5_000 },
      { offset: undefined, maxChars: undefined },
    ]);

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
