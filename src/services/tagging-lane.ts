/**
 * The tagging lane's wait: why the tagger is not running although claims are
 * waiting to be tagged, since when, and when the lane tries again.
 *
 * The tagger has no ledger row. Its queue is the claim row
 * (workers/tagging-pipeline.ts) and nobody pays for a pass, so nothing of
 * the ledger's fault handling (action-service.ts, releaseAction) reached it.
 * On 2026-11-13 the lane recorded 97 failed runs in 168: a tick that met a
 * provider failure handed the claim back and leased the next one at once,
 * five to a tick, every 30 seconds, and a tick that met the spent breaker
 * opened a run to be refused inside it. Neither showed anywhere but as an
 * agent's error rate.
 *
 * There are two waits, and they are the lane's, not the agent's: a tagger
 * run that has started works under neither, so neither is in its briefing.
 * Both are shown where the lane's depth is (`/queue`, `/monitors`).
 *
 *  - A platform fault (deployment-fault.ts): a call the provider refused or
 *    could not serve once the client's own retries were spent. The lane
 *    holds for the engine's wait, 30 seconds doubling to 10 minutes
 *    (faultRetrySeconds), and one claim is tried when it ends. Money cannot
 *    pace this, for the reason it cannot pace a ledger row's wait: a refused
 *    call is answered before anything is billed, so retrying at once is a
 *    loop that has stopped spending. Here there is not even a payer whose
 *    budget could run down: the lane is unattributed work. Nothing is
 *    limited: every claim stays queued and is tagged when the provider
 *    serves the lane again.
 *
 *  - The spend breaker (llm/budget-tracker.ts): the process-wide limit on
 *    unattributed model calls is spent for the hour or the day. That limit
 *    is not new and is not set here; this module only says that the lane is
 *    waiting on it and until when, where before a run was opened to find
 *    out. The counters are per process, so with several tasks the lane
 *    reads as waiting when the task that ticked last was spent.
 *
 * The state is one row of platform_flags, so every task holds the lane on a
 * fault any of them met, and the API process that serves `/queue` reads the
 * same row.
 */
import { rawQuery } from "../db/client.js";
import {
  PLATFORM_FAULT_LABELS,
  faultRetrySeconds,
  isPlatformFaultReason,
  type PlatformFaultReason,
} from "./deployment-fault.js";

export const TAGGING_LANE_FLAG = "tagging_lane_wait";

export type TaggingLaneWaitReason = PlatformFaultReason | "spend_breaker";

export interface TaggingLaneWait {
  reason: TaggingLaneWaitReason;
  /** The reason in words, safe to publish. Reads after "waiting on". */
  reason_label: string;
  /** When the lane first met it, ISO 8601. */
  since: string;
  /** When the lane tries a claim next, ISO 8601. */
  next_attempt_at: string;
  /** Consecutive attempts a platform fault has stopped; 0 for the breaker. */
  attempts: number;
}

const BREAKER_LABEL =
  "the platform's spend breaker: its limit on model calls that no person or mandate is paying for is spent for this " +
  "window (not a fault, and nothing about the claims)";

const labelOf = (reason: TaggingLaneWaitReason): string =>
  reason === "spend_breaker" ? BREAKER_LABEL : PLATFORM_FAULT_LABELS[reason];

function parse(value: unknown): TaggingLaneWait | null {
  const v = value as Partial<TaggingLaneWait> | null;
  if (!v || typeof v !== "object") return null;
  const reason = v.reason;
  if (reason !== "spend_breaker" && !isPlatformFaultReason(reason)) return null;
  if (typeof v.since !== "string" || typeof v.next_attempt_at !== "string") return null;
  return {
    reason,
    reason_label: labelOf(reason),
    since: v.since,
    next_attempt_at: v.next_attempt_at,
    attempts: Number(v.attempts ?? 0),
  };
}

/** The lane's recorded wait, whether or not its next attempt has come; null when there is none. */
export async function readTaggingLaneWait(): Promise<TaggingLaneWait | null> {
  const [row] = await rawQuery<{ value: unknown }>(`SELECT value FROM platform_flags WHERE key = $1`, [
    TAGGING_LANE_FLAG,
  ]);
  return parse(row?.value);
}

/**
 * Whether the wait is still on: its next attempt is ahead. One whose time has
 * come is due, and no surface shows it as a wait (the rule the ledger's rows
 * follow, deployment-fault.ts, waitingOnFaultSql).
 */
export function taggingLaneWaiting(wait: TaggingLaneWait | null, now: number = Date.now()): wait is TaggingLaneWait {
  return wait !== null && new Date(wait.next_attempt_at).getTime() > now;
}

/** The wait `/queue` and `/monitors` show: the recorded one while it is still on. */
export async function currentTaggingLaneWait(now: number = Date.now()): Promise<TaggingLaneWait | null> {
  const wait = await readTaggingLaneWait();
  return taggingLaneWaiting(wait, now) ? wait : null;
}

async function write(wait: Omit<TaggingLaneWait, "reason_label">): Promise<void> {
  await rawQuery(
    `INSERT INTO platform_flags (key, value, updated_at)
     VALUES ($1, $2::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [TAGGING_LANE_FLAG, JSON.stringify(wait)]
  );
}

/**
 * A platform fault stopped the lane's attempt: hold it for the engine's
 * wait. `prior` is the wait the tick read when it began; a fault that
 * follows a fault continues its count and keeps its since.
 */
export async function holdTaggingLaneOnFault(
  reason: PlatformFaultReason,
  prior: TaggingLaneWait | null,
  now: number = Date.now()
): Promise<TaggingLaneWait> {
  const continuing = prior !== null && prior.reason !== "spend_breaker";
  const attempts = (continuing ? prior.attempts : 0) + 1;
  const wait = {
    reason,
    since: continuing ? prior.since : new Date(now).toISOString(),
    next_attempt_at: new Date(now + faultRetrySeconds(attempts) * 1000).toISOString(),
    attempts,
  };
  await write(wait);
  return { ...wait, reason_label: labelOf(reason) };
}

/**
 * When the breaker's window that `limitType` names rolls over: the top of
 * the next UTC hour, or the next UTC midnight (budget-tracker.ts,
 * rolloverIfNeeded).
 */
export function breakerResetsAt(limitType: string, now: number = Date.now()): number {
  const span = limitType.startsWith("daily") ? 86_400_000 : 3_600_000;
  return (Math.floor(now / span) + 1) * span;
}

/**
 * The spend breaker is spent: record that the lane waits on it until its
 * window rolls over. Written once per window, not once per tick.
 */
export async function holdTaggingLaneOnBreaker(
  limitType: string,
  prior: TaggingLaneWait | null,
  now: number = Date.now()
): Promise<TaggingLaneWait> {
  const next = new Date(breakerResetsAt(limitType, now)).toISOString();
  if (prior?.reason === "spend_breaker" && prior.next_attempt_at === next) return prior;
  const wait = {
    reason: "spend_breaker" as const,
    since: prior?.reason === "spend_breaker" ? prior.since : new Date(now).toISOString(),
    next_attempt_at: next,
    attempts: 0,
  };
  await write(wait);
  return { ...wait, reason_label: BREAKER_LABEL };
}

/** The lane ran, or has nothing to run: it is waiting on nothing. */
export async function clearTaggingLaneWait(): Promise<void> {
  await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [TAGGING_LANE_FLAG]);
}
