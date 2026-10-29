/**
 * Ambient attribution for LLM usage metering (#70).
 *
 * The metering chokepoint (client.ts) needs to know WHO an LLM call is for and
 * WHICH agent is making it, but that context lives far away — in the Fastify
 * request or the worker's job row. AsyncLocalStorage carries it across the
 * async gap without threading a parameter through every agent signature.
 *
 * Two layers set it:
 *   - workers/routes set the identity: runWithUsageContext({userId, apiKeyId,
 *     jobId}, ...) — restored from the job row for background work.
 *   - agent entry points set the actor: withAgent("extractor", ...) merges the
 *     agent name into whatever identity context is already active.
 *
 * No context at all = system work (metered with null user, e.g. Steward
 * governance sweeps), which is exactly the semantics we want by default.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  finishAgentRun,
  recordAgentRunSkills,
  startAgentRun,
  type AgentTrace,
} from "../services/trace-service.js";

export interface UsageContext {
  userId?: string | null;
  apiKeyId?: string | null;
  jobId?: string | null;
  /** The claim this work serves (#217) — makes per-claim cost a query. */
  claimId?: string | null;
  requestId?: string | null;
  /** Agent making the calls: extractor | matcher | steward | curator | ... */
  agent?: string;
  /** The agent_runs row this work belongs to (#334 L0) — stamped onto every
   *  llm_usage row so per-run cost is a join. Set by withAgent. */
  runId?: string | null;
  /** Live trace handle for step recording (toolUseLoop). Set by withAgent
   *  when tracing is enabled; absent = don't record steps. */
  trace?: AgentTrace;
  /**
   * The domain skills active for the enclosing run (skill names), set by
   * withSkills once the agent has resolved them. Read by the writes that
   * stamp provenance (assessments.skills), never by the agent itself.
   */
  skills?: string[];
  /**
   * Set by untraced(): the work in progress handles content that must stay
   * transient — a reader's page text, a chat question, a passage handed to
   * the MCP for on-demand analysis (#356). withAgent opens no run inside it
   * and no step is recorded, whatever TRACE_LEVEL says. Metering is
   * unaffected: llm_usage rows carry counts and cost, never content.
   */
  untraced?: true;
  /**
   * Live cost accumulator for the enclosing metered operation. The metering
   * chokepoint adds each call's REAL cost here synchronously — the same raw,
   * per-model figure it writes to llm_usage; the platform's margin lives in
   * the owl's purchase price, never here — so cap-and-settle charging
   * (owl-ledger-service.settleMeteredCharge) can read the operation's cost
   * the moment the work finishes, without waiting on the async llm_usage
   * insert. The field keeps its historical name.
   */
  meter?: { billedMicroUsd: number };
  /**
   * What the enclosing pass may spend, as the lane that funds it set it
   * (withPassBudget): the allocations covering a ledger action, a buyer's
   * quoted cap, a job's or a mandate's remaining budget. `meter` measures
   * the pass's own spend, so what is left is `microUsd - meter.billedMicroUsd`.
   * The agent is shown it: in its task message, after every turn of the
   * tool loop, and in the refusal of a paid tool the remainder cannot
   * cover (runBudget, budgetRefusal below).
   */
  passBudget?: PassBudget;
}

export interface PassBudget {
  microUsd: number;
  /** Where the money comes from, in words the agent is shown. */
  source: string;
  meter: { billedMicroUsd: number };
}

/** What the enclosing pass has left to spend, or null when no lane set a budget. */
export function passBudgetLeftMicroUsd(ctx: UsageContext = getUsageContext()): number | null {
  const budget = ctx.passBudget;
  if (!budget) return null;
  return Math.max(0, budget.microUsd - budget.meter.billedMicroUsd);
}

const storage = new AsyncLocalStorage<UsageContext>();

export function getUsageContext(): UsageContext {
  return storage.getStore() ?? {};
}

export function runWithUsageContext<T>(
  context: UsageContext,
  fn: () => T
): T {
  // Merge over any enclosing context so nesting composes (e.g. a worker sets
  // identity, then an agent adds its name).
  return storage.run({ ...getUsageContext(), ...context }, fn);
}

/**
 * Tag all LLM calls inside `fn` as made by `agent`, and — when tracing is
 * enabled — open an agent_runs row for the invocation, closed when the
 * wrapped work settles. This is the one seam every agent entry point already
 * passes through, which is what makes it the right place to mint run
 * identity (#334 L0). Nested withAgent calls open nested runs; the inner one
 * shadows the outer for the duration, which is the honest reading of "an
 * agent invoked another agent".
 */
export function withAgent<T>(agent: string, fn: () => T): T {
  const context = getUsageContext();
  const trace = context.untraced ? null : startAgentRun(agent, context);
  if (!trace) return runWithUsageContext({ agent }, fn);
  return runWithUsageContext({ agent, runId: trace.runId, trace }, () => {
    let result: T;
    try {
      result = fn();
    } catch (err) {
      finishAgentRun(trace, "error", err);
      throw err;
    }
    if (result instanceof Promise) {
      return result.then(
        (value) => {
          finishAgentRun(trace, "ok");
          return value;
        },
        (err) => {
          finishAgentRun(trace, "error", err);
          throw err;
        }
      ) as unknown as T;
    }
    finishAgentRun(trace, "ok");
    return result;
  });
}

/**
 * Run `fn` with the given domain skills recorded as active: on the usage
 * context (so update_claim_assessment stamps assessments.skills) and on the
 * enclosing agent_runs row when tracing is on. Called by each agent once it
 * has resolved its skills from the claim, contribution, or mandate.
 */
export function withSkills<T>(skills: readonly string[], fn: () => T): T {
  const names = [...new Set(skills)].sort();
  const trace = getUsageContext().trace;
  if (trace) recordAgentRunSkills(trace, names);
  return runWithUsageContext({ skills: names }, fn);
}

/**
 * Run `fn` with tracing suppressed, whatever TRACE_LEVEL says. This is the
 * privacy seam of the trace substrate (#356): the transcript of an agent
 * run is verbatim — the page it read, the question it was asked — so work
 * over content a user never published runs inside this wrapper, and nothing
 * derived from that content reaches agent_runs or agent_steps. Any trace
 * handle from an enclosing run is dropped too, so a nested agent cannot
 * append its steps to an outer run. Independent of the metering context,
 * which keeps attributing tokens and cost as usual.
 */
export function untraced<T>(fn: () => T): T {
  return runWithUsageContext(
    { untraced: true, trace: undefined, runId: null },
    fn
  );
}

/**
 * Run `fn` with a fresh cost meter and return what its LLM calls actually
 * cost at the billed (cost-plus) rate. The meter is scoped: nested meters
 * shadow outer ones, so an operation measures only its own work.
 */
export async function withCostMeter<T>(
  fn: () => Promise<T>
): Promise<{ value: T; billedMicroUsd: number }> {
  const meter = { billedMicroUsd: 0 };
  const value = await runWithUsageContext({ meter }, fn);
  return { value, billedMicroUsd: meter.billedMicroUsd };
}

/**
 * withCostMeter for a pass with a budget: the same fresh meter, and the
 * budget the lane funding the pass sets, read against that meter. A null
 * budget meters the pass and sets none.
 */
export async function withPassBudget<T>(
  budget: { microUsd: number; source: string } | null,
  fn: () => Promise<T>
): Promise<{ value: T; billedMicroUsd: number }> {
  const meter = { billedMicroUsd: 0 };
  const value = await runWithUsageContext(
    { meter, passBudget: budget ? { microUsd: Math.max(0, Math.round(budget.microUsd)), source: budget.source, meter } : undefined },
    fn
  );
  return { value, billedMicroUsd: meter.billedMicroUsd };
}

/** The enclosing run's budget and what it has spent so far, in micro-USD. */
export interface RunBudget {
  ceilingMicroUsd: number;
  /** Where the money comes from, in the lane's words. */
  source: string;
  spentMicroUsd: number;
  remainingMicroUsd: number;
}

/**
 * The enclosing pass's budget read against its meter, or null when no lane
 * set one. A lane that set a budget of nothing has set one: its pass's paid
 * tools decline. Remaining goes negative once a pass overspends.
 */
export function runBudget(): RunBudget | null {
  const budget = getUsageContext().passBudget;
  if (!budget) return null;
  const spent = budget.meter.billedMicroUsd;
  return {
    ceilingMicroUsd: budget.microUsd,
    source: budget.source,
    spentMicroUsd: spent,
    remainingMicroUsd: budget.microUsd - spent,
  };
}

/**
 * A paid tool's check before it charges: null when the call fits the run's
 * budget (or the run has none), else the refusal to return to the agent,
 * saying what the call costs and what is left.
 */
export function budgetRefusal(tool: string, priceMicroUsd: number): string | null {
  const budget = runBudget();
  if (!budget) return null;
  const price = Math.max(0, priceMicroUsd);
  if (budget.remainingMicroUsd > 0 && price <= budget.remainingMicroUsd) return null;
  const usd = (micro: number) => `$${(Math.max(0, micro) / 1_000_000).toFixed(2)}`;
  return JSON.stringify({
    success: false,
    message:
      `${tool} would cost about ${usd(price)}, and this run has ${usd(budget.remainingMicroUsd)} ` +
      `of its ${usd(budget.ceilingMicroUsd)} budget left. Work with what you have and record ` +
      `your conclusion; if the question needs more, say so in your reasoning, and a ` +
      `better-funded pass can take it up.`,
  });
}
