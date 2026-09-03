import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Capture requests at the SDK boundary (the same seam client.test.ts uses) and
// the constructor options, so the two memoized clients can be told apart.
const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  betaCreate: vi.fn(),
  betaStream: vi.fn(),
  constructed: [] as Array<Record<string, unknown>>,
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class AnthropicMock {
    messages = { create: mocks.create };
    beta = { messages: { create: mocks.betaCreate, stream: mocks.betaStream } };
    constructor(options: Record<string, unknown>) {
      mocks.constructed.push(options);
    }
  },
}));

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({ anthropicApiKey: "test-key" }),
}));

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterLlmUsage: vi.fn(),
}));

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { LlmRefusalError } from "../../../../src/llm/errors.js";
import { MODELS } from "../../../../src/llm/models.js";
import {
  LONG_RUN_MAX_OUTPUT_TOKENS,
  TASK_BUDGETS_BETA,
  anthropicAdapter,
  resetAnthropicClient,
} from "../../../../src/llm/providers/anthropic.js";

const EPHEMERAL = { type: "ephemeral" };

function response(overrides: Record<string, unknown> = {}) {
  return {
    model: MODELS.sonnet,
    content: [{ type: "text", text: "hello" }],
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 7,
      cache_creation_input_tokens: 3,
    },
    stop_reason: "end_turn",
    container: null,
    ...overrides,
  };
}

const TOOL = {
  name: "search",
  description: "Search",
  input_schema: { type: "object", properties: {}, required: [] },
} as unknown as Anthropic.Messages.ToolUnion;

const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];

/** A three-message tool-loop history: user text, assistant tool call, user tool result. */
function loopHistory(): Anthropic.MessageParam[] {
  return [
    { role: "user", content: "go" },
    {
      role: "assistant",
      content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "t1", content: "found" }],
    },
  ];
}

function sentParams(mock = mocks.create, call = 0): Record<string, any> {
  return mock.mock.calls[call]![0] as Record<string, any>;
}

/** Every cache_control marker in a request, wherever it sits. */
function countBreakpoints(params: Record<string, any>): number {
  let n = 0;
  for (const tool of params.tools ?? []) if (tool.cache_control) n++;
  for (const block of params.system ?? []) if (block.cache_control) n++;
  for (const message of params.messages ?? []) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) if (block.cache_control) n++;
  }
  return n;
}

function lastUserContent(params: Record<string, any>): any[] {
  const users = params.messages.filter((m: { role: string }) => m.role === "user");
  return users[users.length - 1]!.content;
}

beforeEach(() => {
  resetAnthropicClient();
  mocks.constructed.length = 0;
  mocks.create.mockReset().mockResolvedValue(response());
  mocks.betaCreate.mockReset().mockResolvedValue(response({ model: MODELS.fable }));
  mocks.betaStream.mockReset().mockImplementation(() => ({
    finalMessage: async () => response({ model: MODELS.fable }),
  }));
});

afterEach(() => {
  delete process.env.LLM_LONG_RUN_TIMEOUT_MS;
});

describe("system blocks", () => {
  it("keeps a plain string as one cached text block", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64, system: "be terse" });
    expect(sentParams().system).toEqual([
      { type: "text", text: "be terse", cache_control: EPHEMERAL },
    ]);
  });

  it("maps each string of an array to its own cached text block, in order", async () => {
    await anthropicAdapter.complete({
      messages,
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["constitution and role", "domain skill"],
    });
    expect(sentParams().system).toEqual([
      { type: "text", text: "constitution and role", cache_control: EPHEMERAL },
      { type: "text", text: "domain skill", cache_control: EPHEMERAL },
    ]);
  });

  it("puts breakpoints on only the last three blocks when more arrive", async () => {
    await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["a", "b", "c", "d", "e"],
    });
    const params = sentParams();
    expect(params.system.map((b: { text: string }) => b.text)).toEqual(["a", "b", "c", "d", "e"]);
    expect(params.system.map((b: { cache_control?: unknown }) => Boolean(b.cache_control))).toEqual([
      false, false, true, true, true,
    ]);
    // Tool list (1) + three system blocks = the API's four; no history one.
    expect(countBreakpoints(params)).toBe(4);
  });

  it("omits the system field for an empty array and drops empty strings", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64, system: [] });
    expect(sentParams()).not.toHaveProperty("system");

    mocks.create.mockClear();
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64, system: ["", "role"] });
    expect(sentParams().system).toEqual([{ type: "text", text: "role", cache_control: EPHEMERAL }]);
  });

  it("applies to the structured path too", async () => {
    mocks.create.mockResolvedValue(response({ content: [{ type: "text", text: "{}" }] }));
    await anthropicAdapter.completeStructured({
      messages,
      schema: { type: "object", properties: {}, required: [], additionalProperties: false },
      schemaName: "Thing",
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["role", "skill"],
    });
    expect(sentParams().system).toHaveLength(2);
    expect(sentParams().system[1]).toEqual({ type: "text", text: "skill", cache_control: EPHEMERAL });
  });
});

describe("effort", () => {
  it("lands in output_config on complete and completeWithTools", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64, effort: "xhigh" });
    expect(sentParams().output_config).toEqual({ effort: "xhigh" });

    await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      effort: "low",
    });
    expect(sentParams(mocks.create, 1).output_config).toEqual({ effort: "low" });
  });

  it("merges with the structured-output format", async () => {
    mocks.create.mockResolvedValue(response({ content: [{ type: "text", text: "{}" }] }));
    const schema = { type: "object", properties: {}, required: [], additionalProperties: false };
    await anthropicAdapter.completeStructured({
      messages,
      schema,
      schemaName: "Thing",
      model: MODELS.sonnet,
      maxTokens: 64,
      effort: "max",
    });
    expect(sentParams().output_config).toEqual({
      format: { type: "json_schema", schema },
      effort: "max",
    });
  });

  it("sends no output_config when unset (structured keeps format only)", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64 });
    expect(sentParams()).not.toHaveProperty("output_config");
  });

  it("rides through the Fable beta path with the refusal fallback", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.fable, maxTokens: 64, effort: "high" });
    const params = sentParams(mocks.betaCreate);
    expect(params.output_config).toEqual({ effort: "high" });
    expect(params.betas).toEqual(["server-side-fallback-2026-06-01"]);
    expect(params.fallbacks).toEqual([{ model: MODELS.opus }]);
  });
});

describe("usage and served model", () => {
  it("exposes cache read and creation tokens on the result", async () => {
    const result = await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64 });
    expect(result.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 7,
      cacheCreationTokens: 3,
    });
  });

  it("reports the served model and whether a fallback ran", async () => {
    mocks.betaCreate.mockResolvedValue(response({ model: MODELS.opus }));
    const fell = await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.fable,
      maxTokens: 64,
    });
    expect(fell.model).toBe(MODELS.fable);
    expect(fell.servedModel).toBe(MODELS.opus);
    expect(fell.fallbackRan).toBe(true);

    mocks.betaCreate.mockResolvedValue(response({ model: MODELS.fable }));
    const same = await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.fable,
      maxTokens: 64,
    });
    expect(same.servedModel).toBe(MODELS.fable);
    expect(same.fallbackRan).toBe(false);

    // A dated snapshot of the requested alias is the same model, not a fallback.
    mocks.create.mockResolvedValue(response({ model: "claude-sonnet-5-20260401" }));
    const dated = await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
    });
    expect(dated.fallbackRan).toBe(false);
  });

  it("leaves both fields unset when the response names no model", async () => {
    mocks.create.mockResolvedValue(response({ model: undefined }));
    const result = await anthropicAdapter.completeWithTools({
      messages,
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
    });
    expect(result).not.toHaveProperty("servedModel");
    expect(result).not.toHaveProperty("fallbackRan");
  });
});

describe("moving history breakpoint on the tool path", () => {
  it("marks the last block of the last user message and leaves the caller's history untouched", async () => {
    const history = loopHistory();
    const before = JSON.parse(JSON.stringify(history));

    await anthropicAdapter.completeWithTools({
      messages: history,
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      system: "role",
    });

    const params = sentParams();
    expect(lastUserContent(params)).toEqual([
      { type: "tool_result", tool_use_id: "t1", content: "found", cache_control: EPHEMERAL },
    ]);
    // Earlier messages go out exactly as given.
    expect(params.messages.slice(0, 2)).toEqual(before.slice(0, 2));
    // Tools (1) + system (1) + history (1).
    expect(countBreakpoints(params)).toBe(3);
    // The breakpoint was added on a copy, never on the caller's array.
    expect(history).toEqual(before);
  });

  it("turns a string user message into a cached text block", async () => {
    await anthropicAdapter.completeWithTools({
      messages: [{ role: "user", content: "go" }],
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
    });
    expect(sentParams().messages).toEqual([
      { role: "user", content: [{ type: "text", text: "go", cache_control: EPHEMERAL }] },
    ]);
  });

  it("fits two system blocks beside the tool list and the history (four in all)", async () => {
    await anthropicAdapter.completeWithTools({
      messages: loopHistory(),
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["role", "skill"],
    });
    const params = sentParams();
    expect(countBreakpoints(params)).toBe(4);
    expect(lastUserContent(params)[0].cache_control).toEqual(EPHEMERAL);
  });

  it("drops the history breakpoint, not a system one, at three system blocks", async () => {
    await anthropicAdapter.completeWithTools({
      messages: loopHistory(),
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["role", "skill one", "skill two"],
    });
    const params = sentParams();
    expect(params.system.every((b: { cache_control?: unknown }) => b.cache_control)).toBe(true);
    expect(lastUserContent(params)[0]).not.toHaveProperty("cache_control");
    expect(countBreakpoints(params)).toBe(4);
  });

  it("never exceeds four breakpoints however many system blocks arrive", async () => {
    await anthropicAdapter.completeWithTools({
      messages: loopHistory(),
      tools: [TOOL],
      model: MODELS.sonnet,
      maxTokens: 64,
      system: ["a", "b", "c", "d", "e", "f"],
    });
    expect(countBreakpoints(sentParams())).toBe(4);
    expect(lastUserContent(sentParams())[0]).not.toHaveProperty("cache_control");
  });

  it("does not touch the single-shot paths", async () => {
    await anthropicAdapter.complete({ messages: loopHistory(), model: MODELS.sonnet, maxTokens: 64 });
    expect(lastUserContent(sentParams())[0]).not.toHaveProperty("cache_control");
  });
});

describe("completeWithToolsStreaming", () => {
  const longRun = {
    messages,
    tools: [TOOL],
    model: MODELS.fable,
    maxTokens: 200_000,
    fallbacks: "none" as const,
  };

  it("streams on the long-run client and reads the final message", async () => {
    const result = await anthropicAdapter.completeWithToolsStreaming(longRun);

    expect(mocks.betaStream).toHaveBeenCalledTimes(1);
    expect(mocks.betaCreate).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(result.content).toBe("hello");
    expect(result.servedModel).toBe(MODELS.fable);
    expect(result.fallbackRan).toBe(false);
    expect(result.usage.cacheReadTokens).toBe(7);

    // A second client, with the hour-long timeout and two retries.
    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0]).toMatchObject({ timeout: 3_600_000, maxRetries: 2 });
  });

  it("takes the long-run timeout from LLM_LONG_RUN_TIMEOUT_MS", async () => {
    process.env.LLM_LONG_RUN_TIMEOUT_MS = "120000";
    await anthropicAdapter.completeWithToolsStreaming(longRun);
    expect(mocks.constructed[0]).toMatchObject({ timeout: 120_000, maxRetries: 2 });
  });

  it("keeps the long-run client separate from the standard one", async () => {
    await anthropicAdapter.complete({ messages, model: MODELS.sonnet, maxTokens: 64 });
    await anthropicAdapter.completeWithToolsStreaming(longRun);
    expect(mocks.constructed.map((c) => c.timeout)).toEqual([180_000, 3_600_000]);
  });

  it("caps max_tokens at the streaming maximum and sends the tool breakpoint", async () => {
    await anthropicAdapter.completeWithToolsStreaming(longRun);
    const params = sentParams(mocks.betaStream);
    expect(params.max_tokens).toBe(LONG_RUN_MAX_OUTPUT_TOKENS);
    expect(params.tools[0].cache_control).toEqual(EPHEMERAL);
    // Fable rejects sampling params; and no betas or fallbacks unless asked.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("betas");
    expect(params).not.toHaveProperty("fallbacks");
    expect(params).not.toHaveProperty("output_config");
  });

  it("passes a smaller max_tokens through unchanged", async () => {
    await anthropicAdapter.completeWithToolsStreaming({ ...longRun, maxTokens: 4096 });
    expect(sentParams(mocks.betaStream).max_tokens).toBe(4096);
  });

  it("opts into the server-side fallback only when asked", async () => {
    await anthropicAdapter.completeWithToolsStreaming({ ...longRun, fallbacks: "server" });
    const params = sentParams(mocks.betaStream);
    expect(params.betas).toEqual(["server-side-fallback-2026-06-01"]);
    expect(params.fallbacks).toEqual([{ model: MODELS.opus }]);
  });

  it("sends effort and the task budget in output_config with the task-budgets beta", async () => {
    await anthropicAdapter.completeWithToolsStreaming({
      ...longRun,
      effort: "xhigh",
      taskBudgetTokens: 64_000,
    });
    const params = sentParams(mocks.betaStream);
    expect(params.output_config).toEqual({
      effort: "xhigh",
      task_budget: { type: "tokens", total: 64_000 },
    });
    expect(params.betas).toEqual([TASK_BUDGETS_BETA]);
  });

  it("appends caller betas after the derived ones, without duplicates", async () => {
    await anthropicAdapter.completeWithToolsStreaming({
      ...longRun,
      fallbacks: "server",
      taskBudgetTokens: 20_000,
      betas: ["compact-2026-01-12", "server-side-fallback-2026-06-01"],
    });
    expect(sentParams(mocks.betaStream).betas).toEqual([
      "server-side-fallback-2026-06-01",
      TASK_BUDGETS_BETA,
      "compact-2026-01-12",
    ]);
  });

  it("uses the same system blocks and history breakpoint as the tool path", async () => {
    await anthropicAdapter.completeWithToolsStreaming({
      ...longRun,
      messages: loopHistory(),
      system: ["role", "skill"],
    });
    const params = sentParams(mocks.betaStream);
    expect(params.system).toHaveLength(2);
    expect(lastUserContent(params)[0].cache_control).toEqual(EPHEMERAL);
    expect(countBreakpoints(params)).toBe(4);
  });

  it("threads the container and reports a fallback-served turn", async () => {
    mocks.betaStream.mockImplementation(() => ({
      finalMessage: async () =>
        response({
          model: MODELS.opus,
          container: { id: "cont_1" },
          content: [{ type: "tool_use", id: "t1", name: "search", input: { q: "x" } }],
          stop_reason: "tool_use",
        }),
    }));
    const result = await anthropicAdapter.completeWithToolsStreaming({ ...longRun, container: "cont_0" });
    expect(sentParams(mocks.betaStream).container).toBe("cont_0");
    expect(result.container).toBe("cont_1");
    expect(result.toolUses).toEqual([{ id: "t1", name: "search", input: { q: "x" } }]);
    expect(result.stopReason).toBe("tool_use");
    expect(result.fallbackRan).toBe(true);
  });

  it("throws LlmRefusalError when the streamed turn was refused", async () => {
    mocks.betaStream.mockImplementation(() => ({
      finalMessage: async () =>
        response({ content: [], stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } }),
    }));
    await expect(anthropicAdapter.completeWithToolsStreaming(longRun)).rejects.toThrow(LlmRefusalError);
  });
});
