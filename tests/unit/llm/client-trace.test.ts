import { describe, it, expect, vi, beforeEach } from "vitest";

// toolUseLoop should record one 'assistant' step per model turn and one
// 'tool_results' step per executed batch — but only when a trace handle is
// present on the usage context (#334 L0).
const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  complete: vi.fn(),
  completeStructured: vi.fn(),
  recordAgentStep: vi.fn(),
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
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

import { complete, completeStructured, toolUseLoop } from "../../../src/llm/client.js";
import { runWithUsageContext } from "../../../src/llm/usage-context.js";

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
});

// Single-shot completions are whole agent turns for the agents that never
// enter a tool-use loop (the Extractor, the judge), so they are recorded as
// one "completion" step — prompt and output, system prompt by size only.
describe("single-shot completion step recording", () => {
  it("records a structured completion with its prompt, schema and output", async () => {
    mocks.completeStructured.mockResolvedValueOnce({ items: [{ text: "a claim" }] });
    const trace = { runId: "run-2", seq: { n: 0 } };
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
    expect(mocks.recordAgentStep).toHaveBeenCalledOnce();
    const [t, kind, content] = mocks.recordAgentStep.mock.calls[0]!;
    expect(t).toBe(trace);
    expect(kind).toBe("completion");
    expect(content).toEqual({
      model: "m",
      schemaName: "Claims",
      systemChars: "the constitution".length,
      messages,
      output: { items: [{ text: "a claim" }] },
      stopReason: null,
    });
  });

  it("records a plain completion with its text and stop reason", async () => {
    mocks.complete.mockResolvedValueOnce({ content: "hello", model: "m", usage, stopReason: "end_turn" });
    const trace = { runId: "run-3", seq: { n: 0 } };
    await runWithUsageContext({ trace }, () =>
      complete({ messages: [{ role: "user", content: "hi" }], model: "m" })
    );
    const [, kind, content] = mocks.recordAgentStep.mock.calls[0]!;
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
    const trace = { runId: "run-1", seq: { n: 0 } };

    await runWithUsageContext({ trace }, () =>
      toolUseLoop({
        initialMessages: [{ role: "user", content: "go" }],
        tools: [],
        executeTool: async () => "search-output",
      })
    );

    const calls = mocks.recordAgentStep.mock.calls;
    expect(calls.map((c) => c[1])).toEqual([
      "assistant",
      "tool_results",
      "assistant",
    ]);
    expect(calls[0]![2]).toEqual({
      stopReason: "tool_use",
      content: toolTurn.rawContent,
    });
    expect(calls[1]![2]).toEqual([
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
