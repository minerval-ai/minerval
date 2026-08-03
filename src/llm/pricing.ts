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
 * Rates are USD per million tokens (Anthropic list prices, 2026-08):
 *   - cache reads bill at 0.1× the input rate
 *   - 5-minute ephemeral cache writes bill at 1.25× the input rate (the only
 *     TTL client.ts uses)
 */

interface ModelRates {
  /** USD per 1M uncached input tokens. */
  inputPerMtok: number;
  /** USD per 1M output tokens. */
  outputPerMtok: number;
}

// Keyed by model-ID prefix so dated snapshots ("claude-haiku-4-5-20251001")
// resolve to their family. Longest prefix wins.
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
};

// Conservative default for unknown models: price at the top (Fable) tier so a
// new model ID never meters as free. Ops sees the unknown model in usage rows.
const FALLBACK_RATES: ModelRates = { inputPerMtok: 10, outputPerMtok: 50 };

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

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
}

/**
 * Derive the cost of one LLM call in integer micro-USD.
 *
 * Note: `inputTokens` from the API is already the *uncached* input count —
 * cache reads/writes are reported separately — so the four components are
 * additive with no double counting.
 */
export function costMicroUsd(model: string, usage: UsageTokens): number {
  const rates = ratesForModel(model);
  const usd =
    (usage.inputTokens / 1_000_000) * rates.inputPerMtok +
    (usage.outputTokens / 1_000_000) * rates.outputPerMtok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) *
      rates.inputPerMtok *
      CACHE_READ_MULTIPLIER +
    ((usage.cacheCreationTokens ?? 0) / 1_000_000) *
      rates.inputPerMtok *
      CACHE_WRITE_MULTIPLIER;
  return Math.round(usd * 1_000_000);
}

/** Format a micro-USD amount for display/logs, e.g. 1234567 → "$1.2346". */
export function formatMicroUsd(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(4)}`;
}
