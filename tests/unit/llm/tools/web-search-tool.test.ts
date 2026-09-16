import { describe, it, expect } from "vitest";
import {
  webSearchAvailable,
  webSearchTool,
  webSearchUnavailableNote,
  WEB_SEARCH_TOOL_NAME,
} from "../../../../src/llm/tools/web-search-tool.js";

describe("web_search tool gating", () => {
  it("offers the Anthropic server tool on a Claude model", () => {
    expect(webSearchAvailable("claude-sonnet-5")).toBe(true);
    expect(webSearchTool("claude-fable-5-1", 5)).toEqual({
      type: "web_search_20260209",
      name: WEB_SEARCH_TOOL_NAME,
      max_uses: 5,
    });
    expect(webSearchUnavailableNote("claude-fable-5-1")).toBe("");
  });

  it("withholds it on OpenRouter and OpenAI models, with a briefing note", () => {
    for (const model of ["z-ai/glm-5.3-flash", "gpt-5-mini", "o3"]) {
      expect(webSearchAvailable(model)).toBe(false);
      expect(webSearchTool(model, 5)).toBeNull();
      expect(webSearchUnavailableNote(model)).toContain("web_search is unavailable");
    }
  });
});
