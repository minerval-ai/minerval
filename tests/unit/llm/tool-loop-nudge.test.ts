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

describe("toolUseLoop finalToolNudge.when", () => {
  it("does not nudge once the caller says the work is done", async () => {
    createMock.mockResolvedValue(prose);
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      finalToolNudge: { max: 1, message: "Call submit now.", when: () => false },
      executeTool: async () => "ok",
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });
});

describe("toolUseLoop max_tokens recovery", () => {
  const cut = {
    content: [{ type: "text", text: "Reasoning at length about the" }],
    usage: { input_tokens: 10, output_tokens: 4096 },
    stop_reason: "max_tokens",
    container: null,
  };

  it("replays the cut turn with a note and continues when no server tools are in play", async () => {
    createMock.mockResolvedValueOnce(cut).mockResolvedValueOnce(decision);
    let final: unknown = null;
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool: async () => "ok",
      onFinalTool: (name, input) => (name === "submit" ? (final = input) : null),
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    const second = createMock.mock.calls[1]![0];
    expect(second.messages.at(-2).role).toBe("assistant");
    expect(JSON.stringify(second.messages.at(-1).content)).toContain("cut off at the output limit");
    expect(final).toEqual({ is_match: true });
    expect(result.stopReason).toBe("tool_use");
  });

  it("gives up after two recoveries", async () => {
    createMock.mockResolvedValue(cut);
    const result = await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 8,
      executeTool: async () => "ok",
    });
    expect(createMock).toHaveBeenCalledTimes(3);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("resumes with server tools in play, replaying the cut turn without its dangling server tool use", async () => {
    const cutMidSearch = {
      content: [
        { type: "text", text: "Searching for the trial" },
        { type: "server_tool_use", id: "srvtoolu_1", name: "code_execution", input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 4096 },
      stop_reason: "max_tokens",
      container: { id: "cont_1" },
    };
    createMock.mockResolvedValueOnce(cutMidSearch).mockResolvedValueOnce(decision);
    let final: unknown = null;
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools: [...tools, { type: "web_search_20260209", name: "web_search", max_uses: 5 } as never],
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool: async () => "ok",
      onFinalTool: (name, input) => (name === "submit" ? (final = input) : null),
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    const second = createMock.mock.calls[1]![0];
    expect(second.container).toBe("cont_1");
    expect(second.messages.at(-2)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "Searching for the trial" }],
    });
    expect(final).toEqual({ is_match: true });
  });

  it("answers a tool call the cutoff left unfinished, so the replay is a valid request", async () => {
    // A large tool input (a drafted mandate's plan) cut off mid-call: the
    // tool_use block is in the content, its input incomplete. Replayed
    // without a tool_result, the API refuses the next request outright.
    const cutMidCall = {
      content: [
        { type: "text", text: "Drafting the mandate now." },
        { type: "tool_use", id: "toolu_cut", name: "submit", input: {} },
      ],
      usage: { input_tokens: 10, output_tokens: 4096 },
      stop_reason: "max_tokens",
      container: null,
    };
    createMock.mockResolvedValueOnce(cutMidCall).mockResolvedValueOnce(decision);
    const executed: string[] = [];
    let final: unknown = null;
    await toolUseLoop({
      initialMessages: [{ role: "user", content: "decide" }],
      tools,
      model: MODELS.haiku,
      maxIterations: 4,
      executeTool: async (name) => {
        executed.push(name);
        return "ok";
      },
      onFinalTool: (name, input) => (name === "submit" ? (final = input) : null),
    });
    expect(createMock).toHaveBeenCalledTimes(2);
    const second = createMock.mock.calls[1]![0];
    expect(second.messages.at(-2).content).toContainEqual(
      expect.objectContaining({ type: "tool_use", id: "toolu_cut" })
    );
    const answer = second.messages.at(-1);
    expect(answer.role).toBe("user");
    // The tool_result comes first in the message, as the API requires.
    expect(answer.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "toolu_cut",
      is_error: true,
    });
    expect(JSON.stringify(answer.content)).toContain("cut off at the output limit");
    // The cut call never ran: its input is incomplete.
    expect(executed).toEqual([]);
    expect(final).toEqual({ is_match: true });
  });

});
