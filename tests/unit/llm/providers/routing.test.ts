import { describe, it, expect } from "vitest";

import {
  ACCEPTED_MODEL_ID_SHAPES,
  isSupportedModelId,
  providerForModel,
  resolveProvider,
  unresolvableModelIdMessage,
} from "../../../../src/llm/providers/routing.js";
import { MODELS } from "../../../../src/llm/models.js";

describe("resolveProvider — the routing table", () => {
  it("routes claude-* to Anthropic", () => {
    expect(resolveProvider(MODELS.fable)).toBe("anthropic");
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
