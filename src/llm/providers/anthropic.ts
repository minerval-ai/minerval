/**
 * Anthropic direct adapter.
 *
 * Everything Anthropic-specific lives here and NOWHERE else: prompt caching via
 * ephemeral cache_control breakpoints (one per system block, one on the tool
 * list, and a moving one on the message history of a tool loop), the
 * Fable/Mythos server-side Opus refusal fallback, container threading for
 * container-backed server tools, the temperature allowlist, `output_config`
 * (effort and native structured outputs), and the streamed long-run path with
 * its betas. None of it is abstracted into a cross-provider layer, and none of
 * it is emulated by the other adapters — see providers/index.ts for what they
 * reject.
 */
import Anthropic from "@anthropic-ai/sdk";

import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";
import {
  MODELS,
  modelAcceptsTemperature,
  modelNeedsRefusalFallback,
} from "../models.js";
import { logCacheUsage, recordCallUsage, type ProviderUsage } from "./metering.js";
import type {
  CompleteRequest,
  CompletionResult,
  EffortLevel,
  LlmMessage,
  LongRunRequest,
  ProviderAdapter,
  StructuredRequest,
  SystemPrompt,
  TokenUsage,
  ToolCompleteRequest,
  ToolCompletionResult,
  ToolUse,
} from "./types.js";

type ContentBlock = Anthropic.ContentBlock;
type ContentBlockParam = Anthropic.ContentBlockParam;
type TextBlock = Anthropic.TextBlock;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ToolUnion = Anthropic.Messages.ToolUnion;
type OutputConfig = Anthropic.Messages.OutputConfig;
type BetaOutputConfig = Anthropic.Beta.Messages.BetaOutputConfig;
// `stream()` takes any params extending the beta MessageCreateParamsBase; the
// non-streaming beta type is that base plus `stream?: false`, and is the one
// createMessage already casts to.
type BetaStreamParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** Beta id for the server-side refusal fallback, array form. */
const SERVER_SIDE_FALLBACK_BETA = "server-side-fallback-2026-06-01";

/**
 * Beta id for task budgets. The installed SDK types `output_config.task_budget`
 * on the beta endpoint, but its AnthropicBeta union is open-ended (`string &
 * {}`) and does not enumerate this id; it is the id the platform docs name.
 */
export const TASK_BUDGETS_BETA = "task-budgets-2026-03-13";

/** The largest `max_tokens` the strong tier accepts. Streaming is required at this size. */
export const LONG_RUN_MAX_OUTPUT_TOKENS = 128_000;

/** Default wall time one long-run turn may take before the SDK gives up on it. */
const DEFAULT_LONG_RUN_TIMEOUT_MS = 3_600_000;

let _client: Anthropic | null = null;
let _longRunClient: Anthropic | null = null;

function requireApiKey(): string {
  const config = loadConfig();
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured, but a call was routed to a " +
        'Claude model. Set ANTHROPIC_API_KEY or point the agent\'s *_MODEL env ' +
        "var at a provider you have a key for."
    );
  }
  return config.anthropicApiKey;
}

function getClient(): Anthropic {
  if (_client) return _client;
  // Bound how long a single request can stall. The SDK default is 10 minutes,
  // so one wedged socket can freeze an entire ingestion run; cap it (override
  // with LLM_REQUEST_TIMEOUT_MS) and let the SDK's automatic retries recover.
  const timeout = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000);
  const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? 4);
  _client = new Anthropic({ apiKey: requireApiKey(), timeout, maxRetries });
  return _client;
}

/**
 * The client for the long-run path. A single streamed turn on the strong tier
 * can legitimately run for many minutes, so the 180-second cap above would
 * abort it and the four retries would re-issue it — each attempt billable
 * server-side. This client waits an hour per attempt (LLM_LONG_RUN_TIMEOUT_MS)
 * and retries twice, which covers a dropped connection without multiplying a
 * fifteen-minute turn five times over.
 */
export function getLongRunClient(): Anthropic {
  if (_longRunClient) return _longRunClient;
  const timeout = Number(
    process.env.LLM_LONG_RUN_TIMEOUT_MS ?? DEFAULT_LONG_RUN_TIMEOUT_MS
  );
  _longRunClient = new Anthropic({ apiKey: requireApiKey(), timeout, maxRetries: 2 });
  return _longRunClient;
}

/** Test seam: drop the memoized clients so a new config/key takes effect. */
export function resetAnthropicClient(): void {
  _client = null;
  _longRunClient = null;
}

/** Build the optional `temperature` field, omitting it for models that reject it. */
function temperatureParam(
  model: string,
  temperature?: number
): { temperature?: number } {
  if (!modelAcceptsTemperature(model)) return {};
  return { temperature: temperature ?? 0 };
}

/** Build `output_config` from the effort level plus any path-specific fields. */
function outputConfigParam(
  effort: EffortLevel | undefined,
  extra: OutputConfig = {}
): { output_config?: OutputConfig } {
  const config: OutputConfig = { ...extra, ...(effort ? { effort } : {}) };
  return Object.keys(config).length > 0 ? { output_config: config } : {};
}

// --- Prompt caching --------------------------------------------------------
// The system prompt (constitution + role, several KB and identical across every
// call to a given agent), any domain-skill blocks after it, and the tool
// schemas are a large, stable prefix. We mark them with ephemeral cache_control
// so repeated calls within the ~5 min window reuse the cached prefix — a big
// cost/latency win in a full corpus run (one system prompt, hundreds of claims)
// and in production. The API allows at most four breakpoints per request; the
// budget is one for the tool list, up to three for system blocks, and — on the
// tool-use path, when the system leaves room — one moving breakpoint on the
// message history so a long loop pays cache-read rates for what it already
// sent. See https://platform.claude.com/docs/en/build-with-claude/prompt-caching

/** The API's per-request cap on cache breakpoints. */
const MAX_BREAKPOINTS = 4;
/** System blocks beyond this many share the tool list's remaining budget; the LAST ones win. */
const MAX_SYSTEM_BREAKPOINTS = MAX_BREAKPOINTS - 1;

const EPHEMERAL = { type: "ephemeral" } as const;

/** The non-empty blocks of a system prompt, in order. */
function systemBlocks(system: SystemPrompt | undefined): string[] {
  if (system === undefined) return [];
  const blocks = typeof system === "string" ? [system] : system;
  return blocks.filter((text) => text.length > 0);
}

/**
 * Turn the system prompt into text blocks, each with its own breakpoint so a
 * block appended after the role (a domain skill) leaves the role block's cache
 * entry shared with runs that lack it. When more blocks arrive than the
 * budget allows, the breakpoints go on the last three: a breakpoint caches
 * everything before it, so the earlier blocks are still covered.
 */
function cachedSystem(
  system: SystemPrompt | undefined
): Anthropic.TextBlockParam[] | undefined {
  const blocks = systemBlocks(system);
  if (blocks.length === 0) return undefined;
  const firstCached = Math.max(0, blocks.length - MAX_SYSTEM_BREAKPOINTS);
  return blocks.map((text, i) =>
    i >= firstCached
      ? { type: "text", text, cache_control: EPHEMERAL }
      : { type: "text", text }
  );
}

function systemParam(
  system: SystemPrompt | undefined
): { system?: Anthropic.TextBlockParam[] } {
  const blocks = cachedSystem(system);
  return blocks ? { system: blocks } : {};
}

/**
 * Mark the tool list as cacheable by putting cache_control on the LAST tool
 * (the breakpoint caches every preceding tool too). Returns a new array.
 */
function cachedTools(tools: ToolUnion[]): ToolUnion[] {
  if (tools.length === 0) return tools;
  const out = tools.slice();
  const last = out[out.length - 1]!;
  out[out.length - 1] = {
    ...last,
    cache_control: EPHEMERAL,
  } as ToolUnion;
  return out;
}

/**
 * The moving history breakpoint: cache_control on the last content block of
 * the last user message. Each turn of a loop moves it forward, so turn N+1
 * reads turn N's whole history from the cache and pays full price only for
 * the newest tool results. Returns a new array; the caller's messages (and
 * the block that gets marked) are never mutated, which is what keeps the
 * loop's history append-only.
 */
function withHistoryBreakpoint(messages: LlmMessage[]): LlmMessage[] {
  let idx = messages.length - 1;
  while (idx >= 0 && messages[idx]!.role !== "user") idx--;
  if (idx < 0) return messages;
  const message = messages[idx]!;

  let content: ContentBlockParam[];
  if (typeof message.content === "string") {
    if (message.content.length === 0) return messages;
    content = [{ type: "text", text: message.content, cache_control: EPHEMERAL }];
  } else {
    const last = message.content[message.content.length - 1];
    // Thinking blocks are the one param type without cache_control; they
    // never end a user message, but do not build a request that 400s if one does.
    if (!last || last.type === "thinking" || last.type === "redacted_thinking") {
      return messages;
    }
    content = message.content.slice();
    content[content.length - 1] = { ...last, cache_control: EPHEMERAL } as ContentBlockParam;
  }

  const out = messages.slice();
  out[idx] = { ...message, content };
  return out;
}

/**
 * The messages of a tool request, with the history breakpoint when it fits
 * the four-breakpoint budget beside the tool list and the system blocks. With
 * three or more system blocks the history breakpoint is the one dropped: a
 * system block is shared across every run of the agent, the history is not.
 */
function toolMessages(req: ToolCompleteRequest): LlmMessage[] {
  const used =
    (req.tools.length > 0 ? 1 : 0) +
    Math.min(systemBlocks(req.system).length, MAX_SYSTEM_BREAKPOINTS);
  return used < MAX_BREAKPOINTS ? withHistoryBreakpoint(req.messages) : req.messages;
}

/**
 * Create one message, routing Fable-family models through the beta endpoint
 * with the server-side Opus fallback: their safety classifiers can decline a
 * benign-adjacent request (HTTP 200, stop_reason "refusal"), and the fallback
 * re-serves it on Opus 4.8 inside the same call instead of failing the agent
 * run. Other models use the plain Messages endpoint unchanged.
 *
 * The beta response/params are structural supersets of the non-beta types for
 * everything this client reads (content, usage, stop_reason, container), so
 * the casts below keep the beta surface contained to this one function.
 */
async function createMessage(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const client = getClient();
  if (modelNeedsRefusalFallback(params.model)) {
    const response = await client.beta.messages.create({
      ...(params as unknown as Anthropic.Beta.Messages.MessageCreateParamsNonStreaming),
      betas: [SERVER_SIDE_FALLBACK_BETA],
      fallbacks: [{ model: MODELS.opus }],
    });
    return response as unknown as Anthropic.Message;
  }
  return client.messages.create(params);
}

/**
 * Fail loudly on stop_reason "refusal" instead of returning empty content (or
 * schema-violating output from completeStructured — on a refusal the API does
 * not guarantee the output matches the requested schema, so this must run
 * before any parsing). On Fable models this fires only when the Opus fallback
 * refused too.
 */
function checkRefusal(response: Anthropic.Message, model: string): void {
  if (response.stop_reason === "refusal") {
    throw new LlmRefusalError(model, response.stop_details?.category ?? null);
  }
}

function normalizeUsage(u: Anthropic.Usage): ProviderUsage {
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.cache_read_input_tokens ?? 0,
    cacheCreationTokens: u.cache_creation_input_tokens ?? 0,
  };
}

function meter(response: Anthropic.Message, model: string): ProviderUsage {
  const usage = normalizeUsage(response.usage);
  recordCallUsage("anthropic", response.model ?? model, usage);
  logCacheUsage("anthropic", usage);
  return usage;
}

/** The seam's usage shape, cache components included. */
function tokenUsage(usage: ProviderUsage): TokenUsage {
  return {
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadTokens: usage.cacheReadTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
  };
}

function textOf(content: ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += (block as TextBlock).text;
  }
  return text;
}

function toolUsesOf(content: ContentBlock[]): ToolUse[] {
  const toolUses: ToolUse[] = [];
  for (const block of content) {
    if (block.type === "tool_use") {
      const tb = block as ToolUseBlock;
      toolUses.push({
        id: tb.id,
        name: tb.name,
        input: tb.input as Record<string, unknown>,
      });
    }
  }
  return toolUses;
}

/**
 * Which model produced the turn. `fallbackRan` is judged by family, not by
 * exact string: a served id that merely extends the requested alias (a dated
 * snapshot of it) is the same model, whereas the Opus id the refusal fallback
 * re-serves on is not. A fallback is sticky for about an hour, so later turns
 * carry it here without a fallback block in the content.
 */
function servedModelFields(
  response: Anthropic.Message,
  model: string
): Pick<ToolCompletionResult, "servedModel" | "fallbackRan"> {
  const served = response.model;
  if (typeof served !== "string" || served.length === 0) return {};
  return { servedModel: served, fallbackRan: !served.startsWith(model) };
}

function toolCompletionResult(
  response: Anthropic.Message,
  model: string,
  usage: ProviderUsage
): ToolCompletionResult {
  return {
    content: textOf(response.content),
    model,
    usage: tokenUsage(usage),
    stopReason: response.stop_reason,
    toolUses: toolUsesOf(response.content),
    rawContent: response.content,
    container: response.container?.id ?? null,
    ...servedModelFields(response, model),
  };
}

/**
 * The beta ids one long-run request opts into: the refusal fallback only when
 * the request asked for it, task budgets only when a budget is set, plus
 * whatever the caller passed, deduplicated in order.
 */
function longRunBetas(req: LongRunRequest): string[] {
  const betas: string[] = [];
  if (req.fallbacks === "server") betas.push(SERVER_SIDE_FALLBACK_BETA);
  if (req.taskBudgetTokens !== undefined) betas.push(TASK_BUDGETS_BETA);
  for (const beta of req.betas ?? []) {
    if (!betas.includes(beta)) betas.push(beta);
  }
  return betas;
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    const response = await createMessage({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      ...systemParam(req.system),
      ...(req.tools ? { tools: cachedTools(req.tools) } : {}),
      ...(req.container ? { container: req.container } : {}),
      ...outputConfigParam(req.effort),
    });
    checkRefusal(response, req.model);
    const usage = meter(response, req.model);

    return {
      content: textOf(response.content),
      model: req.model,
      usage: tokenUsage(usage),
      stopReason: response.stop_reason,
      container: response.container?.id ?? null,
    };
  },

  async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
    const response = await createMessage({
      model: req.model,
      messages: toolMessages(req),
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      tools: cachedTools(req.tools),
      ...systemParam(req.system),
      ...(req.container ? { container: req.container } : {}),
      ...outputConfigParam(req.effort),
    });
    checkRefusal(response, req.model);
    const usage = meter(response, req.model);
    return toolCompletionResult(response, req.model, usage);
  },

  /**
   * Native structured outputs (`output_config.format`): the API constrains
   * generation to the schema and returns the JSON as text content.
   *
   * Schema restrictions apply (a strict JSON Schema subset): every object must
   * set `additionalProperties: false` with a complete `required` array; numeric
   * bounds (minimum/maximum), string length constraints, and recursive schemas
   * are not supported — validate those in code instead. The first request with
   * a new schema pays a one-time server-side compilation cost; compiled schemas
   * are cached for 24 hours.
   */
  async completeStructured<T>(req: StructuredRequest): Promise<T> {
    // No tools on this request — the system blocks from cachedSystem are the
    // only cache breakpoints, and their cache_control applies regardless.
    const response = await createMessage({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      ...systemParam(req.system),
      ...outputConfigParam(req.effort, {
        format: { type: "json_schema", schema: req.schema },
      }),
    });
    // On a refusal the output is not guaranteed to match the schema — fail
    // loudly before attempting to parse.
    checkRefusal(response, req.model);
    meter(response, req.model);

    const text = textOf(response.content);

    if (response.stop_reason === "max_tokens") {
      // Truncated output is invalid/incomplete JSON (this bites on large inputs
      // — a 9k-word document once overflowed the extractor). Fail with an
      // actionable message instead of a bare JSON parse error.
      throw new Error(
        `Structured response "${req.schemaName}" was truncated at ` +
          `max_tokens (${req.maxTokens}) and cannot be parsed. Increase ` +
          `maxTokens or reduce the input size.`
      );
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Structured response "${req.schemaName}" was not valid JSON ` +
          `(stop_reason: ${response.stop_reason ?? "unknown"}).`
      );
    }
  },

  /**
   * One streamed turn of a long-running loop, on the long-run client. The
   * stream is consumed to its final message here — the seam has no use for
   * partial events — so the caller sees exactly the shape completeWithTools
   * returns, plus the served model. The refusal fallback is opt-in per
   * request rather than keyed off the model family as createMessage does: a
   * loop that must not be silently re-served on another tier says so.
   */
  async completeWithToolsStreaming(req: LongRunRequest): Promise<ToolCompletionResult> {
    const output: BetaOutputConfig = {
      ...(req.effort ? { effort: req.effort } : {}),
      ...(req.taskBudgetTokens !== undefined
        ? { task_budget: { type: "tokens", total: req.taskBudgetTokens } }
        : {}),
    };
    const betas = longRunBetas(req);
    const base: Anthropic.MessageCreateParams = {
      model: req.model,
      messages: toolMessages(req),
      max_tokens: Math.min(req.maxTokens, LONG_RUN_MAX_OUTPUT_TOKENS),
      ...temperatureParam(req.model, req.temperature),
      tools: cachedTools(req.tools),
      ...systemParam(req.system),
      ...(req.container ? { container: req.container } : {}),
    };
    // Same structural-superset cast as createMessage: the beta params only add
    // fields to the non-beta shape for everything built above.
    const params: BetaStreamParams = {
      ...(base as unknown as BetaStreamParams),
      ...(Object.keys(output).length > 0 ? { output_config: output } : {}),
      ...(req.fallbacks === "server" ? { fallbacks: [{ model: MODELS.opus }] } : {}),
      ...(betas.length > 0 ? { betas } : {}),
    };

    const final = await getLongRunClient().beta.messages.stream(params).finalMessage();
    const response = final as unknown as Anthropic.Message;
    checkRefusal(response, req.model);
    const usage = meter(response, req.model);
    return toolCompletionResult(response, req.model, usage);
  },
};
