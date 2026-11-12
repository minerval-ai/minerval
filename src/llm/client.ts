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
 * Being the one path, it is also where every call with a system prompt is
 * told today's date (run-date.ts, #771), where an agent run in a
 * deployment with features switched off is told which (withRunBrief below),
 * and where a call is refused before anything is sent when its model's
 * provider is not cleared for the label the run works at (clearedAdapter
 * below; src/provider-labels.ts).
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
import {
  DEFAULT_MODEL,
  modelRefusalFallbackForm,
  modelSupportsLongRun,
} from "./models.js";
import { currentLabel, getUsageContext, runBudget } from "./usage-context.js";
import { spendLine } from "./budget-line.js";
import { markRunPrivate, recordAgentStep, type AgentTrace } from "../services/trace-service.js";
import { toolPrivateReason } from "./run-visibility.js";
import { getAdapter } from "./providers/index.js";
import { malformedToolArguments } from "./providers/openai-dialect.js";
import { resolveProvider } from "./providers/routing.js";
import { withRunDate } from "./run-date.js";
import { featuresOffNote, withLeadingNote } from "./features-off-note.js";
import { unclearedServicesNote, withoutUnclearedTools } from "./uncleared-services-note.js";
import { assertProviderCleared } from "./provider-clearance.js";
import { stampErrorProvider } from "./errors.js";
import { deploymentFaultOf } from "../services/deployment-fault.js";
import { noteDeploymentFault } from "../services/deployment-fault-service.js";
import { offFeatures } from "../features.js";
import { toolOutputForTrace, toolResultContent, type ToolExecution } from "./tool-output.js";
import { observeRun, type SeenIds } from "./seen-ids.js";
import { setupRecord, splitSetup, type SetupRecord } from "../services/setup-split.js";
import { loadConfig } from "../config.js";
import { CODE_EXECUTION_TOOL, meterCodeExecution, turnUsedCodeExecution } from "./instrument-harness.js";
import type {
  CompletionResult,
  EffortLevel,
  ProviderAdapter,
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
/** The streaming path's output ceiling (providers/anthropic.ts LONG_RUN_MAX_OUTPUT_TOKENS). */
const LONG_RUN_MAX_TOKENS = 128_000;

/**
 * What the seam adds to the first task message of an agent run: the note
 * that says which features this deployment has switched off
 * (features-off-note.ts), and the note that says which outside services
 * are not cleared for the label the run works at
 * (uncleared-services-note.ts). Nothing when every feature is on and every
 * service is cleared, which is how the public deployment runs. The role
 * prompts cannot say either, because they are the same text in every
 * deployment, and an agent is told the limits it works under, with the
 * reason.
 *
 * An agent run is a call with an agent on the usage context, which withAgent
 * sets and every agent's entry point passes through; a run that is not
 * traced (untraced) is still one. A call outside any agent run is sent as
 * given. Every function here that sends messages applies this on entry, and
 * a conversation that already carries the passage is left alone, so a loop's
 * later turns and a resumed transcript are told once, in the first message.
 *
 * `model` is the run's: whether web search is a service of its own or the
 * model provider's server tool depends on it.
 */
function withRunBrief(messages: MessageParam[], model: string): MessageParam[] {
  if (!getUsageContext().agent) return messages;
  const brief = [featuresOffNote(), unclearedServicesNote(model)].filter((note) => note.length > 0);
  return withLeadingNote(messages, brief.join("\n\n"));
}

/**
 * The adapter that serves `model`, once its provider is known to be cleared
 * for the label this run works at (provider-clearance.ts, which says why
 * that label and no other). Every call below takes its adapter from here,
 * before it builds a request, so a run that may not be served fails on its
 * first call with nothing sent and nothing spent. There is no second
 * provider to fall back to and no reading of the label as public.
 */
async function clearedAdapter(model: string): Promise<ProviderAdapter> {
  const adapter = getAdapter(model);
  const provider = resolveProvider(model) ?? adapter.name;
  await assertProviderCleared(provider);
  return namingProvider(adapter, provider);
}

/**
 * The adapter, with every failure of a call stamped with the provider that
 * answered it and, when it is a deployment fault (the account out of
 * credits, the key rejected), put on record for the operator
 * (deployment-fault-service.ts). The error is rethrown unchanged: what a
 * lane does with it is the lane's business. Every call takes its adapter
 * from clearedAdapter, so a fault is recorded whichever agent met it,
 * including one whose failure a tool turns into a result (match_claim).
 */
function namingProvider(adapter: ProviderAdapter, provider: string): ProviderAdapter {
  const watch = <A extends unknown[], R>(call: ((...args: A) => Promise<R>) | undefined) =>
    call &&
    (async (...args: A): Promise<R> => {
      try {
        return await call.apply(adapter, args);
      } catch (err) {
        stampErrorProvider(err, provider);
        if (deploymentFaultOf(err)) {
          void noteDeploymentFault(err, { surface: `the ${getUsageContext().agent ?? "unattributed"} agent` });
        }
        throw err;
      }
    });
  return {
    name: adapter.name,
    complete: watch(adapter.complete),
    completeWithTools: watch(adapter.completeWithTools),
    completeStructured: watch(adapter.completeStructured),
    ...(adapter.completeWithToolsStreaming
      ? { completeWithToolsStreaming: watch(adapter.completeWithToolsStreaming) }
      : {}),
  } as ProviderAdapter;
}

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
  const adapter = await clearedAdapter(model);
  options = {
    ...options,
    system: withRunDate(options.system),
    messages: withRunBrief(options.messages, model),
    ...(options.tools ? { tools: withoutUnclearedTools(options.tools) } : {}),
  };
  // Sonnet 5.5 runs adaptive thinking by default and thinking spend counts
  // against max_tokens, so the old 4096 default left too little room for the
  // actual answer — 8192 keeps headroom without changing agent call sites.
  const result = await adapter.complete({
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
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    effort: options.effort,
    temperature: options.temperature,
  });
  return result;
}

/**
 * A run that executes a tool whose output can carry private data, or a tool
 * nobody has classified, keeps its transcript private (run-visibility.ts).
 */
function markPrivateTools(trace: AgentTrace, executed: ReadonlyArray<{ name: string }>): void {
  for (const t of executed) {
    const reason = toolPrivateReason(t.name);
    if (reason) markRunPrivate(trace, reason);
  }
}

/**
 * The setup a model was given, recorded verbatim as one "prompt" step at the
 * start of every tool-use loop and before every single-shot completion (the
 * replay's "inspect all the way down" requirement): the full system prompt
 * (string or cached blocks — the constitution, the role, the domain skills),
 * the initial messages, the tool descriptors (name, description, input
 * schema for client tools; server tool descriptors as given), and the
 * sampling parameters. Fire-and-forget through recordAgentStep, like every
 * other step: a prompt step never throws or slows the loop, and nothing is
 * recorded without a trace on the context.
 */
function recordPromptStep(step: {
  model: string;
  system?: SystemPrompt;
  initialMessages: MessageParam[];
  tools?: ToolUnion[];
  maxTokens?: number;
  effort?: EffortLevel;
  temperature?: number;
  schemaName?: string;
  schema?: Record<string, unknown>;
}): void {
  const context = getUsageContext();
  const trace = context.trace;
  if (!trace) return;
  const tools = (step.tools ?? []).map((t) =>
    "input_schema" in t
      ? { name: t.name, description: t.description ?? null, input_schema: t.input_schema }
      : t
  );
  // The setup as versioned parts (services/setup-service.ts): each part is
  // stored once, and the step records which ones it ran under, with the
  // label the run writes at (src/labels.ts), the provider that served it
  // (src/provider-labels.ts) and the features that were off for it
  // (src/features.ts). Never fails the run: a setup that cannot be split or
  // stored is left out.
  // The registry that names role parts imports every role's prompt module,
  // so storage loads lazily, off the step's path.
  let setup: SetupRecord | null = null;
  try {
    const parts = splitSetup({
      system: step.system ?? null,
      tools: tools as Array<{ name: string } & Record<string, unknown>>,
    });
    const config = loadConfig();
    setup = setupRecord(
      parts,
      step,
      config.gitSha ?? null,
      currentLabel(),
      offFeatures(config),
      resolveProvider(step.model)
    );
    const agent = context.agent ?? "unknown";
    void import("../services/setup-service.js")
      .then((s) => s.storeSetupParts(s.classifyParts(parts, agent)))
      .catch((err) =>
        console.error("[trace] failed to store setup parts:", err instanceof Error ? err.message : err)
      );
  } catch (err) {
    console.error("[trace] failed to split setup:", err instanceof Error ? err.message : err);
  }
  // Everything but the prompt set's hash is fixed here, as it was given.
  const content = {
    setup,
    model: step.model,
    effort: step.effort ?? null,
    maxTokens: step.maxTokens ?? null,
    temperature: step.temperature ?? null,
    system: step.system ?? null,
    initialMessages: step.initialMessages,
    tools,
    ...(step.schemaName ? { schemaName: step.schemaName, schema: step.schema ?? null } : {}),
  };
  // The prompt set is built from every role's prompt module, so it loads
  // lazily like the registry above: the step's sequence number is claimed
  // now, and the step is written once the hash is known (at once, after the
  // first run in a process). A manifest that cannot be built leaves null.
  const withPromptSet = import("../services/prompt-set.js")
    .then((m) => m.getPromptSet().hash)
    .catch((err) => {
      console.error("[trace] failed to build the prompt set:", err instanceof Error ? err.message : err);
      return null;
    })
    .then((hash) => (setup ? { ...content, setup: { ...setup, promptSet: hash } } : content));
  recordAgentStep(trace, "prompt", withPromptSet);
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
  schema?: Record<string, unknown>;
  output: unknown;
  stopReason?: string | null;
  maxTokens?: number;
  effort?: EffortLevel;
  temperature?: number;
}): void {
  const trace = getUsageContext().trace;
  if (!trace) return;
  // The prompt first, whole; the completion step keeps its shape (system
  // prompt by size) for the readers that predate the prompt step.
  recordPromptStep({
    model: step.model,
    system: step.system,
    initialMessages: step.messages,
    maxTokens: step.maxTokens,
    effort: step.effort,
    temperature: step.temperature,
    schemaName: step.schemaName,
    schema: step.schema,
  });
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
  const adapter = await clearedAdapter(model);
  options = {
    ...options,
    system: withRunDate(options.system),
    messages: withRunBrief(options.messages, model),
    tools: withoutUnclearedTools(options.tools),
  };
  return adapter.completeWithTools({
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
  const adapter = await clearedAdapter(model);
  options = {
    ...options,
    system: withRunDate(options.system),
    messages: withRunBrief(options.messages, model),
  };
  const result = await adapter.completeStructured<T>({
    ...options,
    model,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  });
  recordCompletionStep({
    model,
    messages: options.messages,
    system: options.system,
    schemaName: options.schemaName,
    schema: options.schema,
    output: result,
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    effort: options.effort,
    temperature: options.temperature,
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
/** The running turn counter's wording (#474), one line after the tool results. */
export function turnCounterLine(used: number, max: number): string {
  return `Turn ${used} of ${max} used; ${max - used} remain.`;
}

/**
 * The notices a run with a budget gets, once each: when most of it is
 * spent, and when all of it is. The money, not the turn guard, is what
 * normally ends such a run.
 */
export const BUDGET_WRAP_UP_FRACTION = 0.85;
export function budgetWrapUpNotice(
  spentMicroUsd: number,
  ceilingMicroUsd: number,
  canPetition = false
): string {
  const over = spentMicroUsd >= ceilingMicroUsd;
  if (over) {
    return (
      `Budget notice: this run has spent its whole budget. Make your concluding ` +
      `tool call(s) now, and record what you could and couldn't establish; ` +
      `whatever is not recorded is lost.` +
      (canPetition
        ? ` If the work needs another pass, petition for a follow-up ` +
          `(petition_mandate, kind follow_up) so it can start where you stop.`
        : "")
    );
  }
  return (
    `Budget notice: most of this run's budget is spent. ` +
    (canPetition
      ? `If what is left of the work is essential and needs more, petition for ` +
        `it now (petition_mandate) and say what it is for. Otherwise finish `
      : `Finish `) +
    `the work in hand and make your concluding tool call(s) soon; whatever is ` +
    `not recorded when the run ends is lost.`
  );
}

/**
 * The budget notice an agent gets when it sets none of its own (#474): every
 * agent records its conclusions through a tool call, so every agent needs
 * telling, shortly before the cut, that unrecorded conclusions are lost.
 */
export const DEFAULT_ITERATION_BUDGET_NOTICE = {
  warnWithin: 2,
  message: (remaining: number): string =>
    `Budget notice: ${remaining} tool-use turn(s) remain, the last of them ` +
    `included. Whatever is not recorded through a tool call when the run ` +
    `ends is lost: stop exploring and make your concluding tool call(s) now.`,
};

export async function toolUseLoop(options: {
  initialMessages: MessageParam[];
  tools: ToolUnion[];
  system?: SystemPrompt;
  model?: string;
  maxTokens?: number;
  temperature?: number;
  effort?: EffortLevel;
  maxIterations?: number;
  /** The result as a string, or a ToolOutput when the tool shows the model an image or a document (tool-output.ts). */
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolExecution>;
  /**
   * The run's record of the ids it has been shown (seen-ids.ts), when the
   * caller keeps one across loops (the Matcher's retry is a fresh
   * transcript of the same decision). Absent, the loop keeps its own.
   * Either way the loop fills it from the opening messages and every tool
   * result, and runs each tool in its scope, which is how a graph read
   * repairs a mistyped id (#934).
   */
  seenIds?: SeenIds;
  /** Called when the model calls a "final" tool (e.g. submit_decomposition). Return result to stop loop. */
  onFinalTool?: (name: string, input: Record<string, unknown>) => unknown | null;
  /**
   * When set, the loop appends a plain-text budget notice to the tool-result
   * message once only `warnWithin` iterations remain, so the agent can finish
   * its essential actions (e.g. recording an assessment) instead of being cut
   * off mid-task at maxIterations. The string is the agent-facing wording.
   */
  iterationBudgetNotice?: { warnWithin: number; message: (remaining: number) => string };
  /**
   * A running counter appended to every tool-result message (#474): "Turn 3
   * of 12 used; 9 remain." A budget stated once up front stops meaning
   * anything by turn 20 of a 40-turn run, because a model does not track its
   * own turn count across a long transcript; a continuous signal lets it
   * pace. On by default; false turns it off.
   */
  turnCounter?: boolean;
  /**
   * Replaces the turn counter's line with the caller's own, asked for after
   * every turn with the turns used and the cap: an instrument whose binding
   * budget is dollars says what has been spent instead (instrument-harness
   * spendLine). An empty string appends nothing.
   */
  turnNote?: (used: number, max: number) => string;
  /**
   * When the agent's whole output is one final tool call (the Matcher's
   * decision), a turn that ends in prose instead — "resubmitting now", and
   * then nothing — loses the run. With this set, such a turn is answered with
   * `message` as a user turn and the loop continues, at most `max` times per
   * loop; each nudge still counts against maxIterations. Only turns with NO
   * tool use are nudged; a final tool the loop accepted ends it as before.
   */
  finalToolNudge?: {
    message: string;
    max: number;
    /** Nudge only while this holds (e.g. "no decision recorded yet"); default always. */
    when?: () => boolean;
  };
  /**
   * Called before every model turn, pause_turn continuations included, with
   * the 0-based turn index. An instrument's harness uses it to enforce what
   * the executor alone cannot see (a dollar ceiling crossed by server tools,
   * a wall-clock cap, an operator pause); to end the loop it throws, and the
   * caller catches its own error.
   */
  beforeTurn?: (turn: number) => Promise<void> | void;
  /**
   * Run each turn on the adapter's streaming path, where a turn has no
   * request timeout to beat. On the models the long-run path serves, a turn
   * may emit up to the model's full output (the long-run client's ceiling):
   * for a loop that writes one large output, such as the Grantmaker's
   * drafted mandate, which a non-streaming request cannot hold. A provider
   * with no streaming path runs non-streaming as before.
   */
  stream?: boolean;
  /**
   * Called with the reply's text as the model writes it, with the 0-based
   * turn it belongs to: deltas while a turn streams, or a turn's whole text
   * once it completes when the turn did not stream. For showing a person the
   * reply while it forms.
   */
  onText?: (delta: string, turn: number) => void;
  /**
   * Asked after every turn's tools have run: text that arrived for the run
   * while it worked (an answer to something it asked for, session-service.ts),
   * appended to that turn's tool results so the run reads it next turn.
   */
  pendingInput?: () => Promise<string | null>;
  /**
   * Called once when the loop returns, with the whole conversation: the
   * messages sent and the final assistant turn. A run that pauses keeps it
   * to resume from (session-service.ts).
   */
  onEnd?: (transcript: MessageParam[]) => void;
}): Promise<ToolCompletionResult> {
  // Refused here, before the prompt step is recorded and before the first
  // turn, when the model's provider is not cleared for the run's label.
  const streamModel = options.model ?? DEFAULT_MODEL;
  const streamAdapter = await clearedAdapter(streamModel);
  // Dated once for the whole loop, so every turn sends the same prompt, and
  // briefed once: the first message carries the run's brief from here on, in
  // what is sent, in the prompt step and in the transcript handed to onEnd.
  // The toolset is fixed here too, without the tools of an outside service
  // that is not cleared for the run's label, so the prompt step records
  // what the model was offered.
  options = {
    ...options,
    system: withRunDate(options.system),
    initialMessages: withRunBrief(options.initialMessages, streamModel),
    tools: withoutUnclearedTools(options.tools),
  };
  const messages = [...options.initialMessages];
  const observed = observeRun(options.initialMessages, options.seenIds);
  const finish = (r: ToolCompletionResult): ToolCompletionResult => {
    options.onEnd?.([...messages, { role: "assistant", content: r.rawContent } as MessageParam]);
    return r;
  };
  const streaming =
    options.stream && streamAdapter.completeWithToolsStreaming
      ? streamAdapter.completeWithToolsStreaming.bind(streamAdapter)
      : null;
  const fallbackForm = modelRefusalFallbackForm(streamModel);
  const maxIter = options.maxIterations ?? 5;
  const notice = options.iterationBudgetNotice ?? DEFAULT_ITERATION_BUDGET_NOTICE;
  const turnCounter = options.turnCounter ?? true;
  let lastResult: ToolCompletionResult | null = null;
  let nudges = 0;
  let maxTokensRecoveries = 0;
  // Trace handle from the enclosing withAgent, when tracing is enabled: the
  // loop is where the transcript exists, so it's where steps are recorded
  // (#334 L0). Absent handle = record nothing, zero overhead.
  const trace = getUsageContext().trace;
  if (trace) {
    recordPromptStep({
      model: options.model ?? DEFAULT_MODEL,
      system: options.system,
      initialMessages: options.initialMessages,
      tools: options.tools,
      maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
      effort: options.effort,
      temperature: options.temperature,
    });
  }
  // Container-backed server tools (web_search_20260209 runs via code execution)
  // mint a container on first use that MUST be passed back on every later turn of
  // the loop, or the API rejects the request. Thread the latest id through.
  // Anthropic-only; the other adapters never return one.
  let containerId: string | undefined;

  // 0: no notice yet; 1: the wrap-up notice went out; 2: the spent one did.
  let budgetWarned = 0;

  // The code-execution sandbox is billed by container time, which no token
  // count carries. A loop that offers it meters each turn that used it by
  // the turn's wall-clock seconds, at the published container rate
  // (instrument-harness.ts), into the enclosing meter, so the run's budget
  // binds it like any paid tool.
  const offersSandbox = options.tools.some(
    (t) => (t as { name?: string }).name === CODE_EXECUTION_TOOL.name
  );

  for (let i = 0; i < maxIter; i++) {
    if (options.beforeTurn) await options.beforeTurn(i);
    const spentAtTurnStart = runBudget()?.spentMicroUsd ?? 0;
    const turnStartedAt = Date.now();
    const turn = i;
    const result = streaming
      ? await (() => {
          checkBudget();
          return streaming({
            messages,
            tools: options.tools,
            system: options.system,
            model: streamModel,
            maxTokens:
              options.maxTokens ??
              (modelSupportsLongRun(streamModel) ? LONG_RUN_MAX_TOKENS : DEFAULT_MAX_TOKENS),
            temperature: options.temperature,
            effort: options.effort,
            container: containerId,
            // The same refusal fallback the non-streaming path gives this model.
            fallbacks:
              fallbackForm === "array" ? "server" : fallbackForm === "default" ? "default" : "none",
            ...(options.onText ? { onText: (delta: string) => options.onText!(delta, turn) } : {}),
          });
        })()
      : await completeWithTools({
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
    if (offersSandbox && turnUsedCodeExecution(result)) {
      await meterCodeExecution((Date.now() - turnStartedAt) / 1000);
    }
    if (!streaming && options.onText && result.content) options.onText(result.content, turn);

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

    // A turn truncated at max_tokens is recoverable: a model that reasons in
    // its output (GLM 5.3 Flash) hit the cap on most Steward turns and a
    // majority of Matcher turns in the corpus run, and every one of those runs
    // ended with no assessment or decision. Tell it what happened and let it
    // finish, at most twice per loop; the assistant turn is replayed only when
    // it has content (an empty one the Anthropic API rejects). A server tool
    // use the cutoff left without its result is already gone from rawContent
    // (providers/anthropic.ts, replayableContent), so the replay is valid with
    // server tools in the toolset too.
    if (result.stopReason === "max_tokens") {
      const provider = resolveProvider(options.model ?? DEFAULT_MODEL);
      const canResume =
        maxTokensRecoveries < 2 &&
        i < maxIter - 1 &&
        (result.rawContent.length > 0 || provider !== "anthropic");
      if (canResume) {
        maxTokensRecoveries++;
        if (result.rawContent.length > 0) {
          messages.push({ role: "assistant", content: result.rawContent });
        }
        const note =
          "Your previous turn was cut off at the output limit (max_tokens) before " +
          "it finished, and nothing from it was recorded. Do not repeat it. Continue " +
          "from here far more concisely: decide, and make the tool call now.";
        // A client tool call the cutoff left unfinished (a large input, such
        // as a drafted mandate's plan) is replayed with the turn, and the API
        // refuses a tool_use with no tool_result after it. Answer each one as
        // not run: its input is incomplete.
        const cutCalls: ToolResultBlockParam[] = result.rawContent
          .filter((b) => b.type === "tool_use")
          .map((b) => ({
            type: "tool_result",
            tool_use_id: (b as { id: string }).id,
            is_error: true,
            content:
              "Not run: this call was cut off at the output limit before its " +
              "input was complete. Make it again, more compactly.",
          }));
        messages.push({
          role: "user",
          content: [...cutCalls, { type: "text", text: note }],
        });
        if (trace) {
          recordAgentStep(trace, "tool_results", [
            { name: "max_tokens_recovery", input: {}, output: note },
          ]);
        }
        continue;
      }
      return finish(result);
    }

    if (result.stopReason === "end_turn" || result.toolUses.length === 0) {
      const nudge = options.finalToolNudge;
      if (
        nudge &&
        result.toolUses.length === 0 &&
        nudges < nudge.max &&
        i < maxIter - 1 &&
        (nudge.when?.() ?? true)
      ) {
        nudges++;
        messages.push({ role: "assistant", content: result.rawContent });
        messages.push({ role: "user", content: [{ type: "text", text: nudge.message }] });
        if (trace) {
          recordAgentStep(trace, "tool_results", [
            { name: "final_tool_nudge", input: {}, output: nudge.message },
          ]);
        }
        continue;
      }
      return finish(result);
    }

    // Check for final tool
    if (options.onFinalTool) {
      for (const tu of result.toolUses) {
        const finalResult = options.onFinalTool(tu.name, tu.input);
        if (finalResult !== null && finalResult !== undefined) {
          return finish(result);
        }
      }
    }

    // Execute tools and build tool_result messages
    const toolResults: ToolResultBlockParam[] = [];
    const executedTools: Array<{ name: string; input: unknown; output: string }> = [];
    for (const tu of result.toolUses) {
      const output =
        malformedToolArguments(tu.input) ??
        (await observed.call(() => options.executeTool(tu.name, tu.input)));
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: toolResultContent(output),
      });
      executedTools.push({ name: tu.name, input: tu.input, output: toolOutputForTrace(output) });
    }
    if (trace && executedTools.length > 0) {
      recordAgentStep(trace, "tool_results", executedTools);
      markPrivateTools(trace, executedTools);
    }

    // Tell the agent where it stands after every turn (#474), and, once the
    // budget is nearly spent, that it should wrap up its essential actions on
    // the next turn rather than being hard-cut.
    const remaining = maxIter - 1 - i;
    const userContent: Array<ToolResultBlockParam | { type: "text"; text: string }> = [
      ...toolResults,
    ];
    // A run with a budget is told its spend against it (the binding
    // constraint) as well as the turn guard; an instrument that writes its
    // own line (turnNote) already does both.
    const budget = options.turnNote ? null : runBudget();
    if (turnCounter) {
      let line = options.turnNote ? options.turnNote(i + 1, maxIter) : turnCounterLine(i + 1, maxIter);
      if (budget) {
        line =
          spendLine({
            spentMicroUsd: budget.spentMicroUsd,
            ceilingMicroUsd: budget.ceilingMicroUsd,
            lastTurnMicroUsd: budget.spentMicroUsd - spentAtTurnStart,
          }) + ` ${line}`;
      }
      if (line) userContent.push({ type: "text", text: line });
    }
    if (budget) {
      const stage =
        budget.spentMicroUsd >= budget.ceilingMicroUsd
          ? 2
          : budget.spentMicroUsd >= budget.ceilingMicroUsd * BUDGET_WRAP_UP_FRACTION
            ? 1
            : 0;
      if (stage > budgetWarned) {
        budgetWarned = stage;
        userContent.push({
          type: "text",
          text: budgetWrapUpNotice(
            budget.spentMicroUsd,
            budget.ceilingMicroUsd,
            options.tools.some((t) => "name" in t && t.name === "petition_mandate")
          ),
        });
      }
    }
    if (remaining > 0 && remaining <= notice.warnWithin) {
      userContent.push({ type: "text", text: notice.message(remaining) });
    }
    if (options.pendingInput) {
      const arrived = await options.pendingInput();
      if (arrived) userContent.push({ type: "text", text: arrived });
    }

    // Append assistant message and tool results
    messages.push({ role: "assistant", content: result.rawContent });
    messages.push({ role: "user", content: userContent });
  }

  return finish(lastResult!);
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
  executeTool: (name: string, input: Record<string, unknown>) => Promise<ToolExecution>;
  /** As toolUseLoop's: the run's record of the ids it has been shown. */
  seenIds?: SeenIds;
  /** Called when the model calls a "final" tool. Return non-null to stop the loop. */
  onFinalTool?: (name: string, input: Record<string, unknown>) => unknown | null;
  beforeTurn?: (state: LongRunLoopState) => Promise<{ stop?: string } | void>;
  afterTurn?: (state: LongRunLoopState, result: ToolCompletionResult) => Promise<void>;
  reminder?: (state: LongRunLoopState) => string | null;
}): Promise<LongRunLoopResult> {
  const model = options.model ?? DEFAULT_MODEL;
  const adapter = await clearedAdapter(model);
  // Dated once for the whole run, so every turn sends the same prompt, and
  // briefed once, in the first message. The toolset is fixed here, as in
  // toolUseLoop.
  options = {
    ...options,
    system: withRunDate(options.system),
    initialMessages: withRunBrief(options.initialMessages, model),
    tools: withoutUnclearedTools(options.tools),
  };
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
  const observed = observeRun(options.initialMessages, options.seenIds);
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
  if (trace) {
    recordPromptStep({
      model,
      system: options.system,
      initialMessages: options.initialMessages,
      tools: options.tools,
      maxTokens: options.maxTokens,
      effort: options.effort,
      temperature: options.temperature,
    });
  }
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
      const output =
        malformedToolArguments(tu.input) ??
        (await observed.call(() => options.executeTool(tu.name, tu.input)));
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: toolResultContent(output) });
      executedTools.push({ name: tu.name, input: tu.input, output: toolOutputForTrace(output) });
    }
    if (trace && executedTools.length > 0) {
      recordAgentStep(trace, "tool_results", executedTools);
      markPrivateTools(trace, executedTools);
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
