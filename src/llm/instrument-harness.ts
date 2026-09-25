/**
 * What every instrument's harness shares (docs/mathematics.md 7.3, #298).
 *
 * An instrument is an agent an administrator launches for one bounded piece
 * of work: the solver on a formal statement, the researcher on a question.
 * Each runs under a dollar ceiling read from the usage meter every turn,
 * gets one wrap-up notice when most of the ceiling is spent, is halted by an
 * operator flag polled every turn, and pays for the code-execution sandbox
 * by the wall-clock second. None of that is judgment; all of it is the
 * mechanism that guarantees a run halts (Part VIII). The solver was the
 * first instrument and the researcher is the general case; the pieces
 * they share live here so the two cannot drift.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolCompletionResult } from "./client.js";
import { getUsageContext } from "./usage-context.js";
import { hasExplicitRates, ratesForModel } from "./pricing.js";
import { meterExternalUsage } from "../services/usage-service.js";

/** Why a harness stopped the loop, as `hookStop` reports it. */
export const STOP_CEILING = "ceiling";
export const STOP_PAUSED = "paused";
export const STOP_CANCELLED = "cancelled";

/** The wrap-up notice goes out at this fraction of the ceiling. */
export const REMINDER_FRACTION = 0.85;

/**
 * The model-facing pacing signal: the provider's task budget, a running
 * token countdown the model sees, sized from the dollar ceiling. The
 * fraction leaves room for the input side of every turn (history at
 * cache-read rates), checker time, and container time; the dollar ceiling
 * binds either way. The provider's minimum is 20,000 tokens.
 */
export const TASK_BUDGET_FRACTION = 0.6;
export const TASK_BUDGET_MIN_TOKENS = 20_000;
export function taskBudgetTokens(ceilingMicroUsd: number, model: string): number {
  const outputPerMtok = ratesForModel(model).outputPerMtok;
  const usd = Math.max(0, ceilingMicroUsd) / 1_000_000;
  const tokens = Math.floor((usd * TASK_BUDGET_FRACTION * 1_000_000) / outputPerMtok);
  return Math.max(TASK_BUDGET_MIN_TOKENS, tokens);
}

/**
 * A guard on the loop, not a budget: the dollar ceiling ends every run
 * (each turn re-reads the whole history, so no turn is free), and this
 * number only bounds a harness bug that somehow spent nothing.
 */
export const MAX_TURNS_GUARD = 10_000;

/**
 * The published container rate for the code-execution tool, past the free
 * allowance: $0.05 per container-hour. The allowance is not tracked here,
 * so the meter errs on the side of counting it.
 */
export const CODE_EXECUTION_USD_PER_HOUR = 0.05;

/**
 * The code-execution server tool: a sandbox with Python and the usual
 * scientific libraries (one CPU, no network). The installed SDK types it on
 * the Messages endpoint.
 */
export const CODE_EXECUTION_TOOL: Anthropic.Messages.CodeExecutionTool20260120 = {
  type: "code_execution_20260120",
  name: "code_execution",
};

/** The enclosing cost meter's reading, in micro-USD; zero when no meter is set. */
export function meterMicroUsd(): number {
  return getUsageContext().meter?.billedMicroUsd ?? 0;
}

/** Whether a turn used the code-execution sandbox, from its raw content blocks. */
export function turnUsedCodeExecution(result: ToolCompletionResult): boolean {
  return result.rawContent.some((block) => {
    const type = (block as { type?: string }).type ?? "";
    const name = (block as { name?: string }).name ?? "";
    return (
      (type === "server_tool_use" && name === "code_execution") ||
      type === "code_execution_tool_result" ||
      type === "bash_code_execution_tool_result" ||
      type === "text_editor_code_execution_tool_result"
    );
  });
}

/** Meter a turn's container time into llm_usage, by the wall-clock second. */
export async function meterCodeExecution(seconds: number): Promise<void> {
  const s = Math.max(0, seconds);
  await meterExternalUsage({
    provider: "anthropic_code_execution",
    model: "anthropic/code_execution",
    units: s,
    unitKind: "container_seconds",
    costMicroUsd: (s / 3600) * CODE_EXECUTION_USD_PER_HOUR * 1_000_000,
  });
}

// ---------------------------------------------------------------------------
// Budget legibility
//
// A model told "$2.00" has no reliable sense of what that buys: it does not
// know its own price, and the dominant cost of a tool loop (every turn
// re-reading a growing history) is not one it can intuit. So the harness
// does the arithmetic. Up front, a rough translation from the rate table;
// after every turn, a spend line read from the meter, which is exact and
// needs no rates at all.
// ---------------------------------------------------------------------------

/** Assumptions behind the up-front estimate: a typical turn's output, what the history grows by, a page read in full. */
export const TYPICAL_OUTPUT_TOKENS = { longRun: 2_500, ordinary: 800 } as const;
export const TYPICAL_TOOL_RESULT_TOKENS = 1_500;
export const PAGE_TOKENS = 3_000;
const CHARS_PER_TOKEN = 4;

export interface BudgetEstimate {
  /** About how many turns of typical size the ceiling buys. */
  turns: number;
  /** About what one page read in full on the first turn costs by the last. */
  pageUsd: number;
}

/**
 * The up-front translation of a dollar ceiling into turns, for a model with
 * list rates in the table. Null for a model priced by its provider per call
 * (OpenRouter), where the table has nothing honest to say; the spend line
 * covers that model from its first turn.
 */
export function estimateBudget(input: {
  model: string;
  ceilingMicroUsd: number;
  /** The system prompt and task message, in characters. */
  promptChars: number;
  longRun: boolean;
}): BudgetEstimate | null {
  if (!hasExplicitRates(input.model)) return null;
  const rates = ratesForModel(input.model);
  const perTok = rates.inputPerMtok / 1_000_000;
  const read = perTok * (rates.cacheReadMultiplier ?? 0.1);
  const write = perTok * (rates.cacheWriteMultiplier ?? 1.25);
  const out = rates.outputPerMtok / 1_000_000;
  const outputTokens = input.longRun ? TYPICAL_OUTPUT_TOKENS.longRun : TYPICAL_OUTPUT_TOKENS.ordinary;
  const growth = outputTokens + TYPICAL_TOOL_RESULT_TOKENS;
  const budget = Math.max(0, input.ceilingMicroUsd) / 1_000_000;
  let context = input.promptChars / CHARS_PER_TOKEN;
  // The first turn writes the prompt to the cache; each later one reads the
  // history, writes what the last turn added, and produces its output.
  let spent = context * write + outputTokens * out;
  let turns = spent <= budget ? 1 : 0;
  while (turns > 0 && turns < MAX_TURNS_GUARD) {
    const next = context * read + growth * write + outputTokens * out;
    if (spent + next > budget) break;
    spent += next;
    context += growth;
    turns++;
  }
  const pageUsd = PAGE_TOKENS * (write + read * Math.max(0, turns - 1));
  return { turns, pageUsd };
}

function usd(micro: number): string {
  return `$${(Math.max(0, micro) / 1_000_000).toFixed(2)}`;
}

/**
 * The line shown after every turn: what has been spent, of what, and about
 * how many turns remain at the last turn's cost. Turns grow dearer as the
 * history grows, so the count is an upper bound and says so.
 */
export function spendLine(input: {
  spentMicroUsd: number;
  ceilingMicroUsd: number;
  lastTurnMicroUsd: number;
}): string {
  const { spentMicroUsd: spent, ceilingMicroUsd: ceiling, lastTurnMicroUsd: last } = input;
  const pct = ceiling > 0 ? Math.min(100, Math.round((100 * spent) / ceiling)) : 100;
  const head = `Budget: ${usd(spent)} of ${usd(ceiling)} spent (${pct}%).`;
  if (last <= 0 || spent >= ceiling) return head;
  const left = Math.floor((ceiling - spent) / last);
  return (
    `${head} Your last turn cost ${usd(last)}; at that rate about ${left} ` +
    `turn${left === 1 ? "" : "s"} remain, fewer as the conversation grows.`
  );
}
