/**
 * Translation between the seam's Anthropic dialect and the OpenAI Chat
 * Completions dialect — plus the provider-neutral helpers shared with the
 * Responses translation next door.
 *
 * WHO USES WHAT
 * -------------
 * The Chat Completions translation (toChatMessages / toChatTools /
 * fromChatMessage / mapFinishReason / usageFromCompletion) is **OpenRouter's**,
 * and OpenRouter's alone. The OpenAI direct adapter used to share it; it now
 * speaks the Responses API (see responses-dialect.ts).
 *
 * WHY THEY DIVERGED
 * -----------------
 * The original argument for one shared Chat Completions translator was that it
 * maps 1:1 onto the seam's Anthropic-shaped assistant turn (tool_use ↔
 * `tool_calls`, tool_result ↔ a `role:"tool"` message) with no provider-opaque
 * state smuggled through toolUseLoop, whereas Responses wants a flat item list
 * and, for a reasoning model, wants reasoning items echoed back. That argument
 * traded away the two things Responses is for: OpenAI's hosted server-side
 * tools (web search, code interpreter) live only there, and reasoning context
 * is only carried across turns of a tool loop there. Both are worth the opaque
 * round-trip — which `rawContent` was already designed to permit — so the
 * OpenAI adapter took it. OpenRouter has no equivalent surface for our
 * purposes and stays here, unchanged.
 *
 * The genuinely dialect-independent pieces below — the Anthropic-only
 * capability guard, strict-schema coercion, schema-name sanitising,
 * tool-argument parsing, tool_result flattening — are imported by BOTH
 * translations, so each still has exactly one place to fix a bug.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import type { LlmContentBlock, LlmMessage, LlmTool, ToolUse } from "./types.js";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
type ChatTool = OpenAI.Chat.Completions.ChatCompletionTool;

/**
 * Anthropic server tools (web_search, code execution, …) carry a versioned
 * `type` and no `input_schema`; client tools always carry `input_schema`.
 */
export function isServerTool(tool: LlmTool): boolean {
  return !("input_schema" in tool);
}

/**
 * Server tools and containers are Anthropic-only in this pass. Fail with a
 * message that names the capability and the way out, rather than sending a
 * request the other provider will reject on its own obscure terms.
 */
export function assertAnthropicOnlyCapabilitiesUnused(
  provider: string,
  model: string,
  opts: { tools?: LlmTool[]; container?: string }
): void {
  const serverTools = (opts.tools ?? []).filter(isServerTool);
  if (serverTools.length > 0) {
    const names = serverTools
      .map((t) => (t as { name?: string; type?: string }).name ?? (t as { type?: string }).type)
      .join(", ");
    throw new Error(
      `Anthropic server tools (${names}) are not supported on ${provider} ` +
        `(model "${model}"). Server tools and containers are Anthropic-only — ` +
        `run this agent on a "claude-…" model, or give it client-side tools only.`
    );
  }
  if (opts.container) {
    throw new Error(
      `Container-backed execution is not supported on ${provider} (model ` +
        `"${model}"). Containers are Anthropic-only.`
    );
  }
}

/** Flatten an Anthropic tool_result payload to the plain string OpenAI wants. */
export function toolResultText(
  content: Anthropic.ToolResultBlockParam["content"]
): string {
  if (typeof content === "string") return content;
  if (!content) return "";
  let text = "";
  for (const block of content) {
    if (block.type === "text") text += block.text;
  }
  return text;
}

/**
 * Translate the seam's Anthropic messages (plus an optional system prompt) into
 * Chat Completions messages.
 *
 * tool_result blocks become standalone `role:"tool"` messages emitted BEFORE
 * any sibling text, because the API requires every tool call to be answered
 * immediately after the assistant turn that made it.
 */
export function toChatMessages(
  messages: LlmMessage[],
  system?: string
): ChatMessage[] {
  const out: ChatMessage[] = [];
  if (system) out.push({ role: "system", content: system });

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const text: string[] = [];
    const toolCalls: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[] = [];
    const toolMessages: ChatMessage[] = [];

    for (const block of message.content) {
      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "tool_use":
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
          break;
        case "tool_result":
          toolMessages.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: toolResultText(block.content),
          });
          break;
        default:
          throw new Error(
            `Content block "${block.type}" is not supported on the ` +
              `OpenAI-compatible path (only text, tool_use, and tool_result are).`
          );
      }
    }

    // Tool results first, then whatever text rode along (e.g. toolUseLoop's
    // iteration-budget notice).
    out.push(...toolMessages);
    if (message.role === "assistant") {
      if (text.length > 0 || toolCalls.length > 0) {
        out.push({
          role: "assistant",
          content: text.length > 0 ? text.join("") : null,
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        });
      }
    } else if (text.length > 0) {
      out.push({ role: "user", content: text.join("") });
    }
  }

  return out;
}

/** Translate Anthropic client tools into OpenAI function tools. */
export function toChatTools(tools: LlmTool[]): ChatTool[] {
  return tools.map((tool) => {
    const t = tool as Anthropic.Tool;
    return {
      type: "function" as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema as unknown as Record<string, unknown>,
      },
    };
  });
}

/**
 * OpenAI finish reasons, expressed in the seam's Anthropic vocabulary so
 * toolUseLoop's control flow is provider-independent.
 */
export function mapFinishReason(reason: string | null | undefined): string | null {
  switch (reason) {
    case "stop":
      return "end_turn";
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "refusal";
    default:
      return reason ?? null;
  }
}

export interface ParsedAssistantTurn {
  content: string;
  toolUses: ToolUse[];
  rawContent: LlmContentBlock[];
}

/**
 * Re-express an assistant message as Anthropic content blocks so it can round
 * trip through toolUseLoop and come back out of toChatMessages unchanged.
 */
export function fromChatMessage(
  message: OpenAI.Chat.Completions.ChatCompletionMessage
): ParsedAssistantTurn {
  const rawContent: LlmContentBlock[] = [];
  const toolUses: ToolUse[] = [];
  const content = message.content ?? "";

  if (content) {
    rawContent.push({ type: "text", text: content, citations: null } as LlmContentBlock);
  }

  for (const call of message.tool_calls ?? []) {
    if (call.type !== "function") continue;
    const input = parseToolArguments(call.function.arguments, call.function.name);
    toolUses.push({ id: call.id, name: call.function.name, input });
    rawContent.push({
      type: "tool_use",
      id: call.id,
      name: call.function.name,
      input,
    } as unknown as LlmContentBlock);
  }

  return { content, toolUses, rawContent };
}

/** Parse a tool call's JSON arguments, naming the tool when it isn't valid JSON. */
export function parseToolArguments(
  args: string,
  toolName: string
): Record<string, unknown> {
  if (!args) return {};
  try {
    return JSON.parse(args) as Record<string, unknown>;
  } catch {
    throw new Error(
      `Tool call "${toolName}" returned arguments that are not valid JSON.`
    );
  }
}

/**
 * Coerce a schema into the strict-mode subset both OpenAI's `strict: true`
 * json_schema and Anthropic's output_config require: every object closed with
 * `additionalProperties: false` and a `required` array naming every property.
 *
 * Call-site schemas already satisfy this (the structured-outputs migration made
 * them so), which makes this a cheap idempotent guard rather than a translation
 * layer — a schema that drifts still gets a working request instead of a 400.
 */
export function toStrictJsonSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(toStrictJsonSchema);
  if (schema === null || typeof schema !== "object") return schema;

  const node = { ...(schema as Record<string, unknown>) };

  if (node.properties && typeof node.properties === "object") {
    const properties = node.properties as Record<string, unknown>;
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(properties)) {
      next[key] = toStrictJsonSchema(value);
    }
    node.properties = next;
    node.additionalProperties = false;
    node.required = Object.keys(next);
  }

  if (node.items !== undefined) node.items = toStrictJsonSchema(node.items);
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    if (Array.isArray(node[key])) {
      node[key] = (node[key] as unknown[]).map(toStrictJsonSchema);
    }
  }

  return node;
}

/**
 * Normalize OpenAI-style usage into the seam's accounting.
 *
 * `prompt_tokens` on an OpenAI-compatible API INCLUDES cached tokens, whereas
 * the seam (and pricing.ts) treats `inputTokens` as the UNCACHED count the way
 * Anthropic reports it. Subtract here so the components stay additive and cache
 * reads get billed at the cache-read multiplier exactly once.
 *
 * `cache_write_tokens` is read defensively: it is absent on the pre-5.6 models
 * (where cache writes are free) and present on the newer ones.
 */
export function usageFromCompletion(
  usage: OpenAI.CompletionUsage | undefined
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } {
  const promptTokens = usage?.prompt_tokens ?? 0;
  const details = usage?.prompt_tokens_details as
    | { cached_tokens?: number; cache_write_tokens?: number }
    | undefined;
  const cacheRead = details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, promptTokens - cacheRead - cacheWrite),
    outputTokens: usage?.completion_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
  };
}

/** OpenAI schema names must be a-z, A-Z, 0-9, underscore or dash (≤64 chars). */
export function sanitizeSchemaName(name: string): string {
  const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return cleaned || "response";
}
