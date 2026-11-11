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
 * The same context carries the label the work writes at (src/labels.ts).
 * Workers set it outside both layers, from the row the work waited in:
 * runAtLabel(job.sensitivityLabel, ...).
 *
 * No context at all = system work (metered with null user, e.g. Steward
 * governance sweeps), which is exactly the semantics we want by default.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import {
  finishAgentRun,
  markRunPrivate,
  markRunWroteGraph,
  recordAgentRunSkills,
  recordMode,
  RunLogError,
  sealAgentRun,
  startAgentRun,
  type AgentTrace,
} from "../services/trace-service.js";
import { setStatementObserver } from "../db/statement-observer.js";
import { writesGraph } from "../db/graph-writes.js";
import { MissingLabelError, PUBLIC_LABEL } from "../labels.js";

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
   * The skills the enclosing run has in hand (skill names): set by
   * withSkills when the run opens and extended by noteSkillLoaded as it
   * loads more. Read by the writes that stamp provenance
   * (assessments.skills), never by the agent itself.
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
   * The agent session this run belongs to (session-service.ts): what it asks
   * for and waits on (research it commissions, a question to another node's
   * Steward) is answered into this session, which pauses when the run ends
   * its turn with answers outstanding and resumes when they arrive. Set by
   * every agent that spends: the Stewards, the Curator, the Consistency
   * Checker, the Audit Agent and Correspondents. Absent, nothing waits.
   */
  session?: { id: string; role: string; nodeId: string | null };
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
  /**
   * The label the enclosing work writes at (src/labels.ts): stamped onto the
   * run row, its prompt step's setup, every judgment and source it writes,
   * and every piece of work it enqueues (currentLabel below), never chosen
   * by the agent. Set by whatever picks work up, from the row the work
   * waited in (runAtLabel below). Absent means public: a request outside
   * any run, which is all the public graph has.
   */
  label?: string;
}

export interface PassBudget {
  /**
   * The ceiling. It moves during a run: down when the run pays for other
   * work from it (commission), up when a petition is granted.
   */
  microUsd: number;
  /** Where the money comes from, in words the agent is shown. Never names a mandate. */
  source: string;
  meter: { billedMicroUsd: number };
  /** Who is paying, for commission and petition_mandate; absent when no one can be asked. */
  funding?: RunFunding;
}

/**
 * Who pays for a run, as the lane that funds it knows it: the ledger row it
 * is running (whose allocations hold its money, and along whose chain a
 * petition is routed), and the mandate or person behind it.
 */
export interface RunFunding {
  actionId?: string | null;
  grantId?: string | null;
  userId?: string | null;
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

/**
 * The label a write made now carries: the enclosing run's or request's, and
 * public outside any. The write seams of the labelled tables call this the
 * way they read the funder and the run id from the context.
 */
export function currentLabel(): string {
  return getUsageContext().label ?? PUBLIC_LABEL;
}

/**
 * Run `fn` at the label of the work that started it. Every worker and
 * executor calls this with the label of the row it picked up (a job, a
 * ledger action, an order, a paused session), so the run it opens, what that
 * run writes and what that run enqueues all carry the label the work had
 * when it was created. `work` names the row for the error.
 *
 * A row with no label is refused, not run as public: the caller read a row
 * without its label, or a message was queued without one, and either would
 * otherwise write private work as public without a sign.
 */
export function runAtLabel<T>(label: string | null | undefined, work: string, fn: () => T): T {
  if (typeof label !== "string" || label.length === 0) throw new MissingLabelError(work);
  return runWithUsageContext({ label }, fn);
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
 *
 * Work that returns without a promise closes its run without waiting, in
 * either mode: there is nothing to hold its result behind. Every agent's
 * entry point is async.
 */
// A run that writes to the graph keeps its transcript (db/graph-writes.ts).
// The statement observer sees every query db/client.ts sends; the run open
// in the current context, if any, is marked on its first graph write.
setStatementObserver((sql) => {
  const trace = getUsageContext().trace;
  if (trace && !trace.wroteGraph && writesGraph(sql)) markRunWroteGraph(trace);
});

/**
 * Mark the run open in this context private, with a reason (run-visibility.ts):
 * for agent code that hands a run private input its agent's default does not
 * cover. No run open, nothing to mark.
 */
export function markCurrentRunPrivate(reason: string): void {
  const trace = getUsageContext().trace;
  if (trace) markRunPrivate(trace, reason);
}

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
      // In record mode the run is not finished until its log is sealed
      // (#552): the work's result is held until every step is written, and
      // a log that could not be written whole fails the run. What the run
      // already wrote to the graph stays written; a reader tells it by the
      // run being unsealed.
      if (recordMode()) {
        return result.then(
          async (value) => {
            if (!(await sealAgentRun(trace, "ok"))) throw new RunLogError(trace.runId);
            return value;
          },
          async (err) => {
            await sealAgentRun(trace, "error", err);
            throw err;
          }
        ) as unknown as T;
      }
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
 * Run `fn` with the given skills recorded on the usage context (so
 * update_claim_assessment stamps assessments.skills) and on the enclosing
 * agent_runs row when tracing is on. Each agent opens its run with the
 * skills already in its prompt, usually none; the ones it loads with
 * load_skill are added by noteSkillLoaded as it loads them.
 */
export function withSkills<T>(skills: readonly string[], fn: () => T): T {
  const names = [...new Set(skills)].sort();
  const trace = getUsageContext().trace;
  if (trace) recordAgentRunSkills(trace, names);
  return runWithUsageContext({ skills: names }, fn);
}

/**
 * Record that the run loaded `skill` with load_skill. The name joins the
 * list withSkills opened, in place, so a write that stamps provenance after
 * the load (assessments.skills) names it, and the agent_runs row is updated.
 * Outside withSkills there is no list to join and nothing is recorded.
 */
export function noteSkillLoaded(skill: string): void {
  const context = getUsageContext();
  const skills = context.skills;
  if (!skills || skills.includes(skill)) return;
  skills.push(skill);
  skills.sort();
  if (context.trace) recordAgentRunSkills(context.trace, skills);
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
  budget: { microUsd: number; source: string; funding?: RunFunding } | null,
  fn: () => Promise<T>
): Promise<{ value: T; billedMicroUsd: number }> {
  const meter = { billedMicroUsd: 0 };
  const value = await runWithUsageContext(
    {
      meter,
      passBudget: budget
        ? { microUsd: Math.max(0, Math.round(budget.microUsd)), source: budget.source, meter, funding: budget.funding }
        : undefined,
    },
    fn
  );
  return { value, billedMicroUsd: meter.billedMicroUsd };
}

/**
 * Run `fn` under `budget` unless the caller already set one (a lane that
 * funds the pass knows its own ceiling better). The budget's meter is fresh,
 * so it measures this run alone, and what it measured is added to any
 * enclosing meter afterwards: nested meters shadow outer ones, and a caller
 * that records the run's cost (a contribution's review_cost) must still see
 * it, failure included.
 */
export async function withDefaultPassBudget<T>(
  budget: { microUsd: number; source: string },
  fn: () => Promise<T>
): Promise<T> {
  if (getUsageContext().passBudget) return fn();
  const outer = getUsageContext().meter;
  const meter = { billedMicroUsd: 0 };
  try {
    return await runWithUsageContext(
      {
        meter,
        passBudget: { microUsd: Math.max(0, Math.round(budget.microUsd)), source: budget.source, meter },
      },
      fn
    );
  } finally {
    if (outer) outer.billedMicroUsd += meter.billedMicroUsd;
  }
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
  // A run whose lane says who pays can petition that mandate (spend-tools.ts).
  const canPetition = Boolean(getUsageContext().passBudget?.funding);
  return JSON.stringify({
    success: false,
    message:
      `${tool} would cost about ${usd(price)}, and this run has ${usd(budget.remainingMicroUsd)} ` +
      `of its ${usd(budget.ceilingMicroUsd)} budget left. ` +
      (canPetition
        ? `If the work needs it, petition_mandate asks the mandate paying for this run for more, ` +
          `and answers in this run. Otherwise work with what you have and record what you could ` +
          `and couldn't establish.`
        : `Work with what you have and record what you could and couldn't establish.`),
  });
}
