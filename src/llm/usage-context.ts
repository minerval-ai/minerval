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
   * Live cost accumulator for the enclosing metered operation. The metering
   * chokepoint adds each call's BILLED (marked-up) cost here synchronously,
   * so cap-and-settle charging (owl-ledger-service.settleMeteredCharge) can
   * read the operation's real cost the moment the work finishes, without
   * waiting on the async llm_usage insert.
   */
  meter?: { billedMicroUsd: number };
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
  const trace = startAgentRun(agent, getUsageContext());
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
