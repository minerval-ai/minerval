/**
 * Where model prices come from, and how two lists of them become one.
 *
 * Neither Anthropic nor OpenAI publishes its prices in a form a program can
 * read: their model lists (GET /v1/models) carry ids and limits, not
 * prices. Two public lists do carry them, for both vendors' first-party
 * models, at the vendors' list rates, with cache rates and the higher rate
 * some models charge for a long prompt:
 *
 *  - OpenRouter's model list (openrouter.ai/api/v1/models). OpenRouter is a
 *    reseller, but for these models it lists the vendor's own rates. Its
 *    ids are "anthropic/claude-opus-5.5" and "openai/gpt-5.6-sol"; the
 *    vendor's are "claude-opus-5-5" and "gpt-5.6-sol".
 *  - LiteLLM's price file (model_prices_and_context_window.json in
 *    BerriAI/litellm), kept by that project's maintainers and keyed by the
 *    vendor's own ids.
 *
 * They are kept by different people from different places, so the rule is
 * that a price this deployment already meters at changes only when both
 * lists state the new one. A model with no price yet is priced from either
 * list alone: one list is better than the fallback rate, which overcharges
 * by design, and a new release usually reaches one list a day or two
 * before the other. Where the two disagree, or a listed price is not a
 * believable one (zero, negative, or more than MAX_USD_PER_MTOK), the price
 * in force stays and the disagreement is reported.
 *
 * A model the lists stop carrying keeps its last price: usage rows from
 * before still name it, and a deployment may still call it.
 *
 * This module does no I/O and imports nothing, so the unit suite pins the
 * rules on fixtures and the snapshot script and the refresh worker share
 * them. services/model-price-service.ts fetches; pricing.ts reads.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
export const LITELLM_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export type PriceSourceName = "openrouter" | "litellm";
export type PricedProvider = "anthropic" | "openai";

/**
 * Above this, a listed price is taken for a mistake in the list (a price per
 * token read as a price per million, say), not a price. The dearest model
 * either vendor sells is well under a tenth of it.
 */
export const MAX_USD_PER_MTOK = 1_000;

/** A model's price, in US dollars per million tokens. */
export interface ModelPrice {
  provider: PricedProvider;
  inputPerMtok: number;
  outputPerMtok: number;
  /** A cache read. Left out where no list states one: pricing.ts then uses 0.1× input. */
  cacheReadPerMtok?: number;
  /**
   * A 5-minute cache write. Left out where no list states one: pricing.ts
   * then uses 1.25× input for Anthropic, and nothing for OpenAI, which
   * billed no cache writes before GPT-5.6 (every model since lists a price).
   */
  cacheWritePerMtok?: number;
  /** The higher rates for a prompt of more than `overTokens` tokens, cache reads and writes counted. */
  longPrompt?: { overTokens: number; inputPerMtok: number; outputPerMtok: number };
}

/** A price in the catalog: the price, and which lists stated it when it was last taken. */
export interface CatalogPrice extends ModelPrice {
  sources: PriceSourceName[];
}

export type Catalog = Record<string, CatalogPrice>;

/** One list's prices, by the vendor's model id. */
export interface Listing {
  source: PriceSourceName;
  prices: Map<string, ModelPrice>;
}

// ---------------------------------------------------------------------------
// Reading the lists
// ---------------------------------------------------------------------------

/** USD per token, as either list writes it (a string or a number), to USD per Mtok. */
function perMtok(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n)) return undefined;
  // Per-token prices are small binary fractions; rounding to a millionth of
  // a dollar per Mtok removes the noise of the multiplication and nothing else.
  return Math.round(n * 1e6 * 1e6) / 1e6;
}

/** The provider an id is routed to, by the shape rule in providers/routing.ts. */
export function pricedProviderOf(id: string): PricedProvider | null {
  if (/^claude-/.test(id)) return "anthropic";
  if (/^(gpt-|o\d)/.test(id)) return "openai";
  return null;
}

/**
 * The vendor's id for an OpenRouter id, or null for one this deployment
 * does not call directly. Anthropic's ids spell a version with dashes
 * ("claude-opus-5-5") where OpenRouter uses a dot ("claude-opus-5.5");
 * OpenAI's keep the dot ("gpt-5.6-sol"). A variant OpenRouter sells on its
 * own terms (":batch", ":free") is not the vendor's model, and neither is
 * OpenAI's open-weight gpt-oss: other hosts serve it, at their prices, and
 * OpenAI's API does not sell it.
 */
export function vendorIdFromOpenRouter(openrouterId: string): string | null {
  if (openrouterId.includes(":")) return null;
  const m = /^(anthropic|openai)\/(.+)$/.exec(openrouterId);
  if (!m || /^gpt-oss/.test(m[2]!)) return null;
  const id = m[1] === "anthropic" ? m[2]!.replace(/\./g, "-") : m[2]!;
  return pricedProviderOf(id) ? id : null;
}

interface OpenRouterPricing {
  prompt?: string;
  completion?: string;
  input_cache_read?: string;
  input_cache_write?: string;
  overrides?: Array<{ min_prompt_tokens?: number; prompt?: string; completion?: string }>;
}

/** The body of GET openrouter.ai/api/v1/models, as the prices of the vendors' own models. */
export function parseOpenRouterModels(body: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  const data = (body as { data?: unknown })?.data;
  if (!Array.isArray(data)) throw new Error("the OpenRouter model list has no data array");
  for (const entry of data as Array<{ id?: unknown; pricing?: OpenRouterPricing }>) {
    if (typeof entry?.id !== "string") continue;
    const id = vendorIdFromOpenRouter(entry.id);
    if (!id) continue;
    const p = entry.pricing ?? {};
    const input = perMtok(p.prompt);
    const output = perMtok(p.completion);
    if (input === undefined || output === undefined) continue;
    const price: ModelPrice = { provider: pricedProviderOf(id)!, inputPerMtok: input, outputPerMtok: output };
    const read = perMtok(p.input_cache_read);
    const write = perMtok(p.input_cache_write);
    if (read !== undefined) price.cacheReadPerMtok = read;
    if (write !== undefined) price.cacheWritePerMtok = write;
    const tier = (p.overrides ?? [])
      .filter((o) => typeof o?.min_prompt_tokens === "number" && o.min_prompt_tokens > 0)
      .sort((a, b) => a.min_prompt_tokens! - b.min_prompt_tokens!)[0];
    const longInput = perMtok(tier?.prompt);
    const longOutput = perMtok(tier?.completion);
    if (tier && longInput !== undefined && longOutput !== undefined) {
      price.longPrompt = { overTokens: tier.min_prompt_tokens!, inputPerMtok: longInput, outputPerMtok: longOutput };
    }
    out.set(id, price);
  }
  return out;
}

/** LiteLLM's price file, as the prices of the vendors' own chat models. */
export function parseLiteLlmPrices(body: unknown): Map<string, ModelPrice> {
  const out = new Map<string, ModelPrice>();
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new Error("the LiteLLM price file is not an object keyed by model");
  }
  for (const [id, raw] of Object.entries(body as Record<string, unknown>)) {
    if (id.includes("/") || id.includes(":")) continue;
    const provider = pricedProviderOf(id);
    if (!provider || !raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.litellm_provider !== provider) continue;
    if (e.mode !== "chat" && e.mode !== "responses") continue;
    const input = perMtok(e.input_cost_per_token);
    const output = perMtok(e.output_cost_per_token);
    if (input === undefined || output === undefined) continue;
    const price: ModelPrice = { provider, inputPerMtok: input, outputPerMtok: output };
    const read = perMtok(e.cache_read_input_token_cost);
    const write = perMtok(e.cache_creation_input_token_cost);
    if (read !== undefined) price.cacheReadPerMtok = read;
    if (write !== undefined) price.cacheWritePerMtok = write;
    // The long-prompt tier is written "input_cost_per_token_above_272k_tokens";
    // the lowest threshold is the one a prompt crosses first.
    const tiers = Object.keys(e)
      .map((k) => /^input_cost_per_token_above_(\d+)k_tokens$/.exec(k))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]))
      .sort((a, b) => a - b);
    if (tiers.length > 0) {
      const k = tiers[0]!;
      const longInput = perMtok(e[`input_cost_per_token_above_${k}k_tokens`]);
      const longOutput = perMtok(e[`output_cost_per_token_above_${k}k_tokens`]);
      if (longInput !== undefined && longOutput !== undefined) {
        price.longPrompt = { overTokens: k * 1000, inputPerMtok: longInput, outputPerMtok: longOutput };
      }
    }
    out.set(id, price);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Making one catalog of them
// ---------------------------------------------------------------------------

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 + 1e-6 * Math.max(Math.abs(a), Math.abs(b));

function sameOptional(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined ? a === b : near(a, b);
}

/** Whether two prices are the same price. */
export function samePrice(a: ModelPrice, b: ModelPrice): boolean {
  if (!near(a.inputPerMtok, b.inputPerMtok) || !near(a.outputPerMtok, b.outputPerMtok)) return false;
  if (!sameOptional(a.cacheReadPerMtok, b.cacheReadPerMtok)) return false;
  if (!sameOptional(a.cacheWritePerMtok, b.cacheWritePerMtok)) return false;
  if (!a.longPrompt || !b.longPrompt) return !a.longPrompt && !b.longPrompt;
  return sameLongPrompt(a.longPrompt, b.longPrompt);
}

function sameLongPrompt(a: NonNullable<ModelPrice["longPrompt"]>, b: NonNullable<ModelPrice["longPrompt"]>): boolean {
  return a.overTokens === b.overTokens && near(a.inputPerMtok, b.inputPerMtok) && near(a.outputPerMtok, b.outputPerMtok);
}

/**
 * The lists' prices for one model as one price, or what they disagree on.
 * A part one list leaves out (a cache rate, a long-prompt tier) is taken
 * from the list that states it: the lists differ in how complete they are,
 * and that is not a disagreement. A part both state differently is.
 */
export function mergeListed(prices: ModelPrice[]): { price: ModelPrice } | { disagree: string[] } {
  const [first, ...rest] = prices;
  if (!first) return { disagree: ["no list states it"] };
  const merged: ModelPrice = { ...first, ...(first.longPrompt ? { longPrompt: { ...first.longPrompt } } : {}) };
  const disagree: string[] = [];
  for (const p of rest) {
    if (!near(merged.inputPerMtok, p.inputPerMtok)) disagree.push("input");
    if (!near(merged.outputPerMtok, p.outputPerMtok)) disagree.push("output");
    for (const field of ["cacheReadPerMtok", "cacheWritePerMtok"] as const) {
      const a = merged[field];
      const b = p[field];
      if (a === undefined) {
        if (b !== undefined) merged[field] = b;
      } else if (b !== undefined && !near(a, b)) disagree.push(field === "cacheReadPerMtok" ? "cache read" : "cache write");
    }
    if (!merged.longPrompt) {
      if (p.longPrompt) merged.longPrompt = { ...p.longPrompt };
    } else if (p.longPrompt && !sameLongPrompt(merged.longPrompt, p.longPrompt)) {
      disagree.push("long-prompt rate");
    }
  }
  return disagree.length > 0 ? { disagree: [...new Set(disagree)] } : { price: merged };
}

/** What makes a listed price unbelievable, or null when it is a price. */
export function implausible(price: ModelPrice): string | null {
  const ok = (x: number) => Number.isFinite(x) && x > 0 && x <= MAX_USD_PER_MTOK;
  if (!ok(price.inputPerMtok) || !ok(price.outputPerMtok)) {
    return `input $${price.inputPerMtok} and output $${price.outputPerMtok} per Mtok are not a price ` +
      `(each must be above 0 and at most $${MAX_USD_PER_MTOK})`;
  }
  for (const [name, value] of [
    ["cache read", price.cacheReadPerMtok],
    ["cache write", price.cacheWritePerMtok],
  ] as const) {
    if (value !== undefined && !(Number.isFinite(value) && value >= 0 && value <= 4 * price.inputPerMtok)) {
      return `a ${name} at $${value} per Mtok, against input at $${price.inputPerMtok}, is not a price`;
    }
  }
  const long = price.longPrompt;
  if (long && !(ok(long.inputPerMtok) && ok(long.outputPerMtok) && long.overTokens > 0)) {
    return "its long-prompt rate is not a price";
  }
  return null;
}

export interface PriceChange {
  model: string;
  /** Null for a model priced for the first time. */
  from: ModelPrice | null;
  to: ModelPrice;
  sources: PriceSourceName[];
}

export interface HeldPrice {
  model: string;
  /** Why the price in force (or none) stays. */
  reason: string;
}

export interface Reconciled {
  catalog: Catalog;
  /** Prices that changed, and models priced for the first time. */
  changes: PriceChange[];
  /** Listed prices not taken. */
  held: HeldPrice[];
}

function withoutSources(p: CatalogPrice): ModelPrice {
  const { sources: _sources, ...price } = p;
  return price;
}

const sortedCatalog = (c: Catalog): Catalog =>
  Object.fromEntries(Object.entries(c).sort(([a], [b]) => a.localeCompare(b)));

/**
 * The catalog the lists make of `previous`: every price `previous` holds,
 * the new models the lists price, and the changes both lists agree on.
 */
export function reconcile(previous: Catalog, listings: Listing[]): Reconciled {
  const catalog: Catalog = { ...previous };
  const changes: PriceChange[] = [];
  const held: HeldPrice[] = [];
  const ids = new Set<string>();
  for (const l of listings) for (const id of l.prices.keys()) ids.add(id);

  for (const id of [...ids].sort()) {
    const stating = listings.filter((l) => l.prices.has(id));
    const sources = stating.map((l) => l.source);
    const merged = mergeListed(stating.map((l) => l.prices.get(id)!));
    const prior = previous[id];
    if ("disagree" in merged) {
      held.push({
        model: id,
        reason: `${sources.join(" and ")} disagree on its ${merged.disagree.join(", ")}`,
      });
      continue;
    }
    const wrong = implausible(merged.price);
    if (wrong) {
      held.push({ model: id, reason: `${sources.join(" and ")} list ${wrong}` });
      continue;
    }
    if (!prior) {
      catalog[id] = { ...merged.price, sources };
      changes.push({ model: id, from: null, to: merged.price, sources });
      continue;
    }
    if (samePrice(withoutSources(prior), merged.price)) {
      catalog[id] = { ...merged.price, sources };
      continue;
    }
    if (stating.length < 2) {
      held.push({
        model: id,
        reason:
          `only ${sources[0]} lists the new price; a price in force changes when ` +
          `both ${listings.length > 1 ? "lists" : "lists (one could not be read)"} state it`,
      });
      continue;
    }
    catalog[id] = { ...merged.price, sources };
    changes.push({ model: id, from: withoutSources(prior), to: merged.price, sources });
  }
  return { catalog: sortedCatalog(catalog), changes, held };
}

/** One price in words, for a log line or a report. */
export function describePrice(p: ModelPrice): string {
  const parts = [`$${p.inputPerMtok}/$${p.outputPerMtok}`];
  if (p.cacheReadPerMtok !== undefined) parts.push(`reads $${p.cacheReadPerMtok}`);
  if (p.cacheWritePerMtok !== undefined) parts.push(`writes $${p.cacheWritePerMtok}`);
  if (p.longPrompt) {
    parts.push(`over ${p.longPrompt.overTokens} tokens $${p.longPrompt.inputPerMtok}/$${p.longPrompt.outputPerMtok}`);
  }
  return `${parts.join(", ")} per Mtok`;
}
