/**
 * The LLM seam.
 *
 * Six functions — complete, completeWithTools, completeStructured,
 * completeStructuredList, toolUseLoop, longRunToolLoop — are the ONLY way
 * anything in this codebase talks to a model. Their signatures speak the
 * Anthropic dialect (`MessageParam`, `ToolUnion`) and the first five are stable
 * across providers: every agent in src/llm/agents/ is written against them, and
 * switching an agent to another provider is one env var
 * (MATCHER_MODEL=qwen/qwen3-…), never a code change. The sixth,
 * longRunToolLoop, is the Anthropic-only path for agents that run for hours
 * (streaming, betas, task budgets, per-turn hooks); it fails with a capability
 * message on any other provider rather than degrading silently.
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
import { getUsageContext } from "./usage-context.js";
import { recordAgentStep } from "../services/trace-service.js";
import { getAdapter } from "./providers/index.js";
import type {
  CompletionResult,
  EffortLevel,
  SystemPrompt,
  TokenUsage,
  ToolCompletionResult,
  ToolUse,
} from "./providers/types.js";

export type {
  CompletionResult,
  EffortLevel,
  SystemPrompt,
  TokenUsage,
  ToolCompletionResult,
  ToolUse,
};

const DEFAULT_MAX_TOKENS = 8192;

export async function complete(options: {
  messages: MessageParam[];
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolUnion[];
  container?: string;
  effort?: EffortLevel;
}): Promise<CompletionResult> {
  checkBudget();
  const model = options.model ?? DEFAULT_MODEL;
  // Sonnet 5 runs adaptive thinking by default and thinking spend counts
  // against max_tokens, so the old 4096 default left too little room for the
  // actual answer — 8192 keeps headroom without changing agent call sites.
  const result = await getAdapter(model).complete({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  recordCompletionStep({
    model,
    messages: options.messages,
    system: options.system,
    output: result.content,
    stopReason: result.stopReason,
  });
  return result;
}

/**
 * A single-shot completion is a whole agent turn for the agents that never
 * enter a tool-use loop (the Extractor, the scorecard judge), so when a trace
 * is active it is recorded as one "completion" step: the prompt, the output,
 * and the size of the system prompt (not its text — it is the constitution,
 * large and static). Without this an Extractor run was a bare agent_runs
 * row with no steps (#334 L0).
 */
function recordCompletionStep(step: {
  model: string;
  messages: MessageParam[];
  system?: SystemPrompt;
  schemaName?: string;
  output: unknown;
  stopReason?: string | null;
}): void {
  const trace = getUsageContext().trace;
  if (!trace) return;
  // The system prompt may be several cached blocks (constitution-plus-role,
  // then one per domain skill); the size recorded is the total.
  const systemChars =
    typeof step.system === "string"
      ? step.system.length
      : (step.system ?? []).reduce((n, block) => n + block.length, 0);
  recordAgentStep(trace, "completion", {
    model: step.model,
    schemaName: step.schemaName ?? null,
    systemChars,
    messages: step.messages,
    output: step.output,
    stopReason: step.stopReason ?? null,
  });
}

export async function completeWithTools(options: {
  messages: MessageParam[];
  tools: ToolUnion[];
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  container?: string;
  effort?: EffortLevel;
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
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
}): Promise<T> {
  checkBudget();
  const model = options.model ?? DEFAULT_MODEL;
  const result = await getAdapter(model).completeStructured<T>({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  recordCompletionStep({
    model,
    messages: options.messages,
    system: options.system,
    schemaName: options.schemaName,
    output: result,
  });
  return result;
}

/**
 * Get a structured list response by wrapping the item schema in an
 * `{ items: [...] }` object (structured outputs require a top-level object).
 */
export async function completeStructuredList<T>(options: {
  messages: MessageParam[];
  itemSchema: Record<string, unknown>;
  schemaName: string;
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
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
    effort: options.effort,
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
 *
 * The history is append-only: an earlier turn is never edited once sent. The
 * strong tier binds its thinking blocks to the turns around them and rejects a
 * history whose earlier turns changed, and the moving cache breakpoint in the
 * Anthropic adapter only pays off when the prefix it caches stays put.
 */
export async function toolUseLoop(options: {
  initialMessages: MessageParam[];
  tools: ToolUnion[];
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
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
  // Trace handle from the enclosing withAgent, when tracing is enabled: the
  // loop is where the transcript exists, so it's where steps are recorded
  // (#334 L0). Absent handle = record nothing, zero overhead.
  const trace = getUsageContext().trace;
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
      effort: options.effort,
      container: containerId,
    });

    lastResult = result;
    if (result.container) containerId = result.container;

    // One step per model turn, whatever the loop decides to do with it —
    // pause_turn continuations and max_tokens cutoffs are part of the record.
    if (trace) {
      recordAgentStep(trace, "assistant", {
        stopReason: result.stopReason,
        content: result.rawContent,
      });
    }

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
    const executedTools: Array<{ name: string; input: unknown; output: string }> = [];
    for (const tu of result.toolUses) {
      const output = await options.executeTool(tu.name, tu.input);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: output,
      });
      executedTools.push({ name: tu.name, input: tu.input, output });
    }
    if (trace && executedTools.length > 0) {
      recordAgentStep(trace, "tool_results", executedTools);
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

// --- The long-run path -----------------------------------------------------

/** Why longRunToolLoop returned. */
export type LongRunStopReason =
  /** The model finished (end_turn, or a turn with no tool calls). */
  | "end_turn"
  /** `onFinalTool` accepted a tool call. */
  | "final_tool"
  /** `beforeTurn` asked the loop to stop; see `hookStop`. */
  | "hook"
  /** `maxIterations` model turns ran. */
  | "max_iterations"
  /** `maxWallMs` elapsed before the next turn could start. */
  | "max_wall"
  /** Two consecutive turns hit max_tokens; the one continuation did not help. */
  | "max_tokens";

/** What the per-turn hooks see. */
export interface LongRunLoopState {
  /** Model turns completed so far: 0 in `beforeTurn` of the first turn, 1 in `afterTurn` of it. */
  turn: number;
  /** The append-only history as sent so far. Read it; never edit earlier entries. */
  messages: readonly MessageParam[];
  /** Epoch millis when the loop started. */
  startedAt: number;
  elapsedMs: number;
  lastResult: ToolCompletionResult | null;
  /** Token usage summed over every turn so far, cache components included. */
  usage: Required<TokenUsage>;
}

export interface LongRunLoopResult {
  /** The last model turn, or null when a hook stopped the loop before the first one. */
  result: ToolCompletionResult | null;
  /** Model turns that ran. */
  turns: number;
  stopReason: LongRunStopReason;
  /** The reason `beforeTurn` gave, when `stopReason` is "hook". */
  hookStop?: string;
}

/** Sent as the next user message when a turn is cut off at max_tokens. */
export const CONTINUE_AFTER_MAX_TOKENS =
  "Your previous turn stopped at the output token limit. Continue from " +
  "exactly where it stopped, without repeating what you already wrote.";

const DEFAULT_LONG_RUN_ITERATIONS = 100;

/**
 * The tool loop for agents that run for hours: the same control flow as
 * toolUseLoop, on the adapter's streaming path (a turn may emit up to 128K
 * tokens), with per-turn hooks, a wall-clock cap, and one continuation when a
 * turn is cut off at max_tokens.
 *
 * Anthropic-only by construction — it needs `completeWithToolsStreaming`, and
 * fails with a capability message when the routed adapter lacks it.
 *
 * Hooks:
 *  - `beforeTurn(state)` runs before each model call; returning `{stop}` ends
 *    the loop with stopReason "hook" (a kill switch, a spend cap, a deadline).
 *  - `afterTurn(state, result)` runs once per model turn, after any tool calls
 *    it made were executed and appended, and before the loop returns on a
 *    terminal turn.
 *  - `reminder(state)` is asked for text to append to the next user message
 *    (after the tool results); null appends nothing.
 *
 * The history is append-only, and this is load-bearing rather than tidy: the
 * strong tier binds thinking blocks to the turns around them and rejects a
 * history whose earlier turns changed, so a reminder is appended as a new
 * block rather than edited in, and the max_tokens continuation is a new user
 * message rather than a re-issued turn. A truncated turn gets exactly one
 * continuation; if the continuation is truncated too the loop stops with
 * stopReason "max_tokens" instead of cycling until the caps.
 */
export async function longRunToolLoop(options: {
  initialMessages: MessageParam[];
  tools: ToolUnion[];
  system?: SystemPrompt;
  model?: string;
  /** Capped at the adapter's streaming maximum (128,000). Defaults to that maximum. */
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
  taskBudgetTokens?: number;
  /** Defaults to "none": a long run says explicitly when it may be re-served elsewhere. */
  fallbacks?: "none" | "server";
  betas?: string[];
  maxIterations?: number;
  /** Wall-clock cap for the whole loop; checked before each turn. */
  maxWallMs?: number;
  executeTool: (name: string, input: Record<string, unknown>) => Promise<string>;
  /** Called when the model calls a "final" tool. Return non-null to stop the loop. */
  onFinalTool?: (name: string, input: Record<string, unknown>) => unknown | null;
  beforeTurn?: (state: LongRunLoopState) => Promise<{ stop?: string } | void>;
  afterTurn?: (state: LongRunLoopState, result: ToolCompletionResult) => Promise<void>;
  reminder?: (state: LongRunLoopState) => string | null;
}): Promise<LongRunLoopResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const adapter = getAdapter(model);
  const streaming = adapter.completeWithToolsStreaming;
  if (!streaming) {
    throw new Error(
      `longRunToolLoop needs a provider with a streaming tool path, and model ` +
        `"${model}" routes to ${adapter.name}, which has none. The long-run ` +
        `path is Anthropic-only — run this agent on a "claude-…" model.`
    );
  }
  const completeStreaming = streaming.bind(adapter);

  const messages = [...options.initialMessages];
  const maxIter = options.maxIterations ?? DEFAULT_LONG_RUN_ITERATIONS;
  const maxWallMs = options.maxWallMs ?? Number.POSITIVE_INFINITY;
  const startedAt = Date.now();
  const usage: Required<TokenUsage> = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  const trace = getUsageContext().trace;
  let containerId: string | undefined;
  let turns = 0;
  let lastResult: ToolCompletionResult | null = null;
  // True when the previous turn was the continuation of a truncated one.
  let continuedLastTurn = false;

  const state = (): LongRunLoopState => ({
    turn: turns,
    messages,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    lastResult,
    usage: { ...usage },
  });
  const finish = (stopReason: LongRunStopReason, hookStop?: string): LongRunLoopResult => ({
    result: lastResult,
    turns,
    stopReason,
    ...(hookStop !== undefined ? { hookStop } : {}),
  });
  const after = async (result: ToolCompletionResult): Promise<void> => {
    if (options.afterTurn) await options.afterTurn(state(), result);
  };

  for (;;) {
    if (turns >= maxIter) return finish("max_iterations");
    if (Date.now() - startedAt >= maxWallMs) return finish("max_wall");
    if (options.beforeTurn) {
      const verdict = await options.beforeTurn(state());
      if (verdict && verdict.stop !== undefined) return finish("hook", verdict.stop);
    }

    checkBudget();
    const result = await completeStreaming({
      messages,
      tools: options.tools,
      system: options.system,
      model,
      maxTokens: options.maxTokens ?? 128_000,
      temperature: options.temperature,
      effort: options.effort,
      taskBudgetTokens: options.taskBudgetTokens,
      fallbacks: options.fallbacks ?? "none",
      betas: options.betas,
      container: containerId,
    });

    turns++;
    lastResult = result;
    usage.inputTokens += result.usage.inputTokens;
    usage.outputTokens += result.usage.outputTokens;
    usage.cacheReadTokens += result.usage.cacheReadTokens ?? 0;
    usage.cacheCreationTokens += result.usage.cacheCreationTokens ?? 0;
    if (result.container) containerId = result.container;

    if (trace) {
      recordAgentStep(trace, "assistant", {
        stopReason: result.stopReason,
        content: result.rawContent,
      });
    }

    // Same server-tool continuation as toolUseLoop: resubmit the turn unchanged.
    if (result.stopReason === "pause_turn") {
      messages.push({ role: "assistant", content: result.rawContent });
      await after(result);
      continue;
    }

    const truncated = result.stopReason === "max_tokens";
    if (truncated && continuedLastTurn) {
      await after(result);
      return finish("max_tokens");
    }
    if (!truncated && (result.stopReason === "end_turn" || result.toolUses.length === 0)) {
      await after(result);
      return finish("end_turn");
    }

    if (options.onFinalTool) {
      for (const tu of result.toolUses) {
        const finalResult = options.onFinalTool(tu.name, tu.input);
        if (finalResult !== null && finalResult !== undefined) {
          await after(result);
          return finish("final_tool");
        }
      }
    }

    // Execute whatever tool calls the turn made — a truncated turn's complete
    // ones included, since every tool_use sent back needs its tool_result.
    const toolResults: ToolResultBlockParam[] = [];
    const executedTools: Array<{ name: string; input: unknown; output: string }> = [];
    for (const tu of result.toolUses) {
      const output = await options.executeTool(tu.name, tu.input);
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: output });
      executedTools.push({ name: tu.name, input: tu.input, output });
    }
    if (trace && executedTools.length > 0) {
      recordAgentStep(trace, "tool_results", executedTools);
    }

    const userContent: Array<ToolResultBlockParam | { type: "text"; text: string }> = [
      ...toolResults,
    ];
    if (truncated) {
      userContent.push({ type: "text", text: CONTINUE_AFTER_MAX_TOKENS });
    }
    const reminder = options.reminder ? options.reminder(state()) : null;
    if (reminder !== null && reminder.length > 0) {
      userContent.push({ type: "text", text: reminder });
    }

    messages.push({ role: "assistant", content: result.rawContent });
    messages.push({ role: "user", content: userContent });
    continuedLastTurn = truncated;
    await after(result);
  }
}
