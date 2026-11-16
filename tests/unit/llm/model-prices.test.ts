/**
 * Prices a deployment states for itself (src/llm/model-prices.ts), how the
 * meter uses them (src/llm/pricing.ts), and the refusal of a model with no
 * price where a deployment creates its own owls.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { parseModelPrices } from "../../../src/llm/model-prices.js";

const ENV = ["MODEL_PRICES", "OWLS", "READS", "STEWARD_MODEL", "STRIPE_SECRET_KEY"];
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
  vi.resetModules();
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

describe("MODEL_PRICES", () => {
  it("is empty by default", () => {
    expect(parseModelPrices("")).toEqual({ prices: [], problems: [] });
    expect(parseModelPrices("  ")).toEqual({ prices: [], problems: [] });
  });

  it("reads a list of prices, with the cache multipliers where given", () => {
    const { prices, problems } = parseModelPrices(
      JSON.stringify([
        { model: "gpt-oss-120b", inputUsdPerMtok: 0.5, outputUsdPerMtok: 1.5 },
        { model: "claude-opus-5-5", inputUsdPerMtok: 3, outputUsdPerMtok: 15, cacheReadMultiplier: 0.2 },
      ])
    );
    expect(problems).toEqual([]);
    expect(prices).toEqual([
      { model: "gpt-oss-120b", inputUsdPerMtok: 0.5, outputUsdPerMtok: 1.5 },
      { model: "claude-opus-5-5", inputUsdPerMtok: 3, outputUsdPerMtok: 15, cacheReadMultiplier: 0.2 },
    ]);
  });

  it("accepts a price of zero: a deployment that counts a model as free says so", () => {
    const { prices, problems } = parseModelPrices(
      '[{"model":"gpt-local","inputUsdPerMtok":0,"outputUsdPerMtok":0}]'
    );
    expect(problems).toEqual([]);
    expect(prices).toHaveLength(1);
  });

  it("says what is wrong in words an installer can act on", () => {
    expect(parseModelPrices("{not json").problems[0]).toMatch(/MODEL_PRICES is not valid JSON/);
    expect(parseModelPrices('{"model":"x"}').problems[0]).toMatch(/must be a JSON list/);
    const { prices, problems } = parseModelPrices(
      JSON.stringify([
        { model: "gpt-a", inputUsdPerMtok: 1 },
        { model: "gpt-b", inputUsdPerMtok: 1, outputUsdPerMtok: 2, perToken: 3 },
        { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
        { model: "gpt-c", inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
        { model: "gpt-c", inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
        { model: "gpt-d", inputUsdPerMtok: -1, outputUsdPerMtok: 2 },
      ])
    );
    expect(prices.map((p) => p.model)).toEqual(["gpt-c"]);
    expect(problems).toHaveLength(5);
    expect(problems[0]).toMatch(/entry 1 \("gpt-a"\) needs "inputUsdPerMtok" and "outputUsdPerMtok"/);
    expect(problems[1]).toMatch(/"perToken", which is not a field of a price/);
    expect(problems[2]).toMatch(/entry 3 needs a "model"/);
    expect(problems[3]).toMatch(/states a price for "gpt-c" more than once/);
    expect(problems[4]).toMatch(/entry 6 \("gpt-d"\) needs/);
  });

  it("fails the config load on a value that cannot be read", async () => {
    process.env.MODEL_PRICES = '[{"model":"gpt-a"}]';
    const { loadConfig } = await import("../../../src/config.js");
    // The message arrives inside the schema's list of issues.
    expect(() => loadConfig()).toThrow(/MODEL_PRICES entry 1 .* what a call to the model costs/);
  });
});

describe("a stated price in the meter", () => {
  it("prices a model the table does not know, in place of the fallback", async () => {
    process.env.MODEL_PRICES = '[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.hasExplicitRates("gpt-oss-120b")).toBe(true);
    expect(pricing.hasExplicitRates("gpt-oss-20b")).toBe(false);
    // A dated snapshot resolves to the model the price names.
    expect(pricing.costMicroUsd("gpt-oss-120b-2026-01-01", { inputTokens: 2_000_000, outputTokens: 1_000_000 })).toBe(
      2_500_000
    );
    // The default cache multipliers: reads 0.1 of the input price, writes 1.25.
    expect(
      pricing.costMicroUsd("gpt-oss-120b", {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 1_000_000,
        cacheCreationTokens: 1_000_000,
      })
    ).toBe(50_000 + 625_000);
  });

  it("wins over the table for a model the table knows, and keeps the table's cache multipliers", async () => {
    process.env.MODEL_PRICES = '[{"model":"claude-opus-5-5","inputUsdPerMtok":2,"outputUsdPerMtok":10}]';
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.ratesForModel("claude-opus-5-5")).toEqual({
      inputPerMtok: 2,
      outputPerMtok: 10,
      cacheReadMultiplier: 0.05,
    });
    // Another model of the family keeps the table's price.
    expect(pricing.ratesForModel("claude-opus-5").inputPerMtok).toBe(5);
  });

  it("takes the longest match among stated prices", async () => {
    process.env.MODEL_PRICES = JSON.stringify([
      { model: "gpt-oss", inputUsdPerMtok: 1, outputUsdPerMtok: 1 },
      { model: "gpt-oss-120b", inputUsdPerMtok: 3, outputUsdPerMtok: 3 },
    ]);
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.ratesForModel("gpt-oss-120b").inputPerMtok).toBe(3);
    expect(pricing.ratesForModel("gpt-oss-20b").inputPerMtok).toBe(1);
  });

  it("changes nothing where no price is stated", async () => {
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.ratesForModel("claude-hypothetical-9")).toEqual({ inputPerMtok: 10, outputPerMtok: 50 });
    expect(pricing.ratesForModel("claude-opus-5-5")).toEqual({
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheReadMultiplier: 0.05,
    });
  });
});

describe("a model with no price", () => {
  it("has one when the table, a stated price or its provider prices it", async () => {
    process.env.MODEL_PRICES = '[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.modelIsPriced("claude-sonnet-5-5")).toBe(true);
    expect(pricing.modelIsPriced("gpt-oss-120b")).toBe(true);
    // OpenRouter reports what each call cost.
    expect(pricing.modelIsPriced("qwen/qwen3-235b-a22b")).toBe(true);
    expect(pricing.modelIsPriced("claude-hypothetical-9")).toBe(false);
    expect(pricing.modelIsPriced("gpt-oss-20b")).toBe(false);
  });

  it("is still served on the public graph, at the fallback rate as before", async () => {
    const { getAdapter } = await import("../../../src/llm/providers/index.js");
    expect(getAdapter("claude-hypothetical-9").name).toBe("anthropic");
  });

  it("is refused before anything is sent where the deployment creates its own owls", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    const { getAdapter } = await import("../../../src/llm/providers/index.js");
    const pricing = await import("../../../src/llm/pricing.js");
    expect(() => getAdapter("gpt-oss-120b")).toThrow(pricing.ModelNotPricedError);
    expect(() => getAdapter("gpt-oss-120b")).toThrow(
      'The model "gpt-oss-120b" has no price in this deployment, so the call was refused before ' +
        "anything was sent. This deployment creates its own owls, and one owl covers one dollar " +
        "of metered cost at the prices it is configured with: a model with no price would run " +
        "uncounted. State its price in MODEL_PRICES, in US dollars per million input and output " +
        'tokens, for example [{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}], ' +
        "or use a model that has a price."
    );
    // A model with a price is served as anywhere.
    expect(getAdapter("claude-sonnet-5-5").name).toBe("anthropic");
    expect(getAdapter("qwen/qwen3-235b-a22b").name).toBe("openrouter");
  });

  it("is served there once its price is stated", async () => {
    process.env.READS = "members";
    process.env.OWLS = "created";
    process.env.MODEL_PRICES = '[{"model":"gpt-oss-120b","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';
    const { getAdapter } = await import("../../../src/llm/providers/index.js");
    expect(getAdapter("gpt-oss-120b").name).toBe("openai");
  });

  it("is named with its setting among the models a deployment is configured to run", async () => {
    process.env.STEWARD_MODEL = "gpt-oss-120b";
    const pricing = await import("../../../src/llm/pricing.js");
    expect(pricing.unpricedConfiguredModels()).toEqual([{ setting: "STEWARD_MODEL", model: "gpt-oss-120b" }]);
    vi.resetModules();
    process.env.MODEL_PRICES = '[{"model":"gpt-oss","inputUsdPerMtok":0.5,"outputUsdPerMtok":1.5}]';
    const priced = await import("../../../src/llm/pricing.js");
    expect(priced.unpricedConfiguredModels()).toEqual([]);
  });
});
