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

export interface UsageContext {
  userId?: string | null;
  apiKeyId?: string | null;
  jobId?: string | null;
  /** The claim this work serves (#217) — makes per-claim cost a query. */
  claimId?: string | null;
  requestId?: string | null;
  /** Agent making the calls: extractor | matcher | steward | curator | ... */
  agent?: string;
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

/** Tag all LLM calls inside `fn` as made by `agent`. */
export function withAgent<T>(agent: string, fn: () => T): T {
  return runWithUsageContext({ agent }, fn);
}
