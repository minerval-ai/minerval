import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture requests at the SDK boundary so we can assert on exactly what the
// client sends (params, endpoint) per model family.
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

import {
  complete,
  completeStructured,
  completeStructuredList,
} from "../../../src/llm/client.js";
import { LlmRefusalError } from "../../../src/llm/errors.js";
import { MODELS } from "../../../src/llm/models.js";

const okResponse = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 10, output_tokens: 5 },
  stop_reason: "end_turn",
  container: null,
};

const messages = [{ role: "user" as const, content: "hi" }];

beforeEach(() => {
  createMock.mockReset().mockResolvedValue(okResponse);
  betaCreateMock.mockReset().mockResolvedValue(okResponse);
});

describe("complete() model routing", () => {
  it("routes Fable through the beta endpoint with the Opus refusal fallback", async () => {
    const result = await complete({ messages, model: MODELS.fable });

    expect(result.content).toBe("hello");
    expect(createMock).not.toHaveBeenCalled();
    const params = betaCreateMock.mock.calls[0]![0];
    expect(params.model).toBe(MODELS.fable);
    expect(params.betas).toEqual(["server-side-fallback-2026-06-01"]);
    expect(params.fallbacks).toEqual([{ model: MODELS.opus }]);
    // Fable rejects sampling params and any thinking config with a 400.
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("thinking");
  });

  it("omits temperature for Sonnet 5 (non-default values 400)", async () => {
    await complete({ messages, model: MODELS.sonnet, temperature: 0 });

    expect(betaCreateMock).not.toHaveBeenCalled();
    const params = createMock.mock.calls[0]![0];
    expect(params.model).toBe(MODELS.sonnet);
    expect(params).not.toHaveProperty("temperature");
    expect(params).not.toHaveProperty("fallbacks");
  });

  it("still sends temperature for Haiku", async () => {
    await complete({ messages, model: MODELS.haiku });

    const params = createMock.mock.calls[0]![0];
    expect(params.temperature).toBe(0);
  });
});

describe("completeStructured() native structured outputs", () => {
  const schema = {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
    additionalProperties: false,
  };

  it("sends output_config.format and parses JSON from the text block(s)", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      // JSON may arrive split across text blocks — concatenate before parsing.
      content: [
        { type: "text", text: '{"name": ' },
        { type: "text", text: '"Ada"}' },
      ],
    });

    const result = await completeStructured<{ name: string }>({
      messages,
      schema,
      schemaName: "Person",
      model: MODELS.sonnet,
    });

    expect(result).toEqual({ name: "Ada" });
    const params = createMock.mock.calls[0]![0];
    expect(params.output_config).toEqual({
      format: { type: "json_schema", schema },
    });
    // The legacy forced-"respond"-tool pattern is gone entirely.
    expect(params).not.toHaveProperty("tools");
    expect(params.system?.[0]?.text ?? "").not.toContain("respond");
  });

  it("throws LlmRefusalError on refusal before attempting to parse", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
    });

    await expect(
      completeStructured({ messages, schema, schemaName: "Person", model: MODELS.sonnet })
    ).rejects.toThrow(LlmRefusalError);
  });

  it("throws an actionable error when output is truncated at max_tokens", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [{ type: "text", text: '{"name": "Ad' }],
      stop_reason: "max_tokens",
    });

    await expect(
      completeStructured({
        messages,
        schema,
        schemaName: "Person",
        model: MODELS.sonnet,
        maxTokens: 128,
      })
    ).rejects.toThrow(/truncated at max_tokens \(128\)/);
  });

  it("throws a parse error naming the schema when the JSON is invalid", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [{ type: "text", text: "not json" }],
    });

    await expect(
      completeStructured({ messages, schema, schemaName: "Person", model: MODELS.sonnet })
    ).rejects.toThrow(/Structured response "Person" was not valid JSON/);
  });
});

describe("completeStructuredList() items wrapper", () => {
  const itemSchema = {
    type: "object",
    properties: { n: { type: "integer" } },
    required: ["n"],
    additionalProperties: false,
  };

  it("wraps the item schema in a strict object schema and unwraps items", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [{ type: "text", text: '{"items": [{"n": 1}, {"n": 2}]}' }],
    });

    const items = await completeStructuredList<{ n: number }>({
      messages,
      itemSchema,
      schemaName: "Num",
      model: MODELS.sonnet,
    });

    expect(items).toEqual([{ n: 1 }, { n: 2 }]);
    const params = createMock.mock.calls[0]![0];
    expect(params.output_config.format).toEqual({
      type: "json_schema",
      schema: {
        type: "object",
        properties: { items: { type: "array", items: itemSchema } },
        required: ["items"],
        additionalProperties: false,
      },
    });
  });

  it("throws an actionable error when the parsed object has no items array", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [{ type: "text", text: "{}" }],
    });

    await expect(
      completeStructuredList({ messages, itemSchema, schemaName: "Num", model: MODELS.sonnet })
    ).rejects.toThrow(/returned no items array/);
  });
});

describe("complete() refusal handling", () => {
  it("throws LlmRefusalError instead of returning empty content", async () => {
    createMock.mockResolvedValue({
      ...okResponse,
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber" },
    });

    await expect(complete({ messages, model: MODELS.sonnet })).rejects.toThrow(
      LlmRefusalError
    );
  });

  it("throws when the whole Fable fallback chain refused", async () => {
    betaCreateMock.mockResolvedValue({
      ...okResponse,
      content: [],
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: null },
    });

    await expect(complete({ messages, model: MODELS.fable })).rejects.toThrow(
      LlmRefusalError
    );
  });
});
