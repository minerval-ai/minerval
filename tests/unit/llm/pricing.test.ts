import { describe, it, expect } from "vitest";
import {
  costMicroUsd,
  ratesForModel,
  formatMicroUsd,
} from "../../../src/llm/pricing.js";

describe("pricing", () => {
  it("resolves model families by prefix, including dated snapshots", () => {
    expect(ratesForModel("claude-opus-4-8")).toEqual({
      inputPerMtok: 5,
      outputPerMtok: 25,
    });
    expect(ratesForModel("claude-haiku-4-5-20251001")).toEqual({
      inputPerMtok: 1,
      outputPerMtok: 5,
    });
  });

  it("prices unknown models at the conservative fallback, never free", () => {
    const rates = ratesForModel("claude-hypothetical-9");
    expect(rates.inputPerMtok).toBeGreaterThan(0);
    expect(rates.outputPerMtok).toBeGreaterThan(0);
  });

  it("derives cost from all four token components", () => {
    // Sonnet 4.6: $3 in / $15 out per MTok; cache read 0.1×, write 1.25×.
    const micro = costMicroUsd("claude-sonnet-4-6", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 3 + 15 + 0.3 + 3.75 = 22.05 USD
    expect(micro).toBe(22_050_000);
  });

  it("rounds to integer micro-USD for small calls", () => {
    const micro = costMicroUsd("claude-haiku-4-5-20251001", {
      inputTokens: 137,
      outputTokens: 42,
    });
    // 137/1e6*1 + 42/1e6*5 = 0.000347 USD = 347 μUSD
    expect(micro).toBe(347);
  });

  it("formats micro-USD for display", () => {
    expect(formatMicroUsd(22_050_000)).toBe("$22.0500");
    expect(formatMicroUsd(347)).toBe("$0.0003");
  });
});

describe("OpenAI pricing", () => {
  it("resolves the longest matching prefix, not the family root", () => {
    expect(ratesForModel("gpt-5-nano").inputPerMtok).toBe(0.05);
    expect(ratesForModel("gpt-5-mini").inputPerMtok).toBe(0.25);
    expect(ratesForModel("gpt-5").inputPerMtok).toBe(1.25);
    expect(ratesForModel("gpt-5.4-mini").outputPerMtok).toBe(4.5);
    expect(ratesForModel("gpt-5.4").outputPerMtok).toBe(15);
    // Dated snapshots resolve to their family.
    expect(ratesForModel("gpt-5-nano-2025-08-07").outputPerMtok).toBe(0.4);
  });

  it("bills pre-5.6 cache writes as free and 5.6 cache writes at 1.25×", () => {
    // gpt-5: $1.25 in / $10 out. Cache reads 0.1×, cache writes FREE.
    const pre56 = costMicroUsd("gpt-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 1.25 + 0.125 + 0 = 1.375 USD
    expect(pre56).toBe(1_375_000);

    // gpt-5.6-terra: $2 in / $12 out. Cache reads 0.1×, cache writes 1.25×.
    const gen56 = costMicroUsd("gpt-5.6-terra", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 2 + 0.2 + 2.5 = 4.7 USD
    expect(gen56).toBe(4_700_000);
  });

  it("still prices an unlisted OpenAI-shaped model at the conservative fallback", () => {
    expect(ratesForModel("gpt-9-hypothetical").inputPerMtok).toBe(10);
  });
});

describe("provider-reported cost override", () => {
  it("uses the provider's number verbatim when present", () => {
    // An OpenRouter model resolves to no rate row, so the table would price it
    // at the conservative fallback — the reported cost must win instead.
    const micro = costMicroUsd("qwen/qwen3-235b-a22b", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      providerCostMicroUsd: 4321,
    });
    expect(micro).toBe(4321);
  });

  it("falls back to the table when the provider reported nothing", () => {
    const micro = costMicroUsd("qwen/qwen3-235b-a22b", {
      inputTokens: 1_000_000,
      outputTokens: 0,
    });
    expect(micro).toBe(10_000_000);
  });

  it("treats a reported zero cost as authoritative (free models exist)", () => {
    const micro = costMicroUsd("meta-llama/llama-3.3-70b-instruct:free", {
      inputTokens: 500_000,
      outputTokens: 500_000,
      providerCostMicroUsd: 0,
    });
    expect(micro).toBe(0);
  });
});
