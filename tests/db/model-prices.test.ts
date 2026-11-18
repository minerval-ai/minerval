/**
 * The live price catalog (src/services/model-price-service.ts) against a
 * real database, with the two price lists served by a stand-in fetch: what
 * a refresh stores, what the meter reads after it, that a price in force
 * changes only when both lists agree, and that two refreshes at once record
 * a change once.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { rawQuery } from "../../src/db/client.js";
import { LITELLM_PRICES_URL, OPENROUTER_MODELS_URL } from "../../src/llm/price-sources.js";
import { costMicroUsd, priceCatalog, ratesForModel, usePriceCatalog } from "../../src/llm/pricing.js";
import {
  loadModelPrices,
  MODEL_PRICES_FLAG,
  refreshLogLines,
  refreshModelPrices,
  storedModelPrices,
} from "../../src/services/model-price-service.js";

/** Prices per token, the way both lists write them. */
const perToken = (usdPerMtok: number) => usdPerMtok / 1e6;

interface Lists {
  openrouter?: Record<string, [number, number]> | "down";
  litellm?: Record<string, [number, number]> | "down";
}

/** A fetch that serves the two lists, each a map of vendor id to [input, output] per Mtok. */
function listsFetch(lists: Lists): typeof fetch {
  return (async (url: string | URL | Request) => {
    const href = String(url);
    if (href === OPENROUTER_MODELS_URL) {
      if (lists.openrouter === "down" || !lists.openrouter) return new Response("unavailable", { status: 503 });
      const data = Object.entries(lists.openrouter).map(([id, [i, o]]) => ({
        // OpenRouter spells Anthropic's version with a dot.
        id: id.startsWith("claude-") ? `anthropic/${id.replace(/-(\d+)-(\d+)$/, "-$1.$2")}` : `openai/${id}`,
        pricing: { prompt: String(perToken(i)), completion: String(perToken(o)) },
      }));
      return Response.json({ data });
    }
    if (href === LITELLM_PRICES_URL) {
      if (lists.litellm === "down" || !lists.litellm) return new Response("unavailable", { status: 503 });
      const body = Object.fromEntries(
        Object.entries(lists.litellm).map(([id, [i, o]]) => [
          id,
          {
            litellm_provider: id.startsWith("claude-") ? "anthropic" : "openai",
            mode: "chat",
            input_cost_per_token: perToken(i),
            output_cost_per_token: perToken(o),
          },
        ])
      );
      return Response.json(body);
    }
    throw new Error(`unexpected fetch of ${href}`);
  }) as typeof fetch;
}

async function clear(): Promise<void> {
  await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [MODEL_PRICES_FLAG]);
}

beforeEach(async () => {
  await clear();
  usePriceCatalog(null);
});
afterEach(() => usePriceCatalog(null));
afterAll(clear);

describe("refreshing the price catalog", () => {
  it("prices a new release from one list, stores the catalog over the snapshot, and meters at it", async () => {
    const r = await refreshModelPrices({
      fetchImpl: listsFetch({ openrouter: { "claude-opus-9-1": [3, 15] }, litellm: "down" }),
      now: new Date("2026-11-18T12:00:00Z"),
    });
    expect(r.written).toBe(true);
    expect(r.changes).toEqual([
      expect.objectContaining({ model: "claude-opus-9-1", from: null, sources: ["openrouter"] }),
    ]);
    expect(r.failures).toEqual([{ source: "litellm", error: expect.stringMatching(/503/) }]);
    expect(refreshLogLines(r).map((l) => l.text)).toEqual([
      "Model prices: claude-opus-9-1 priced at $3/$15 per Mtok (openrouter)",
      expect.stringMatching(/^Model prices: could not read litellm: /),
    ]);

    // This process meters at it at once...
    expect(priceCatalog().live).toBe(true);
    expect(costMicroUsd("claude-opus-9-1", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBe(18_000_000);

    // ...and another reads it from the row.
    usePriceCatalog(null);
    expect(ratesForModel("claude-opus-9-1").inputPerMtok).toBe(10); // the fallback, on the snapshot
    const stored = await loadModelPrices();
    expect(ratesForModel("claude-opus-9-1").inputPerMtok).toBe(3);
    expect(stored?.checked_at).toBe("2026-11-18T12:00:00.000Z");
    expect(stored?.sources).toEqual([
      { source: "litellm", ok: false, error: expect.stringMatching(/503/) },
      { source: "openrouter", ok: true },
    ]);
    // The snapshot's models are in the stored catalog too: it is a whole one.
    expect(Object.keys(stored!.catalog).length).toBeGreaterThan(20);
  });

  it("changes a price in force only when both lists state the new one", async () => {
    await refreshModelPrices({ fetchImpl: listsFetch({ openrouter: { "gpt-9-sol": [4, 20] } }) });

    const one = await refreshModelPrices({
      fetchImpl: listsFetch({ openrouter: { "gpt-9-sol": [2, 10] }, litellm: { "gpt-9-sol": [4, 20] } }),
    });
    expect(one.changes).toEqual([]);
    expect(one.held).toEqual([{ model: "gpt-9-sol", reason: "openrouter and litellm disagree on its input, output" }]);
    expect(ratesForModel("gpt-9-sol").inputPerMtok).toBe(4);

    const alone = await refreshModelPrices({
      fetchImpl: listsFetch({ openrouter: { "gpt-9-sol": [2, 10] }, litellm: "down" }),
    });
    expect(alone.held[0]?.reason).toMatch(/only openrouter lists the new price/);
    expect(ratesForModel("gpt-9-sol").inputPerMtok).toBe(4);

    const both = await refreshModelPrices({
      fetchImpl: listsFetch({ openrouter: { "gpt-9-sol": [2, 10] }, litellm: { "gpt-9-sol": [2, 10] } }),
    });
    expect(both.changes).toEqual([
      expect.objectContaining({ model: "gpt-9-sol", from: expect.objectContaining({ inputPerMtok: 4 }), to: expect.objectContaining({ inputPerMtok: 2 }) }),
    ]);
    expect(ratesForModel("gpt-9-sol").inputPerMtok).toBe(2);

    // The row keeps the changes, newest first.
    const stored = await storedModelPrices();
    expect(stored?.changes.map((c) => [c.model, c.from === null ? null : c.from.inputPerMtok, c.to.inputPerMtok])).toEqual([
      ["gpt-9-sol", 4, 2],
      ["gpt-9-sol", null, 4],
    ]);
  });

  it("says a standing hold once, not at every refresh", async () => {
    await refreshModelPrices({ fetchImpl: listsFetch({ openrouter: { "gpt-9-terra": [1, 5] } }) });
    const lists = listsFetch({ openrouter: { "gpt-9-terra": [2, 5] }, litellm: { "gpt-9-terra": [3, 5] } });
    const first = await refreshModelPrices({ fetchImpl: lists });
    const second = await refreshModelPrices({ fetchImpl: lists });
    expect(first.newlyHeld.map((h) => h.model)).toEqual(["gpt-9-terra"]);
    expect(second.held.map((h) => h.model)).toEqual(["gpt-9-terra"]);
    expect(second.newlyHeld).toEqual([]);
  });

  it("writes nothing when neither list can be read, and the meter keeps what it had", async () => {
    await refreshModelPrices({ fetchImpl: listsFetch({ openrouter: { "claude-opus-9-1": [3, 15] } }) });
    const r = await refreshModelPrices({ fetchImpl: listsFetch({ openrouter: "down", litellm: "down" }) });
    expect(r.written).toBe(false);
    expect(r.failures.map((f) => f.source).sort()).toEqual(["litellm", "openrouter"]);
    expect(ratesForModel("claude-opus-9-1").inputPerMtok).toBe(3);
    expect((await storedModelPrices())?.catalog["claude-opus-9-1"]?.inputPerMtok).toBe(3);
  });

  it("records a change once when two tasks refresh at the same moment", async () => {
    const lists = listsFetch({ openrouter: { "claude-opus-9-2": [6, 30] }, litellm: { "claude-opus-9-2": [6, 30] } });
    const [a, b] = await Promise.all([refreshModelPrices({ fetchImpl: lists }), refreshModelPrices({ fetchImpl: lists })]);
    expect(a.changes.length + b.changes.length).toBe(1);
    const stored = await storedModelPrices();
    expect(stored?.changes.filter((c) => c.model === "claude-opus-9-2")).toHaveLength(1);
  });

  it("leaves out a stored price that is not one, and stands the snapshot's in for it", async () => {
    await rawQuery(
      `INSERT INTO platform_flags (key, value) VALUES ($1, $2::jsonb)`,
      [
        MODEL_PRICES_FLAG,
        JSON.stringify({
          catalog: {
            "claude-opus-9-3": { provider: "anthropic", inputPerMtok: 0, outputPerMtok: 0, sources: ["openrouter"] },
            "claude-opus-9-4": { provider: "anthropic", inputPerMtok: 7, outputPerMtok: 35, sources: ["openrouter"] },
          },
          checked_at: "2026-11-18T00:00:00Z",
        }),
      ]
    );
    const stored = await loadModelPrices();
    expect(stored?.catalog["claude-opus-9-3"]).toBeUndefined();
    expect(ratesForModel("claude-opus-9-4").inputPerMtok).toBe(7);
    expect(ratesForModel("claude-opus-5-5").inputPerMtok).toBeGreaterThan(0);
  });
});
