import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * toolUseLoop's `stream` option: on a model the long-run path serves, each
 * turn goes over the streaming endpoint with the model's full output
 * allowance and the refusal fallback the non-streaming path would give it;
 * any other model runs non-streaming as before.
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
    streamMock.mockReturnValue({ finalMessage: async () => decision });
    const result = await run(MODELS.strong);
    expect(result.toolUses[0]!.name).toBe("submit");
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();
    expect(betaCreateMock).not.toHaveBeenCalled();
    const params = streamMock.mock.calls[0]![0];
    expect(params.max_tokens).toBe(128_000);
    expect(params.fallbacks).toEqual([{ model: MODELS.opus }]);
  });

  it("runs non-streaming on a model the long-run path does not serve", async () => {
    createMock.mockResolvedValue(decision);
    await run(MODELS.haiku);
    expect(streamMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});
