import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * web_fetch on every provider (llm/tools/web-fetch-tool.ts): the Anthropic
 * server tool on a Claude model that runs it, OpenRouter's own server tool
 * on an OpenRouter model (both with nothing for the loop to execute), and
 * on OpenAI direct, which serves no fetch tool, a client-side tool of the
 * same name executed through the lookout's page reader.
 */

const { page, state } = vi.hoisted(() => ({ page: vi.fn(), state: { fail: "" } }));
vi.mock("../../../../src/services/source-watch-service.js", () => ({
  readPage: async (...args: unknown[]) => {
    if (state.fail) return { ok: false, problem: state.fail };
    return page(...args);
  },
}));

import {
  createWebFetch,
  WEB_FETCH_MAX_CONTENT_TOKENS,
  WEB_FETCH_TOOL_NAME,
} from "../../../../src/llm/tools/web-fetch-tool.js";

beforeEach(() => {
  page.mockReset();
  state.fail = "";
});

describe("web_fetch on every provider", () => {
  it("is the Anthropic server tool on a Claude model that runs it, with nothing to execute", () => {
    for (const model of ["claude-fable-5-1", "claude-sonnet-5", "claude-opus-4-8"]) {
      const wf = createWebFetch(model, 4);
      expect(wf.tool).toEqual({
        type: "web_fetch_20260318",
        name: WEB_FETCH_TOOL_NAME,
        max_uses: 4,
        max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS,
      });
      expect(wf.execute).toBeNull();
    }
  });

  it("is OpenRouter's own server tool on an OpenRouter model, with nothing to execute", () => {
    const wf = createWebFetch("z-ai/glm-5.3-flash", 3);
    expect(wf.tool).toEqual({
      type: "openrouter:web_fetch",
      parameters: { engine: "exa", max_uses: 3, max_content_tokens: WEB_FETCH_MAX_CONTENT_TOKENS },
    });
    expect(wf.execute).toBeNull();
  });

  it("is a client-side tool of the same name where no provider serves one, read through the page reader", async () => {
    for (const model of ["gpt-5-mini", "o3", "claude-haiku-4-5-20251001"]) {
      const wf = createWebFetch(model, 2);
      expect(wf.tool.name).toBe(WEB_FETCH_TOOL_NAME);
      expect("input_schema" in wf.tool).toBe(true);
      expect(wf.execute).not.toBeNull();
    }
    page.mockResolvedValue({ ok: true, text: "Abstract: …", chars: 11 });
    const wf = createWebFetch("gpt-5-mini", 2);
    const out = JSON.parse(await wf.execute!({ url: "https://x.org/a" }));
    expect(page).toHaveBeenCalledWith("https://x.org/a", expect.any(Number));
    expect(out).toEqual({ url: "https://x.org/a", text: "Abstract: …", chars: 11 });
  });

  it("caps fetches per run in the server tools' vocabulary, and reports a failed fetch instead of throwing", async () => {
    page.mockResolvedValue({ ok: true, text: "p", chars: 1 });
    const wf = createWebFetch("gpt-5-mini", 1);
    await wf.execute!({ url: "https://x.org/one" });
    expect(JSON.parse(await wf.execute!({ url: "https://x.org/two" }))).toEqual({
      error_code: "max_uses_exceeded",
      max_uses: 1,
    });
    expect(page).toHaveBeenCalledTimes(1);

    state.fail = "Failed to fetch https://x.org/gone: 404";
    const out = JSON.parse(await createWebFetch("gpt-5-mini", 1).execute!({ url: "https://x.org/gone" }));
    expect(out).toMatchObject({ url: "https://x.org/gone", error_code: "url_not_accessible" });
    expect(out.message).toContain("404");
    expect(JSON.parse(await createWebFetch("gpt-5-mini", 1).execute!({ url: " " }))).toEqual({ error: "url is required" });
  });
});
