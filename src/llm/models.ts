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
  sonnet: "claude-sonnet-5",
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
 * moved off Haiku 4.5 on quality and price (#257), held DeepSeek V4 Flash, and
 * now holds GLM 5.3 Flash. The key is named for the ROLE, not the vendor, so
 * the next supersession is a one-line id change here and nowhere else.
 *
 * It is pinned identically on the ECS task definitions (MATCHER_MODEL and
 * TAGGER_MODEL in infra/lib/api-stack.ts, MATCHER_MODEL in solver-stack.ts);
 * the model guard asserts default and pin agree, so a corpus or dev run scores
 * the model production runs.
 *
 * Why the versioned id and not `~z-ai/glm-flash-latest`: every eval number in
 * this repo is a claim about a specific model, and an alias that repoints when
 * the vendor ships makes a scorecard a measurement of nothing. Same discipline
 * as the dated Haiku snapshot in MODELS. Z.ai publishes no dated revisions on
 * OpenRouter, so the version is the most specific stable id available.
 *
 * Two operational facts, verified against OpenRouter's endpoint list and one
 * live call at the time of pinning:
 *  - Routing under the adapter's `data_collection: "deny"` constraint resolves
 *    (to Together, at $0.15/$0.50 per Mtok list; several endpoints serve it
 *    cheaper, and OpenRouter reports the actual cost per call, which is what
 *    we meter). Context is 1M on all but one endpoint (Reka, 262k), so an
 *    agent that needs the full window must constrain provider routing.
 *  - No endpoint advertises `parallel_tool_calls`, and the model writes its
 *    reasoning into `content` ahead of a tool call. Neither breaks the adapter
 *    (a tool loop sequences calls per turn; structured output reads only the
 *    forced tool's arguments), but the reasoning is billed output on every
 *    call, and a fan-out agent cannot batch tool calls within one turn.
 */
export const OPENROUTER_MODELS = {
  flash: "z-ai/glm-5.3-flash",
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
 * family (Opus 5.5, Fable 5.1, Sonnet 5) and Opus 4.7+ reject non-default sampling params
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
 * (HTTP 200 with stop_reason "refusal") and should opt into the server-side
 * Opus fallback (`server-side-fallback-2026-06-01`) so a false positive
 * degrades to Opus instead of failing the agent run. Currently the Fable /
 * Mythos family and Opus 5.5 (whose classifiers add `bio` and
 * `reasoning_extraction` to Opus 5's `cyber`). Opus 5 itself is not listed —
 * the match is exact on the 5.5 version, so `claude-opus-5` stays out.
 */
export function modelNeedsRefusalFallback(id: string): boolean {
  return /^claude-(fable-|mythos-|opus-5-5)/.test(id);
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
