import { describe, expect, it } from "vitest";
import {
  implausible,
  parseLiteLlmPrices,
  parseOpenRouterModels,
  reconcile,
  vendorIdFromOpenRouter,
  type Catalog,
  type Listing,
  type ModelPrice,
} from "../../../src/llm/price-sources.js";

// Fixtures in the two lists' own shapes: prices per TOKEN, OpenRouter's as strings.
const openRouterBody = {
  data: [
    {
      id: "anthropic/claude-opus-5.5",
      pricing: { prompt: "0.000004", completion: "0.00002", input_cache_read: "0.0000002", input_cache_write: "0.000005" },
    },
    { id: "anthropic/claude-opus-5.5:batch", pricing: { prompt: "0.000002", completion: "0.00001" } },
    {
      id: "anthropic/claude-haiku-5.5",
      pricing: {
        prompt: "0.0000001",
        completion: "0.0000005",
        overrides: [{ min_prompt_tokens: 100000, prompt: "0.0000005", completion: "0.0000025" }],
      },
    },
    { id: "openai/gpt-5.6-sol", pricing: { prompt: "0.000004", completion: "0.00002" } },
    { id: "qwen/qwen3-235b-a22b", pricing: { prompt: "0.0000002", completion: "0.0000006" } },
    { id: "anthropic/claude-unpriced", pricing: {} },
  ],
};

const liteLlmBody = {
  "claude-opus-5-5": {
    litellm_provider: "anthropic",
    mode: "chat",
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    cache_read_input_token_cost: 2e-7,
  },
  "gpt-5.6-sol": {
    litellm_provider: "openai",
    mode: "chat",
    input_cost_per_token: 4e-6,
    output_cost_per_token: 2e-5,
    input_cost_per_token_above_272k_tokens: 8e-6,
    output_cost_per_token_above_272k_tokens: 3e-5,
  },
  "gpt-image-1": { litellm_provider: "openai", mode: "image_generation", input_cost_per_token: 5e-6, output_cost_per_token: 4e-5 },
  "anthropic/claude-opus-5-5": { litellm_provider: "anthropic", mode: "chat", input_cost_per_token: 1, output_cost_per_token: 1 },
  "ft:gpt-4o": { litellm_provider: "openai", mode: "chat", input_cost_per_token: 1, output_cost_per_token: 1 },
  sample_spec: { note: "not a model" },
};

const listings = (): Listing[] => [
  { source: "openrouter", prices: parseOpenRouterModels(openRouterBody) },
  { source: "litellm", prices: parseLiteLlmPrices(liteLlmBody) },
];

describe("reading the lists", () => {
  it("maps OpenRouter ids to the vendors' ids, and leaves out its own variants and other vendors", () => {
    expect(vendorIdFromOpenRouter("anthropic/claude-opus-5.5")).toBe("claude-opus-5-5");
    expect(vendorIdFromOpenRouter("openai/gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(vendorIdFromOpenRouter("anthropic/claude-opus-5.5:batch")).toBeNull();
    expect(vendorIdFromOpenRouter("qwen/qwen3-235b-a22b")).toBeNull();
    expect([...parseOpenRouterModels(openRouterBody).keys()].sort()).toEqual([
      "claude-haiku-5-5",
      "claude-opus-5-5",
      "gpt-5.6-sol",
    ]);
  });

  it("reads prices per Mtok, with cache rates and the long-prompt tier", () => {
    const or = parseOpenRouterModels(openRouterBody);
    expect(or.get("claude-opus-5-5")).toEqual({
      provider: "anthropic",
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheReadPerMtok: 0.2,
      cacheWritePerMtok: 5,
    });
    expect(or.get("claude-haiku-5-5")?.longPrompt).toEqual({ overTokens: 100_000, inputPerMtok: 0.5, outputPerMtok: 2.5 });
    const ll = parseLiteLlmPrices(liteLlmBody);
    expect([...ll.keys()].sort()).toEqual(["claude-opus-5-5", "gpt-5.6-sol"]);
    expect(ll.get("gpt-5.6-sol")?.longPrompt).toEqual({ overTokens: 272_000, inputPerMtok: 8, outputPerMtok: 30 });
  });

  it("fails loudly on a body that is not the list", () => {
    expect(() => parseOpenRouterModels({ error: "rate limited" })).toThrow(/no data array/);
    expect(() => parseLiteLlmPrices([])).toThrow(/not an object/);
  });
});

describe("reconciling", () => {
  it("prices a new model from the lists, taking each part from the list that states it", () => {
    const { catalog, changes, held } = reconcile({}, listings());
    expect(held).toEqual([]);
    expect(catalog["claude-opus-5-5"]).toEqual({
      provider: "anthropic",
      inputPerMtok: 4,
      outputPerMtok: 20,
      cacheReadPerMtok: 0.2,
      cacheWritePerMtok: 5,
      sources: ["openrouter", "litellm"],
    });
    // OpenRouter alone lists Haiku 5.5 here: a model with no price is priced from one list.
    expect(catalog["claude-haiku-5-5"]?.sources).toEqual(["openrouter"]);
    // The tier only LiteLLM states is kept.
    expect(catalog["gpt-5.6-sol"]?.longPrompt?.overTokens).toBe(272_000);
    expect(changes.map((c) => c.model)).toEqual(["claude-haiku-5-5", "claude-opus-5-5", "gpt-5.6-sol"]);
    expect(changes.every((c) => c.from === null)).toBe(true);
  });

  it("changes a price in force when both lists state the new one", () => {
    const previous: Catalog = {
      "claude-opus-5-5": { provider: "anthropic", inputPerMtok: 5, outputPerMtok: 25, sources: ["litellm"] },
    };
    const { catalog, changes } = reconcile(previous, listings());
    expect(catalog["claude-opus-5-5"]?.inputPerMtok).toBe(4);
    expect(changes.find((c) => c.model === "claude-opus-5-5")?.from?.inputPerMtok).toBe(5);
  });

  it("keeps a price in force that only one list has changed", () => {
    const previous: Catalog = {
      "claude-haiku-5-5": { provider: "anthropic", inputPerMtok: 1, outputPerMtok: 5, sources: ["openrouter"] },
    };
    const { catalog, changes, held } = reconcile(previous, listings());
    expect(catalog["claude-haiku-5-5"]?.inputPerMtok).toBe(1);
    expect(changes.some((c) => c.model === "claude-haiku-5-5")).toBe(false);
    expect(held).toEqual([{ model: "claude-haiku-5-5", reason: expect.stringMatching(/only openrouter lists the new price/) }]);
  });

  it("keeps the price in force where the lists disagree, and says on what", () => {
    const disagreeing: Listing[] = [
      { source: "openrouter", prices: new Map([["gpt-5.6-sol", price(4, 20)]]) },
      { source: "litellm", prices: new Map([["gpt-5.6-sol", price(5, 20)]]) },
    ];
    const previous: Catalog = { "gpt-5.6-sol": { ...price(5, 30), sources: ["litellm"] } };
    const { catalog, held } = reconcile(previous, disagreeing);
    expect(catalog["gpt-5.6-sol"]?.outputPerMtok).toBe(30);
    expect(held).toEqual([{ model: "gpt-5.6-sol", reason: "openrouter and litellm disagree on its input" }]);
  });

  it("refuses a listed price that is not believable, even for a new model", () => {
    const wrong: Listing[] = [
      { source: "openrouter", prices: new Map([["gpt-free", price(0, 0)], ["gpt-units", price(4_000_000, 20_000_000)]]) },
    ];
    const { catalog, held } = reconcile({}, wrong);
    expect(catalog).toEqual({});
    expect(held.map((h) => h.model)).toEqual(["gpt-free", "gpt-units"]);
    expect(implausible(price(4, 20))).toBeNull();
    expect(implausible({ ...price(4, 20), cacheReadPerMtok: 400 })).toMatch(/cache read/);
  });

  it("keeps a model the lists no longer carry, and records the lists that state each price", () => {
    const previous: Catalog = {
      "claude-opus-4-1": { provider: "anthropic", inputPerMtok: 15, outputPerMtok: 75, sources: ["litellm"] },
      "claude-opus-5-5": { provider: "anthropic", inputPerMtok: 4, outputPerMtok: 20, cacheReadPerMtok: 0.2, cacheWritePerMtok: 5, sources: ["litellm"] },
    };
    const { catalog, changes } = reconcile(previous, listings());
    expect(catalog["claude-opus-4-1"]?.inputPerMtok).toBe(15);
    // The same price: not a change, but now known to both lists.
    expect(changes.some((c) => c.model === "claude-opus-5-5")).toBe(false);
    expect(catalog["claude-opus-5-5"]?.sources).toEqual(["openrouter", "litellm"]);
    expect(Object.keys(catalog)).toEqual([...Object.keys(catalog)].sort());
  });
});

function price(input: number, output: number): ModelPrice {
  return { provider: "openai", inputPerMtok: input, outputPerMtok: output };
}
