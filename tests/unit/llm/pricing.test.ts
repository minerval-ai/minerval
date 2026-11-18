/**
 * The meter (src/llm/pricing.ts), against a fixed catalog: the prices
 * themselves come from the lists (price-sources.ts) and change without a
 * release, so these tests pin how a price is applied, not what it is. The
 * snapshot's own contents are checked for shape only, and model-guard.test.ts
 * checks that every model this deployment is configured to run has a price.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  costMicroUsd,
  formatMicroUsd,
  hasExplicitRates,
  priceCatalog,
  ratesForModel,
  usePriceCatalog,
} from "../../../src/llm/pricing.js";
import { PRICE_SNAPSHOT } from "../../../src/llm/price-snapshot.js";
import { implausible, type Catalog } from "../../../src/llm/price-sources.js";

const FIXTURE: Catalog = {
  "claude-opus-5-5": { provider: "anthropic", inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2, cacheWritePerMtok: 5, sources: ["openrouter", "litellm"] },
  "claude-opus-5": { provider: "anthropic", inputPerMtok: 5, outputPerMtok: 25, sources: ["litellm"] },
  "claude-haiku-4-5": { provider: "anthropic", inputPerMtok: 1, outputPerMtok: 5, cacheReadPerMtok: 0.1, cacheWritePerMtok: 1.25, sources: ["litellm"] },
  "claude-haiku-5-5": {
    provider: "anthropic",
    inputPerMtok: 0.1,
    outputPerMtok: 0.5,
    cacheReadPerMtok: 0.01,
    cacheWritePerMtok: 0.125,
    longPrompt: { overTokens: 100_000, inputPerMtok: 0.5, outputPerMtok: 2.5 },
    sources: ["openrouter", "litellm"],
  },
  "gpt-4.1": { provider: "openai", inputPerMtok: 2, outputPerMtok: 8, cacheReadPerMtok: 0.5, sources: ["litellm"] },
  "gpt-5": { provider: "openai", inputPerMtok: 1.25, outputPerMtok: 10, cacheReadPerMtok: 0.125, sources: ["litellm"] },
  "gpt-5-nano": { provider: "openai", inputPerMtok: 0.05, outputPerMtok: 0.4, sources: ["litellm"] },
  "gpt-5.6-terra": {
    provider: "openai",
    inputPerMtok: 2,
    outputPerMtok: 12,
    cacheReadPerMtok: 0.2,
    cacheWritePerMtok: 2.5,
    longPrompt: { overTokens: 272_000, inputPerMtok: 4, outputPerMtok: 18 },
    sources: ["openrouter", "litellm"],
  },
};

beforeEach(() => usePriceCatalog(FIXTURE));
afterEach(() => usePriceCatalog(null));

describe("the catalog the meter reads", () => {
  it("is the snapshot until a live catalog is read, and the live one after", () => {
    usePriceCatalog(null);
    expect(priceCatalog()).toEqual({ catalog: PRICE_SNAPSHOT, live: false });
    usePriceCatalog(FIXTURE);
    expect(priceCatalog()).toEqual({ catalog: FIXTURE, live: true });
  });

  it("finds a model's own entry, and a dated snapshot's family", () => {
    expect(ratesForModel("claude-opus-5-5")).toEqual({
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheReadMultiplier: 0.05,
      cacheWriteMultiplier: 1.25,
    });
    expect(ratesForModel("claude-opus-5").inputPerMtok).toBe(5);
    expect(ratesForModel("claude-haiku-4-5-20251001").inputPerMtok).toBe(1);
    expect(ratesForModel("gpt-5-nano-2025-08-07").outputPerMtok).toBe(0.4);
  });

  it("does not price a model as a sibling it merely starts with", () => {
    // Not "gpt-4.1"'s price, nor "claude-opus-5"'s: a model the lists do not
    // price is unknown, and meters at the fallback.
    expect(hasExplicitRates("gpt-4.1-nano")).toBe(false);
    expect(hasExplicitRates("claude-opus-5-6")).toBe(false);
    expect(ratesForModel("gpt-4.1-nano").inputPerMtok).toBe(10);
  });

  it("prices unknown models at the conservative fallback, never free", () => {
    const rates = ratesForModel("claude-hypothetical-9");
    expect(rates.inputPerMtok).toBe(10);
    expect(rates.outputPerMtok).toBe(50);
    expect(ratesForModel("gpt-9-hypothetical").inputPerMtok).toBe(10);
  });
});

describe("cost", () => {
  it("derives cost from all four token components at the listed cache rates", () => {
    const micro = costMicroUsd("claude-opus-5-5", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 4 + 20 + 0.2 + 5 = 29.2 USD
    expect(micro).toBe(29_200_000);
  });

  it("uses 0.1× reads and 1.25× Anthropic writes where no list states a cache rate", () => {
    const micro = costMicroUsd("claude-opus-5", {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 1_000_000,
      cacheCreationTokens: 1_000_000,
    });
    // 0.5 + 6.25 = 6.75 USD
    expect(micro).toBe(6_750_000);
  });

  it("bills no OpenAI cache write that no list prices, and a listed one at its price", () => {
    // gpt-5: no cache-write price listed — OpenAI billed none before GPT-5.6.
    const pre56 = costMicroUsd("gpt-5", {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 50_000,
    });
    // 0.125 + 0.0125 + 0 = 0.1375 USD
    expect(pre56).toBe(137_500);
    const gen56 = costMicroUsd("gpt-5.6-terra", {
      inputTokens: 100_000,
      outputTokens: 0,
      cacheReadTokens: 100_000,
      cacheCreationTokens: 50_000,
    });
    // 0.2 + 0.02 + 0.125 = 0.345 USD
    expect(gen56).toBe(345_000);
  });

  it("rounds to integer micro-USD for small calls", () => {
    const micro = costMicroUsd("claude-haiku-4-5-20251001", { inputTokens: 137, outputTokens: 42 });
    // 137/1e6*1 + 42/1e6*5 = 0.000347 USD = 347 μUSD
    expect(micro).toBe(347);
  });

  it("formats micro-USD for display", () => {
    expect(formatMicroUsd(22_050_000)).toBe("$22.0500");
    expect(formatMicroUsd(347)).toBe("$0.0003");
  });
});

describe("a price that depends on the prompt's length", () => {
  it("meters the base rate for a prompt at or under the threshold", () => {
    const micro = costMicroUsd("claude-haiku-5-5", {
      inputTokens: 40_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 40_000,
      cacheCreationTokens: 20_000,
    });
    // 0.004 + 0.5 + 0.0004 + 0.0025 = 0.5069 USD
    expect(micro).toBe(506_900);
  });

  it("meters the higher rate once the prompt, cache reads and writes included, passes it", () => {
    const micro = costMicroUsd("claude-haiku-5-5", {
      inputTokens: 40_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 50_000,
      cacheCreationTokens: 20_000,
    });
    // 0.02 + 2.5 + 0.0025 + 0.0125 = 2.535 USD
    expect(micro).toBe(2_535_000);
    expect(ratesForModel("claude-haiku-4-5-20251001").longPrompt).toBeUndefined();
  });
});

describe("provider-reported cost override", () => {
  it("uses the provider's number verbatim when present", () => {
    // An OpenRouter model has no catalog entry, so it would meter at the
    // conservative fallback — the reported cost must win instead.
    const micro = costMicroUsd("qwen/qwen3-235b-a22b", {
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      providerCostMicroUsd: 4321,
    });
    expect(micro).toBe(4321);
  });

  it("falls back to the fallback rate when the provider reported nothing", () => {
    expect(costMicroUsd("qwen/qwen3-235b-a22b", { inputTokens: 1_000_000, outputTokens: 0 })).toBe(10_000_000);
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

describe("the committed snapshot", () => {
  it("holds only believable prices for models routed to Anthropic or OpenAI, in order", () => {
    const ids = Object.keys(PRICE_SNAPSHOT);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
    for (const [id, price] of Object.entries(PRICE_SNAPSHOT)) {
      expect(/^(claude-|gpt-|o\d)/.test(id), id).toBe(true);
      expect(implausible(price), id).toBeNull();
      expect(price.sources.length, id).toBeGreaterThan(0);
    }
  });
});
