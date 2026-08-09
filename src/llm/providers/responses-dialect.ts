/**
 * Translation between the seam's Anthropic dialect and OpenAI's **Responses**
 * API, used by the OpenAI direct adapter only.
 *
 * WHY RESPONSES (AND WHY IT IS NOT SHARED WITH OPENROUTER)
 * -------------------------------------------------------
 * Responses is OpenAI's platform-native surface: hosted server-side tools (web
 * search, code interpreter) exist only there, and every GPT-5 model is a
 * reasoning model whose chain of thought is only carried across turns of a tool
 * loop on this API. OpenRouter does not expose an equivalent, so it keeps the
 * Chat Completions translation in openai-dialect.ts. Provider-neutral helpers
 * (strict-schema coercion, schema-name sanitising, tool-argument parsing, the
 * Anthropic-only capability guard) still live in that module and are imported
 * here, so there is exactly one place to fix a bug in each of them.
 *
 * THE REASONING ROUND-TRIP
 * ------------------------
 * We are stateless: `store: false` on every request, full history resent each
 * turn, `previous_response_id` never used. For a reasoning model that means the
 * ONLY way to carry reasoning across a tool loop is to ask for
 * `include: ["reasoning.encrypted_content"]` and echo the returned reasoning
 * items back — verbatim, in their original position relative to the
 * function_call items they precede.
 *
 * The seam's `rawContent` is provider-opaque (it only ever round-trips through
 * toolUseLoop's message append; no agent reads it — see providers/types.ts), so
 * this module smuggles the whole Responses `output` array through it inside one
 * synthetic content block. `toResponsesInput` splices those items straight back
 * into the next request's `input`, which makes the round-trip byte-exact rather
 * than a lossy re-derivation from Anthropic blocks.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type OpenAI from "openai";

import { isWebSearchServerTool, parseToolArguments, toolResultText } from "./openai-dialect.js";
import type { LlmContentBlock, LlmMessage, LlmTool, ToolUse } from "./types.js";

type ResponseInputItem = OpenAI.Responses.ResponseInputItem;
type ResponseOutputItem = OpenAI.Responses.ResponseOutputItem;
type ResponsesTool = OpenAI.Responses.Tool;

/**
 * The synthetic Anthropic content block that carries a turn's Responses items
 * through toolUseLoop. Deliberately not a real Anthropic block type: nothing
 * but this module may interpret it, and an unrecognised block reaching another
 * adapter should fail loudly rather than be silently half-understood.
 */
const RESPONSES_ITEMS_BLOCK = "openai_responses_items" as const;

interface ResponsesItemsBlock {
  type: typeof RESPONSES_ITEMS_BLOCK;
  items: ResponseInputItem[];
}

/** Wrap a turn's raw output items as the seam's opaque `rawContent`. */
export function responsesItemsBlock(items: ResponseOutputItem[]): LlmContentBlock {
  const block: ResponsesItemsBlock = {
    type: RESPONSES_ITEMS_BLOCK,
    items: items as unknown as ResponseInputItem[],
  };
  return block as unknown as LlmContentBlock;
}

/** The items inside an opaque turn block, or null if this isn't one. */
function readResponsesItemsBlock(block: { type: string }): ResponseInputItem[] | null {
  if (block.type !== RESPONSES_ITEMS_BLOCK) return null;
  return (block as unknown as ResponsesItemsBlock).items ?? [];
}

/**
 * Translate the seam's Anthropic messages into a Responses `input` array.
 *
 * The system prompt does NOT come through here — it rides in the request's
 * `instructions` field, which is where Responses wants it.
 *
 * Ordering matters: a `function_call_output` must follow the `function_call` it
 * answers, so tool results are emitted in place and any plain text riding along
 * in the same message (toolUseLoop's iteration-budget notice) is emitted after
 * them as its own message item.
 */
export function toResponsesInput(messages: LlmMessage[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];

  for (const message of messages) {
    if (typeof message.content === "string") {
      out.push({ role: message.role, content: message.content });
      continue;
    }

    const text: string[] = [];

    for (const block of message.content) {
      const items = readResponsesItemsBlock(block);
      if (items) {
        // A previous assistant turn from this adapter: reasoning items (with
        // their encrypted_content), message items and function_call items, all
        // replayed verbatim and in order.
        out.push(...items);
        continue;
      }

      switch (block.type) {
        case "text":
          text.push(block.text);
          break;
        case "tool_use":
          // Only reachable for a turn this adapter did not produce (e.g. an
          // agent hand-building history); the opaque block covers our own.
          out.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: JSON.stringify(block.input ?? {}),
          });
          break;
        case "tool_result":
          out.push({
            type: "function_call_output",
            call_id: block.tool_use_id,
            output: toolResultText(
              block.content as Anthropic.ToolResultBlockParam["content"]
            ),
          });
          break;
        default:
          throw new Error(
            `Content block "${block.type}" is not supported on the OpenAI ` +
              `Responses path (only text, tool_use, and tool_result are).`
          );
      }
    }

    if (text.length > 0) {
      out.push({ role: message.role, content: text.join("") });
    }
  }

  return out;
}

/**
 * Build the request's `tools` array from the seam's Anthropic client tools.
 *
 * HOSTED-TOOL SEAM: OpenAI's server-side tools are ordinary entries in this
 * same array — `{ type: "web_search" }`, `{ type: "code_interpreter",
 * container: { type: "auto" } }` — and the model calls them without a round
 * trip through executeTool. Being able to push them here is the whole reason
 * this adapter moved off Chat Completions. Web search is mapped (see
 * isWebSearchServerTool in openai-dialect.ts); the rest of the seam's
 * server-tool vocabulary is still Anthropic-only
 * (assertAnthropicOnlyCapabilitiesUnused). Note the hosted tool's per-call
 * fee is billed by OpenAI outside token usage, so llm_usage slightly
 * understates the cost of searching turns.
 */
export function toResponsesTools(tools: LlmTool[]): ResponsesTool[] {
  const out: ResponsesTool[] = [];
  for (const tool of tools) {
    if (isWebSearchServerTool(tool)) {
      // Anthropic's max_uses has no direct equivalent here; the agent-side
      // iteration budget bounds search volume instead.
      out.push({ type: "web_search" } as ResponsesTool);
      continue;
    }
    const t = tool as Anthropic.Tool;
    out.push({
      type: "function",
      name: t.name,
      description: t.description ?? null,
      parameters: t.input_schema as unknown as Record<string, unknown>,
      // Tool arguments are validated by our own tool implementations; strict
      // mode would additionally require every agent tool schema to be closed.
      strict: false,
    });
  }
  return out;
}

export interface ParsedResponsesTurn {
  content: string;
  toolUses: ToolUse[];
  rawContent: LlmContentBlock[];
  /** The refusal text from a `refusal` content part, if the model refused. */
  refusal: string | null;
}

/**
 * Re-express a Response as the seam's assistant turn. `rawContent` keeps the
 * output items verbatim so the next request can replay them (see the reasoning
 * round-trip note above).
 */
export function fromResponse(
  response: OpenAI.Responses.Response
): ParsedResponsesTurn {
  let content = "";
  let refusal: string | null = null;
  const toolUses: ToolUse[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const part of item.content) {
        if (part.type === "output_text") content += part.text;
        else if (part.type === "refusal") refusal = part.refusal;
      }
    } else if (item.type === "function_call") {
      toolUses.push({
        id: item.call_id,
        name: item.name,
        input: parseToolArguments(item.arguments, item.name),
      });
    }
  }

  return {
    content,
    toolUses,
    rawContent: [responsesItemsBlock(response.output ?? [])],
    refusal,
  };
}

/**
 * Responses statuses expressed in the seam's Anthropic vocabulary, so
 * toolUseLoop's control flow stays provider-independent.
 *
 * There is no per-turn "finish reason" on this API: a truncated turn is
 * `status: "incomplete"` with `incomplete_details.reason`, and a turn that
 * wants tools is simply a completed one carrying function_call items.
 */
export function mapResponseStatus(
  response: OpenAI.Responses.Response,
  toolUseCount: number
): string | null {
  const reason = response.incomplete_details?.reason;
  if (reason === "max_output_tokens") return "max_tokens";
  if (reason === "content_filter") return "refusal";
  if (response.status === "incomplete") return "max_tokens";
  if (toolUseCount > 0) return "tool_use";
  return "end_turn";
}

/**
 * Normalize Responses usage into the seam's accounting.
 *
 * `input_tokens` INCLUDES cached tokens, whereas the seam (and pricing.ts)
 * treats `inputTokens` as the UNCACHED count the way Anthropic reports it.
 * Subtract here so the four components stay additive and cache reads get billed
 * at the cache-read multiplier exactly once — the same invariant the Chat
 * Completions path maintains in usageFromCompletion.
 */
export function usageFromResponse(
  usage: OpenAI.Responses.ResponseUsage | undefined
): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
} {
  const inputTokens = usage?.input_tokens ?? 0;
  const details = usage?.input_tokens_details as
    | { cached_tokens?: number; cache_write_tokens?: number }
    | undefined;
  const cacheRead = details?.cached_tokens ?? 0;
  const cacheWrite = details?.cache_write_tokens ?? 0;
  return {
    inputTokens: Math.max(0, inputTokens - cacheRead - cacheWrite),
    outputTokens: usage?.output_tokens ?? 0,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheWrite,
  };
}
