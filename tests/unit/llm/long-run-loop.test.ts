import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// The loops are exercised against a fake adapter (as client-trace.test.ts does)
// so the control flow — what gets appended, when the loop stops — is what's
// under test, not the wire format.
const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  completeWithToolsStreaming: vi.fn(),
  recordAgentStep: vi.fn(),
  streamingAvailable: true,
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () =>
    mocks.streamingAvailable
      ? {
          name: "anthropic",
          completeWithTools: mocks.completeWithTools,
          completeWithToolsStreaming: mocks.completeWithToolsStreaming,
        }
      : { name: "openai", completeWithTools: mocks.completeWithTools },
}));

vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: mocks.recordAgentStep,
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));

vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
}));

import {
  CONTINUE_AFTER_MAX_TOKENS,
  longRunToolLoop,
  toolUseLoop,
  type ToolCompletionResult,
} from "../../../src/llm/client.js";

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 20 };

function toolTurn(id: string): ToolCompletionResult {
  return {
    content: "",
    model: "claude-fable-5-1",
    usage,
    stopReason: "tool_use",
    toolUses: [{ id, name: "search", input: { q: id } }],
    rawContent: [
      { type: "tool_use", id, name: "search", input: { q: id } },
    ] as unknown as Anthropic.ContentBlock[],
  };
}

function textTurn(text: string, stopReason = "end_turn"): ToolCompletionResult {
  return {
    content: text,
    model: "claude-fable-5-1",
    usage,
    stopReason,
    toolUses: [],
    rawContent: [{ type: "text", text }] as unknown as Anthropic.ContentBlock[],
  };
}

const snapshot = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Snapshot the messages array each call receives, in call order. */
function recordMessages(mock: typeof mocks.completeWithTools): Anthropic.MessageParam[][] {
  const seen: Anthropic.MessageParam[][] = [];
  const queue: ToolCompletionResult[] = [];
  mock.mockImplementation(async (req: { messages: Anthropic.MessageParam[] }) => {
    seen.push(snapshot(req.messages));
    return queue.shift() ?? textTurn("done");
  });
  (mock as unknown as { queue: ToolCompletionResult[] }).queue = queue;
  return seen;
}

function queueTurns(mock: typeof mocks.completeWithTools, turns: ToolCompletionResult[]): void {
  (mock as unknown as { queue: ToolCompletionResult[] }).queue.push(...turns);
}

/** Every earlier entry of the previous request must reappear unchanged. */
function expectAppendOnly(seen: Anthropic.MessageParam[][]): void {
  for (let i = 1; i < seen.length; i++) {
    const prev = seen[i - 1]!;
    const next = seen[i]!;
    expect(next.length).toBeGreaterThan(prev.length);
    expect(next.slice(0, prev.length)).toEqual(prev);
  }
}

const initial: Anthropic.MessageParam[] = [{ role: "user", content: "go" }];
const executeTool = async (name: string, input: Record<string, unknown>) =>
  `${name}:${String(input.q)}`;

beforeEach(() => {
  mocks.completeWithTools.mockReset();
  mocks.completeWithToolsStreaming.mockReset();
  mocks.recordAgentStep.mockReset();
  mocks.streamingAvailable = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("toolUseLoop is append-only", () => {
  it("never edits an earlier entry across three turns, nor the caller's array", async () => {
    const seen = recordMessages(mocks.completeWithTools);
    queueTurns(mocks.completeWithTools, [toolTurn("t1"), toolTurn("t2"), textTurn("done")]);
    const before = snapshot(initial);

    const result = await toolUseLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      maxIterations: 10,
    });

    expect(result.content).toBe("done");
    expect(seen.map((m) => m.length)).toEqual([1, 3, 5]);
    expectAppendOnly(seen);
    expect(seen[2]![3]).toEqual({ role: "assistant", content: toolTurn("t2").rawContent });
    expect(seen[2]![4]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "search:t2" }],
    });
    expect(initial).toEqual(before);
  });
});

describe("longRunToolLoop", () => {
  it("fails with a capability message when the adapter has no streaming path", async () => {
    mocks.streamingAvailable = false;
    await expect(
      longRunToolLoop({ initialMessages: initial, tools: [], model: "gpt-5", executeTool })
    ).rejects.toThrow(/Anthropic-only/);
    expect(mocks.completeWithTools).not.toHaveBeenCalled();
  });

  it("sends the long-run request shape with explicit defaults", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      model: "claude-fable-5-1",
      system: ["role", "skill"],
      effort: "xhigh",
      taskBudgetTokens: 64_000,
      betas: ["compact-2026-01-12"],
      executeTool,
    });
    const req = mocks.completeWithToolsStreaming.mock.calls[0]![0];
    expect(req).toMatchObject({
      model: "claude-fable-5-1",
      system: ["role", "skill"],
      effort: "xhigh",
      taskBudgetTokens: 64_000,
      betas: ["compact-2026-01-12"],
      fallbacks: "none",
      maxTokens: 128_000,
    });
  });

  it("is append-only across three turns and returns the last result", async () => {
    const seen = recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), toolTurn("t2"), textTurn("done")]);
    const before = snapshot(initial);

    const outcome = await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });

    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.turns).toBe(3);
    expect(outcome.result?.content).toBe("done");
    expect(seen.map((m) => m.length)).toEqual([1, 3, 5]);
    expectAppendOnly(seen);
    expect(initial).toEqual(before);
  });

  it("stops when beforeTurn says so, reporting the reason and the last turn", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), toolTurn("t2")]);

    const outcome = await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      beforeTurn: async (state) => (state.turn === 1 ? { stop: "kill switch" } : undefined),
    });

    expect(outcome.stopReason).toBe("hook");
    expect(outcome.hookStop).toBe("kill switch");
    expect(outcome.turns).toBe(1);
    expect(outcome.result?.toolUses[0]?.id).toBe("t1");
    expect(mocks.completeWithToolsStreaming).toHaveBeenCalledTimes(1);
  });

  it("can be stopped before the first turn", async () => {
    const outcome = await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      beforeTurn: async () => ({ stop: "not now" }),
    });
    expect(outcome).toEqual({ result: null, turns: 0, stopReason: "hook", hookStop: "not now" });
    expect(mocks.completeWithToolsStreaming).not.toHaveBeenCalled();
  });

  it("stops at the wall-clock cap before starting another turn", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-03T00:00:00Z"));
    const tenMinutes = 10 * 60_000;
    mocks.completeWithToolsStreaming.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + tenMinutes);
      return toolTurn("t");
    });
    const elapsedSeen: number[] = [];

    const outcome = await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      maxWallMs: 15 * 60_000,
      beforeTurn: async (state) => {
        elapsedSeen.push(state.elapsedMs);
      },
    });

    // Turn 1 starts at 0, turn 2 at 10 min; 20 min is over the cap.
    expect(outcome.stopReason).toBe("max_wall");
    expect(outcome.turns).toBe(2);
    expect(elapsedSeen).toEqual([0, tenMinutes]);
  });

  it("stops at maxIterations", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), toolTurn("t2"), toolTurn("t3")]);
    const outcome = await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      maxIterations: 2,
    });
    expect(outcome.stopReason).toBe("max_iterations");
    expect(outcome.turns).toBe(2);
  });

  it("stops on the final tool without executing it", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("submit")]);
    const executed: string[] = [];
    const outcome = await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool: async (name) => {
        executed.push(name);
        return "";
      },
      onFinalTool: (name) => (name === "search" ? { done: true } : null),
    });
    expect(outcome.stopReason).toBe("final_tool");
    expect(outcome.turns).toBe(1);
    expect(executed).toEqual([]);
  });

  it("continues once after max_tokens with a new user message, then honors end_turn", async () => {
    const seen = recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [
      textTurn("half an answer", "max_tokens"),
      textTurn("the rest"),
    ]);

    const outcome = await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });

    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.turns).toBe(2);
    expect(seen[1]).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "half an answer" }] },
      { role: "user", content: [{ type: "text", text: CONTINUE_AFTER_MAX_TOKENS }] },
    ]);
    expectAppendOnly(seen);
  });

  it("answers a truncated turn's tool calls before asking it to continue", async () => {
    const seen = recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [
      { ...toolTurn("t1"), stopReason: "max_tokens" },
      textTurn("done"),
    ]);

    await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });

    expect(seen[1]![2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "search:t1" },
        { type: "text", text: CONTINUE_AFTER_MAX_TOKENS },
      ],
    });
  });

  it("stops with max_tokens when the continuation is truncated too", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [
      textTurn("one", "max_tokens"),
      textTurn("two", "max_tokens"),
      textTurn("never reached"),
    ]);
    const outcome = await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });
    expect(outcome.stopReason).toBe("max_tokens");
    expect(outcome.turns).toBe(2);
    expect(outcome.result?.content).toBe("two");
  });

  it("allows a fresh continuation after a turn that was not truncated", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [
      textTurn("one", "max_tokens"),
      toolTurn("t1"),
      textTurn("three", "max_tokens"),
      textTurn("done"),
    ]);
    const outcome = await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });
    expect(outcome.stopReason).toBe("end_turn");
    expect(outcome.turns).toBe(4);
  });

  it("appends the reminder as the last text of the next user message", async () => {
    const seen = recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), toolTurn("t2"), textTurn("done")]);

    await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      reminder: (state) => (state.turn === 1 ? "record your progress" : null),
    });

    expect(seen[1]![2]).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "t1", content: "search:t1" },
        { type: "text", text: "record your progress" },
      ],
    });
    expect(seen[2]![4]).toEqual({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t2", content: "search:t2" }],
    });
    // The earlier reminder stayed in place: no rewriting of history.
    expectAppendOnly(seen);
  });

  it("calls afterTurn once per model turn with cumulative usage", async () => {
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), textTurn("done")]);
    const turns: Array<{ turn: number; input: number; cacheRead: number; messages: number }> = [];

    await longRunToolLoop({
      initialMessages: initial,
      tools: [],
      executeTool,
      afterTurn: async (state, result) => {
        turns.push({
          turn: state.turn,
          input: state.usage.inputTokens,
          cacheRead: state.usage.cacheReadTokens,
          messages: state.messages.length,
        });
        expect(state.lastResult).toBe(result);
      },
    });

    expect(turns).toEqual([
      { turn: 1, input: 10, cacheRead: 100, messages: 3 },
      { turn: 2, input: 20, cacheRead: 200, messages: 3 },
    ]);
  });

  it("threads the container and resubmits a paused turn unchanged", async () => {
    const seen = recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [
      { ...textTurn("searching", "pause_turn"), container: "cont_1" },
      textTurn("done"),
    ]);

    const outcome = await longRunToolLoop({ initialMessages: initial, tools: [], executeTool });

    expect(outcome.turns).toBe(2);
    expect(mocks.completeWithToolsStreaming.mock.calls[1]![0].container).toBe("cont_1");
    expect(seen[1]).toEqual([
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "searching" }] },
    ]);
  });

  it("records trace steps like toolUseLoop when a trace is active", async () => {
    const { runWithUsageContext } = await import("../../../src/llm/usage-context.js");
    recordMessages(mocks.completeWithToolsStreaming);
    queueTurns(mocks.completeWithToolsStreaming, [toolTurn("t1"), textTurn("done")]);
    const trace = { runId: "run-1", seq: { n: 0 } };

    await runWithUsageContext({ trace }, () =>
      longRunToolLoop({ initialMessages: initial, tools: [], executeTool })
    );

    expect(mocks.recordAgentStep.mock.calls.map((c) => c[1])).toEqual([
      "assistant",
      "tool_results",
      "assistant",
    ]);
  });
});
