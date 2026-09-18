/**
 * Model discovery (#334 S7 / #324 "discover") — the pure half.
 *
 * Diff the providers' live model lists against what this codebase declares:
 *   - NEW: a provider id we do not register anywhere (a candidate to adopt);
 *   - DEPRECATED: an id we register (a default, a pin, a rate-table entry)
 *     that its provider no longer lists — the silent-drift case the guard
 *     stage cannot see, because the guard checks our tables against
 *     themselves, not against the provider;
 *   - PRICING DRIFT: a model priced in src/llm/pricing.ts that OpenRouter
 *     also lists (as vendor/model) at a different list rate. OpenRouter is a
 *     reseller, so its rate is a hint, not the vendor's word — but a
 *     mismatch is worth a look either way.
 *
 * No network here: models-discover.ts fetches and prints, this module diffs
 * fixture-shaped responses so the unit suite can pin the logic.
 */

/** One `data[]` entry of GET https://api.anthropic.com/v1/models. */
export interface AnthropicModelEntry {
  id: string;
  display_name?: string;
  created_at?: string;
}

/** One `data[]` entry of GET https://api.openai.com/v1/models. */
export interface OpenAiModelEntry {
  id: string;
  owned_by?: string;
  created?: number;
}

/** One `data[]` entry of GET https://openrouter.ai/api/v1/models (pricing in USD per TOKEN, as strings). */
export interface OpenRouterModelEntry {
  id: string;
  name?: string;
  created?: number;
  pricing?: { prompt?: string; completion?: string };
  context_length?: number;
}

export interface ProviderLists {
  anthropic?: AnthropicModelEntry[];
  openai?: OpenAiModelEntry[];
  openrouter?: OpenRouterModelEntry[];
}

export type ProviderName = "anthropic" | "openai" | "openrouter";

/** Where a registered id comes from, so a deprecation names what to edit. */
export interface RegisteredModel {
  id: string;
  /** e.g. "MODELS.sonnet", "OPENROUTER_MODELS.flash", "pin STEWARD_MODEL", "pricing prefix". */
  source: string;
}

export interface Rates {
  inputPerMtok: number;
  outputPerMtok: number;
}

export interface Candidate {
  provider: ProviderName;
  id: string;
  /** Provider-side date, ISO, when known. */
  released: string | null;
  /** OpenRouter list rates, USD per Mtok, when listed. */
  rates: Rates | null;
}

export interface Deprecation {
  provider: ProviderName;
  id: string;
  sources: string[];
}

export interface PricingDrift {
  /** Our id, e.g. "claude-sonnet-5". */
  id: string;
  /** The OpenRouter id it was matched to, e.g. "anthropic/claude-sonnet-5". */
  openrouterId: string;
  ours: Rates;
  openrouter: Rates;
}

export interface DiscoveryDiff {
  candidates: Candidate[];
  deprecated: Deprecation[];
  pricingDrift: PricingDrift[];
  /** Providers whose list was not available (no key, fetch failed), by name. */
  unavailable: ProviderName[];
}

/**
 * Which provider an id belongs to, by the same shape rule routing.ts uses
 * (kept local so this module stays dependency-free for the unit suite).
 */
export function providerOf(id: string): ProviderName | null {
  if (/^claude-/.test(id)) return "anthropic";
  if (/^gpt-/.test(id) || /^o\d/.test(id)) return "openai";
  if (id.includes("/")) return "openrouter";
  return null;
}

/** OpenRouter prices per token as strings → USD per Mtok. */
export function openRouterRates(entry: OpenRouterModelEntry): Rates | null {
  const p = Number(entry.pricing?.prompt);
  const c = Number(entry.pricing?.completion);
  if (!Number.isFinite(p) || !Number.isFinite(c)) return null;
  return { inputPerMtok: round4(p * 1_000_000), outputPerMtok: round4(c * 1_000_000) };
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/**
 * Ids worth surfacing as candidates. The provider lists are long and mostly
 * irrelevant (embeddings, audio, image, moderation, legacy dated snapshots,
 * OpenRouter's thousands); the filter keeps the chat-capable families this
 * codebase could route an agent to. Conservative on purpose: an operator
 * running --json can widen it.
 */
export function isCandidateId(provider: ProviderName, id: string): boolean {
  if (provider === "anthropic") return /^claude-/.test(id);
  if (provider === "openai") {
    if (!/^(gpt-|o\d)/.test(id)) return false;
    return !/(embedding|audio|realtime|tts|transcribe|image|search|moderation|instruct|codex|preview)/.test(id);
  }
  // OpenRouter: only the vendors we already route through it, or the family
  // the cheap tier currently holds; the rest of the zoo is noise here.
  return /^(z-ai|deepseek|qwen|moonshotai|google|meta-llama|mistralai|x-ai)\//.test(id) && !/:free$/.test(id);
}

/**
 * Whether a pricing prefix accounts for a listed id: the id itself, or a
 * dated snapshot of it ("claude-haiku-4-5" → "claude-haiku-4-5-20251001",
 * "gpt-5-nano" → "gpt-5-nano-2025-08-07"). NOT any id that merely starts
 * with it: ratesForModel would price "gpt-5.7" off the "gpt-5" entry, but
 * that is the fallback behaviour discovery exists to surface, so a new
 * family member is a candidate, not a covered id.
 */
export function coveredByPrefix(prefix: string, id: string): boolean {
  if (id === prefix) return true;
  const rest = id.startsWith(prefix) ? id.slice(prefix.length) : null;
  return rest !== null && /^-(\d{8}|\d{4}-\d{2}-\d{2})$/.test(rest);
}

/**
 * Whether a registered id is "present" in a provider list. Anthropic and
 * OpenAI list exact ids, so a registered id (a default, a pin, a dated
 * snapshot) is present when listed exactly; a pricing PREFIX is present when
 * the list carries it or a dated snapshot of it.
 */
export function isPresent(registered: RegisteredModel, listed: Set<string>): boolean {
  if (listed.has(registered.id)) return true;
  if (registered.source.startsWith("pricing")) {
    for (const id of listed) if (coveredByPrefix(registered.id, id)) return true;
  }
  return false;
}

/** "anthropic/claude-sonnet-5" → "claude-sonnet-5"; "openai/gpt-5-mini" → "gpt-5-mini"; else null. */
export function vendorStripped(openrouterId: string): string | null {
  const m = /^(anthropic|openai)\/(.+)$/.exec(openrouterId);
  return m ? m[2]! : null;
}

export function diffModels(input: {
  registry: RegisteredModel[];
  providers: ProviderLists;
  /** Our explicit rates for an id, or null when pricing.ts has no entry (OpenRouter-priced, or fallback). */
  ratesFor: (id: string) => Rates | null;
  /** Relative drift beyond which a rate difference is reported (default 1%). */
  driftTolerance?: number;
}): DiscoveryDiff {
  const tol = input.driftTolerance ?? 0.01;
  const unavailable: ProviderName[] = [];
  const listed: Record<ProviderName, Set<string>> = { anthropic: new Set(), openai: new Set(), openrouter: new Set() };
  const registeredIds = new Set(input.registry.map((r) => r.id));

  const candidates: Candidate[] = [];
  const consider = (provider: ProviderName, id: string, released: string | null, rates: Rates | null) => {
    listed[provider].add(id);
    if (registeredIds.has(id)) return;
    // A pricing prefix covers its dated snapshots: not new.
    if (input.registry.some((r) => r.source.startsWith("pricing") && coveredByPrefix(r.id, id))) return;
    if (!isCandidateId(provider, id)) return;
    candidates.push({ provider, id, released, rates });
  };

  if (input.providers.anthropic) {
    for (const m of input.providers.anthropic) consider("anthropic", m.id, m.created_at ?? null, null);
  } else unavailable.push("anthropic");
  if (input.providers.openai) {
    for (const m of input.providers.openai) consider("openai", m.id, m.created ? new Date(m.created * 1000).toISOString() : null, null);
  } else unavailable.push("openai");
  if (input.providers.openrouter) {
    for (const m of input.providers.openrouter) {
      consider("openrouter", m.id, m.created ? new Date(m.created * 1000).toISOString() : null, openRouterRates(m));
    }
  } else unavailable.push("openrouter");

  const deprecated: Deprecation[] = [];
  const byId = new Map<string, string[]>();
  for (const r of input.registry) (byId.get(r.id) ?? byId.set(r.id, []).get(r.id)!).push(r.source);
  for (const [id, sources] of byId) {
    const provider = providerOf(id);
    if (!provider || unavailable.includes(provider)) continue;
    const present = sources.some((source) => isPresent({ id, source }, listed[provider]));
    if (!present) deprecated.push({ provider, id, sources });
  }

  const pricingDrift: PricingDrift[] = [];
  for (const m of input.providers.openrouter ?? []) {
    const ours = vendorStripped(m.id);
    if (!ours) continue;
    const rates = input.ratesFor(ours);
    const theirs = openRouterRates(m);
    if (!rates || !theirs) continue;
    const off = (a: number, b: number) => (a === 0 ? b !== 0 : Math.abs(a - b) / a > tol);
    if (off(rates.inputPerMtok, theirs.inputPerMtok) || off(rates.outputPerMtok, theirs.outputPerMtok)) {
      pricingDrift.push({ id: ours, openrouterId: m.id, ours: rates, openrouter: theirs });
    }
  }

  const byDate = (a: Candidate, b: Candidate) => (b.released ?? "").localeCompare(a.released ?? "") || a.id.localeCompare(b.id);
  return { candidates: candidates.sort(byDate), deprecated: deprecated.sort((a, b) => a.id.localeCompare(b.id)), pricingDrift, unavailable };
}

/**
 * The rate-table prefixes in src/llm/pricing.ts, read from its source the
 * way production-pins.ts reads the CDK stack: MODEL_RATES is private by
 * design (ratesForModel is the API), and an id in that table is a model the
 * codebase claims to know the price of — which is exactly what a deprecation
 * should name. Matches `"<prefix>": { inputPerMtok` lines only.
 */
export function parsePricingPrefixes(pricingSource: string): string[] {
  const out: string[] = [];
  for (const m of pricingSource.matchAll(/^\s*"([^"]+)":\s*\{\s*inputPerMtok/gm)) out.push(m[1]!);
  return out;
}

/** Plain table for the terminal. */
export function renderDiscovery(diff: DiscoveryDiff): string {
  const out: string[] = [];
  const rate = (r: Rates | null) => (r ? `$${r.inputPerMtok}/$${r.outputPerMtok} per Mtok` : "");
  out.push(`Candidates (listed by a provider, not registered here): ${diff.candidates.length}`);
  for (const c of diff.candidates) {
    out.push(`  ${c.provider.padEnd(10)} ${c.id.padEnd(44)} ${(c.released ?? "").slice(0, 10).padEnd(10)} ${rate(c.rates)}`);
  }
  out.push(`Deprecated (registered here, missing from the provider's list): ${diff.deprecated.length}`);
  for (const d of diff.deprecated) out.push(`  ${d.provider.padEnd(10)} ${d.id.padEnd(44)} ← ${d.sources.join(", ")}`);
  out.push(`Pricing drift (pricing.ts vs OpenRouter list rate): ${diff.pricingDrift.length}`);
  for (const p of diff.pricingDrift) {
    out.push(`  ${p.id.padEnd(30)} ours ${rate(p.ours).padEnd(26)} openrouter ${rate(p.openrouter)}  (${p.openrouterId})`);
  }
  if (diff.unavailable.length) out.push(`Not checked (no key or fetch failed): ${diff.unavailable.join(", ")}`);
  return out.join("\n");
}
