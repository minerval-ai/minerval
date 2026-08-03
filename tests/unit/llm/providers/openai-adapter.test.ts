import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mock the transport, not the SDK: the adapter's OpenAI client is constructed
// with `(...args) => fetch(...args)`, which resolves the global at call time,
// so stubbing global fetch exercises the SDK's real request construction.
const fetchMock = vi.fn();

const meterLlmUsage = vi.fn();

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({
    openaiApiKey: "test-openai-key",
    anthropicApiKey: "",
    openrouterApiKey: "",
    publicWebBaseUrl: "https://minerval.ai",
  }),
}));

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterLlmUsage: (...args: unknown[]) => meterLlmUsage(...args),
}));

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

import { LlmRefusalError } from "../../../../src/llm/errors.js";
import {
  openaiAcceptsTemperature,
  openaiAdapter,
  resetOpenAiClient,
} from "../../../../src/llm/providers/openai.js";
import { withAgent } from "../../../../src/llm/usage-context.js";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Queue a canned completion. A Response body can only be read once, so this
 * builds a fresh one per call rather than resolving a shared instance.
 */
function respondWith(body: unknown): void {
  fetchMock.mockImplementation(async () => jsonResponse(body));
}

/** The body the SDK actually put on the wire for the Nth call. */
function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl_1",
    model: "gpt-5-nano",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: "hello", refusal: null },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    ...overrides,
  };
}

const messages: Anthropic.MessageParam[] = [{ role: "user", content: "hi" }];

const CLIENT_TOOL = {
  name: "search_claims",
  description: "Search the graph",
  input_schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
} as unknown as Anthropic.Messages.ToolUnion;

beforeEach(() => {
  resetOpenAiClient();
  meterLlmUsage.mockReset();
  fetchMock.mockReset();
  respondWith(completion());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai adapter — request construction", () => {
  it("posts to the chat completions endpoint with max_completion_tokens", async () => {
    await openaiAdapter.complete({
      messages,
      model: "gpt-5-nano",
      maxTokens: 512,
      system: "be terse",
    });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("api.openai.com");
    expect(url).toContain("/chat/completions");

    const body = sentBody();
    expect(body.model).toBe("gpt-5-nano");
    // Reasoning tokens count against this; `max_tokens` is deprecated and is
    // rejected outright by reasoning models.
    expect(body.max_completion_tokens).toBe(512);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body.messages).toEqual([
      { role: "system", content: "be terse" },
      { role: "user", content: "hi" },
    ]);
  });

  it("omits temperature for reasoning models and sends it for gpt-4o", async () => {
    expect(openaiAcceptsTemperature("gpt-5-nano")).toBe(false);
    expect(openaiAcceptsTemperature("o3")).toBe(false);
    expect(openaiAcceptsTemperature("gpt-4o")).toBe(true);

    await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64, temperature: 0 });
    expect(sentBody()).not.toHaveProperty("temperature");

    fetchMock.mockClear();
    await openaiAdapter.complete({ messages, model: "gpt-4o", maxTokens: 64, temperature: 0 });
    expect(sentBody().temperature).toBe(0);
  });

  it("sets a stable prompt_cache_key from the ambient agent context", async () => {
    await withAgent("steward", () =>
      openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    );
    expect(sentBody().prompt_cache_key).toBe("minerval:steward");

    fetchMock.mockClear();
    await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 });
    expect(sentBody()).not.toHaveProperty("prompt_cache_key");
  });

  it("refuses Anthropic-only capabilities instead of sending a doomed request", async () => {
    const serverTool = {
      type: "web_search_20260209",
      name: "web_search",
    } as unknown as Anthropic.Messages.ToolUnion;

    await expect(
      openaiAdapter.completeWithTools({
        messages,
        model: "gpt-5-nano",
        maxTokens: 64,
        tools: [serverTool],
      })
    ).rejects.toThrow(/Anthropic-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openai adapter — response parsing", () => {
  it("returns text content and a normalized stop reason", async () => {
    const result = await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 });
    expect(result.content).toBe("hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
  });

  it("parses tool calls into ToolUse plus a round-trippable rawContent", async () => {
    respondWith(
      completion({
          choices: [
            {
              index: 0,
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                refusal: null,
                tool_calls: [
                  {
                    id: "call_abc",
                    type: "function",
                    function: { name: "search_claims", arguments: '{"q":"gravity"}' },
                  },
                ],
              },
            },
          ],
        })
    );

    const result = await openaiAdapter.completeWithTools({
      messages,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.toolUses).toEqual([
      { id: "call_abc", name: "search_claims", input: { q: "gravity" } },
    ]);
    // rawContent is what toolUseLoop appends back as the assistant turn.
    expect(result.rawContent).toEqual([
      { type: "tool_use", id: "call_abc", name: "search_claims", input: { q: "gravity" } },
    ]);
    expect(sentBody().tools).toEqual([
      {
        type: "function",
        function: {
          name: "search_claims",
          description: "Search the graph",
          parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        },
      },
    ]);
  });

  it("surfaces a refusal as LlmRefusalError", async () => {
    respondWith(
      completion({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: null, refusal: "I can't help with that" },
            },
          ],
        })
    );

    await expect(
      openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    ).rejects.toThrow(LlmRefusalError);
  });
});

describe("openai adapter — structured outputs", () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
    additionalProperties: false,
  };

  it("uses a native strict json_schema response format, not a respond tool", async () => {
    respondWith(
      completion({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: '{"verdict":"supported"}', refusal: null },
            },
          ],
        })
    );

    const result = await openaiAdapter.completeStructured<{ verdict: string }>({
      messages,
      schema,
      schemaName: "ClaimVerdict",
      model: "gpt-5-nano",
      maxTokens: 256,
    });

    expect(result).toEqual({ verdict: "supported" });
    const body = sentBody();
    expect(body).not.toHaveProperty("tools");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: { name: "ClaimVerdict", strict: true, schema },
    });
  });

  it("throws an actionable error on malformed JSON", async () => {
    respondWith(
      completion({
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "{not json", refusal: null },
            },
          ],
        })
    );

    await expect(
      openaiAdapter.completeStructured({
        messages,
        schema,
        schemaName: "ClaimVerdict",
        model: "gpt-5-nano",
        maxTokens: 256,
      })
    ).rejects.toThrow(/"ClaimVerdict" was not valid JSON/);
  });

  it("names the truncation cause when the response hit the token ceiling", async () => {
    respondWith(
      completion({
          choices: [
            {
              index: 0,
              finish_reason: "length",
              message: { role: "assistant", content: '{"verdict":"sup', refusal: null },
            },
          ],
        })
    );

    await expect(
      openaiAdapter.completeStructured({
        messages,
        schema,
        schemaName: "ClaimVerdict",
        model: "gpt-5-nano",
        maxTokens: 256,
      })
    ).rejects.toThrow(/truncated at max_tokens \(256\)/);
  });
});

describe("openai adapter — metering", () => {
  it("records the provider and uncached input tokens", async () => {
    respondWith(
      completion({
          usage: {
            prompt_tokens: 1000,
            completion_tokens: 20,
            total_tokens: 1020,
            prompt_tokens_details: { cached_tokens: 900 },
          },
        })
    );

    await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 });

    expect(meterLlmUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5-nano",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 900,
      cacheCreationTokens: 0,
      providerCostMicroUsd: undefined,
    });
  });
});

describe("openai adapter — configuration", () => {
  it("fails with a config error, not a 401, when no key is set", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/config.js", () => ({
      loadConfig: () => ({ openaiApiKey: "" }),
    }));
    const mod = await import("../../../../src/llm/providers/openai.js");
    mod.resetOpenAiClient();

    await expect(
      mod.openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    ).rejects.toThrow(/OPENAI_API_KEY is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doUnmock("../../../../src/config.js");
    vi.resetModules();
  });
});
