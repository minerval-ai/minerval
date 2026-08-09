/**
 * OpenAI direct adapter.
 *
 * Speaks the **Responses API** (see the round-trip design in
 * responses-dialect.ts) with OpenAI's own native features: strict `json_schema`
 * text format for completeStructured, `prompt_cache_key` for stable prefix
 * caching, `refusal` content parts surfaced as the seam's LlmRefusalError, and
 * encrypted reasoning echoed across turns of a tool loop so a GPT-5 model does
 * not restart its thinking every iteration.
 *
 * Stateless by construction: `store: false` on every request and full history
 * resent each turn. `previous_response_id` is never used — nothing about the
 * seam assumes server-side conversation state, and opting in would make the
 * loop unresumable from a different process.
 *
 * Anthropic server tools and containers are refused by design (see
 * assertAnthropicOnlyCapabilitiesUnused) — with one mapped exception: the
 * seam's web_search tool is served by OpenAI's own hosted web search
 * (isOpenAiHostedMappable in responses-dialect.ts), which is the point of
 * being on this API.
 */
import OpenAI from "openai";

import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";
import { getUsageContext } from "../usage-context.js";
import { logCacheUsage, recordCallUsage } from "./metering.js";
import {
  assertAnthropicOnlyCapabilitiesUnused,
  sanitizeSchemaName,
  toStrictJsonSchema,
} from "./openai-dialect.js";
import {
  fromResponse,
  isOpenAiHostedMappable,
  mapResponseStatus,
  toResponsesInput,
  toResponsesTools,
  usageFromResponse,
} from "./responses-dialect.js";
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

type ResponseCreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;

function baseParams(req: {
  model: string;
  maxTokens: number;
  temperature?: number;
  system?: string;
}): ResponseCreateParams {
  const cacheKey = promptCacheKey();
  return {
    model: req.model,
    // Reasoning tokens count against this. `max_tokens` is a Chat Completions
    // parameter and is rejected outright here.
    max_output_tokens: req.maxTokens,
    // Stateless: we resend full history every call, so there is nothing for
    // OpenAI to retain and no `previous_response_id` to chase.
    store: false,
    ...(req.system ? { instructions: req.system } : {}),
    ...(openaiAcceptsTemperature(req.model)
      ? { temperature: req.temperature ?? 0 }
      : {}),
    ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
  };
}

function checkRefusal(
  refusal: string | null,
  response: OpenAI.Responses.Response,
  model: string
): void {
  if (refusal) throw new LlmRefusalError(model, refusal);
  if (response.incomplete_details?.reason === "content_filter") {
    throw new LlmRefusalError(model, "content_filter");
  }
}

/** A failed response carries no usable output — surface why, not "no content". */
function assertNotFailed(response: OpenAI.Responses.Response, model: string): void {
  if (response.status === "failed" || response.error) {
    throw new Error(
      `OpenAI model "${model}" failed to generate a response: ` +
        `${response.error?.message ?? "unknown error"}`
    );
  }
}

function meter(response: OpenAI.Responses.Response, model: string) {
  const usage = usageFromResponse(response.usage);
  recordCallUsage("openai", response.model ?? model, usage);
  logCacheUsage("openai", usage);
  return usage;
}

export const openaiAdapter: ProviderAdapter = {
  name: "openai",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    // Web-search server tools are mapped to OpenAI's hosted search rather than
    // refused; guard everything else.
    assertAnthropicOnlyCapabilitiesUnused("OpenAI", req.model, {
      ...req,
      tools: req.tools?.filter((t) => !isOpenAiHostedMappable(t)),
    });

    const response = await getClient().responses.create({
      ...baseParams(req),
      input: toResponsesInput(req.messages),
      ...(req.tools && req.tools.length > 0
        ? { tools: toResponsesTools(req.tools) }
        : {}),
    });

    assertNotFailed(response, req.model);
    const turn = fromResponse(response);
    checkRefusal(turn.refusal, response, req.model);
    const usage = meter(response, req.model);

    return {
      content: turn.content,
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: mapResponseStatus(response, turn.toolUses.length),
      container: null,
    };
  },

  async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
    // Web-search server tools are mapped to OpenAI's hosted search rather than
    // refused; guard everything else.
    assertAnthropicOnlyCapabilitiesUnused("OpenAI", req.model, {
      ...req,
      tools: req.tools.filter((t) => !isOpenAiHostedMappable(t)),
    });

    const response = await getClient().responses.create({
      ...baseParams(req),
      input: toResponsesInput(req.messages),
      tools: toResponsesTools(req.tools),
      tool_choice: "auto",
      // Only the tool loop replays a turn, and only a reasoning model's
      // encrypted chain of thought makes that replay worth anything. Asking for
      // it on the single-shot paths would just inflate every response body.
      include: ["reasoning.encrypted_content"],
    });

    assertNotFailed(response, req.model);
    const turn = fromResponse(response);
    checkRefusal(turn.refusal, response, req.model);
    const usage = meter(response, req.model);

    return {
      content: turn.content,
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: mapResponseStatus(response, turn.toolUses.length),
      toolUses: turn.toolUses,
      // The raw Responses items — reasoning (with encrypted_content), message,
      // and function_call — kept verbatim so the next turn replays them in
      // position. See responses-dialect.ts.
      rawContent: turn.rawContent,
      container: null,
    };
  },

  /**
   * Native strict structured outputs — `text.format` of type `json_schema`,
   * NOT a forced "respond" tool. The API constrains generation to the schema
   * and returns JSON as the message text.
   */
  async completeStructured<T>(req: StructuredRequest): Promise<T> {
    const response = await getClient().responses.create({
      ...baseParams(req),
      input: toResponsesInput(req.messages),
      text: {
        format: {
          type: "json_schema",
          name: sanitizeSchemaName(req.schemaName),
          strict: true,
          schema: toStrictJsonSchema(req.schema) as Record<string, unknown>,
        },
      },
    });

    assertNotFailed(response, req.model);
    const turn = fromResponse(response);
    // On a refusal the output is not guaranteed to match the schema — fail
    // loudly before attempting to parse.
    checkRefusal(turn.refusal, response, req.model);
    meter(response, req.model);

    if (
      response.status === "incomplete" ||
      response.incomplete_details?.reason === "max_output_tokens"
    ) {
      throw new Error(
        `Structured response "${req.schemaName}" was truncated at ` +
          `max_tokens (${req.maxTokens}) and cannot be parsed. Increase ` +
          `maxTokens or reduce the input size.`
      );
    }

    // `output_text` is the SDK's concatenation of the message item's
    // output_text parts; fall back to our own parse of the same items.
    const text = response.output_text || turn.content;

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(
        `Structured response "${req.schemaName}" was not valid JSON ` +
          `(status: ${response.status ?? "unknown"}).`
      );
    }
  },
};
