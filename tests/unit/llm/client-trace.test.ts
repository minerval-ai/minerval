import { describe, it, expect, vi, beforeEach, onTestFinished } from "vitest";
import { getPromptSet } from "../../../src/services/prompt-set.js";

// toolUseLoop should record one 'assistant' step per model turn and one
// 'tool_results' step per executed batch — but only when a trace handle is
// present on the usage context (#334 L0).
const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  complete: vi.fn(),
  completeStructured: vi.fn(),
  recordAgentStep: vi.fn(),
  markRunPrivate: vi.fn(),
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({
    completeWithTools: mocks.completeWithTools,
    complete: mocks.complete,
    completeStructured: mocks.completeStructured,
  }),
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  markRunPrivate: mocks.markRunPrivate,
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

// A run at a label other than public is served only by a provider cleared
// for it (src/provider-labels.ts). Whether the label the setting names is
// defined is asked of the database, answered from here.
vi.mock("../../../src/services/label-service.js", () => ({
  undefinedLabels: async () => [],
}));

import { complete, completeStructured, toolUseLoop } from "../../../src/llm/client.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";
import { runDateLine } from "../../../src/llm/run-date.js";
import { loadConfig } from "../../../src/config.js";

// What the model is sent: the caller's system prompt, dated at the seam (#771).
const DATED_SYSTEM = `the constitution\n\n${runDateLine()}`;

const usage = { inputTokens: 1, outputTokens: 1 };

const toolTurn = {
  content: "",
  model: "m",
  usage,
  stopReason: "tool_use",
  toolUses: [{ id: "t1", name: "search", input: { q: "x" } }],
  rawContent: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
};

const finalTurn = {
  content: "done",
  model: "m",
  usage,
  stopReason: "end_turn",
  toolUses: [],
  rawContent: [{ type: "text", text: "done" }],
};

beforeEach(() => {
  mocks.completeWithTools.mockReset();
  mocks.complete.mockReset();
  mocks.completeStructured.mockReset();
  mocks.recordAgentStep.mockReset();
  mocks.markRunPrivate.mockReset();
});

// Single-shot completions are whole agent turns for the agents that never
// enter a tool-use loop (the Extractor, the judge), so they are recorded as
// one "completion" step — prompt and output, system prompt by size only.
describe("single-shot completion step recording", () => {
  it("records a structured completion with its prompt, schema and output", async () => {
    mocks.completeStructured.mockResolvedValueOnce({ items: [{ text: "a claim" }] });
    const trace = { runId: "run-2", seq: { n: 0 }, ready: Promise.resolve() };
    const messages = [{ role: "user" as const, content: "extract" }];

    const out = await runWithUsageContext({ trace }, () =>
      completeStructured<{ items: unknown[] }>({
        messages,
        schema: { type: "object" },
        schemaName: "Claims",
        system: "the constitution",
        model: "m",
      })
    );

    expect(out.items).toHaveLength(1);
    // The setup first, verbatim (the replay's prompt step), then the completion.
    expect(mocks.recordAgentStep).toHaveBeenCalledTimes(2);
    const [, promptKind, prompt] = mocks.recordAgentStep.mock.calls[0]!;
    expect(promptKind).toBe("prompt");
    // The prompt step's content arrives as a promise: it waits on the prompt
    // set's hash, which is stamped on the setup.
    const recorded = (await prompt) as {
      setup: { promptSet: string | null; label: string; featuresOff: string[] };
    };
    expect(recorded.setup.promptSet).toBe(getPromptSet().hash);
    // The label the run writes at is in the setup too: public unless the
    // context says otherwise (src/labels.ts).
    expect(recorded.setup.label).toBe("public");
    // And the features that were off for the run (src/features.ts): always
    // recorded, an empty list when everything was on.
    expect(recorded.setup.featuresOff).toEqual([]);
    expect(recorded).toMatchObject({
      model: "m",
      system: DATED_SYSTEM,
      initialMessages: messages,
      tools: [],
      schemaName: "Claims",
      schema: { type: "object" },
      maxTokens: 8192,
    });
    const [t, kind, content] = mocks.recordAgentStep.mock.calls[1]!;
    expect(t).toBe(trace);
    expect(kind).toBe("completion");
    expect(content).toEqual({
      model: "m",
      schemaName: "Claims",
      systemChars: DATED_SYSTEM.length,
      messages,
      output: { items: [{ text: "a claim" }] },
      stopReason: null,
    });
  });

  it("records a plain completion with its text and stop reason", async () => {
    mocks.complete.mockResolvedValueOnce({ content: "hello", model: "m", usage, stopReason: "end_turn" });
    const trace = { runId: "run-3", seq: { n: 0 }, ready: Promise.resolve() };
    await runWithUsageContext({ trace }, () =>
      complete({ messages: [{ role: "user", content: "hi" }], model: "m" })
    );
    expect(mocks.recordAgentStep.mock.calls.map((c) => c[1])).toEqual(["prompt", "completion"]);
    const [, kind, content] = mocks.recordAgentStep.mock.calls[1]!;
    expect(kind).toBe("completion");
    expect(content).toMatchObject({ output: "hello", stopReason: "end_turn", systemChars: 0 });
  });

  it("records nothing without a trace on the context", async () => {
    mocks.completeStructured.mockResolvedValueOnce({});
    await completeStructured({ messages: [], schema: {}, schemaName: "X", model: "m" });
    expect(mocks.recordAgentStep).not.toHaveBeenCalled();
  });
});

describe("toolUseLoop step recording", () => {
  it("records assistant and tool_results steps when a trace is active", async () => {
    mocks.completeWithTools
      .mockResolvedValueOnce(toolTurn)
      .mockResolvedValueOnce(finalTurn);
    const trace = { runId: "run-1", seq: { n: 0 }, ready: Promise.resolve() };

    const tools = [
      { name: "search", description: "find things", input_schema: { type: "object" as const } },
    ];
    // The run works at `internal`, so its model's provider is cleared for it.
    const deployment = loadConfig() as { providerLabels: Record<string, string[]> };
    const loaded = deployment.providerLabels;
    onTestFinished(() => {
      deployment.providerLabels = loaded;
    });
    deployment.providerLabels = { anthropic: ["public", "internal"] };
    await runWithUsageContext({ trace, label: "internal" }, () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools,
        system: "the constitution",
        executeTool: async () => "search-output",
      })
    );

    const calls = mocks.recordAgentStep.mock.calls;
    expect(calls.map((c) => c[1])).toEqual([
      "prompt",
      "assistant",
      "tool_results",
      "assistant",
    ]);
    // The prompt step carries the whole setup: system prompt, initial
    // messages and the tool descriptors, verbatim, the label the run writes
    // at, taken from the context, and the provider that served it.
    expect(await calls[0]![2]).toMatchObject({
      setup: { label: "internal", featuresOff: [], provider: "anthropic" },
      system: DATED_SYSTEM,
      initialMessages: [{ role: "user", content: "go" }],
      tools: [{ name: "search", description: "find things", input_schema: { type: "object" } }],
    });
    expect(calls[1]![2]).toEqual({
      stopReason: "tool_use",
      content: toolTurn.rawContent,
    });
    expect(calls[2]![2]).toEqual([
      { name: "search", input: { q: "x" }, output: "search-output" },
    ]);
    expect(calls.every((c) => c[0] === trace)).toBe(true);
  });

  it("records nothing without a trace on the context", async () => {
    mocks.completeWithTools.mockResolvedValueOnce(finalTurn);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "go" }],
      tools: [],
      executeTool: async () => "unused",
    });
    expect(mocks.recordAgentStep).not.toHaveBeenCalled();
  });
});

// A run that executes a tool whose output can carry private data, or a tool
// nobody has classified, keeps its transcript private (run-visibility.ts).
describe("toolUseLoop visibility marks", () => {
  const loop = (name: string) => {
    const turn = {
      ...toolTurn,
      toolUses: [{ id: "t1", name, input: {} }],
      rawContent: [{ type: "tool_use", id: "t1", name, input: {} }],
    };
    mocks.completeWithTools.mockResolvedValueOnce(turn).mockResolvedValueOnce(finalTurn);
    const trace = { runId: "run-v", seq: { n: 0 }, ready: Promise.resolve() };
    return runWithUsageContext({ trace }, () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools: [{ name, description: "", input_schema: { type: "object" as const } }],
        executeTool: async () => "out",
      })
    );
  };

  it("marks the run for an unclassified tool", async () => {
    await loop("search");
    expect(mocks.markRunPrivate).toHaveBeenCalledWith(expect.anything(), "tool:search:unclassified");
  });

  it("marks the run for a tool that reads private data", async () => {
    await loop("grant_overview");
    expect(mocks.markRunPrivate).toHaveBeenCalledWith(expect.anything(), "tool:grant_overview");
  });

  it("leaves the run alone for a public read", async () => {
    await loop("get_claim");
    expect(mocks.markRunPrivate).not.toHaveBeenCalled();
  });
});
