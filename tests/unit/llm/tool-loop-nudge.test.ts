import { describe, it, expect, vi, beforeEach } from "vitest";

const createMock = vi.fn();
const betaCreateMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: createMock };
    beta = { messages: { create: betaCreateMock } };
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

const prose = {
  content: [{ type: "text", text: "Resubmitting with every required field set." }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "end_turn",
  container: null,
};
const decision = {
  content: [{ type: "tool_use", id: "t1", name: "submit", input: { is_match: true } }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "tool_use",
  container: null,
};
const tools = [{ name: "submit", description: "d", input_schema: { type: "object" as const } }];

beforeEach(() => {
  createMock.mockReset();
});

describe("toolUseLoop finalToolNudge", () => {
  it("answers a prose-only turn with the nudge and continues to the final tool", async () => {
    createMock.mockResolvedValueOnce(prose).mockResolvedValueOnce(decision);
    let final: unknown = null;
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      finalToolNudge: { max: 1, message: "Call submit now." },
      executeTool: async () => "ok",
      onFinalTool: (name, input) => (name === "submit" ? (final = input) : null),
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    const second = createMock.mock.calls[1]![0];
    const last = second.messages.at(-1);
    expect(last.role).toBe("user");
    expect(JSON.stringify(last.content)).toContain("Call submit now.");
    expect(final).toEqual({ is_match: true });
    expect(result.toolUses[0]!.name).toBe("submit");
  });

  it("nudges at most `max` times, then returns the prose turn", async () => {
    createMock.mockResolvedValue(prose);
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 6,
      finalToolNudge: { max: 1, message: "Call submit now." },
      executeTool: async () => "ok",
      onFinalTool: () => null,
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("end_turn");
  });

  it("does nothing without the option", async () => {
    createMock.mockResolvedValue(prose);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool: async () => "ok",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("toolUseLoop malformed tool arguments", () => {
  it("answers the call with the parse message instead of executing the tool", async () => {
    const malformed = {
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "submit",
          input: { __malformed_arguments: "Tool call \"submit\" returned arguments that are not valid JSON." },
        },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
      stop_reason: "tool_use",
      container: null,
    };
    createMock.mockResolvedValueOnce(malformed).mockResolvedValueOnce(decision);
    const executeTool = vi.fn(async () => "ok");
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool,
      onFinalTool: (name, input) => ("is_match" in input ? input : null),
    });
    expect(executeTool).not.toHaveBeenCalled();
    const second = createMock.mock.calls[1]![0];
    expect(JSON.stringify(second.messages.at(-1).content)).toContain("not valid JSON");
  });
});
