import { describe, it, expect, vi, beforeEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

/**
 * Both tool loops keep the run's record of the ids it has been shown
 * (llm/seen-ids.ts, #934): from the opening messages and from every tool
 * result, with each tool run inside the record's scope, so a graph read a
 * later turn makes can repair a mistyped id against what earlier turns
 * returned. A caller may hand the loop a record it keeps across loops.
 */

const mocks = vi.hoisted(() => ({
  completeWithTools: vi.fn(),
  completeWithToolsStreaming: vi.fn(),
}));

vi.mock("../../../src/llm/providers/index.js", () => ({
  getAdapter: () => ({
    name: "anthropic",
    completeWithTools: mocks.completeWithTools,
    completeWithToolsStreaming: mocks.completeWithToolsStreaming,
  }),
}));
vi.mock("../../../src/services/trace-service.js", () => ({
  recordAgentStep: vi.fn(),
  markRunPrivate: vi.fn(),
  startAgentRun: vi.fn(() => null),
  finishAgentRun: vi.fn(),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({ checkBudget: vi.fn() }));

import { longRunToolLoop, toolUseLoop, type ToolCompletionResult } from "../../../src/llm/client.js";
import { SeenIds, seenIdsInRun } from "../../../src/llm/seen-ids.js";

const PROMPT_ID = "0a0a0a0a-1b1b-4c2c-8d3d-4e4e4e4e4e4e";
const FOUND_ID = "edb65b17-29b2-4a3a-9064-7940bcaf287f";
const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0 };

function toolTurn(id: string, name: string): ToolCompletionResult {
  return {
    content: "",
    model: "claude-opus-5-5",
    usage,
    stopReason: "tool_use",
    toolUses: [{ id, name, input: {} }],
    rawContent: [{ type: "tool_use", id, name, input: {} }] as unknown as Anthropic.ContentBlock[],
  };
}
const done: ToolCompletionResult = {
  content: "done",
  model: "claude-opus-5-5",
  usage,
  stopReason: "end_turn",
  toolUses: [],
  rawContent: [{ type: "text", text: "done" }] as unknown as Anthropic.ContentBlock[],
};

/** A search that returns FOUND_ID, then a read that reports what the record held when it ran. */
function script(mock: typeof mocks.completeWithTools) {
  const turns = [toolTurn("t1", "search"), toolTurn("t2", "read"), done];
  mock.mockImplementation(async () => turns.shift() ?? done);
  const seenAtRead: Array<{ prompt: boolean; found: boolean; text: string | null }> = [];
  const executeTool = async (name: string) => {
    if (name === "search") return JSON.stringify({ results: [{ id: FOUND_ID, canonical_form: "the found node" }] });
    const record = seenIdsInRun();
    seenAtRead.push({
      prompt: record?.has(PROMPT_ID) ?? false,
      found: record?.has(FOUND_ID) ?? false,
      text: record?.get(FOUND_ID)?.text ?? null,
    });
    return "read";
  };
  return { executeTool, seenAtRead };
}

const initial: Anthropic.MessageParam[] = [{ role: "user", content: `Steward node ${PROMPT_ID}.` }];

beforeEach(() => {
  mocks.completeWithTools.mockReset();
  mocks.completeWithToolsStreaming.mockReset();
});

describe("the tool loops keep the run's record of ids", () => {
  it("toolUseLoop: a later tool sees the prompt's ids and an earlier result's, with its wording", async () => {
    const { executeTool, seenAtRead } = script(mocks.completeWithTools);
    await toolUseLoop({ initialMessages: initial, tools: [], executeTool, maxIterations: 5 });
    expect(seenAtRead).toEqual([{ prompt: true, found: true, text: "the found node" }]);
    // Outside the loop there is no record.
    expect(seenIdsInRun()).toBeNull();
  });

  it("toolUseLoop: fills a record the caller keeps", async () => {
    const { executeTool } = script(mocks.completeWithTools);
    const record = new SeenIds();
    await toolUseLoop({ initialMessages: initial, tools: [], executeTool, maxIterations: 5, seenIds: record });
    expect(record.has(PROMPT_ID)).toBe(true);
    expect(record.has(FOUND_ID)).toBe(true);
  });

  it("longRunToolLoop keeps the same record", async () => {
    const { executeTool, seenAtRead } = script(mocks.completeWithToolsStreaming);
    await longRunToolLoop({ initialMessages: initial, tools: [], model: "claude-opus-5-5", executeTool });
    expect(seenAtRead).toEqual([{ prompt: true, found: true, text: "the found node" }]);
  });
});
