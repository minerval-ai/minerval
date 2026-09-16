/**
 * OpenRouter adapter — one key, every other vendor's model zoo.
 *
 * OpenRouter serves an OpenAI-compatible Chat Completions API, so it reuses the
 * translation in openai-dialect.ts with a different baseURL/key and three
 * OpenRouter-specific behaviours:
 *
 *  1. Structured output goes through a FORCED function call ("respond") rather
 *     than a json_schema response format. Native structured outputs are only
 *     available on some of the zoo; a forced tool call is the most portable
 *     mechanism across it.
 *
 *     Do not "modernize" this to response_format. OpenRouter routes one model
 *     ID across many provider endpoints, and support differs BETWEEN THEM: of
 *     the 25 endpoints serving the cheap tier's pin (OPENROUTER_MODELS.flash)
 *     at the time of writing, six advertise no structured-output support,
 *     while every one of them supports tool calling. Switching would
 *     therefore fail intermittently, on a subset of calls, decided by which
 *     endpoint routing happened to pick — the worst shape of bug this
 *     codebase could buy for a cosmetic gain.
 *  2. `usage: {include: true}` makes every response carry token counts, cached
 *     tokens, and OpenRouter's own computed cost. That cost is authoritative —
 *     we cannot maintain a rate table for hundreds of third-party models — so
 *     it is passed to metering as an override of the table-derived cost.
 *  3. `temperature` is only sent when a caller explicitly asks for one. The zoo
 *     includes reasoning models that reject sampling params, and unlike the
 *     other two adapters we cannot enumerate which.
 *
 * Deliberately NOT used: OpenRouter's beta Responses API.
 */
import OpenAI from "openai";

import { loadConfig } from "../../config.js";
import { LlmRefusalError } from "../errors.js";
import { OPENROUTER_MODELS } from "../models.js";
import { logCacheUsage, recordCallUsage } from "./metering.js";
import {
  assertAnthropicOnlyCapabilitiesUnused,
  fromChatMessage,
  mapFinishReason,
  parseToolArguments,
  toChatMessages,
  toChatTools,
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

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

let _client: OpenAI | null = null;

function getClient(): OpenAI {
  if (_client) return _client;
  const config = loadConfig();
  if (!config.openrouterApiKey) {
    throw new Error(
      "OPENROUTER_API_KEY is not configured, but a call was routed to an " +
        'OpenRouter model (a "vendor/model" id). Set OPENROUTER_API_KEY or ' +
        "point the agent's *_MODEL env var at a provider you have a key for."
    );
  }
  _client = new OpenAI({
    apiKey: config.openrouterApiKey,
    baseURL: OPENROUTER_BASE_URL,
    timeout: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 4),
    // Attribution headers OpenRouter recommends; they surface the app on their
    // dashboards and leaderboards.
    defaultHeaders: {
      "HTTP-Referer": config.publicWebBaseUrl,
      "X-Title": "Minerval",
    },
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  return _client;
}

/** Test seam: drop the memoized client so a new config/key takes effect. */
export function resetOpenRouterClient(): void {
  _client = null;
}

type ExtraParams = Record<string, unknown>;

function baseParams(req: {
  model: string;
  maxTokens: number;
  temperature?: number;
}): ExtraParams {
  return {
    model: req.model,
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    // Ask for the full usage block: token counts, cached tokens, and cost.
    usage: { include: true },
    // Route only to hosts whose data policy forbids training on prompts —
    // the privacy page promises "API terms that exclude training on your
    // data", and OpenRouter's zoo includes hosts where that isn't true.
    provider: { data_collection: "deny" },
  };
}

/** OpenRouter's usage block, a superset of OpenAI's. */
interface OpenRouterUsage extends OpenAI.CompletionUsage {
  /** Actual charge for the call, in USD credits. */
  cost?: number;
}

function meter(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string
) {
  const usage = usageFromCompletion(completion.usage);
  const cost = (completion.usage as OpenRouterUsage | undefined)?.cost;
  const withCost = {
    ...usage,
    ...(typeof cost === "number"
      ? { costMicroUsd: Math.round(cost * 1_000_000) }
      : {}),
  };
  recordCallUsage("openrouter", completion.model ?? model, withCost);
  logCacheUsage("openrouter", withCost);
  return withCost;
}

function firstChoice(
  completion: OpenAI.Chat.Completions.ChatCompletion,
  model: string
): OpenAI.Chat.Completions.ChatCompletion.Choice {
  const choice = completion.choices[0];
  if (!choice) {
    const err = (completion as { error?: { message?: string } }).error?.message;
    throw new Error(
      `OpenRouter model "${model}" returned no choices` +
        (err ? `: ${err}` : ".")
    );
  }
  return choice;
}

/**
 * An upstream host failing mid-generation comes back as HTTP 200 with
 * `finish_reason: "error"` and an `error` on the choice, which the SDK's own
 * retry (on HTTP status) never sees. It says nothing about the request — the
 * same call succeeds on the next host — so retry it here, and when the
 * retries are spent throw it as the transient failure it is (a status of
 * 502 is what isTransientApiError keys off), naming the upstream message.
 */
const UPSTREAM_ERROR_RETRIES = Number(process.env.LLM_MAX_RETRIES ?? 4);

function upstreamError(
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice
): string | null {
  const err = (choice as { error?: { message?: string; code?: number } }).error;
  if (choice.finish_reason === ("error" as string) || err) {
    return err?.message ?? "finish_reason: error";
  }
  return null;
}

async function createWithUpstreamRetry(
  params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
  model: string
): Promise<{
  completion: OpenAI.Chat.Completions.ChatCompletion;
  choice: OpenAI.Chat.Completions.ChatCompletion.Choice;
}> {
  let lastError = "";
  for (let attempt = 0; attempt <= UPSTREAM_ERROR_RETRIES; attempt++) {
    const completion = await getClient().chat.completions.create(params);
    const choice = firstChoice(completion, model);
    const err = upstreamError(choice);
    if (err === null) return { completion, choice };
    lastError = err;
    // The failed attempt is still billed for what it produced.
    meter(completion, model);
    if (attempt < UPSTREAM_ERROR_RETRIES) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
  const error = new Error(
    `OpenRouter upstream error for "${model}" after ${UPSTREAM_ERROR_RETRIES + 1} ` +
      `attempts (bad gateway): ${lastError}`
  );
  (error as { status?: number }).status = 502;
  throw error;
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

/** One hit from a web search: where, what it is called, and an excerpt. */
export interface WebSearchHit {
  url: string;
  title: string;
  /** The page excerpt the search engine returned, capped per hit. */
  excerpt: string;
}

/** Characters of excerpt kept per hit: enough to judge relevance, not the page. */
const WEB_SEARCH_EXCERPT_CHARS = 1500;

/**
 * A web search through OpenRouter's `web` plugin, for any model on any
 * provider.
 *
 * OpenRouter has no standalone search endpoint: the plugin runs a search
 * for the request's last user message, injects the hits into the prompt,
 * and returns them as `url_citation` annotations on the reply. So a search
 * is one chat completion on the cheap tier with the query as its only
 * message and `max_tokens: 1` — the reply is discarded, the annotations are
 * the result. The engine is pinned to Exa so the shape does not change with
 * whichever model fills the tier (a model with a native engine would run
 * that instead, and its annotations arrive on its own terms). Metered like
 * any other call: OpenRouter's reported cost covers the search fee.
 */
export async function openrouterWebSearch(
  query: string,
  maxResults: number
): Promise<WebSearchHit[]> {
  const model = OPENROUTER_MODELS.flash;
  const completion = await getClient().chat.completions.create({
    ...baseParams({ model, maxTokens: 1 }),
    messages: [{ role: "user", content: query }],
    plugins: [{ id: "web", engine: "exa", max_results: maxResults }],
  } as unknown as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming);
  meter(completion, model);
  const choice = completion.choices[0];
  const err = choice ? upstreamError(choice) : null;
  if (!choice || err) {
    throw new Error(`OpenRouter web search failed: ${err ?? "no choices"}`);
  }
  const annotations =
    (choice.message as { annotations?: Array<{ type?: string; url_citation?: { url?: string; title?: string; content?: string } }> })
      .annotations ?? [];
  return annotations
    .filter((a) => a.type === "url_citation" && a.url_citation?.url)
    .map((a) => ({
      url: a.url_citation!.url!,
      title: a.url_citation!.title ?? "",
      excerpt: (a.url_citation!.content ?? "").slice(0, WEB_SEARCH_EXCERPT_CHARS),
    }));
}

export const openrouterAdapter: ProviderAdapter = {
  name: "openrouter",

  async complete(req: CompleteRequest): Promise<CompletionResult> {
    assertAnthropicOnlyCapabilitiesUnused("OpenRouter", req.model, req);

    const { completion, choice } = await createWithUpstreamRetry({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      ...(req.tools && req.tools.length > 0
        ? { tools: toChatTools(req.tools) }
        : {}),
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, req.model);

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
    assertAnthropicOnlyCapabilitiesUnused("OpenRouter", req.model, req);

    const { completion, choice } = await createWithUpstreamRetry({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      tools: toChatTools(req.tools),
      tool_choice: "auto",
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, req.model);

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

  async completeStructured<T>(req: StructuredRequest): Promise<T> {
    const { completion, choice } = await createWithUpstreamRetry({
      ...baseParams(req),
      messages: toChatMessages(req.messages, req.system),
      tools: [
        {
          type: "function",
          function: {
            name: "respond",
            description: `Provide the response as a ${req.schemaName}`,
            parameters: req.schema,
          },
        },
      ],
      tool_choice: { type: "function", function: { name: "respond" } },
    } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming, req.model);

    checkRefusal(choice, req.model);
    meter(completion, req.model);

    const call = (choice.message.tool_calls ?? []).find(
      (c) => c.type === "function" && c.function.name === "respond"
    );

    if (!call || call.type !== "function") {
      if (choice.finish_reason === "length") {
        throw new Error(
          `Structured response "${req.schemaName}" was truncated at ` +
            `max_tokens (${req.maxTokens}) and cannot be parsed. Increase ` +
            `maxTokens or reduce the input size.`
        );
      }
      // Tool-calling support varies across OpenRouter's zoo — name the model so
      // the fix (pick a tool-calling model) is obvious from the log line alone.
      throw new Error(
        `OpenRouter model "${req.model}" did not return the forced "respond" ` +
          `tool call for schema "${req.schemaName}" (finish_reason: ` +
          `${choice.finish_reason ?? "unknown"}). This model may not support ` +
          `tool calling — choose one that does, or route this agent to a ` +
          `"claude-…" or "gpt-…" model.`
      );
    }

    try {
      return parseToolArguments(call.function.arguments, "respond") as T;
    } catch {
      throw new Error(
        `Structured response "${req.schemaName}" from OpenRouter model ` +
          `"${req.model}" was not valid JSON.`
      );
    }
  },
};
