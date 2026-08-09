/**
 * Enqueue-event telemetry (#334 L0, #217's fan-out half).
 *
 * Records one enqueue_events row per enqueue through the queue-service
 * chokepoint, tagged with the target (queue, trigger, claim/job/contribution)
 * and the source (the enclosing agent run, from the ambient usage context).
 * This is the raw data for fan-out analysis ("how many Stewards does one
 * Steward run wake"), cascade-lineage reconstruction (#295's empirical R),
 * and measuring what #182's pending-slot coalescing absorbs.
 *
 * Same posture as metering and tracing: fire-and-forget, swallows its own
 * errors — telemetry never fails or slows an enqueue. ENQUEUE_EVENTS: "on"
 * records, "off" doesn't; unset resolves to off under vitest (unit tests must
 * not attempt DB writes) and on everywhere else, production included — the
 * rows are tiny and production fan-out is exactly the data #217 wants.
 */
import { getDb } from "../db/client.js";
import { enqueueEvents } from "../db/schema.js";
import { getUsageContext } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";

export type EnqueueTargetQueue =
  | "steward"
  | "curator"
  | "contribution"
  | "arbitration"
  | "audit"
  | "claim_pipeline"
  | "url_extraction";

export interface EnqueueEventInput {
  queue: EnqueueTargetQueue;
  trigger?: string;
  claimId?: string;
  jobId?: string;
  contributionId?: string;
  /** Steward lane only: appended to an existing pending slot vs created it. */
  coalesced?: boolean;
}

export function enqueueEventsEnabled(): boolean {
  const setting = loadConfig().enqueueEvents;
  if (setting) return setting === "on";
  return !process.env.VITEST;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Some message fields carry non-uuid sentinels by upstream convention (e.g.
 * steward-created claims enqueue the claim pipeline with jobId "steward",
 * there being no job row). The uuid columns here take real ids or NULL —
 * a sentinel must not fail the whole event row (first seen live: 6 of a
 * smoke run's 8 claim-pipeline enqueues silently lost).
 */
function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

/** Record one enqueue. Fire-and-forget; never throws. */
export function recordEnqueueEvent(event: EnqueueEventInput): void {
  if (!enqueueEventsEnabled()) return;
  const ctx = getUsageContext();
  void (async () => {
    try {
      await getDb().insert(enqueueEvents).values({
        queue: event.queue,
        trigger: event.trigger ?? null,
        claimId: uuidOrNull(event.claimId),
        jobId: uuidOrNull(event.jobId),
        contributionId: uuidOrNull(event.contributionId),
        sourceAgent: ctx.agent ?? null,
        sourceRunId: uuidOrNull(ctx.runId),
        sourceClaimId: uuidOrNull(ctx.claimId),
        coalesced: event.coalesced ?? null,
      });
    } catch (err) {
      console.error(
        "[enqueue-events] failed to record enqueue:",
        err instanceof Error ? err.message : err
      );
    }
  })();
}
