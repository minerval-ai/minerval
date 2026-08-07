/**
 * Single source of truth for Anthropic API model IDs, and for the
 * Anthropic-specific model behaviours the direct adapter keys off.
 *
 * The Anthropic adapter (src/llm/providers/anthropic.ts) talks to the Messages
 * API directly, which only accepts plain IDs like "claude-sonnet-4-6".
 * Bedrock/Vertex-style IDs ("us.anthropic.claude-...") 404 there and resolve to
 * no provider at all, so config rejects them (see issue #11).
 *
 * These are the DEFAULTS. Any agent can be pointed at another provider with its
 * *_MODEL env var — which backend an ID routes to is decided by ID shape in
 * src/llm/providers/routing.ts, the single source of truth for routing.
 */
export const MODELS = {
  /**
   * Fable 5 — the load-bearing agents (Steward, Curator, Audit, Arbitration)
   * run on it in production (issue #77). Thinking is always on (never send a
   * `thinking` config), and its safety classifiers can refuse benign-adjacent
   * requests, so the client opts into the server-side Opus fallback for it —
   * see modelNeedsRefusalFallback and client.ts.
   */
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5-20251001",
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
 * family (Fable 5, Sonnet 5) and Opus 4.7+ reject non-default sampling params
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
 * Mythos family.
 */
export function modelNeedsRefusalFallback(id: string): boolean {
  return /^claude-(fable|mythos)-/.test(id);
}
