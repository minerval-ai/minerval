/**
 * Model pricing — the single source of truth for deriving a cost from token
 * counts at the metering chokepoint (client.ts → usage-service).
 *
 * Costs are stored in micro-USD (1e-6 USD) as integers, derived at insert time
 * so historical usage rows keep the price that was in effect when the tokens
 * were spent. A future credits ledger (Stripe metered billing, issue #70's
 * follow-up) decrements against these derived costs; changing a price here
 * only affects new rows.
 *
 * Rates are USD per million tokens, the vendors' list prices, and nobody
 * types them in. A running deployment reads two public price lists every
 * few hours and keeps what they agree on (price-sources.ts for the rules,
 * services/model-price-service.ts for the refresh); calls are metered at
 * that live catalog once this process has read it. Before then, and where
 * the lists cannot be reached, they are metered at the snapshot in
 * price-snapshot.ts, which `npm run prices:snapshot` writes from the same
 * lists by the same rules. A model the catalog does not know meters at the
 * fallback rate below.
 *
 * A cache read and a 5-minute cache write are priced as the lists state
 * them; where neither states one, a read is 0.1× input, an Anthropic write
 * 1.25×, and an OpenAI write nothing (OpenAI billed none before GPT-5.6).
 *
 * OpenRouter models are not (and need not be) in the catalog — hundreds of
 * third-party models with their own prices. That adapter reports the provider's
 * OWN computed cost, which overrides everything here; see
 * `UsageTokens.providerCostMicroUsd`.
 *
 * A deployment can state prices of its own in MODEL_PRICES (model-prices.ts):
 * for a model the catalog does not know, or in place of the catalog's for one
 * it does (a negotiated rate). A stated price wins over the catalog. Where a
 * deployment creates its own owls, a model with no price at all is refused
 * before it is called (assertModelPriced below); everywhere else an unknown
 * model meters at the fallback rate, as it always has.
 */
import { loadConfig } from "../config.js";
import { modelPriceExample, type StatedModelPrice } from "./model-prices.js";
import { PRICE_SNAPSHOT } from "./price-snapshot.js";
import type { Catalog, ModelPrice } from "./price-sources.js";
import { resolveProvider } from "./providers/routing.js";

interface ModelRates {
  /** USD per 1M uncached input tokens. */
  inputPerMtok: number;
  /** USD per 1M output tokens. */
  outputPerMtok: number;
  /** Multiple of the input rate charged for a cache READ. Default 0.1. */
  cacheReadMultiplier?: number;
  /** Multiple of the input rate charged for a cache WRITE. Default 1.25. */
  cacheWriteMultiplier?: number;
  /**
   * Higher rates for a request whose prompt is longer than `overTokens`,
   * where the vendor prices by prompt length. The prompt counts every input
   * token: uncached input, cache reads and cache writes. The cache
   * multipliers apply to these rates as to the base ones.
   */
  longPrompt?: { overTokens: number; inputPerMtok: number; outputPerMtok: number };
}

/** The live catalog, once this process has read it; until then, the snapshot. */
let liveCatalog: Catalog | null = null;

/**
 * Meter at this catalog from now on (services/model-price-service.ts sets
 * it when it reads the database). Null goes back to the snapshot.
 */
export function usePriceCatalog(catalog: Catalog | null): void {
  liveCatalog = catalog;
}

/** The catalog calls are metered at: the live one, or the snapshot before it is read. */
export function priceCatalog(): { catalog: Catalog; live: boolean } {
  return liveCatalog ? { catalog: liveCatalog, live: true } : { catalog: PRICE_SNAPSHOT, live: false };
}

/**
 * A catalog price as rates. The cache rates become multiples of the input
 * price; one no list states is left to the defaults, except an OpenAI cache
 * write, which OpenAI did not bill before GPT-5.6 (every model since lists
 * a price for it).
 */
function catalogRates(price: ModelPrice): ModelRates {
  const multiple = (x: number) => Math.round((x / price.inputPerMtok) * 1e9) / 1e9;
  const rates: ModelRates = { inputPerMtok: price.inputPerMtok, outputPerMtok: price.outputPerMtok };
  if (price.cacheReadPerMtok !== undefined) rates.cacheReadMultiplier = multiple(price.cacheReadPerMtok);
  if (price.cacheWritePerMtok !== undefined) rates.cacheWriteMultiplier = multiple(price.cacheWritePerMtok);
  else if (price.provider === "openai") rates.cacheWriteMultiplier = 0;
  if (price.longPrompt) rates.longPrompt = { ...price.longPrompt };
  return rates;
}

// Conservative default for unknown models: price at the top (Fable) tier — the
// most expensive Anthropic list price, above the strong tier's Opus 5.5 — so a
// new model ID never meters as free. Ops sees the unknown model in usage rows.
const FALLBACK_RATES: ModelRates = { inputPerMtok: 10, outputPerMtok: 50 };

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

/**
 * The catalog's entry for a model: the model's own, or, for a dated snapshot
 * ("claude-haiku-4-5-20251001", "gpt-5-nano-2025-08-07"), its family's.
 * Not the entry of any id the model merely starts with: the catalog lists
 * the vendors' models one by one, so "gpt-4.1-nano" missing from it means
 * its price is not known, not that it is "gpt-4.1"'s. Such a model meters at
 * the fallback rate, and is refused where a deployment creates its owls.
 */
function catalogEntryRates(model: string): ModelRates | null {
  const { catalog } = priceCatalog();
  const exact = catalog[model];
  if (exact) return catalogRates(exact);
  const dated = /^(.+?)(?:-\d{8}|-\d{4}-\d{2}-\d{2})$/.exec(model);
  const family = dated ? catalog[dated[1]!] : undefined;
  return family ? catalogRates(family) : null;
}

/** The prices this deployment states (MODEL_PRICES). None in a config without the setting. */
function statedPrices(): readonly StatedModelPrice[] {
  return loadConfig()?.modelPrices ?? [];
}

/** The price this deployment states for a model, if it states one: longest match wins. */
export function statedPriceFor(model: string): StatedModelPrice | null {
  let best: StatedModelPrice | null = null;
  for (const price of statedPrices()) {
    if (model.startsWith(price.model) && (!best || price.model.length > best.model.length)) {
      best = price;
    }
  }
  return best;
}

export function ratesForModel(model: string): ModelRates {
  const table = catalogEntryRates(model);
  const stated = statedPriceFor(model);
  if (stated) {
    // A stated price that leaves the cache multipliers out keeps the
    // catalog's for a model the catalog knows: a negotiated input price does
    // not change how the provider bills its cache.
    const readMultiplier = stated.cacheReadMultiplier ?? table?.cacheReadMultiplier;
    const writeMultiplier = stated.cacheWriteMultiplier ?? table?.cacheWriteMultiplier;
    return {
      inputPerMtok: stated.inputUsdPerMtok,
      outputPerMtok: stated.outputUsdPerMtok,
      ...(readMultiplier !== undefined ? { cacheReadMultiplier: readMultiplier } : {}),
      ...(writeMultiplier !== undefined ? { cacheWriteMultiplier: writeMultiplier } : {}),
    };
  }
  return table ?? FALLBACK_RATES;
}

/**
 * Whether the model has an explicit entry in the price catalog (vs metering at
 * the conservative FALLBACK_RATES). An Anthropic/OpenAI model without explicit
 * rates silently meters at the top-tier fallback — a real misbill against user
 * credit grants until noticed — so the model-guard test asserts this is true
 * for every model the system is configured to reach. OpenRouter models are
 * exempt: they report provider cost per call and are priced from that instead.
 */
export function hasExplicitRates(model: string): boolean {
  return catalogEntryRates(model) !== null || statedPriceFor(model) !== null;
}

/**
 * Whether a call to the model has a price: the catalog or the deployment
 * states one, or its provider prices each call itself. Only the two
 * providers priced from the catalog (Anthropic and OpenAI) can lack one. A
 * provider that reports its own cost (OpenRouter), and an endpoint a
 * deployment declares with its prices, are priced by what they report or
 * declare. A model ID that resolves to no provider is not this function's
 * to refuse: routing does, with its own message.
 */
export function modelIsPriced(model: string): boolean {
  const provider = resolveProvider(model);
  if (provider !== "anthropic" && provider !== "openai") return true;
  return hasExplicitRates(model);
}

/**
 * Each setting whose value is a model ID (STEWARD_MODEL and the rest), with
 * its model, by setting.
 */
export function configuredModels(config: object = loadConfig()): Array<{ setting: string; model: string }> {
  return Object.entries(config)
    .filter(
      (entry): entry is [string, string] =>
        /Model$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0
    )
    .map(([key, model]) => ({
      // stewardStrongModel is set by STEWARD_STRONG_MODEL.
      setting: key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase(),
      model,
    }))
    .sort((a, b) => a.setting.localeCompare(b.setting));
}

/**
 * The models this deployment is configured to run that have no price: each
 * setting whose value is a model ID and whose model the catalog and
 * MODEL_PRICES both lack. Where owls are created, a run on one of these is
 * refused at its first call, so the owls page and the preflight say so
 * before any run starts.
 */
export function unpricedConfiguredModels(
  config: object = loadConfig()
): Array<{ setting: string; model: string }> {
  return configuredModels(config).filter(({ model }) => !modelIsPriced(model));
}

/**
 * What prices a call to the model: a price the deployment states, the
 * catalog, the provider (OpenRouter, or a declared endpoint, reports or
 * declares the cost of each call), or nothing, in which case it meters at
 * the fallback rate, or is refused where owls are created.
 */
export function priceOrigin(model: string): "stated" | "catalog" | "provider" | "none" {
  if (statedPriceFor(model)) return "stated";
  const provider = resolveProvider(model);
  if (provider !== "anthropic" && provider !== "openai") return provider ? "provider" : "none";
  return catalogEntryRates(model) ? "catalog" : "none";
}

/** What a refusal of a call to a model with no price says. */
export function unpricedModelMessage(model: string): string {
  return (
    `The model "${model}" has no price in this deployment, so the call was refused before ` +
    `anything was sent. This deployment creates its own owls, and one owl covers one dollar ` +
    `of metered cost at the prices it is configured with: a model with no price would run ` +
    `uncounted. State its price in MODEL_PRICES, in US dollars per million input and output ` +
    `tokens, for example ${modelPriceExample(model)}, or use a model that has a price.`
  );
}

/** A call refused because its model has no price here. */
export class ModelNotPricedError extends Error {
  readonly code = "MODEL_NOT_PRICED";
  constructor(readonly model: string) {
    super(unpricedModelMessage(model));
    this.name = "ModelNotPricedError";
  }
}

/**
 * Refuse a call to a model with no price, in a deployment that creates its
 * own owls (OWLS=created). There an owl is defined by the deployment's own
 * prices, so the fallback rate would be a number nobody chose. On the
 * public graph, and wherever owls are sold, this does nothing.
 */
export function assertModelPriced(model: string): void {
  if (loadConfig()?.owls !== "created") return;
  if (!modelIsPriced(model)) throw new ModelNotPricedError(model);
}

export interface UsageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * Cost in micro-USD as reported BY THE PROVIDER. When present it OVERRIDES
   * the catalog entirely — the provider's own number is authoritative and, for
   * OpenRouter, the only number that exists for that model. Absent on the
   * Anthropic and OpenAI paths, which are priced from the catalog above.
   */
  providerCostMicroUsd?: number;
}

/**
 * Derive the cost of one LLM call in integer micro-USD.
 *
 * Note: `inputTokens` is the *uncached* input count — cache reads/writes are
 * reported separately (the OpenAI-compatible adapters subtract cached tokens
 * out of `prompt_tokens` to match) — so the four components are additive with
 * no double counting.
 */
export function costMicroUsd(model: string, usage: UsageTokens): number {
  if (usage.providerCostMicroUsd !== undefined) {
    return Math.round(usage.providerCostMicroUsd);
  }
  const rates = ratesForModel(model);
  const readMultiplier = rates.cacheReadMultiplier ?? DEFAULT_CACHE_READ_MULTIPLIER;
  const writeMultiplier =
    rates.cacheWriteMultiplier ?? DEFAULT_CACHE_WRITE_MULTIPLIER;
  const promptTokens =
    usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheCreationTokens ?? 0);
  const { inputPerMtok, outputPerMtok } =
    rates.longPrompt && promptTokens > rates.longPrompt.overTokens ? rates.longPrompt : rates;
  const usd =
    (usage.inputTokens / 1_000_000) * inputPerMtok +
    (usage.outputTokens / 1_000_000) * outputPerMtok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) *
      inputPerMtok *
      readMultiplier +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) *
      inputPerMtok *
      writeMultiplier;
  return Math.round(usd * 1_000_000);
}

/**
 * Anthropic's server-side web search: $10 per 1,000 searches, billed per
 * search on top of the tokens its results add. The response reports the
 * count (usage.server_tool_use.web_search_requests); the token meter never
 * saw it, so every agent's searches were unpriced.
 */
export const ANTHROPIC_WEB_SEARCH_MICRO_USD = 10_000;

/** Format a micro-USD amount for display/logs, e.g. 1234567 → "$1.2346". */
export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}
