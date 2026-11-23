import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Claude on Amazon Bedrock and Google Vertex AI (providers/bedrock.ts,
 * providers/vertex.ts): the Anthropic adapter with each cloud's client.
 * Bedrock is tested at the transport, with a Bedrock API key so no request
 * is signed; Vertex at its client, since its credentials are Google's.
 */
const fetchMock = vi.fn();
const meterLlmUsage = vi.fn();
const vertexCreate = vi.fn();
const vertexOptions: unknown[] = [];

const config = {
  anthropicApiKey: "",
  bedrockRegion: "eu-west-1",
  bedrockApiKey: "test-bedrock-key",
  vertexRegion: "global",
  vertexProjectId: "an-evaluator-project",
};

vi.mock("../../../../src/config.js", () => ({ loadConfig: () => config }));

vi.mock("../../../../src/services/usage-service.js", () => ({
  meterLlmUsage: (...args: unknown[]) => meterLlmUsage(...args),
  meterExternalUsage: vi.fn(),
}));

vi.mock("../../../../src/llm/budget-tracker.js", () => ({
  checkBudget: vi.fn(),
  recordUsage: vi.fn(),
}));

vi.mock("@anthropic-ai/vertex-sdk", () => ({
  AnthropicVertex: class {
    messages = { create: (params: unknown) => vertexCreate(params) };
    constructor(options: unknown) {
      vertexOptions.push(options);
    }
  },
}));

import { bedrockAdapter, resetBedrockClient } from "../../../../src/llm/providers/bedrock.js";
import { resetVertexClient, vertexAdapter } from "../../../../src/llm/providers/vertex.js";

function message(model: string) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "hello" }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5, cache_creation_input_tokens: 0 },
  };
}

beforeEach(() => {
  fetchMock.mockReset();
  meterLlmUsage.mockReset();
  vertexCreate.mockReset();
  vertexOptions.length = 0;
  vi.stubGlobal("fetch", fetchMock);
  config.bedrockRegion = "eu-west-1";
  config.vertexRegion = "global";
  resetBedrockClient();
  resetVertexClient();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Claude on Amazon Bedrock", () => {
  const MODEL = "bedrock:eu.anthropic.claude-opus-5-5-v1:0";

  it("sends Bedrock's id, without the prefix, to the region's runtime, and meters the id as configured", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(JSON.stringify(message("eu.anthropic.claude-opus-5-5-v1:0")), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
    );
    const result = await bedrockAdapter.complete({
      model: MODEL,
      maxTokens: 50,
      messages: [{ role: "user", content: "hi" }],
      system: "be brief",
    });

    expect(result.content).toBe("hello");
    expect(result.model).toBe(MODEL);
    const [url, init] = fetchMock.mock.calls[0]! as [string | URL, RequestInit];
    const href = String(url);
    expect(href).toContain("bedrock-runtime.eu-west-1.amazonaws.com");
    expect(decodeURIComponent(href)).toContain("/model/eu.anthropic.claude-opus-5-5-v1:0/invoke");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    // The model is in the path, not the body, and the system prompt keeps its cache breakpoint.
    expect(body.model).toBeUndefined();
    expect(body.system).toEqual([{ type: "text", text: "be brief", cache_control: { type: "ephemeral" } }]);
    // Opus 5.5 takes no temperature, on Bedrock as on Anthropic.
    expect(body.temperature).toBeUndefined();

    expect(meterLlmUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "bedrock", model: MODEL, inputTokens: 100, cacheReadTokens: 5 })
    );
  });

  it("says what to set when no region is configured, before anything is sent", async () => {
    config.bedrockRegion = "";
    await expect(
      bedrockAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow(/BEDROCK_REGION/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Claude on Google Vertex AI", () => {
  const MODEL = "vertex:claude-sonnet-4-5@20250929";

  it("makes its client with the region and project, sends Vertex's id, and meters the id as configured", async () => {
    vertexCreate.mockResolvedValue(message("claude-sonnet-4-5@20250929"));
    const result = await vertexAdapter.complete({
      model: MODEL,
      maxTokens: 50,
      messages: [{ role: "user", content: "hi" }],
    });

    expect(result.content).toBe("hello");
    expect(vertexOptions[0]).toMatchObject({ region: "global", projectId: "an-evaluator-project" });
    const params = vertexCreate.mock.calls[0]![0] as Record<string, unknown>;
    expect(params.model).toBe("claude-sonnet-4-5@20250929");
    // Sonnet 4.5 takes a temperature, judged by the Claude model the id names.
    expect(params.temperature).toBe(0);
    expect(meterLlmUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "vertex", model: MODEL }));
  });

  it("says what to set when no region is configured", async () => {
    config.vertexRegion = "";
    await expect(
      vertexAdapter.complete({ model: MODEL, maxTokens: 10, messages: [{ role: "user", content: "hi" }] })
    ).rejects.toThrow(/VERTEX_REGION/);
    expect(vertexCreate).not.toHaveBeenCalled();
  });
});
