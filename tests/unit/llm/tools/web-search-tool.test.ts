import { describe, it, expect, vi, beforeEach } from "vitest";

const { search, state } = vi.hoisted(() => ({ search: vi.fn(), state: { fail: "" } }));
vi.mock("../../../../src/llm/providers/openrouter.js", () => ({
  // The failure path throws from the module seam, not from the spy: vitest
  // reports a spy's rejected result as a test error even when the caller
  // catches it.
  openrouterWebSearch: async (...args: unknown[]) => {
    if (state.fail) throw new Error(state.fail);
    return search(...args);
  },
}));

import {
  anthropicServerWebSearch,
  createWebSearch,
  WEB_SEARCH_TOOL_NAME,
} from "../../../../src/llm/tools/web-search-tool.js";
import { withCostMeter, withPassBudget } from "../../../../src/llm/usage-context.js";

beforeEach(() => {
  search.mockReset();
  state.fail = "";
});

describe("web_search on every provider", () => {
  it("is the Anthropic server tool on a Claude model that runs it, with nothing to execute", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(anthropicServerWebSearch(model)).toBe(true);
    }
    const ws = createWebSearch("claude-opus-5-5");
    // No max_uses: the run's budget bounds searches, not a count.
    expect(ws.tool).toEqual({ type: "web_search_20260209", name: WEB_SEARCH_TOOL_NAME });
    expect(ws.execute).toBeNull();
  });

  it("is a client-side tool of the same name elsewhere, executed through OpenRouter", async () => {
    for (const model of ["openai/gpt-6-luna", "gpt-5-mini", "o3", "claude-haiku-4-5-20251001"]) {
      expect(anthropicServerWebSearch(model)).toBe(false);
      const ws = createWebSearch(model);
      expect(ws.tool.name).toBe(WEB_SEARCH_TOOL_NAME);
      expect("input_schema" in ws.tool).toBe(true);
      expect(ws.execute).not.toBeNull();
    }
    search.mockResolvedValue([{ url: "https://x.org/a", title: "A", excerpt: "…" }]);
    const ws = createWebSearch("openai/gpt-6-luna");
    const out = JSON.parse(await ws.execute!({ query: "LK-99 replication" }));
    expect(search).toHaveBeenCalledWith("LK-99 replication", expect.any(Number));
    expect(out).toEqual({ query: "LK-99 replication", hits: [{ url: "https://x.org/a", title: "A", excerpt: "…" }] });
  });

  it("searches without a count, declines a search the budget cannot cover, and reports a failed search instead of throwing", async () => {
    search.mockResolvedValue([]);
    const ws = createWebSearch("openai/gpt-6-luna");
    for (const q of ["one", "two", "three"]) await ws.execute!({ query: q });
    expect(search).toHaveBeenCalledTimes(3);
    const { value } = await withPassBudget({ microUsd: 1, source: "the test" }, () => ws.execute!({ query: "four" }));
    expect(JSON.parse(value).success).toBe(false);
    expect(search).toHaveBeenCalledTimes(3);

    state.fail = "OpenRouter web search failed: bad gateway";
    const fresh = createWebSearch("gpt-5-mini");
    const out = JSON.parse(await fresh.execute!({ query: "three" }));
    expect(out.error_code).toBe("unavailable");
    expect(out.message).toContain("bad gateway");
    expect(JSON.parse(await createWebSearch("gpt-5-mini").execute!({ query: "  " }))).toEqual({ error: "query is required" });
  });
});
