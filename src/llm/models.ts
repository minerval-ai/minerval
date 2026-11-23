/**
 * Single source of truth for Anthropic API model IDs, and for the
 * Anthropic-specific model behaviours the direct adapter keys off.
 *
 * The Anthropic adapter (src/llm/providers/anthropic.ts) talks to the Messages
 * API directly, which only accepts plain IDs like "claude-sonnet-4-6".
 * Bedrock- and Vertex-style IDs ("us.anthropic.claude-...", "claude-...@date")
 * 404 there. They reach Claude on Amazon Bedrock and Google Vertex with a
 * prefix saying which ("bedrock:…", "vertex:…"; providers/routing.ts), and a
 * bare Bedrock-style ID resolves to no provider, so config rejects it with a
 * message naming the prefix (issue #11). The behaviours below key off the
 * Claude model a Bedrock or Vertex ID names (claudeModelName), so Claude is
 * treated the same on all three.
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
   * Fable 5.2 — the frontier tier, for the judgments and the long runs where
   * the best model class pays for itself and volume is low or already bounded
   * by a budget: the Steward's strong variant and its money triggers
   * (STEWARD_STRONG_MODEL), the Dispute Arbitrator, the Grantmaker, the
   * solver, and the researcher's strong tier. $8/$40 per MTok with cache reads
   * at $0.20: twice Opus 5.5 on input and output, the same on cache reads.
   *
   * Its request surface is the strong tier's (below) with these differences:
   * an omitted `effort` defaults to `high`, where Opus 5.5 defaults to
   * `medium`; the prefix check on replayed thinking blocks is enforced for
   * every account whatever its age, so an edited history is a 400 here even
   * where Opus 5.5 lets it through; it needs 30-day data retention; and its rate limit is its own, lower than Opus 5.5's.
   */
  frontier: "claude-fable-5-2",
  /**
   * Opus 5.5 — the strong tier: the high-volume load-bearing agents (the
   * Steward's standard pass, Curator, Audit, Extractor) run on it in
   * production (issue #77; moved off Fable 5.1). $4/$20 per MTok with cache
   * reads at $0.20 — half the frontier tier's $8/$40.
   *
   * Its request surface matches Fable 5.1's, and each difference matters to
   * this codebase: thinking is always on (never send a `thinking` config —
   * `disabled` and `budget_tokens` 400 at every effort level); forced tool use
   * (`tool_choice` "any" or "tool") 400s — the Anthropic adapter never sends
   * one, and must not start; thinking blocks are bound to the model and the
   * conversation that produced them, so an agent loop replaying `rawContent`
   * has to stay append-only (client.ts is); and its cyber/bio safety
   * classifiers can refuse, and a refusal is shown as one: the client asks
   * for no server-side fallback on any model (#1044).
   *
   * Unlike Fable, an omitted `effort` defaults to `medium`, not `high`.
   */
  strong: "claude-opus-5-5",
  /** Opus 4.8, a direct override option. */
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5-5",
  /**
   * Haiku 5.5 — the small Claude model: the Assistant's conversation titles
   * (ASSISTANT_TITLE_MODEL) and an Anthropic-only override for a cheap-tier
   * agent. $0.10/$0.50 per MTok for a prompt of up to 100K tokens, $0.50/$2.50
   * above (pricing.ts). An exact id with no dated snapshot.
   *
   * Its request surface differs from Haiku 4.5's, and each difference matters
   * here: adaptive thinking is on by default and is its only thinking mode
   * (`budget_tokens` 400s; the adapter never sends a `thinking` config), and
   * thinking spends from `max_tokens`, so a call sized for a short reply needs
   * headroom; non-default `temperature`/`top_p`/`top_k` 400 (it is off the
   * modelAcceptsTemperature allowlist); an assistant prefill 400s; `effort`
   * takes low through max and defaults to `medium`; and its safety
   * classifiers can refuse, and a refusal fails loudly like any other
   * model's. Like the 5.5 tiers above, its
   * thinking blocks are bound to the conversation, so a tool loop on it stays
   * append-only.
   */
  haiku: "claude-haiku-5-5",
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
 * as the exact ids in MODELS.
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

/** What a Bedrock model id for Claude begins with once its "bedrock:" prefix is gone. */
const BEDROCK_CLAUDE_ID = /^(?:[a-z]{2,6}(?:-[a-z]{2,4})?\.)?anthropic\.(claude-[a-z0-9-]+?)(?:-v\d+(?::\d+)?)?$/;
/** A Vertex model id for Claude once its "vertex:" prefix is gone: "claude-…", optionally "@<version>". */
const VERTEX_CLAUDE_ID = /^(claude-[a-z0-9-]+)(?:@([a-z0-9-]+))?$/;

/**
 * The Claude model an ID names, as the Anthropic API spells it, or null when
 * it names no Claude model: "claude-…" itself; a Bedrock ID
 * ("bedrock:us.anthropic.claude-opus-5-5-v1:0" is "claude-opus-5-5", the
 * geography and the "-v1:0" version dropped); a Vertex ID
 * ("vertex:claude-sonnet-4-5@20250929" is "claude-sonnet-4-5-20250929", a
 * dated version written the Anthropic API's way, "@default" dropped). What
 * a model can be sent, and its price in the catalog, are the Claude
 * model's wherever it is served.
 */
export function claudeModelName(id: string): string | null {
  const trimmed = id.trim();
  if (isAnthropicModelId(trimmed)) return trimmed;
  if (trimmed.startsWith("bedrock:")) {
    const m = BEDROCK_CLAUDE_ID.exec(trimmed.slice("bedrock:".length));
    return m ? m[1]! : null;
  }
  if (trimmed.startsWith("vertex:")) {
    const m = VERTEX_CLAUDE_ID.exec(trimmed.slice("vertex:".length));
    if (!m) return null;
    return m[2] && /^\d{8}$/.test(m[2]) ? `${m[1]}-${m[2]}` : m[1]!;
  }
  return null;
}

/**
 * Whether a model accepts the `temperature` request parameter. The Claude 5
 * family (Opus 5.5, Fable 5.2, Sonnet 5.5, Haiku 5.5) and Opus 4.7+ reject
 * non-default sampling params with a 400 — and the client sends
 * `temperature: 0`, which counts as non-default — so this is an ALLOWLIST of
 * families known to accept it (Haiku 4.x, Sonnet 4.x), not a blocklist of
 * ones that don't. The version is part of the allowlist: a future family
 * member is NOT assumed to accept it until verified (Haiku 5.5, the first
 * Haiku 5, does not), since a wrong guess 400s every run of
 * the agent routed to it (issue #77; the forward-compat hole from #324's
 * audit). Omitting the parameter is always safe.
 */
export function modelAcceptsTemperature(id: string): boolean {
  return /^claude-(haiku-4|sonnet-4)-/.test(claudeModelName(id) ?? "");
}

/**
 * Whether the model is one the long-run path (client.ts longRunToolLoop) may
 * run on: the strong-tier families that take `output_config.effort`, stream
 * 128K-token turns, and carry the long-run betas. A deployment that points the
 * solver's *_MODEL elsewhere should fail at config load, not hours into a run.
 */
export function modelSupportsLongRun(id: string): boolean {
  return /^claude-(fable|mythos|opus-5)/.test(claudeModelName(id) ?? "");
}

/**
 * Whether the model takes images as input, so a tool may show it one (#912).
 * An ALLOWLIST by family, like modelAcceptsTemperature: a model wrongly
 * assumed to see would be sent an image block its API rejects, which fails
 * the run, while one wrongly assumed blind is only told it cannot view a
 * figure. Every Claude model the Anthropic API serves takes images. The
 * OpenAI and OpenRouter entries are the families whose image input is
 * published (OpenRouter's model list gives `input_modalities`; the cheap
 * tier's GPT-6 Luna lists text, image and file). A model pinned elsewhere
 * that does see needs its family added here.
 */
export function modelSeesImages(id: string): boolean {
  if (claudeModelName(id)) return true;
  if (/^gpt-(4o|4\.1|[5-9])/.test(id)) return true;
  return /^(openai\/gpt-(4o|4\.1|[5-9])|anthropic\/claude-|google\/gemini-)/.test(id);
}

/**
 * Whether a tool may hand the model a PDF as a document block, each page
 * read as text and as an image. Only the Messages API adapters (Anthropic,
 * Bedrock, Vertex) send one; the OpenAI-shaped paths have no translation for
 * it (providers/openai-dialect.ts).
 */
export function modelReadsPdfDocuments(id: string): boolean {
  return claudeModelName(id) !== null;
}

/**
 * The most visual tokens one image costs on the model, for telling an agent
 * what a figure will cost it: an image is ⌈width/28⌉ × ⌈height/28⌉ tokens,
 * downscaled first to fit this cap. 4,784 on Claude 4.7 and later (the Claude
 * 5 family, Haiku 5.5 included, takes the higher figure: it is the one an
 * agent should budget to where no lower cap is published), 1,568 on earlier
 * Claude models. Other providers price images their own way; the
 * higher figure is used for them, as the estimate an agent should budget to.
 */
export function modelImageTokenCap(id: string): number {
  if (/^claude-(haiku-4|sonnet-4|opus-4-[0-6])/.test(claudeModelName(id) ?? "")) return 1568;
  return 4784;
}
