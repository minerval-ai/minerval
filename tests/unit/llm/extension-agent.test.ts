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
// In record mode the chat's run is opened and sealed; the rows go nowhere here.
vi.mock("../../../src/db/client.js", () => ({
  getDb: () => ({
    insert: () => ({ values: async () => undefined }),
    update: () => ({ set: () => ({ where: async () => undefined }) }),
  }),
  rawQuery: async () => [],
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
  getChatKeptNote,
  getChatSystemPrompt,
} from "../../../src/llm/prompts/extension-agent.js";
import { loadConfig } from "../../../src/config.js";

// The loaded config is one object per process; the run log's mode is read from it.
const config = loadConfig() as { runLogMode: "best_effort" | "record" };

beforeEach(() => {
  mocks.toolUseLoop.mockReset().mockResolvedValue({ content: "ok" });
  mocks.executeGraphReadTool.mockReset();
  config.runLogMode = "best_effort";
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
    initialMessages: Array<{ role: string; content: string }>;
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

// A reader may ask the chat what is kept of the conversation, and the true
// answer depends on the deployment (docs/run-log.md): nothing while the run
// log is best-effort, the whole run where the log is kept as a record. The
// role prompt is the same text everywhere, so it says only what holds
// everywhere, and the first message says which of the two holds here.
describe("what the chat is told is kept", () => {
  const NOT_STORED =
    "What Minerval keeps of this conversation: nothing from the page or from the reader's questions is " +
    "written to its database or to a transcript of this run. Only what the reply cost is recorded. " +
    "You can tell the reader so if they ask.";
  const LOGGED =
    "What this deployment keeps of this conversation: it keeps a complete log of every agent run, and " +
    "this run is on it. What you were given about the page, the reader's questions and your replies are " +
    "stored in that log, which is private to the deployment and not shown to other readers. If the " +
    "reader asks what is kept, that is the answer. Telling them that nothing is kept would be false here.";

  it("is that nothing is stored, while the run log is best-effort", async () => {
    const opts = await runChat();
    expect(getChatKeptNote(false)).toBe(NOT_STORED);
    expect(opts.initialMessages).toHaveLength(1);
    expect(opts.initialMessages[0]!.content.startsWith(`${NOT_STORED}\n\nThe page the user is reading:`)).toBe(true);
    expect(opts.initialMessages[0]!.content.endsWith("\n\n---\n\nIs this true?")).toBe(true);
  });

  it("is that the run is on the log, where the log is kept as a record", async () => {
    config.runLogMode = "record";
    const opts = await runChat();
    expect(getChatKeptNote(true)).toBe(LOGGED);
    expect(opts.initialMessages[0]!.content.startsWith(`${LOGGED}\n\nThe page the user is reading:`)).toBe(true);
    expect(opts.initialMessages[0]!.content).not.toContain("nothing from the page");
  });

  it("is said once, on the first of the reader's messages", async () => {
    await extensionChat({
      messages: [
        { role: "user", content: "Is this true?" },
        { role: "assistant", content: "The graph holds it as inconclusive." },
        { role: "user", content: "Do you keep what I ask?" },
      ],
      pageUrl: null,
      pageTitle: null,
      pageClaims: [],
    });
    const sent = (mocks.toolUseLoop.mock.calls[0]![0] as { initialMessages: Array<{ content: string }> })
      .initialMessages;
    expect(sent.map((m) => m.content.includes("What Minerval keeps"))).toEqual([true, false, false]);
    expect(sent[2]!.content).toBe("Do you keep what I ask?");
  });

  it("leaves the role prompt saying only what holds in every deployment", () => {
    const chat = getChatSystemPrompt();
    expect(chat).toContain(
      "Nothing from the reader's page or questions is added to the graph, and a\n" +
        "report carries none of it either: only its title, surface, and ids survive\n" +
        "and the body is discarded, so put the gap in the title."
    );
    expect(chat).not.toMatch(/is persisted|not stored|nothing is kept/i);
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
