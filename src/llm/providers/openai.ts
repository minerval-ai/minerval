/**
 * OpenAI direct adapter.
 *
 * Speaks Chat Completions (see the rationale at the top of openai-dialect.ts)
 * with OpenAI's own native features: strict `json_schema` structured outputs
 * for completeStructured, `prompt_cache_key` for stable prefix caching, and the
 * `refusal` field surfaced as the seam's LlmRefusalError. Everything
 * OpenAI-specific is contained here plus the shared dialect module.
 *
 * Not supported here, by design: Anthropic server tools and containers (see
 * assertAnthropicOnlyCapabilitiesUnused).
 */
import OpenAI from "openai";

import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";
import { getUsageContext } from "../usage-context.js";
import { logCacheUsage, recordCallUsage } from "./metering.js";
import {
  assertAnthropicOnlyCapabilitiesUnused,
  fromChatMessage,
  mapFinishReason,
  sanitizeSchemaName,
  toChatMessages,
  toChatTools,
  toStrictJsonSchema,
  usageFromCompletion,
} from "./openai-dialect.js";
import type {
  CompleteRequest,
  CompletionResult,
  ProviderAdapter,
  StructuredRequest,
  ToolCompleteRequest,
  ToolCompletionResult,
} from "./types.js";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const config = loadConfig();
  if (!config.openaiApiKey) {
    throw new Error(
      "OPENAI_API_KEY is not configured, but a call was routed to an OpenAI " +
        'model. Set OPENAI_API_KEY or point the agent\'s *_MODEL env var at a ' +
        "provider you have a key for."
    );
  }
  _client = new OpenAI({
    apiKey: config.openaiApiKey,
    timeout: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 4),
    // The SDK's bundled HTTP client fails with "Premature close" against
    // api.openai.com in some environments (observed on ECS Fargate / Node 22);
    // native fetch works reliably there. Same override the embedding service
    // has carried since that incident.
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  return _client;
}

/** Test seam: drop the memoized client so a new config/key takes effect. */
export function resetOpenAiClient(): void {
  _client = null;
}

/**
 * Whether an OpenAI model accepts `temperature`. Reasoning models (the o-series
 * and the GPT-5 family) reject any non-default sampling parameter with a 400,
 * and this adapter would send `temperature: 0` — so, exactly like the Anthropic
 * side, this is an ALLOWLIST of families known to accept it, not a blocklist of
 * ones that don't. Omitting the parameter is always safe.
 */
export function openaiAcceptsTemperature(id: string): boolean {
  return /^gpt-(3\.5|4)/.test(id);
}

/**
 * A stable cache key per agent. OpenAI caches long prompt prefixes
 * automatically; `prompt_cache_key` routes same-prefix requests to the same
 * cache shard, which is what makes the hit rate hold up under concurrency.
 * The agent name is exactly the right granularity — one constitution-sized
 * system prompt per agent, reused across every claim it processes.
 */
function promptCacheKey(): string | undefined {
  const agent = getUsageContext().agent;
  return agent ? `minerval:${agent}` : undefined;
}

/** Params the installed SDK types predate (`prompt_cache_key`, added later). */
type ExtraParams = Record<string, unknown>;

function baseParams(req: {
  model: string;
  maxTokens: number;
  temperature?: number;
}): ExtraParams {
  return {
    model: req.model,
    // Reasoning tokens count against this; `max_tokens` is deprecated and is
    // rejected outright by reasoning models.
    max_completion_tokens: req.maxTokens,
    ...(openaiAcceptsTemperature(req.model)
      ? { temperature: req.temperature ?? 0 }
      : {}),
    ...(promptCacheKey() ? { prompt_cache_key: promptCacheKey() } : {}),
  };
}

function checkRefusal(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice,
  model: string
): void {
  const refusal = choice.message.refusal;
  if (refusal) throw new LlmRefusalError(model, refusal);
  if (choice.finish_reason === "content_filter") {
    throw new LlmRefusalError(model, "content_filter");
  }
}

function meter(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string
) {
  const usage = usageFromCompletion(completion.usage);
  recordCallUsage("openai", completion.model ?? model, usage);
  logCacheUsage("openai", usage);
  return usage;
}

function firstChoice(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string
): OpenAI.Chat.Completions.ChatCompletion.Choice {
  const choice = completion.choices[0];
  if (!choice) {
    throw new Error(`OpenAI model "${model}" returned no choices.`);
  }
  return choice;
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    assertAnthropicOnlyCapabilitiesUnused("OpenAI", req.model, req);

    const completion = await getClient().chat.completions.create({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      ...(req.tools && req.tools.length > 0
        ? { tools: toChatTools(req.tools) }
        : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = firstChoice(completion, req.model);
    checkRefusal(choice, req.model);
    const usage = meter(completion, req.model);

    return {
      content: choice.message.content ?? "",
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: mapFinishReason(choice.finish_reason),
      container: null,
    };
  },

  async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
    assertAnthropicOnlyCapabilitiesUnused("OpenAI", req.model, req);

    const completion = await getClient().chat.completions.create({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      tools: toChatTools(req.tools),
      tool_choice: "auto",
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = firstChoice(completion, req.model);
    checkRefusal(choice, req.model);
    const usage = meter(completion, req.model);
    const turn = fromChatMessage(choice.message);

    return {
      content: turn.content,
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: mapFinishReason(choice.finish_reason),
      toolUses: turn.toolUses,
      rawContent: turn.rawContent,
      container: null,
    };
  },

  /**
   * Native strict structured outputs — `response_format: {type:"json_schema",
   * json_schema:{strict: true, …}}`, NOT a forced "respond" tool. The API
   * constrains generation to the schema and returns JSON as the message content.
   */
  async completeStructured<T>(req: StructuredRequest): Promise<T> {
    const completion = await getClient().chat.completions.create({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      response_format: {
        type: "json_schema",
        json_schema: {
          name: sanitizeSchemaName(req.schemaName),
          strict: true,
          schema: toStrictJsonSchema(req.schema) as Record<string, unknown>,
        },
      },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);

    const choice = firstChoice(completion, req.model);
    // On a refusal the output is not guaranteed to match the schema — fail
    // loudly before attempting to parse.
    checkRefusal(choice, req.model);
    meter(completion, req.model);

    if (choice.finish_reason === "length") {
      throw new Error(
        `Structured response "${req.schemaName}" was truncated at ` +
          `max_tokens (${req.maxTokens}) and cannot be parsed. Increase ` +
          `maxTokens or reduce the input size.`
      );
    }

    try {
      return JSON.parse(choice.message.content ?? "") as T;
    } catch {
      throw new Error(
        `Structured response "${req.schemaName}" was not valid JSON ` +
          `(finish_reason: ${choice.finish_reason ?? "unknown"}).`
      );
    }
  },
};
