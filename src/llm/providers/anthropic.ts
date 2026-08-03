/**
 * Anthropic direct adapter — the original code path, unchanged.
 *
 * Everything Anthropic-specific lives here and NOWHERE else: prompt caching via
 * ephemeral cache_control breakpoints, the Fable/Mythos server-side Opus
 * refusal fallback, container threading for container-backed server tools, the
 * temperature allowlist, and native structured outputs (output_config.format).
 * None of it is abstracted into a cross-provider layer, and none of it is
 * emulated by the other adapters — see providers/index.ts for what they reject.
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
  ProviderAdapter,
  StructuredRequest,
  ToolCompleteRequest,
  ToolCompletionResult,
  ToolUse,
} from "./types.js";

type ContentBlock = Anthropic.ContentBlock;
type TextBlock = Anthropic.TextBlock;
type ToolUseBlock = Anthropic.ToolUseBlock;
type ToolUnion = Anthropic.Messages.ToolUnion;

let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (_client) return _client;
  const config = loadConfig();
  if (!config.anthropicApiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not configured, but a call was routed to a " +
        'Claude model. Set ANTHROPIC_API_KEY or point the agent\'s *_MODEL env ' +
        "var at a provider you have a key for."
    );
  }
  // Bound how long a single request can stall. The SDK default is 10 minutes,
  // so one wedged socket can freeze an entire ingestion run; cap it (override
  // with LLM_REQUEST_TIMEOUT_MS) and let the SDK's automatic retries recover.
  const timeout = Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000);
  const maxRetries = Number(process.env.LLM_MAX_RETRIES ?? 4);
  _client = new Anthropic({ apiKey: config.anthropicApiKey, timeout, maxRetries });
  return _client;
}

/** Test seam: drop the memoized client so a new config/key takes effect. */
export function resetAnthropicClient(): void {
  _client = null;
}

/** Build the optional `temperature` field, omitting it for models that reject it. */
function temperatureParam(
  model: string,
  temperature?: number
): { temperature?: number } {
  if (!modelAcceptsTemperature(model)) return {};
  return { temperature: temperature ?? 0 };
}

// --- Prompt caching --------------------------------------------------------
// The system prompt (constitution + role, several KB and identical across every
// call to a given agent) and the tool schemas are a large, stable prefix. We
// mark them with ephemeral cache_control so repeated calls within the ~5 min
// window reuse the cached prefix — a big cost/latency win in a full corpus run
// (one system prompt, hundreds of claims) and in production. See
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching

/** Turn a string system prompt into a single cached text block. */
function cachedSystem(
  system: string | undefined
): string | Anthropic.TextBlockParam[] | undefined {
  if (!system) return undefined;
  return [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
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
    cache_control: { type: "ephemeral" },
  } as ToolUnion;
  return out;
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
      betas: ["server-side-fallback-2026-06-01"],
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

function textOf(content: ContentBlock[]): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += (block as TextBlock).text;
  }
  return text;
}

export const anthropicAdapter: ProviderAdapter = {
  name: "anthropic",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    const response = await createMessage({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      ...(req.system ? { system: cachedSystem(req.system) } : {}),
      ...(req.tools ? { tools: cachedTools(req.tools) } : {}),
      ...(req.container ? { container: req.container } : {}),
    });
    checkRefusal(response, req.model);
    const usage = meter(response, req.model);

    return {
      content: textOf(response.content),
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: response.stop_reason,
      container: response.container?.id ?? null,
    };
  },

  async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
    const response = await createMessage({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      tools: cachedTools(req.tools),
      ...(req.system ? { system: cachedSystem(req.system) } : {}),
      ...(req.container ? { container: req.container } : {}),
    });
    checkRefusal(response, req.model);
    const usage = meter(response, req.model);

    const toolUses: ToolUse[] = [];
    for (const block of response.content) {
      if (block.type === "tool_use") {
        const tb = block as ToolUseBlock;
        toolUses.push({
          id: tb.id,
          name: tb.name,
          input: tb.input as Record<string, unknown>,
        });
      }
    }

    return {
      content: textOf(response.content),
      model: req.model,
      usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
      stopReason: response.stop_reason,
      toolUses,
      rawContent: response.content,
      container: response.container?.id ?? null,
    };
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
    // No tools on this request — the system prompt block from cachedSystem is
    // the sole cache breakpoint, and its cache_control applies regardless.
    const response = await createMessage({
      model: req.model,
      messages: req.messages,
      max_tokens: req.maxTokens,
      ...temperatureParam(req.model, req.temperature),
      ...(req.system ? { system: cachedSystem(req.system) } : {}),
      output_config: {
        format: { type: "json_schema", schema: req.schema },
      },
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
};
