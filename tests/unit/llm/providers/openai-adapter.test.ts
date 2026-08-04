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
 * Queue a canned response. A Response body can only be read once, so this
 * builds a fresh one per call rather than resolving a shared instance.
 */
function respondWith(body: unknown): void {
  fetchMock.mockImplementation(async () => jsonResponse(body));
}

/** Queue one canned response per call, in order (for multi-turn tool loops). */
function respondInSequence(bodies: unknown[]): void {
  let i = 0;
  fetchMock.mockImplementation(async () => jsonResponse(bodies[i++] ?? bodies.at(-1)));
}

/** The body the SDK actually put on the wire for the Nth call. */
function sentBody(call = 0): Record<string, any> {
  const init = fetchMock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, any>;
}

// --- Responses API item fixtures -------------------------------------------

function messageItem(text: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function refusalItem(refusal: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    status: "completed",
    content: [{ type: "refusal", refusal }],
  };
}

/** A reasoning item as returned with `include: ["reasoning.encrypted_content"]`. */
function reasoningItem(encrypted = "gAAAAA-encrypted-cot") {
  return {
    id: "rs_1",
    type: "reasoning",
    summary: [],
    content: [],
    encrypted_content: encrypted,
  };
}

function functionCallItem(callId = "call_abc", args = '{"q":"gravity"}') {
  return {
    id: "fc_1",
    type: "function_call",
    status: "completed",
    call_id: callId,
    name: "search_claims",
    arguments: args,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    id: "resp_1",
    object: "response",
    created_at: 1,
    status: "completed",
    error: null,
    incomplete_details: null,
    instructions: null,
    model: "gpt-5-nano",
    output: [messageItem("hello")],
    parallel_tool_calls: true,
    tool_choice: "auto",
    tools: [],
    usage: {
      input_tokens: 100,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
      output_tokens: 20,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 120,
    },
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
  respondWith(response());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openai adapter — request construction", () => {
  it("posts to the responses endpoint with max_output_tokens and store:false", async () => {
    await openaiAdapter.complete({
      messages,
      model: "gpt-5-nano",
      maxTokens: 512,
      system: "be terse",
    });

    const url = String(fetchMock.mock.calls[0]![0]);
    expect(url).toContain("api.openai.com");
    expect(url).toContain("/responses");
    expect(url).not.toContain("/chat/completions");

    const body = sentBody();
    expect(body.model).toBe("gpt-5-nano");
    // Reasoning tokens count against this; `max_tokens` / `max_completion_tokens`
    // are Chat Completions params and are rejected here.
    expect(body.max_output_tokens).toBe(512);
    expect(body).not.toHaveProperty("max_tokens");
    expect(body).not.toHaveProperty("max_completion_tokens");
    expect(body).not.toHaveProperty("messages");
    // Stateless: nothing retained server-side, no previous_response_id chasing.
    expect(body.store).toBe(false);
    expect(body).not.toHaveProperty("previous_response_id");
    // The system prompt is Responses-native `instructions`, not an input item.
    expect(body.instructions).toBe("be terse");
    expect(body.input).toEqual([{ role: "user", content: "hi" }]);
  });

  it("omits temperature for reasoning models and sends it for gpt-4o", async () => {
    expect(openaiAcceptsTemperature("gpt-5-nano")).toBe(false);
    expect(openaiAcceptsTemperature("gpt-5.6-luna")).toBe(false);
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

  it("asks for encrypted reasoning only where a turn can be replayed", async () => {
    // The tool loop replays assistant turns, so it needs the encrypted chain of
    // thought echoed back; the single-shot paths would just carry dead weight.
    await openaiAdapter.completeWithTools({
      messages,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });
    expect(sentBody().include).toEqual(["reasoning.encrypted_content"]);

    fetchMock.mockClear();
    await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 });
    expect(sentBody()).not.toHaveProperty("include");
  });

  it("builds flat Responses function tools (the slot hosted tools share)", async () => {
    await openaiAdapter.completeWithTools({
      messages,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    expect(sentBody().tools).toEqual([
      {
        type: "function",
        name: "search_claims",
        description: "Search the graph",
        parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
        strict: false,
      },
    ]);
    expect(sentBody().tool_choice).toBe("auto");
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

  it("maps an incomplete response to the seam's max_tokens stop reason", async () => {
    respondWith(
      response({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [reasoningItem()],
      })
    );

    const result = await openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 });
    expect(result.stopReason).toBe("max_tokens");
  });

  it("parses function_call items into ToolUse plus a replayable rawContent", async () => {
    respondWith(response({ output: [reasoningItem(), functionCallItem()] }));

    const result = await openaiAdapter.completeWithTools({
      messages,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    // No per-turn finish reason on this API: function_call items present on a
    // completed response IS the tool-use signal.
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolUses).toEqual([
      { id: "call_abc", name: "search_claims", input: { q: "gravity" } },
    ]);
    // rawContent is provider-opaque: one synthetic block carrying the output
    // items verbatim, so the next turn can replay them byte-for-byte.
    expect(result.rawContent).toEqual([
      {
        type: "openai_responses_items",
        items: [reasoningItem(), functionCallItem()],
      },
    ]);
  });

  it("surfaces a refusal content part as LlmRefusalError", async () => {
    respondWith(response({ output: [refusalItem("I can't help with that")] }));

    await expect(
      openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    ).rejects.toThrow(LlmRefusalError);
  });

  it("surfaces a content_filter stop as LlmRefusalError", async () => {
    respondWith(
      response({ status: "incomplete", incomplete_details: { reason: "content_filter" }, output: [] })
    );

    await expect(
      openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    ).rejects.toThrow(LlmRefusalError);
  });

  it("names the API's own error when a response fails outright", async () => {
    respondWith(
      response({ status: "failed", output: [], error: { code: "server_error", message: "boom" } })
    );

    await expect(
      openaiAdapter.complete({ messages, model: "gpt-5-nano", maxTokens: 64 })
    ).rejects.toThrow(/failed to generate a response: boom/);
  });
});

describe("openai adapter — reasoning round-trip through the tool loop", () => {
  it("replays reasoning items with encrypted_content in their original position", async () => {
    respondInSequence([
      response({ output: [reasoningItem(), functionCallItem()] }),
      response({ output: [reasoningItem("gAAAAA-second-turn"), messageItem("done")] }),
    ]);

    const first = await openaiAdapter.completeWithTools({
      messages,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    // Exactly what toolUseLoop appends (see src/llm/client.ts): the assistant
    // turn's rawContent, then tool results, then any budget notice text.
    const next: Anthropic.MessageParam[] = [
      ...messages,
      { role: "assistant", content: first.rawContent },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_abc", content: "42 claims" },
          { type: "text", text: "1 iteration left" },
        ] as unknown as Anthropic.MessageParam["content"],
      },
    ];

    const second = await openaiAdapter.completeWithTools({
      messages: next,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    const body = sentBody(1);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    expect(body.store).toBe(false);
    // The reasoning item is echoed VERBATIM, with encrypted_content, still
    // ahead of the function_call it reasoned into; the result follows keyed by
    // call_id; the trailing notice becomes its own message item after them.
    expect(body.input).toEqual([
      { role: "user", content: "hi" },
      reasoningItem(),
      functionCallItem(),
      { type: "function_call_output", call_id: "call_abc", output: "42 claims" },
      { role: "user", content: "1 iteration left" },
    ]);
    expect(body.input[1].encrypted_content).toBe("gAAAAA-encrypted-cot");

    expect(second.content).toBe("done");
    expect(second.stopReason).toBe("end_turn");
  });

  it("translates a hand-built Anthropic history that never came from this adapter", async () => {
    const handBuilt: Anthropic.MessageParam[] = [
      { role: "user", content: "hi" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "looking" },
          { type: "tool_use", id: "call_z", name: "search_claims", input: { q: "x" } },
        ] as unknown as Anthropic.MessageParam["content"],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_z", content: "none" },
        ] as unknown as Anthropic.MessageParam["content"],
      },
    ];

    await openaiAdapter.completeWithTools({
      messages: handBuilt,
      model: "gpt-5-nano",
      maxTokens: 64,
      tools: [CLIENT_TOOL],
    });

    expect(sentBody().input).toEqual([
      { role: "user", content: "hi" },
      { type: "function_call", call_id: "call_z", name: "search_claims", arguments: '{"q":"x"}' },
      { role: "assistant", content: "looking" },
      { type: "function_call_output", call_id: "call_z", output: "none" },
    ]);
  });
});

describe("openai adapter — structured outputs", () => {
  const schema = {
    type: "object",
    properties: { verdict: { type: "string" } },
    required: ["verdict"],
    additionalProperties: false,
  };

  it("uses a native strict json_schema text format, not a respond tool", async () => {
    respondWith(response({ output: [messageItem('{"verdict":"supported"}')] }));

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
    expect(body).not.toHaveProperty("response_format");
    expect(body.text).toEqual({
      format: { type: "json_schema", name: "ClaimVerdict", strict: true, schema },
    });
  });

  it("throws an actionable error on malformed JSON", async () => {
    respondWith(response({ output: [messageItem("{not json")] }));

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
      response({
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [messageItem('{"verdict":"sup')],
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

  it("fails on a refusal rather than parsing off-schema output", async () => {
    respondWith(response({ output: [refusalItem("no")] }));

    await expect(
      openaiAdapter.completeStructured({
        messages,
        schema,
        schemaName: "ClaimVerdict",
        model: "gpt-5-nano",
        maxTokens: 256,
      })
    ).rejects.toThrow(LlmRefusalError);
  });
});

describe("openai adapter — metering", () => {
  it("records the provider and uncached input tokens", async () => {
    // `input_tokens` is inclusive of cached AND cache-written tokens (verified
    // live against gpt-5-nano and gpt-5.6-luna), so the adapter subtracts both
    // to keep pricing.ts's components additive.
    respondWith(
      response({
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 900, cache_write_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 5 },
          total_tokens: 1020,
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

  it("subtracts cache writes too, so the 5.6 family bills them exactly once", async () => {
    respondWith(
      response({
        model: "gpt-5.6-luna",
        usage: {
          input_tokens: 4014,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 4011 },
          output_tokens: 5,
          output_tokens_details: { reasoning_tokens: 0 },
          total_tokens: 4019,
        },
      })
    );

    await openaiAdapter.complete({ messages, model: "gpt-5.6-luna", maxTokens: 64 });

    expect(meterLlmUsage).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-5.6-luna",
      inputTokens: 3,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheCreationTokens: 4011,
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
