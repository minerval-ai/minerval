import { describe, it, expect, vi, beforeEach } from "vitest";

// toolUseLoop should record one 'assistant' step per model turn and one
// 'tool_results' step per executed batch — but only when a trace handle is
// present on the usage context (#334 L0).
const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  recordAgentStep: vi.fn(),
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({ completeWithTools: mocks.completeWithTools }),
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

import { toolUseLoop } from "../../../src/llm/client.js";
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
  mocks.recordAgentStep.mockReset();
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
