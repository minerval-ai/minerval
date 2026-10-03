/**
 * Single source of truth for Anthropic API model IDs, and for the
 * Anthropic-specific model behaviours the direct adapter keys off.
 *
 * The Anthropic adapter (src/llm/providers/anthropic.ts) talks to the Messages
 * API directly, which only accepts plain IDs like "claude-sonnet-4-6".
 * Bedrock/Vertex-style IDs ("us.anthropic.claude-...") 404 there and resolve to
 * no provider at all, so config rejects them (see issue #11).
 *
 * These are the Anthropic DEFAULTS. Any agent can be pointed at another
 * provider with its *_MODEL env var — which backend an ID routes to is decided
 * by ID shape in src/llm/providers/routing.ts, the single source of truth for
 * routing. Non-Anthropic IDs this codebase pins as a DEFAULT (rather than as an
 * operator override) live in OPENROUTER_MODELS below, so every model reachable
 * from a config default is still declared in one file.
 */
export const MODELS = {
  /**
   * Opus 5.5 — the strong tier: the load-bearing agents (Steward, Curator,
   * Audit, Arbitration, Extractor, Grantmaker, solver) run on it in production
   * (issue #77; moved off Fable 5.1). $4/$20 per MTok with cache reads at
   * $0.20 — well under Fable's $10/$50.
   *
   * Its request surface matches Fable 5.1's, and each difference matters to
   * this codebase: thinking is always on (never send a `thinking` config —
   * `disabled` and `budget_tokens` 400 at every effort level); forced tool use
   * (`tool_choice` "any" or "tool") 400s — the Anthropic adapter never sends
   * one, and must not start; thinking blocks are bound to the model and the
   * conversation that produced them, so an agent loop replaying `rawContent`
   * has to stay append-only (client.ts is); and its cyber/bio safety
   * classifiers can refuse benign-adjacent requests, so the client opts into
   * the server-side Opus fallback for it — see modelNeedsRefusalFallback.
   *
   * Unlike Fable, an omitted `effort` defaults to `medium`, not `high`.
   */
  strong: "claude-opus-5-5",
  /** The refusal-fallback target for the strong tier (and a direct override option). */
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5-5",
  haiku: "claude-haiku-4-5-20251001",
} as const;

/**
 * Non-Anthropic model IDs pinned as a per-agent DEFAULT in src/config.ts.
 *
 * A "vendor/model" ID routes to OpenRouter, so an agent defaulted here needs
 * OPENROUTER_API_KEY — the Anthropic key alone will not serve it (the adapter
 * fails loudly naming the missing key).
 *
 * The cheap tier. The Matcher's judgment is narrow ("same proposition?") over
 * candidates it retrieves itself, and the tagger (#272) labels topics with no
 * epistemic call at all, so both run the cheapest capable model. The tier
 * moved off Haiku 4.5 on quality and price (#257), held DeepSeek V4 Flash and
 * then GLM 5.3 Flash, and now holds GPT-6 Luna. The key is named for the
 * ROLE, not the vendor, so the next supersession is a one-line id change here
 * and nowhere else.
 *
 * It is pinned identically on the ECS task definitions (MATCHER_MODEL and
 * TAGGER_MODEL in infra/lib/api-stack.ts, MATCHER_MODEL in solver-stack.ts);
 * the model guard asserts default and pin agree, so a corpus or dev run scores
 * the model production runs.
 *
 * Why the versioned id and not `~openai/gpt-luna-latest`: every eval number in
 * this repo is a claim about a specific model, and an alias that repoints when
 * the vendor ships makes a scorecard a measurement of nothing. Same discipline
 * as the dated Haiku snapshot in MODELS.
 *
 * Why through OpenRouter and not OpenAI direct ("gpt-6-luna"): the tier's
 * callers lean on OpenRouter-only behaviour (the `web` plugin search in
 * providers/openrouter.ts, OpenRouter's reported per-call cost), and the
 * OpenAI key stays an optional override rather than a dependency of every
 * cheap-tier agent.
 *
 * Operational facts, verified against OpenRouter's endpoint list and live
 * calls at the time of pinning:
 *  - Routing under the adapter's `data_collection: "deny"` constraint resolves
 *    (OpenAI, Azure and Bedrock endpoints, $0.10/$0.50 per Mtok list; OpenRouter
 *    reports the actual cost per call, which is what we meter). Context is
 *    1.05M and output 128k on every endpoint.
 *  - It is a reasoning model: a forced tool call returns clean arguments, and
 *    the web plugin still returns its citations at `max_tokens: 1` (the reply
 *    is cut off, which the search ignores).
 */
export const OPENROUTER_MODELS = {
  flash: "openai/gpt-6-luna",
} as const;

/** Default model for general completions when a caller doesn't specify one. */
export const DEFAULT_MODEL = MODELS.sonnet;

/**
 * True when `id` looks like an Anthropic API model ID (e.g. "claude-sonnet-4-6")
 * rather than a Bedrock/Vertex-prefixed one (e.g. "us.anthropic.claude-...").
 */
export function isAnthropicModelId(id: string): boolean {
  return /^claude-/.test(id);
}

/**
 * Whether a model accepts the `temperature` request parameter. The Claude 5
 * family (Opus 5.5, Fable 5.1, Sonnet 5.5) and Opus 4.7+ reject non-default sampling params
 * with a 400 — and the client sends `temperature: 0`, which counts as
 * non-default — so this is an ALLOWLIST of families known to accept it
 * (Haiku 4.x, Sonnet 4.x), not a blocklist of ones that don't. The version is
 * part of the allowlist: a future family member (e.g. a Haiku 5) is NOT
 * assumed to accept it until verified, since a wrong guess 400s every run of
 * the agent routed to it (issue #77; the forward-compat hole from #324's
 * audit). Omitting the parameter is always safe.
 */
export function modelAcceptsTemperature(id: string): boolean {
  return /^claude-(haiku-4|sonnet-4)-/.test(id);
}

/**
 * Whether the model's safety classifiers can refuse benign-adjacent requests
 * (HTTP 200 with stop_reason "refusal") and should opt into a server-side
 * fallback so a false positive degrades to another model instead of failing
 * the agent run. Currently the Fable / Mythos family, Opus 5.5 (whose
 * classifiers add `bio` and `reasoning_extraction` to Opus 5's `cyber`), and
 * Sonnet 5.5 (five decline categories to Sonnet 5's one). Opus 5 and Sonnet 5
 * are not listed — the match is exact on the 5.5 version, so `claude-opus-5`
 * and `claude-sonnet-5` stay out. See modelRefusalFallbackForm for which wire
 * form each takes.
 */
export function modelNeedsRefusalFallback(id: string): boolean {
  return modelRefusalFallbackForm(id) !== null;
}

/**
 * The server-side fallback form a classifier-gated model takes, or null when
 * it takes none.
 *
 *  - "array" (`fallbacks: [{model: MODELS.opus}]`, beta
 *    `server-side-fallback-2026-06-01`): Fable / Mythos and Opus 5.5, re-served
 *    on Opus 4.8.
 *  - "default" (`fallbacks: "default"`, beta `server-side-fallback-2026-07-01`):
 *    Sonnet 5.5, whose only fallback is Anthropic's routed one — `cyber` and
 *    `frontier_llm` declines are retried on Sonnet 5; `bio`,
 *    `reasoning_extraction` and `general_harms` declines come back as refusals
 *    and fail loudly like any other.
 *
 * Pairing either beta header with the other form is a 400.
 */
export function modelRefusalFallbackForm(id: string): "array" | "default" | null {
  if (/^claude-(fable-|mythos-|opus-5-5)/.test(id)) return "array";
  if (/^claude-sonnet-5-5/.test(id)) return "default";
  return null;
}

/**
 * Whether the model is one the long-run path (client.ts longRunToolLoop) may
 * run on: the strong-tier families that take `output_config.effort`, stream
 * 128K-token turns, and carry the long-run betas. A deployment that points the
 * solver's *_MODEL elsewhere should fail at config load, not hours into a run.
 */
export function modelSupportsLongRun(id: string): boolean {
  return /^claude-(fable|mythos|opus-5)/.test(id);
}
