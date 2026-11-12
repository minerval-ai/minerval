/**
 * The adapter for an endpoint a deployment runs itself: an OpenAI-compatible
 * Chat Completions API, as vLLM, llama.cpp's server, TGI and Ollama serve
 * it, declared in MODEL_ENDPOINTS (endpoint-config.ts) and reached by a
 * model id of the shape "endpoint:<name>/<model>" (routing.ts).
 *
 * It is the OpenRouter adapter's wire format with a different base URL: the
 * translation in openai-dialect.ts, unchanged. What differs is what such a
 * server can be relied on for, and each difference is handled here or said
 * here:
 *
 *  1. Cost. The server reports tokens and no price, and no rate table can
 *     know what a deployment's own hardware costs. A call is priced from the
 *     endpoint's declared rates and handed to metering as the provider's
 *     cost, the path OpenRouter's reported cost takes, so budgets, the spend
 *     line an agent reads and the owl ledger work as they do everywhere.
 *     Every prompt token is charged at the input rate: the declaration has
 *     no cache rate, so a cached prefix is not discounted.
 *
 *  2. A reply with no token counts is refused (EndpointUnmeteredError)
 *     rather than estimated. A run is bounded by money, and money here is
 *     tokens at the declared rate; a count made up from the length of the
 *     text would put a guess in the ledger and let it stand as a charge,
 *     and a call let through at nothing would leave the run with no bound
 *     but its turn guard. All four servers above report usage on a
 *     non-streamed completion, so this only meets a proxy that strips it,
 *     and it is met on the first call.
 *
 *  3. Structured output is a `json_schema` response format, not the forced
 *     tool call OpenRouter needs. These servers constrain decoding to a
 *     schema natively, and forcing a named tool is the less portable of the
 *     two among them (Ollama ignores `tool_choice`). A server that ignores
 *     the format answers in prose or in JSON of another shape, so the reply
 *     is parsed and checked against the schema, and one that does not fit
 *     fails with the endpoint's name.
 *
 *  4. Tool calls come back in more than one shape. A turn that made tool
 *     calls is reported as `tool_use` whatever finish reason the server
 *     gave (some say "stop"), a call with no id is given one, and arguments
 *     sent as an object are accepted as well as the JSON string the
 *     dialect specifies.
 *
 *  5. No server tools, no container, no prompt-cache breakpoints, no
 *     refusal fallback, no streaming long-run path, and `effort` is not
 *     sent: these are Anthropic's. A request that carries a server tool
 *     fails naming it, as on the other two adapters; the agents offer web
 *     search and the sandbox by provider, so none does
 *     (tools/web-search-tool.ts, the Stewards' and the researcher's
 *     `sandbox`). `temperature` is sent only when a caller asks for one.
 *
 * An error from the endpoint is rethrown with the endpoint's name, its
 * address, the status and the server's own message, and with what the
 * request carried (tools, a response format), since a common cause is a
 * server started without that capability switched on.
 */
import OpenAI from "openai";

import { loadConfig } from "../../config.js";
import { undeclaredEndpointMessage } from "../../provider-labels.js";
import { LlmRefusalError } from "../errors.js";
import type { ModelEndpoint } from "./endpoint-config.js";
import { logCacheUsage, recordCallUsage } from "./metering.js";
import {
  assertAnthropicOnlyCapabilitiesUnused,
  fromChatMessage,
  mapFinishReason,
  sanitizeSchemaName,
  toChatMessages,
  toChatTools,
  toStrictJsonSchema,
} from "./openai-dialect.js";
import { endpointProviderName, parseEndpointModelId } from "./routing.js";
import type {
  CompleteRequest,
  CompletionResult,
  EndpointProviderName,
  ProviderAdapter,
  StructuredRequest,
  ToolCompleteRequest,
  ToolCompletionResult,
} from "./types.js";

type ChatCompletion = OpenAI.Chat.Completions.ChatCompletion;
type Choice = OpenAI.Chat.Completions.ChatCompletion.Choice;
type ChatParams = OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming;

/** The endpoint returned no token counts, so the call could not be priced. */
export class EndpointUnmeteredError extends Error {
  constructor(endpoint: ModelEndpoint, model: string) {
    super(
      `Endpoint "${endpoint.name}" (${endpoint.baseUrl}) returned no token usage for model ` +
        `"${model}", so the call could not be priced and its reply was not used. Every call is ` +
        `metered in money, from the tokens the endpoint reports and the rates MODEL_ENDPOINTS ` +
        `declares for it. Serve the model from a server that reports usage on each completion ` +
        `(vLLM, llama.cpp's server, TGI and Ollama do), or remove whatever strips it.`
    );
    this.name = "EndpointUnmeteredError";
  }
}

const clients = new Map<string, OpenAI>();

function getClient(endpoint: ModelEndpoint): OpenAI {
  let key = "";
  if (endpoint.keyEnv) {
    key = process.env[endpoint.keyEnv] ?? "";
    if (!key) {
      throw new Error(
        `Endpoint "${endpoint.name}" reads its key from the environment variable ` +
          `${endpoint.keyEnv}, which is not set. Set it, or remove "keyEnv" from the endpoint's ` +
          `entry in MODEL_ENDPOINTS if it takes no key.`
      );
    }
  }
  const cacheKey = `${endpoint.name}\n${endpoint.baseUrl}\n${key}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;
  const client = new OpenAI({
    // The SDK will not be built without a key. A server that takes none
    // ignores the header this placeholder is sent in.
    apiKey: key || "none",
    baseURL: endpoint.baseUrl,
    timeout: Number(process.env.LLM_REQUEST_TIMEOUT_MS ?? 180_000),
    maxRetries: Number(process.env.LLM_MAX_RETRIES ?? 4),
    fetch: ((...args: Parameters<typeof fetch>) => fetch(...args)) as unknown as NonNullable<
      ConstructorParameters<typeof OpenAI>[0]
    >["fetch"],
  });
  clients.set(cacheKey, client);
  return client;
}

/** Test seam: drop the memoized clients so a new endpoint or key takes effect. */
export function resetEndpointClients(): void {
  clients.clear();
}

/** The declared endpoint a model id routes to, or the error an installer reads. */
function endpointFor(modelId: string): { endpoint: ModelEndpoint; wireModel: string } {
  const parsed = parseEndpointModelId(modelId);
  const endpoints = loadConfig().modelEndpoints ?? [];
  const endpoint = parsed ? endpoints.find((e) => e.name === parsed.endpoint) : undefined;
  if (!parsed || !endpoint) {
    throw new Error(
      undeclaredEndpointMessage(modelId, endpoints) ??
        `"${modelId}" is not an endpoint model ID.`
    );
  }
  return { endpoint, wireModel: parsed.model };
}

/** What the request carried that a server may not support, for the error. */
function carried(params: ChatParams): string {
  const parts: string[] = [];
  const tools = (params.tools ?? []).length;
  if (tools > 0) parts.push(`${tools} tool definition${tools === 1 ? "" : "s"}`);
  if (params.response_format) parts.push("a json_schema response format");
  return parts.length > 0 ? ` (the request carried ${parts.join(" and ")})` : "";
}

/**
 * An SDK error, restated for whoever runs the endpoint. `status` and `name`
 * are kept, so a transient failure is still told from a request the server
 * will never accept (errors.ts, isTransientApiError).
 */
function endpointFailure(endpoint: ModelEndpoint, wireModel: string, params: ChatParams, err: unknown): Error {
  const status = (err as { status?: unknown })?.status;
  const message = err instanceof Error ? err.message : String(err);
  // The SDK's message opens with the status, which is said once here.
  const detail = typeof status === "number" ? message.replace(new RegExp(`^${status}\\s+`), "") : message;
  const failure = new Error(
    typeof status === "number"
      ? `Endpoint "${endpoint.name}" (${endpoint.baseUrl}) answered ${status} for model ` +
          `"${wireModel}"${carried(params)}: ${detail}`
      : `Endpoint "${endpoint.name}" (${endpoint.baseUrl}) could not be reached for model ` +
          `"${wireModel}": ${detail}`,
    { cause: err }
  );
  if (typeof status === "number") (failure as { status?: number }).status = status;
  if (err instanceof Error) failure.name = err.name;
  return failure;
}

async function create(
  endpoint: ModelEndpoint,
  wireModel: string,
  params: ChatParams
): Promise<{ completion: ChatCompletion; choice: Choice }> {
  const client = getClient(endpoint);
  let completion: ChatCompletion;
  try {
    completion = await client.chat.completions.create(params);
  } catch (err) {
    throw endpointFailure(endpoint, wireModel, params, err);
  }
  const choice = completion.choices?.[0];
  if (!choice) {
    const err = (completion as { error?: { message?: string } }).error?.message;
    throw new Error(
      `Endpoint "${endpoint.name}" (${endpoint.baseUrl}) returned no choices for model ` +
        `"${wireModel}"${err ? `: ${err}` : "."}`
    );
  }
  return { completion, choice };
}

/**
 * Price the call from the endpoint's declared rates and record it. Dollars
 * per million tokens times tokens is micro-dollars, the meter's unit.
 */
function meter(endpoint: ModelEndpoint, model: string, completion: ChatCompletion) {
  const usage = completion.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | null | undefined;
  const inputTokens = usage?.prompt_tokens;
  const outputTokens = usage?.completion_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new EndpointUnmeteredError(endpoint, model);
  }
  const priced = {
    inputTokens,
    outputTokens,
    costMicroUsd: Math.round(
      inputTokens * endpoint.inputUsdPerMtok + outputTokens * endpoint.outputUsdPerMtok
    ),
  };
  const provider = endpointProviderName(endpoint.name);
  // Recorded under the id the deployment configured, endpoint and all: the
  // bare model name a server echoes says nothing about where it was served.
  recordCallUsage(provider, model, priced);
  logCacheUsage(provider, priced);
  return priced;
}

function checkRefusal(choice: Choice, model: string): void {
  const refusal = choice.message.refusal;
  if (refusal) throw new LlmRefusalError(model, refusal);
  if (choice.finish_reason === "content_filter") {
    throw new LlmRefusalError(model, "content_filter");
  }
}

/**
 * The assistant message with its tool calls in the dialect's own shape: each
 * with an id, and arguments as a JSON string. Servers differ on both.
 */
function normalizeToolCalls(
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): OpenAI.Chat.Completions.ChatCompletionMessage {
  const calls = message.tool_calls;
  if (!calls || calls.length === 0) return message;
  const seen = new Set<string>();
  return {
    ...message,
    tool_calls: calls.map((call, i) => {
      if (call.type !== "function") return call;
      const args = call.function.arguments as unknown;
      let id = call.id || `call_${i}`;
      while (seen.has(id)) id = `${id}_${i}`;
      seen.add(id);
      return {
        ...call,
        id,
        function: {
          ...call.function,
          arguments: typeof args === "string" ? args : JSON.stringify(args ?? {}),
        },
      };
    }),
  };
}

function baseParams(
  wireModel: string,
  req: { maxTokens: number; temperature?: number }
): { model: string; max_tokens: number; temperature?: number } {
  return {
    model: wireModel,
    max_tokens: req.maxTokens,
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
  };
}

/**
 * Why `value` does not fit `schema`, or null when it does. It reads the
 * strict subset the seam's schemas are written in (client.ts,
 * completeStructured): types, closed objects with every property required,
 * arrays, enums, and anyOf/oneOf alternatives. A keyword it does not know
 * is not held against the value.
 */
export function schemaMismatch(value: unknown, schema: unknown, path = "the reply"): string | null {
  if (!schema || typeof schema !== "object") return null;
  const s = schema as Record<string, unknown>;

  for (const key of ["anyOf", "oneOf"] as const) {
    const alternatives = s[key];
    if (Array.isArray(alternatives) && alternatives.length > 0) {
      const reasons = alternatives.map((alt) => schemaMismatch(value, alt, path));
      if (reasons.every((r) => r !== null)) return `${path} fits none of the schema's alternatives`;
    }
  }
  if (Array.isArray(s.enum) && !s.enum.some((allowed) => allowed === value)) {
    return `${path} is not one of the values the schema allows`;
  }

  const types = typeof s.type === "string" ? [s.type] : Array.isArray(s.type) ? (s.type as string[]) : [];
  if (types.length > 0) {
    const actual =
      value === null
        ? "null"
        : Array.isArray(value)
          ? "array"
          : typeof value === "number" && Number.isInteger(value)
            ? "integer"
            : typeof value;
    const fits = types.some((t) => t === actual || (t === "number" && actual === "integer"));
    if (!fits) return `${path} is of type ${actual}, where the schema asks for ${types.join(" or ")}`;
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const properties = (s.properties ?? {}) as Record<string, unknown>;
    for (const key of Array.isArray(s.required) ? (s.required as string[]) : []) {
      if (!(key in obj)) return `${path} has no "${key}"`;
    }
    for (const [key, sub] of Object.entries(properties)) {
      if (!(key in obj)) continue;
      const reason = schemaMismatch(obj[key], sub, `${path}.${key}`);
      if (reason) return reason;
    }
  }
  if (Array.isArray(value) && s.items !== undefined) {
    for (let i = 0; i < value.length; i++) {
      const reason = schemaMismatch(value[i], s.items, `${path}[${i}]`);
      if (reason) return reason;
    }
  }
  return null;
}

/** The adapter serving `modelId`, an "endpoint:<name>/<model>" id. Throws when the endpoint is not declared. */
export function endpointAdapterFor(modelId: string): ProviderAdapter {
  const { endpoint } = endpointFor(modelId);
  const name: EndpointProviderName = endpointProviderName(endpoint.name);
  const label = `the endpoint "${endpoint.name}"`;

  return {
    name,

    async complete(req: CompleteRequest): Promise<CompletionResult> {
      const { endpoint, wireModel } = endpointFor(req.model);
      assertAnthropicOnlyCapabilitiesUnused(label, req.model, req);

      const { completion, choice } = await create(endpoint, wireModel, {
        ...baseParams(wireModel, req),
        messages: toChatMessages(req.messages, req.system),
        ...(req.tools && req.tools.length > 0 ? { tools: toChatTools(req.tools) } : {}),
      });

      checkRefusal(choice, req.model);
      const usage = meter(endpoint, req.model, completion);

      return {
        content: choice.message.content ?? "",
        model: req.model,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        stopReason: mapFinishReason(choice.finish_reason),
        container: null,
      };
    },

    async completeWithTools(req: ToolCompleteRequest): Promise<ToolCompletionResult> {
      const { endpoint, wireModel } = endpointFor(req.model);
      assertAnthropicOnlyCapabilitiesUnused(label, req.model, req);

      const { completion, choice } = await create(endpoint, wireModel, {
        ...baseParams(wireModel, req),
        messages: toChatMessages(req.messages, req.system),
        tools: toChatTools(req.tools),
        tool_choice: "auto",
      });

      checkRefusal(choice, req.model);
      const usage = meter(endpoint, req.model, completion);
      const turn = fromChatMessage(normalizeToolCalls(choice.message));
      const stopReason = mapFinishReason(choice.finish_reason);

      return {
        content: turn.content,
        model: req.model,
        usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
        // A turn with tool calls is a tool-use turn, whatever the server
        // called it: the loop would otherwise end on "stop" with the calls
        // unrun. A cutoff stays a cutoff, which the loop recovers from.
        stopReason: turn.toolUses.length > 0 && stopReason !== "max_tokens" ? "tool_use" : stopReason,
        toolUses: turn.toolUses,
        rawContent: turn.rawContent,
        container: null,
      };
    },

    async completeStructured<T>(req: StructuredRequest): Promise<T> {
      const { endpoint, wireModel } = endpointFor(req.model);
      const schema = toStrictJsonSchema(req.schema) as Record<string, unknown>;

      const { completion, choice } = await create(endpoint, wireModel, {
        ...baseParams(wireModel, req),
        messages: toChatMessages(req.messages, req.system),
        response_format: {
          type: "json_schema",
          json_schema: { name: sanitizeSchemaName(req.schemaName), strict: true, schema },
        },
      });

      checkRefusal(choice, req.model);
      meter(endpoint, req.model, completion);

      if (choice.finish_reason === "length") {
        throw new Error(
          `Structured response "${req.schemaName}" was truncated at ` +
            `max_tokens (${req.maxTokens}) and cannot be parsed. Increase ` +
            `maxTokens or reduce the input size.`
        );
      }

      const unusable = (why: string) =>
        new Error(
          `Endpoint "${endpoint.name}" (${endpoint.baseUrl}) did not return the structured ` +
            `response "${req.schemaName}" from model "${wireModel}": ${why}. The request asked ` +
            `for it with a json_schema response format, which the server has to support and ` +
            `apply for this model.`
        );
      let parsed: unknown;
      try {
        parsed = JSON.parse(choice.message.content ?? "");
      } catch {
        throw unusable("the reply is not JSON");
      }
      const mismatch = schemaMismatch(parsed, schema);
      if (mismatch) throw unusable(mismatch);
      return parsed as T;
    },
  };
}
