import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The extension chat reads the graph through the shared read set (#679),
 * and its prompts name those tools and the kinds' own assessments (#680).
 */
const mocks = vi.hoisted(() => ({
  toolUseLoop: vi.fn(),
  executeGraphReadTool: vi.fn(),
}));

vi.mock("../../../src/llm/client.js", () => ({
  toolUseLoop: mocks.toolUseLoop,
  completeStructuredList: vi.fn(),
}));
vi.mock("../../../src/llm/tools/graph-read-tools.js", () => ({
  getGraphReadToolDefinitions: () =>
    ["search_claims", "get_claim", "get_decomposition", "get_dependents"].map((name) => ({
      name,
      description: "",
      input_schema: { type: "object", properties: {} },
    })),
  executeGraphReadTool: mocks.executeGraphReadTool,
}));
vi.mock("../../../src/llm/tools/report-tools.js", () => ({
  createReportTools: () => ({
    definitions: [{ name: "raise_issue", description: "", input_schema: { type: "object", properties: {} } }],
    execute: async () => null,
  }),
}));

import { extensionChat } from "../../../src/llm/agents/extension-agent.js";
import {
  getAssessorSystemPrompt,
  getChatSystemPrompt,
} from "../../../src/llm/prompts/extension-agent.js";

beforeEach(() => {
  mocks.toolUseLoop.mockReset().mockResolvedValue({ content: "ok" });
  mocks.executeGraphReadTool.mockReset();
});

async function runChat() {
  await extensionChat({
    messages: [{ role: "user", content: "Is this true?" }],
    pageUrl: "https://example.com",
    pageTitle: "Example",
    pageClaims: [],
  });
  return mocks.toolUseLoop.mock.calls[0]![0] as {
    tools: Array<{ name: string }>;
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  };
}

describe("extensionChat", () => {
  it("carries the shared graph reads, not the legacy set", async () => {
    const opts = await runChat();
    const names = opts.tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["search_claims", "get_claim", "get_decomposition", "get_dependents", "raise_issue"])
    );
    expect(names).not.toContain("get_claim_details");
    expect(names).not.toContain("search_similar_claims");
  });

  it("dispatches graph reads and answers an unknown tool with an error", async () => {
    const opts = await runChat();
    mocks.executeGraphReadTool.mockResolvedValueOnce('{"claim":{}}');
    expect(await opts.executeTool("get_claim", { claim_id: "x" })).toBe('{"claim":{}}');
    mocks.executeGraphReadTool.mockResolvedValueOnce(null);
    expect(JSON.parse(await opts.executeTool("get_claim_details", {}))).toEqual({
      error: "Unknown tool: get_claim_details",
    });
  });
});

describe("extension prompts", () => {
  it("name the tools the chat has", () => {
    const chat = getChatSystemPrompt();
    for (const tool of ["search_claims", "get_claim", "get_decomposition", "get_dependents"]) {
      expect(chat).toContain(tool);
    }
    expect(chat).not.toContain("get_claim_details");
  });

  it("tell the assessor how a quantity and a question are judged", () => {
    const assessor = getAssessorSystemPrompt();
    expect(assessor).toMatch(/compare the page's figure with the graph's estimate/);
    expect(assessor).toMatch(/standing/);
  });

  it("gate 'egregious' on a confident assessment, not a numeric threshold", () => {
    expect(getAssessorSystemPrompt()).not.toMatch(/at least 0\.8/);
  });
});
