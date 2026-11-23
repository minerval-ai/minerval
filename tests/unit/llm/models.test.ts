import { describe, it, expect } from "vitest";
import {
  MODELS,
  isAnthropicModelId,
  modelAcceptsTemperature,
  modelSupportsLongRun,
} from "../../../src/llm/models.js";

describe("model helpers", () => {
  it("recognizes Anthropic API ids and rejects Bedrock-prefixed ones", () => {
    expect(isAnthropicModelId("claude-sonnet-5")).toBe(true);
    expect(isAnthropicModelId("claude-opus-5-5")).toBe(true);
    expect(isAnthropicModelId("claude-opus-4-8")).toBe(true);
    expect(isAnthropicModelId("us.anthropic.claude-sonnet-5")).toBe(false);
  });

  it("allows temperature only for families known to accept it", () => {
    // Fable 5.1, Sonnet 5, and Opus 4.7+ reject non-default sampling params with
    // a 400 — and the client sends temperature: 0, which is non-default.
    expect(modelAcceptsTemperature(MODELS.frontier)).toBe(false);
    expect(modelAcceptsTemperature(MODELS.strong)).toBe(false);
    expect(modelAcceptsTemperature(MODELS.sonnet)).toBe(false);
    expect(modelAcceptsTemperature(MODELS.opus)).toBe(false);
    expect(modelAcceptsTemperature("claude-opus-4-7")).toBe(false);
    // Haiku 5.5 rejects it like the rest of the 5 family.
    expect(modelAcceptsTemperature(MODELS.haiku)).toBe(false);
    // Haiku 4.x and Sonnet 4.x still accept it.
    expect(modelAcceptsTemperature("claude-haiku-4-5-20251001")).toBe(true);
    expect(modelAcceptsTemperature("claude-sonnet-4-6")).toBe(true);
    // The allowlist is version-specific: a future family member is not assumed
    // to accept temperature until verified (#324's forward-compat hole — a
    // hypothetical claude-haiku-5 matching a bare "haiku" allowlist would 400
    // every Matcher run).
    expect(modelAcceptsTemperature("claude-haiku-5")).toBe(false);
    expect(modelAcceptsTemperature("claude-haiku-5-20270101")).toBe(false);
  });
});

describe("modelSupportsLongRun", () => {
  it("admits the strong-tier families only", () => {
    expect(modelSupportsLongRun(MODELS.frontier)).toBe(true);
    expect(modelSupportsLongRun(MODELS.strong)).toBe(true);
    expect(modelSupportsLongRun("claude-fable-5-1")).toBe(true);
    expect(modelSupportsLongRun("claude-fable-5")).toBe(true);
    expect(modelSupportsLongRun("claude-mythos-5-1")).toBe(true);
    expect(modelSupportsLongRun("claude-opus-5")).toBe(true);
    expect(modelSupportsLongRun(MODELS.opus)).toBe(false);
    expect(modelSupportsLongRun("claude-opus-4-7")).toBe(false);
    expect(modelSupportsLongRun(MODELS.sonnet)).toBe(false);
    expect(modelSupportsLongRun(MODELS.haiku)).toBe(false);
    expect(modelSupportsLongRun("gpt-5")).toBe(false);
    expect(modelSupportsLongRun("qwen/qwen3-235b-a22b")).toBe(false);
  });
});

describe("claudeModelName: Claude on Bedrock and Vertex is the same Claude", () => {
  it("names the Claude model a Bedrock or Vertex id is for", async () => {
    const { claudeModelName } = await import("../../../src/llm/models.js");
    expect(claudeModelName("claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(claudeModelName("bedrock:us.anthropic.claude-opus-5-5-v1:0")).toBe("claude-opus-5-5");
    expect(claudeModelName("bedrock:global.anthropic.claude-sonnet-5-5")).toBe("claude-sonnet-5-5");
    expect(claudeModelName("bedrock:anthropic.claude-sonnet-4-5-20250929-v1:0")).toBe("claude-sonnet-4-5-20250929");
    expect(claudeModelName("vertex:claude-sonnet-4-5@20250929")).toBe("claude-sonnet-4-5-20250929");
    expect(claudeModelName("vertex:claude-opus-5-5@default")).toBe("claude-opus-5-5");
    expect(claudeModelName("vertex:claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(claudeModelName("bedrock:meta.llama3-70b-instruct-v1:0")).toBeNull();
    expect(claudeModelName("vertex:gemini-3-pro")).toBeNull();
    expect(claudeModelName("anthropic/claude-opus-5-5")).toBeNull();
  });

  it("judges what a model can be sent by that Claude model", () => {
    expect(modelAcceptsTemperature("vertex:claude-sonnet-4-5@20250929")).toBe(true);
    expect(modelAcceptsTemperature("bedrock:us.anthropic.claude-opus-5-5-v1:0")).toBe(false);
    expect(modelSupportsLongRun("bedrock:us.anthropic.claude-opus-5-5-v1:0")).toBe(true);
    expect(modelSupportsLongRun("vertex:claude-fable-5-2")).toBe(true);
    expect(modelSupportsLongRun("vertex:claude-sonnet-5-5")).toBe(false);
  });
});
