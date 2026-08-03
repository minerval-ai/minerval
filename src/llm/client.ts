/**
 * The LLM seam.
 *
 * Five functions — complete, completeWithTools, completeStructured,
 * completeStructuredList, toolUseLoop — are the ONLY way anything in this
 * codebase talks to a model. Their signatures speak the Anthropic dialect
 * (`MessageParam`, `ToolUnion`) and are stable across providers: every agent in
 * src/llm/agents/ is written against them, and switching an agent to another
 * provider is one env var (MATCHER_MODEL=qwen/qwen3-…), never a code change.
 *
 * This file does dispatch and provider-independent control flow only. The
 * request-building, wire format, and response parsing for each backend live in
 * src/llm/providers/ — see providers/routing.ts for how a model id picks one.
 */
import type Anthropic from "@anthropic-ai/sdk";

type MessageParam = Anthropic.MessageParam;
type ToolUnion = Anthropic.Messages.ToolUnion;
type ToolResultBlockParam = Anthropic.ToolResultBlockParam;

import { checkBudget } from "./budget-tracker.js";
import { DEFAULT_MODEL } from "./models.js";
import { getAdapter } from "./providers/index.js";
import type {
  CompletionResult,
  TokenUsage,
  ToolCompletionResult,
  ToolUse,
} from "./providers/types.js";

export type { CompletionResult, TokenUsage, ToolCompletionResult, ToolUse };

const DEFAULT_MAX_TOKENS = 8192;

export async function complete(options: {
  messages: MessageParam[];
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolUnion[];
  container?: string;
}): Promise<CompletionResult> {
  checkBudget();
  const model = options.model ?? DEFAULT_MODEL;
  // Sonnet 5 runs adaptive thinking by default and thinking spend counts
  // against max_tokens, so the old 4096 default left too little room for the
  // actual answer — 8192 keeps headroom without changing agent call sites.
  return getAdapter(model).complete({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

export async function completeWithTools(options: {
  messages: MessageParam[];
  tools: ToolUnion[];
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  container?: string;
}): Promise<ToolCompletionResult> {
  checkBudget();
  const model = options.model ?? DEFAULT_MODEL;
  return getAdapter(model).completeWithTools({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

/**
 * Get a structured response constrained to `schema`.
 *
 * Each adapter uses its platform's native mechanism (Anthropic
 * `output_config.format`, OpenAI strict `json_schema`, a forced "respond" tool
 * call on OpenRouter), so write schemas to the strict JSON Schema subset they
 * share: every object closed with `additionalProperties: false` and a complete
 * `required` array (make an optional field required-but-nullable), no numeric
 * bounds or string length constraints, no recursion. Validate the rest in code.
 */
export async function completeStructured<T>(options: {
  messages: MessageParam[];
  schema: Record<string, unknown>;
  schemaName: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<T> {
  checkBudget();
  const model = options.model ?? DEFAULT_MODEL;
  return getAdapter(model).completeStructured<T>({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
}

/**
 * Get a structured list response by wrapping the item schema in an
 * `{ items: [...] }` object (structured outputs require a top-level object).
 */
export async function completeStructuredList<T>(options: {
  messages: MessageParam[];
  itemSchema: Record<string, unknown>;
  schemaName: string;
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}): Promise<T[]> {
  const wrapperSchema = {
    type: "object" as const,
    properties: {
      items: {
        type: "array",
        items: options.itemSchema,
      },
    },
    required: ["items"],
    additionalProperties: false,
  };

  const result = await completeStructured<{ items: T[] }>({
    messages: options.messages,
    schema: wrapperSchema,
    schemaName: `ListOf${options.schemaName}`,
    system: options.system,
    model: options.model,
    maxTokens: options.maxTokens,
    temperature: options.temperature,
  });

  if (!Array.isArray(result?.items)) {
    // Defensive: completeStructured already throws on max_tokens truncation
    // and on unparseable JSON, but fail with an actionable message here too
    // rather than a downstream "x is not iterable".
    throw new Error(
      `Structured list "${options.schemaName}" returned no items array — the ` +
        `response was likely truncated at max_tokens (${options.maxTokens ?? DEFAULT_MAX_TOKENS}). ` +
        `Increase maxTokens or reduce the input size.`
    );
  }

  return result.items;
}

/**
 * Run a multi-turn tool-use loop. Calls the model, executes tools, feeds results back.
 * Continues until the model stops calling tools or maxIterations is reached.
 *
 * Provider-independent: the loop appends the assistant turn and tool results as
 * Anthropic content blocks, and each adapter translates that into its own
 * dialect on the next request. `stopReason` is likewise normalized to the
 * Anthropic vocabulary ("end_turn", "max_tokens", "tool_use", "pause_turn").
 */
export async function toolUseLoop(options: {
  initialMessages: MessageParam[];
  tools: ToolUnion[];
  system?: string;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  maxIterations?: number;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Called when the model calls a "final" tool (e.g. submit_decomposition). Return result to stop loop. */
  onFinalTool?: (name: string, input: Record<string, unknown>) => unknown | null;
  /**
   * When set, the loop appends a plain-text budget notice to the tool-result
   * message once only `warnWithin` iterations remain, so the agent can finish
   * its essential actions (e.g. recording an assessment) instead of being cut
   * off mid-task at maxIterations. The string is the agent-facing wording.
   */
  iterationBudgetNotice?: { warnWithin: number; message: (remaining: number) => string };
}): Promise<ToolCompletionResult> {
  const messages = [...options.initialMessages];
  const maxIter = options.maxIterations ?? 5;
  let lastResult: ToolCompletionResult | null = null;
  // Container-backed server tools (web_search_20260209 runs via code execution)
  // mint a container on first use that MUST be passed back on every later turn of
  // the loop, or the API rejects the request. Thread the latest id through.
  // Anthropic-only; the other adapters never return one.
  let containerId: string | undefined;

  for (let i = 0; i < maxIter; i++) {
    const result = await completeWithTools({
      messages,
      tools: options.tools,
      system: options.system,
      model: options.model,
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      container: containerId,
    });

    lastResult = result;
    if (result.container) containerId = result.container;

    // A long-running server tool (e.g. web_search) can pause the turn. The
    // documented continuation is to resubmit the assistant content UNCHANGED and
    // call again — NOT to inject tool results. Doing the latter (or doing nothing)
    // strands a pending server_tool_use and the next request 400s with
    // "container_id is required when there are pending tool uses…".
    if (result.stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: result.rawContent });
      continue;
    }

    // A turn truncated at max_tokens can leave a server tool use (web search)
    // half-emitted. Resubmitting that turn triggers the same 400, which would
    // crash the whole agent run and lose its work. Stop gracefully with the
    // best-effort result instead — the caller (e.g. the Steward) has already
    // been told to record its conclusion before the budget runs out.
    if (result.stopReason === "max_tokens") {
      return result;
    }

    if (result.stopReason === "end_turn" || result.toolUses.length === 0) {
      return result;
    }

    // Check for final tool
    if (options.onFinalTool) {
      for (const tu of result.toolUses) {
        const finalResult = options.onFinalTool(tu.name, tu.input);
        if (finalResult !== null && finalResult !== undefined) {
          return result;
        }
      }
    }

    // Execute tools and build tool_result messages
    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of result.toolUses) {
      const output = await options.executeTool(tu.name, tu.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: output,
      });
    }

    // If the iteration budget is nearly spent, tell the agent so it can wrap up
    // its essential actions on the next turn rather than being hard-cut.
    const remaining = maxIter - 1 - i;
    const notice = options.iterationBudgetNotice;
    const userContent: Array<ToolResultBlockParam | { type: "text"; text: string }> = [
      ...toolResults,
    ];
    if (notice && remaining > 0 && remaining <= notice.warnWithin) {
      userContent.push({ type: "text", text: notice.message(remaining) });
    }

    // Append assistant message and tool results
    messages.push({ role: "assistant", content: result.rawContent });
    messages.push({ role: "user", content: userContent });
  }

  return lastResult!;
}
