import { describe, it, expect } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";

import {
  assertAnthropicOnlyCapabilitiesUnused,
  isServerTool,
  mapFinishReason,
  sanitizeSchemaName,
  toChatMessages,
  toChatTools,
  toStrictJsonSchema,
  usageFromCompletion,
} from "../../../../src/llm/providers/openai-dialect.js";

const CLIENT_TOOL = {
  name: "search_claims",
  description: "Search",
  input_schema: { type: "object", properties: {}, required: [] },
} as unknown as Anthropic.Messages.ToolUnion;

const SERVER_TOOL = {
  type: "web_search_20260209",
  name: "web_search",
} as unknown as Anthropic.Messages.ToolUnion;

describe("message translation", () => {
  it("maps a system prompt and plain string turns", () => {
    const out = toChatMessages(
      [{ role: "user", content: "hi" }],
      "you are a bot"
    );
    expect(out).toEqual([
      { role: "system", content: "you are a bot" },
      { role: "user", content: "hi" },
    ]);
  });

  it("round-trips an assistant tool_use turn into tool_calls", () => {
    const out = toChatMessages([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "thinking" },
          { type: "tool_use", id: "call_1", name: "search_claims", input: { q: "x" } },
        ] as unknown as Anthropic.ContentBlockParam[],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "call_1", content: "found" },
          { type: "text", text: "2 iterations left" },
        ] as unknown as Anthropic.ContentBlockParam[],
      },
    ]);

    expect(out[1]).toEqual({
      role: "assistant",
      content: "thinking",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "search_claims", arguments: '{"q":"x"}' },
        },
      ],
    });
    // The tool answer must come immediately after the call that asked for it,
    // with any sibling text following as its own user turn.
    expect(out[2]).toEqual({
      role: "tool",
      tool_call_id: "call_1",
      content: "found",
    });
    expect(out[3]).toEqual({ role: "user", content: "2 iterations left" });
  });

  it("rejects content blocks the OpenAI-compatible path cannot carry", () => {
    expect(() =>
      toChatMessages([
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "x" } },
          ] as unknown as Anthropic.ContentBlockParam[],
        },
      ])
    ).toThrow(/not supported on the OpenAI-compatible path/);
  });

  it("translates client tools into function tools", () => {
    expect(toChatTools([CLIENT_TOOL])).toEqual([
      {
        type: "function",
        function: {
          name: "search_claims",
          description: "Search",
          parameters: { type: "object", properties: {}, required: [] },
        },
      },
    ]);
  });
});

describe("Anthropic-only capabilities", () => {
  it("distinguishes server tools from client tools", () => {
    expect(isServerTool(SERVER_TOOL)).toBe(true);
    expect(isServerTool(CLIENT_TOOL)).toBe(false);
  });

  it("throws a capability error for server tools", () => {
    expect(() =>
      assertAnthropicOnlyCapabilitiesUnused("OpenAI", "gpt-5-nano", {
        tools: [CLIENT_TOOL, SERVER_TOOL],
      })
    ).toThrow(/Anthropic server tools \(web_search\).*Anthropic-only/s);
  });

  it("throws a capability error for containers", () => {
    expect(() =>
      assertAnthropicOnlyCapabilitiesUnused("OpenRouter", "qwen/qwen3", {
        container: "container_123",
      })
    ).toThrow(/Containers are Anthropic-only/);
  });

  it("passes when only client tools are used", () => {
    expect(() =>
      assertAnthropicOnlyCapabilitiesUnused("OpenAI", "gpt-5-nano", {
        tools: [CLIENT_TOOL],
      })
    ).not.toThrow();
  });
});

describe("finish reasons map to the seam's Anthropic vocabulary", () => {
  it("normalizes each case", () => {
    expect(mapFinishReason("stop")).toBe("end_turn");
    expect(mapFinishReason("length")).toBe("max_tokens");
    expect(mapFinishReason("tool_calls")).toBe("tool_use");
    expect(mapFinishReason("content_filter")).toBe("refusal");
    expect(mapFinishReason(null)).toBeNull();
  });
});

describe("strict JSON schema coercion", () => {
  it("closes every object and requires every property", () => {
    const strict = toStrictJsonSchema({
      type: "object",
      properties: {
        a: { type: "string" },
        nested: { type: "object", properties: { b: { type: "number" } } },
        list: { type: "array", items: { type: "object", properties: { c: { type: "string" } } } },
      },
      required: ["a"],
    }) as Record<string, unknown>;

    expect(strict.additionalProperties).toBe(false);
    expect(strict.required).toEqual(["a", "nested", "list"]);
    const nested = (strict.properties as Record<string, Record<string, unknown>>).nested;
    expect(nested.additionalProperties).toBe(false);
    expect(nested.required).toEqual(["b"]);
    const list = (strict.properties as Record<string, Record<string, unknown>>).list;
    expect((list.items as Record<string, unknown>).additionalProperties).toBe(false);
  });

  it("is idempotent on an already-compliant schema", () => {
    const schema = {
      type: "object",
      properties: { a: { type: ["string", "null"] } },
      required: ["a"],
      additionalProperties: false,
    };
    expect(toStrictJsonSchema(schema)).toEqual(schema);
  });
});

describe("usage normalization", () => {
  it("subtracts cached tokens out of prompt_tokens so components stay additive", () => {
    const usage = usageFromCompletion({
      prompt_tokens: 1000,
      completion_tokens: 50,
      total_tokens: 1050,
      prompt_tokens_details: { cached_tokens: 800 },
    } as never);

    expect(usage).toEqual({
      inputTokens: 200,
      outputTokens: 50,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
    });
  });

  it("reads cache_write_tokens when the model reports it", () => {
    const usage = usageFromCompletion({
      prompt_tokens: 1000,
      completion_tokens: 10,
      total_tokens: 1010,
      prompt_tokens_details: { cached_tokens: 600, cache_write_tokens: 300 },
    } as never);

    expect(usage.inputTokens).toBe(100);
    expect(usage.cacheCreationTokens).toBe(300);
  });

  it("handles a missing usage block", () => {
    expect(usageFromCompletion(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });
});

describe("schema names", () => {
  it("sanitizes to OpenAI's allowed character set", () => {
    expect(sanitizeSchemaName("ListOf ExtractedClaim!")).toBe("ListOf_ExtractedClaim_");
    expect(sanitizeSchemaName("")).toBe("response");
  });
});
