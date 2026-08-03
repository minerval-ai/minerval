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
 */

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
  // Fable/Mythos 5 share pricing.
  "claude-fable-5": { inputPerMtok: 10, outputPerMtok: 50 },
  "claude-mythos-5": { inputPerMtok: 10, outputPerMtok: 50 },
  // Opus 5 and the 4.x line share pricing. All three 4.x entries are listed
  // because any *_MODEL env override can route an agent to them (see #11's
  // validation), and an unlisted model meters at the Fable-tier fallback —
  // double the real Opus rate against the user's credit grant.
  "claude-opus-5": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-8": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-7": { inputPerMtok: 5, outputPerMtok: 25 },
  "claude-opus-4-6": { inputPerMtok: 5, outputPerMtok: 25 },
  // Sonnet 5 list price; there is an intro rate ($2/$10) through 2026-08-31 —
  // we meter at list so derived costs never understate what credits will owe.
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

// Conservative default for unknown models: price at the top (Fable) tier so a
// new model ID never meters as free. Ops sees the unknown model in usage rows.
const FALLBACK_RATES: ModelRates = { inputPerMtok: 10, outputPerMtok: 50 };

const DEFAULT_CACHE_READ_MULTIPLIER = 0.1;
const DEFAULT_CACHE_WRITE_MULTIPLIER = 1.25;

export function ratesForModel(model: string): ModelRates {
  let best: ModelRates | null = null;
  let bestLen = 0;
  for (const [prefix, rates] of Object.entries(MODEL_RATES)) {
    if (model.startsWith(prefix) && prefix.length > bestLen) {
      best = rates;
      bestLen = prefix.length;
    }
  }
  return best ?? FALLBACK_RATES;
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

/** Format a micro-USD amount for display/logs, e.g. 1234567 → "$1.2346". */
export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}
