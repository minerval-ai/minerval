import { describe, it, expect } from "vitest";
import {
  MODELS,
  isAnthropicModelId,
  modelAcceptsTemperature,
  modelNeedsRefusalFallback,
  modelSupportsLongRun,
} from "../../../src/llm/models.js";

describe("model helpers", () => {
  it("recognizes Anthropic API ids and rejects Bedrock-prefixed ones", () => {
    expect(isAnthropicModelId("claude-sonnet-5")).toBe(true);
    expect(isAnthropicModelId("claude-fable-5-1")).toBe(true);
    expect(isAnthropicModelId("claude-opus-4-8")).toBe(true);
    expect(isAnthropicModelId("us.anthropic.claude-sonnet-5")).toBe(false);
  });

  it("allows temperature only for families known to accept it", () => {
    // Fable 5.1, Sonnet 5, and Opus 4.7+ reject non-default sampling params with
    // a 400 — and the client sends temperature: 0, which is non-default.
    expect(modelAcceptsTemperature(MODELS.fable)).toBe(false);
    expect(modelAcceptsTemperature(MODELS.sonnet)).toBe(false);
    expect(modelAcceptsTemperature(MODELS.opus)).toBe(false);
    expect(modelAcceptsTemperature("claude-opus-4-7")).toBe(false);
    // Haiku 4.x and Sonnet 4.x still accept it.
    expect(modelAcceptsTemperature(MODELS.haiku)).toBe(true);
    expect(modelAcceptsTemperature("claude-sonnet-4-6")).toBe(true);
    // The allowlist is version-specific: a future family member is not assumed
    // to accept temperature until verified (#324's forward-compat hole — a
    // hypothetical claude-haiku-5 matching a bare "haiku" allowlist would 400
    // every Matcher run).
    expect(modelAcceptsTemperature("claude-haiku-5")).toBe(false);
    expect(modelAcceptsTemperature("claude-haiku-5-20270101")).toBe(false);
  });

  it("opts only the Fable/Mythos family into the refusal fallback", () => {
    expect(modelNeedsRefusalFallback(MODELS.fable)).toBe(true);
    expect(modelNeedsRefusalFallback("claude-mythos-5")).toBe(true);
    expect(modelNeedsRefusalFallback(MODELS.opus)).toBe(false);
    expect(modelNeedsRefusalFallback(MODELS.sonnet)).toBe(false);
    expect(modelNeedsRefusalFallback(MODELS.haiku)).toBe(false);
  });
});

describe("modelSupportsLongRun", () => {
  it("admits the strong-tier families only", () => {
    expect(modelSupportsLongRun(MODELS.fable)).toBe(true);
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
