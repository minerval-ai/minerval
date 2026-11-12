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
 * Rates are USD per million tokens (vendor list prices, 2026-08). Cache
 * multipliers differ by family and are carried per row:
 *   - Anthropic: cache reads 0.1×, 5-minute ephemeral cache writes 1.25× (the
 *     only TTL the Anthropic adapter uses)
 *   - OpenAI GPT-5.6 family: cache reads 0.1×, cache writes 1.25×
 *   - OpenAI pre-5.6 GPT-5 family: cache reads 0.1×, cache writes FREE
 *
 * OpenRouter models are not (and cannot be) in this table — hundreds of
 * third-party models with their own prices. That adapter reports the provider's
 * OWN computed cost, which overrides everything here; see
 * `UsageTokens.providerCostMicroUsd`.
 *
 * A deployment can state prices of its own in MODEL_PRICES (model-prices.ts):
 * for a model this table does not know, or in place of this table's for one it
 * does. A stated price wins over the table. Where a deployment creates its own
 * owls, a model with no price at all is refused before it is called
 * (assertModelPriced below); everywhere else an unknown model meters at the
 * fallback rate, as it always has.
 */
import { loadConfig } from "../config.js";
import { modelPriceExample, type StatedModelPrice } from "./model-prices.js";
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
}

/** Pre-5.6 OpenAI models bill cache writes at zero. */
const OPENAI_FREE_CACHE_WRITES = { cacheWriteMultiplier: 0 } as const;

// Keyed by model-ID prefix so dated snapshots ("claude-haiku-4-5-20251001",
// "gpt-5-nano-2025-08-07") resolve to their family. Longest prefix wins.
const MODEL_RATES: Record<string, ModelRates> = {
  // The Fable/Mythos line shares one per-token price across 5 and 5.1. These
  // are PREFIXES, so 5.1 would resolve to the 5 entry — but 5.1 bills cache
  // reads at $0.25/MTok (0.025× input) where 5 bills the 0.1× default, and the
  // load-bearing agents run on 5.1 with cached system prompts, so it needs its
  // own entry or every cost estimate meters their cache reads at four times
  // the real price. Longest prefix wins, so 5.1 lands here and 5 stays below.
  "claude-fable-5-1": { inputPerMtok: 10, outputPerMtok: 50, cacheReadMultiplier: 0.025 },
  // Fable 5.2 — the frontier tier — is cheaper than 5.1: $8/$40, cache reads
  // $0.20/MTok (0.025× input). It needs its own entry for the same reason 5.1
  // does: "claude-fable-5" is a PREFIX of its id, and would meter it at
  // $10/$50 with 0.1× reads.
  "claude-fable-5-2": { inputPerMtok: 8, outputPerMtok: 40, cacheReadMultiplier: 0.025 },
  "claude-fable-5": { inputPerMtok: 10, outputPerMtok: 50 },
  "claude-mythos-5": { inputPerMtok: 10, outputPerMtok: 50 },
  // Opus 5.5 — the strong tier — undercuts Opus 5 at $4/$20 and bills cache
  // reads at $0.20/MTok (0.05× input). "claude-opus-5" is a PREFIX of its id,
  // so without this entry it would meter at Opus 5's $5/$25 and 0.1× reads —
  // overstating every load-bearing agent's cost. Longest prefix wins.
  "claude-opus-5-5": { inputPerMtok: 4, outputPerMtok: 20, cacheReadMultiplier: 0.05 },
  // Opus 5 and the 4.x line share pricing. All three 4.x entries are listed
  // because any *_MODEL env override can route an agent to them (see #11's
  // validation), and an unlisted model meters at the Fable-tier fallback —
  // double the real Opus rate against the user's credit grant.
  "claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-7": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-6": { inputPerMtok: 5, outputPerMtok: 25 },
  // Sonnet 5.5 — the standard tier. Cache reads $0.20 and 5-minute writes
  // $2.50 are the default 0.1×/1.25× multipliers. "claude-sonnet-5" is a
  // PREFIX of its id, so without this entry it would meter at Sonnet 5's list.
  "claude-sonnet-5-5": { inputPerMtok: 2, outputPerMtok: 10 },
  // Sonnet 5 list price — still metered: it is Sonnet 5.5's refusal-fallback
  // target and sits in historical usage rows.
  "claude-sonnet-5": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-sonnet-4-6": { inputPerMtok: 3, outputPerMtok: 15 },
  "claude-haiku-4-5": { inputPerMtok: 1, outputPerMtok: 5 },

  // --- OpenAI (src/llm/providers/openai.ts) --------------------------------
  // 5.6 family: cache reads 0.1×, cache writes 1.25× (the defaults).
  "gpt-5.6-sol": { inputPerMtok: 5, outputPerMtok: 30 },
  "gpt-5.6-terra": { inputPerMtok: 2, outputPerMtok: 12 },
  "gpt-5.6-luna": { inputPerMtok: 0.2, outputPerMtok: 1.2 },
  // Pre-5.6: cache reads 0.1×, cache writes free.
  "gpt-5.5": { inputPerMtok: 5, outputPerMtok: 30, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5.4": { inputPerMtok: 2.5, outputPerMtok: 15, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5.4-mini": { inputPerMtok: 0.75, outputPerMtok: 4.5, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5.4-nano": { inputPerMtok: 0.2, outputPerMtok: 1.25, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5.2": { inputPerMtok: 1.75, outputPerMtok: 14, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5.1": { inputPerMtok: 1.25, outputPerMtok: 10, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5": { inputPerMtok: 1.25, outputPerMtok: 10, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5-mini": { inputPerMtok: 0.25, outputPerMtok: 2, ...OPENAI_FREE_CACHE_WRITES },
  "gpt-5-nano": { inputPerMtok: 0.05, outputPerMtok: 0.4, ...OPENAI_FREE_CACHE_WRITES },
};

// Conservative default for unknown models: price at the top (Fable) tier — the
// most expensive Anthropic list price, above the strong tier's Opus 5.5 — so a
// new model ID never meters as free. Ops sees the unknown model in usage rows.
const FALLBACK_RATES: ModelRates = { inputPerMtok: 10, outputPerMtok: 50 };

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

/** The table's entry for a model: longest prefix wins. */
function tableRates(model: string): ModelRates | null {
  let best: ModelRates | null = null;
  let bestLen = 0;
  for (const [prefix, rates] of Object.entries(MODEL_RATES)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = rates;
      bestLen = prefix.length;
    }
  }
  return best;
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
  const table = tableRates(model);
  const stated = statedPriceFor(model);
  if (stated) {
    // A stated price that leaves the cache multipliers out keeps the
    // table's for a model the table knows: a negotiated input price does
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
 * Whether the model has an explicit entry in the rate table (vs metering at
 * the conservative FALLBACK_RATES). An Anthropic/OpenAI model without explicit
 * rates silently meters at the top-tier fallback — a real misbill against user
 * credit grants until noticed — so the model-guard test asserts this is true
 * for every model the system is configured to reach. OpenRouter models are
 * exempt: they report provider cost per call and are priced from that instead.
 */
export function hasExplicitRates(model: string): boolean {
  return tableRates(model) !== null || statedPriceFor(model) !== null;
}

/**
 * Whether a call to the model has a price: the table or the deployment
 * states one, or its provider prices each call itself. Only the two
 * providers priced from the table (Anthropic and OpenAI) can lack one. A
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
 * The models this deployment is configured to run that have no price: each
 * setting whose value is a model ID (STEWARD_MODEL and the rest) and whose
 * model the table and MODEL_PRICES both lack. Where owls are created, a
 * run on one of these is refused at its first call, so the owls page and
 * the preflight say so before any run starts.
 */
export function unpricedConfiguredModels(
  config: object = loadConfig()
): Array<{ setting: string; model: string }> {
  return Object.entries(config)
    .filter(
      (entry): entry is [string, string] =>
        /Model$/.test(entry[0]) && typeof entry[1] === "string" && entry[1].length > 0
    )
    .filter(([, model]) => !modelIsPriced(model))
    .map(([key, model]) => ({
      // stewardStrongModel is set by STEWARD_STRONG_MODEL.
      setting: key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase(),
      model,
    }))
    .sort((a, b) => a.setting.localeCompare(b.setting));
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
   * the table entirely — the provider's own number is authoritative and, for
   * OpenRouter, the only number that exists for that model. Absent on the
   * Anthropic and OpenAI paths, which are priced from the table above.
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
  const usd =
    (usage.inputTokens / 1_000_000) * rates.inputPerMtok +
    (usage.outputTokens / 1_000_000) * rates.outputPerMtok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) *
      rates.inputPerMtok *
      readMultiplier +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) *
      rates.inputPerMtok *
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
