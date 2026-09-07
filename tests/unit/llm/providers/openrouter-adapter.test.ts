import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

// Mock the transport, not the SDK — see openai-adapter.test.ts.
const fetchMock = vi.fn();
const meterLlmUsage = vi.fn();

vi.mock("../../../../src/config.js", () => ({
  loadConfig: () => ({
    openaiApiKey: "",
    anthropicApiKey: "",
    openrouterApiKey: "test-openrouter-key",
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

import {
  openrouterAdapter,
  resetOpenRouterClient,
} from "../../../../src/llm/providers/openrouter.js";

const MODEL = "qwen/qwen3-235b-a22b";

function respondWith(body: unknown): void {
  fetchMock.mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
  );
}

function sentBody(call = 0): Record<string, unknown> {
  const init = fetchMock.mock.calls[call]![1] as { body: string };
  return JSON.parse(init.body) as Record<string, unknown>;
}

function sentHeaders(call = 0): Record<string, string> {
  const init = fetchMock.mock.calls[call]![1] as { headers: Record<string, string> };
  const headers = init.headers;
  // Node's fetch init headers may be a plain object or a Headers instance.
  return headers instanceof Headers
    ? Object.fromEntries(headers.entries())
    : Object.fromEntries(
        Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)])
      );
}

function completion(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen_1",
    model: MODEL,
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

const schema = {
  type: "object",
  properties: { verdict: { type: "string" } },
  required: ["verdict"],
  additionalProperties: false,
};

function respondToolCall(args: string, overrides: Record<string, unknown> = {}) {
  return completion({
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          refusal: null,
          tool_calls: [
            { id: "call_1", type: "function", function: { name: "respond", arguments: args } },
          ],
        },
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  resetOpenRouterClient();
  meterLlmUsage.mockReset();
  fetchMock.mockReset();
  respondWith(completion());
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("openrouter adapter — request construction", () => {
  it("targets the OpenRouter base URL with attribution headers", async () => {
    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 128 });

    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      "https://openrouter.ai/api/v1/chat/completions"
    );
    const headers = sentHeaders();
    expect(headers["http-referer"]).toBe("https://minerval.ai");
    expect(headers["x-title"]).toBe("Minerval");
  });

  it("asks for the usage block so cost and cached tokens come back", async () => {
    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 128 });
    expect(sentBody().usage).toEqual({ include: true });
    expect(sentBody().max_tokens).toBe(128);
  });

  it("only sends temperature when a caller explicitly asked for one", async () => {
    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 128 });
    expect(sentBody()).not.toHaveProperty("temperature");

    fetchMock.mockClear();
    await openrouterAdapter.complete({
      messages,
      model: MODEL,
      maxTokens: 128,
      temperature: 0.5,
    });
    expect(sentBody().temperature).toBe(0.5);
  });

  it("rejects Anthropic server tools", async () => {
    const serverTool = {
      type: "web_search_20260209",
      name: "web_search",
    } as unknown as Anthropic.Messages.ToolUnion;

    await expect(
      openrouterAdapter.completeWithTools({
        messages,
        model: MODEL,
        maxTokens: 128,
        tools: [serverTool],
      })
    ).rejects.toThrow(/Anthropic-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("openrouter adapter — structured outputs", () => {
  it("forces the respond tool call rather than a json_schema response format", async () => {
    respondWith(respondToolCall('{"verdict":"supported"}'));

    const result = await openrouterAdapter.completeStructured<{ verdict: string }>({
      messages,
      schema,
      schemaName: "ClaimVerdict",
      model: MODEL,
      maxTokens: 256,
    });

    expect(result).toEqual({ verdict: "supported" });
    const body = sentBody();
    expect(body).not.toHaveProperty("response_format");
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "respond" } });
    expect(body.tools).toEqual([
      {
        type: "function",
        function: {
          name: "respond",
          description: "Provide the response as a ClaimVerdict",
          parameters: schema,
        },
      },
    ]);
  });

  it("throws on malformed tool-call arguments", async () => {
    respondWith(respondToolCall("{not json"));

    await expect(
      openrouterAdapter.completeStructured({
        messages,
        schema,
        schemaName: "ClaimVerdict",
        model: MODEL,
        maxTokens: 256,
      })
    ).rejects.toThrow(/"ClaimVerdict".*was not valid JSON/);
  });

  it("names the model when it returns no tool call at all", async () => {
    respondWith(completion());

    await expect(
      openrouterAdapter.completeStructured({
        messages,
        schema,
        schemaName: "ClaimVerdict",
        model: MODEL,
        maxTokens: 256,
      })
    ).rejects.toThrow(
      /OpenRouter model "qwen\/qwen3-235b-a22b" did not return the forced "respond" tool call/
    );
  });
});

describe("openrouter adapter — metering", () => {
  it("passes the provider-reported cost through as an override", async () => {
    respondWith(
      completion({
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 200,
          total_tokens: 1200,
          prompt_tokens_details: { cached_tokens: 400 },
          cost: 0.001234,
        },
      })
    );

    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 128 });

    expect(meterLlmUsage).toHaveBeenCalledWith({
      provider: "openrouter",
      model: MODEL,
      inputTokens: 600,
      outputTokens: 200,
      cacheReadTokens: 400,
      cacheCreationTokens: 0,
      providerCostMicroUsd: 1234,
    });
  });

  it("omits the override when the response carries no cost", async () => {
    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 128 });
    expect(meterLlmUsage.mock.calls[0]![0]).toMatchObject({
      provider: "openrouter",
      providerCostMicroUsd: undefined,
    });
  });
});

describe("openrouter adapter — configuration", () => {
  it("fails with a config error, not a 401, when no key is set", async () => {
    vi.resetModules();
    vi.doMock("../../../../src/config.js", () => ({
      loadConfig: () => ({ openrouterApiKey: "", publicWebBaseUrl: "https://minerval.ai" }),
    }));
    const mod = await import("../../../../src/llm/providers/openrouter.js");
    mod.resetOpenRouterClient();

    await expect(
      mod.openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 64 })
    ).rejects.toThrow(/OPENROUTER_API_KEY is not configured/);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doUnmock("../../../../src/config.js");
    vi.resetModules();
  });
});

describe("openrouter adapter — system blocks", () => {
  it("joins a system array into one leading system message", async () => {
    respondWith(completion());
    await openrouterAdapter.complete({
      messages,
      model: MODEL,
      maxTokens: 64,
      system: ["constitution and role", "domain skill"],
    });
    const sent = sentBody().messages as Array<{ role: string; content: string }>;
    expect(sent[0]).toEqual({
      role: "system",
      content: "constitution and role\n\ndomain skill",
    });
    expect(sent.filter((m) => m.role === "system")).toHaveLength(1);
    expect(sent[1]).toEqual({ role: "user", content: "hi" });
  });

  it("ignores effort, which is Anthropic-only", async () => {
    respondWith(completion());
    await openrouterAdapter.complete({ messages, model: MODEL, maxTokens: 64, effort: "max" });
    expect(sentBody()).not.toHaveProperty("effort");
    expect(sentBody()).not.toHaveProperty("output_config");
  });
});
