import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * toolUseLoop's `stream` option: each turn goes over the streaming endpoint
 * with the refusal fallback the non-streaming path would give its model; a
 * model the long-run path serves gets its full output allowance, any other
 * its usual one. `onText` sees the reply as it forms.
 */

const createMock = vi.fn();
const betaCreateMock = vi.fn();
const streamMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: betaCreateMock, stream: streamMock } };
  },
}));
vi.mock("../../../src/config.js", () => ({
  loadConfig: () => ({ anthropicApiKey: "test-key" }),
}));
vi.mock("../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { toolUseLoop } from "../../../src/llm/client.js";
import { MODELS } from "../../../src/llm/models.js";

const decision = {
  content: [{ type: "tool_use", id: "t1", name: "submit", input: { done: true } }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "tool_use",
  container: null,
};
const tools = [{ name: "submit", description: "d", input_schema: { type: "object" as const } }];

beforeEach(() => {
  createMock.mockReset();
  betaCreateMock.mockReset();
  streamMock.mockReset();
  process.env.ANTHROPIC_API_KEY = "test-key";
});

const run = (model: string) =>
  toolUseLoop({
    initialMessages: [{ role: "user", content: "draft" }],
    tools,
    model,
    stream: true,
    maxIterations: 2,
    executeTool: async () => "ok",
    onFinalTool: (name) => (name === "submit" ? true : null),
  });

describe("toolUseLoop stream", () => {
  it("streams on the strong tier, with the full output allowance and its refusal fallback", async () => {
    streamMock.mockReturnValue({ on: () => undefined, finalMessage: async () => decision });
    const result = await run(MODELS.strong);
    expect(result.toolUses[0]!.name).toBe("submit");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(betaCreateMock).not.toHaveBeenCalled();
    const params = streamMock.mock.calls[0]![0];
    expect(params.max_tokens).toBe(128_000);
    expect(params.fallbacks).toEqual([{ model: MODELS.opus }]);
  });

  it("streams a mid-tier model within its usual output allowance, passing text as it forms", async () => {
    // A stream whose text handler fires before the final message resolves,
    // as the SDK's does.
    streamMock.mockImplementation(() => {
      let onText: ((delta: string) => void) | null = null;
      return {
        on: (event: string, fn: (delta: string) => void) => {
          if (event === "text") onText = fn;
        },
        finalMessage: async () => {
          onText?.("Draft");
          onText?.("ing now.");
          return decision;
        },
      };
    });
    const seen: Array<[string, number]> = [];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "draft" }],
      tools,
      model: MODELS.haiku,
      stream: true,
      maxIterations: 2,
      onText: (delta, turn) => seen.push([delta, turn]),
      executeTool: async () => "ok",
      onFinalTool: (name) => (name === "submit" ? true : null),
    });
    const params = streamMock.mock.calls[0]![0];
    expect(params.max_tokens).toBe(8192);
    expect(params.fallbacks).toBeUndefined();
    expect(seen).toEqual([
      ["Draft", 0],
      ["ing now.", 0],
    ]);
  });

  it("hands a non-streamed turn's whole text to onText", async () => {
    createMock.mockResolvedValue({
      ...decision,
      content: [{ type: "text", text: "All at once." }, ...decision.content],
    });
    const seen: string[] = [];
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "draft" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 2,
      onText: (text) => seen.push(text),
      executeTool: async () => "ok",
      onFinalTool: (name) => (name === "submit" ? true : null),
    });
    expect(streamMock).not.toHaveBeenCalled();
    expect(seen).toEqual(["All at once."]);
  });
});
