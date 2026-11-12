import { describe, it, expect } from "vitest";

import {
  ACCEPTED_MODEL_ID_SHAPES,
  isSupportedModelId,
  parseEndpointModelId,
  providerForModel,
  resolveProvider,
  unresolvableModelIdMessage,
} from "../../../../src/llm/providers/routing.js";
import { MODELS } from "../../../../src/llm/models.js";

describe("resolveProvider — the routing table", () => {
  it("routes claude-* to Anthropic", () => {
    expect(resolveProvider(MODELS.strong)).toBe("anthropic");
    expect(resolveProvider(MODELS.sonnet)).toBe("anthropic");
    expect(resolveProvider(MODELS.haiku)).toBe("anthropic");
    expect(resolveProvider("claude-opus-4-8")).toBe("anthropic");
  });

  it("routes gpt-* and o<digit> to OpenAI", () => {
    expect(resolveProvider("gpt-5-nano")).toBe("openai");
    expect(resolveProvider("gpt-5.6-luna")).toBe("openai");
    expect(resolveProvider("gpt-4o")).toBe("openai");
    expect(resolveProvider("o3")).toBe("openai");
    expect(resolveProvider("o4-mini")).toBe("openai");
  });

  it("routes vendor/model to OpenRouter", () => {
    expect(resolveProvider("qwen/qwen3-235b-a22b")).toBe("openrouter");
    expect(resolveProvider("deepseek/deepseek-r1")).toBe("openrouter");
    // A slash always wins over the vendor's own naming — this is how you reach
    // an OpenAI or Anthropic model THROUGH OpenRouter.
    expect(resolveProvider("openai/gpt-5")).toBe("openrouter");
    expect(resolveProvider("anthropic/claude-sonnet-5")).toBe("openrouter");
  });

  it("resolves nothing for Bedrock-style IDs (issue #11)", () => {
    expect(resolveProvider("us.anthropic.claude-sonnet-4-20250514")).toBeNull();
    expect(resolveProvider("anthropic.claude-3-haiku")).toBeNull();
    expect(isSupportedModelId("us.anthropic.claude-sonnet-5")).toBe(false);
  });

  it("resolves nothing for other unrecognized shapes", () => {
    expect(resolveProvider("")).toBeNull();
    expect(resolveProvider("llama-3-70b")).toBeNull();
    expect(resolveProvider("gemini-2.5-pro")).toBeNull();
    expect(resolveProvider("mistral-large")).toBeNull();
  });
});

describe("error messages", () => {
  it("keeps the Bedrock-specific hint", () => {
    const message = unresolvableModelIdMessage("us.anthropic.claude-sonnet-5");
    expect(message).toContain("Bedrock");
    expect(message).toContain(ACCEPTED_MODEL_ID_SHAPES);
  });

  it("names the three accepted shapes for anything else", () => {
    const message = unresolvableModelIdMessage("llama-3-70b");
    expect(message).toContain("llama-3-70b");
    expect(message).toContain("claude-");
    expect(message).toContain("gpt-");
    expect(message).toContain("vendor/model");
  });

  it("providerForModel throws on an unresolvable id", () => {
    expect(() => providerForModel("llama-3-70b")).toThrow(/does not resolve/);
    expect(providerForModel("gpt-5-nano")).toBe("openai");
  });
});

describe("the endpoint shape: endpoint:<name>/<model>", () => {
  it("routes to the named endpoint, whatever the model after the first slash looks like", () => {
    expect(resolveProvider("endpoint:local/meta-llama/Llama-3.3-70B-Instruct")).toBe("endpoint:local");
    // Ollama's names carry a colon, and a model may be named like a hosted one.
    expect(resolveProvider("endpoint:gpu_2/llama3.3:70b")).toBe("endpoint:gpu_2");
    expect(resolveProvider("endpoint:local/claude-like")).toBe("endpoint:local");
    expect(resolveProvider("endpoint:local/gpt-oss-120b")).toBe("endpoint:local");
    expect(parseEndpointModelId("endpoint:local/meta-llama/Llama-3.3-70B-Instruct")).toEqual({
      endpoint: "local",
      model: "meta-llama/Llama-3.3-70B-Instruct",
    });
  });

  it("does not collide with the three hosted shapes", () => {
    // An open-weight name with no prefix is still an OpenRouter id, as before.
    expect(resolveProvider("meta-llama/llama-3.3-70b-instruct")).toBe("openrouter");
    // OpenRouter's variants put a colon after the slash, never before it.
    expect(resolveProvider("meta-llama/llama-3.3-70b-instruct:free")).toBe("openrouter");
    expect(parseEndpointModelId("meta-llama/llama-3.3-70b-instruct:free")).toBeNull();
    expect(parseEndpointModelId(MODELS.sonnet)).toBeNull();
    expect(parseEndpointModelId("gpt-5-nano")).toBeNull();
  });

  it("resolves nothing for a malformed endpoint id, and never falls through to OpenRouter", () => {
    for (const id of [
      "endpoint:local",
      "endpoint:/meta-llama/Llama-3.3-70B-Instruct",
      "endpoint:local/",
      "endpoint:Local/model",
      "endpoint:my endpoint/model",
    ]) {
      expect(resolveProvider(id), id).toBeNull();
      expect(isSupportedModelId(id), id).toBe(false);
    }
  });

  it("says how to write one when the id begins with the prefix", () => {
    const message = unresolvableModelIdMessage("endpoint:local");
    expect(message).toBe(
      '"endpoint:local" is not a complete endpoint model ID. Write "endpoint:<name>/<model>": the ' +
        'name of an endpoint declared in MODEL_ENDPOINTS (lower-case letters, digits, "-" and "_"), ' +
        "a slash, then the model as that endpoint knows it, for example " +
        '"endpoint:local/meta-llama/Llama-3.3-70B-Instruct".'
    );
    expect(() => providerForModel("endpoint:Local/x")).toThrow(/not a complete endpoint model ID/);
  });

  it("leaves the message for every other id as it was", () => {
    expect(unresolvableModelIdMessage("llama-3-70b")).toBe(
      '"llama-3-70b" does not resolve to a known provider. Use an Anthropic ID ("claude-…"), an ' +
        'OpenAI ID ("gpt-…" or "o3"), or an OpenRouter "vendor/model" ID (e.g. "qwen/qwen3-235b-a22b").'
    );
  });
});
