/**
 * Platform faults: why work that is paid for is waiting on the platform
 * rather than on anything about the work (#967, #969, #971).
 *
 * On 2026-11-12 the deployment's account with one model provider ran out of
 * credits. Every failure was classified correctly as transient, and nothing
 * else went right: a ledger row that failed was handed back and picked again
 * at once, so one 0.05-owl lookout run on the dead provider was retried
 * every few minutes for thirteen hours, each failure paused every lane, and
 * no Steward pass ran although the Steward's own provider was healthy. The
 * rows read `open` the whole time, an ingest read `cancelled`, a mandate
 * paid for a review whose only news was the fault, and no maintainer was
 * told.
 *
 * This module is the vocabulary for that state. A fault has a public class,
 * the only thing a public surface shows of it (the raw provider text names
 * accounts, request ids and hosts; it stays in logs and the service-scoped
 * report, as a park's does, #846):
 *
 *  - credits_fault: the provider refused the call because the deployment's
 *    account cannot pay (llm/errors.ts, isProviderBillingError). The
 *    operator's to fix.
 *  - credentials_fault: the provider rejected the deployment's key (#846).
 *    The operator's to fix.
 *  - provider_unavailable: any other transient failure once the client's own
 *    retries are spent (rate limit, overload, 5xx, network). Usually clears
 *    on its own.
 *
 * The first two are deployment faults: they are recorded and reported to
 * maintainers (deployment-fault-service.ts). All three make a ledger row
 * wait: its attempt is not counted against the work, the row stays open and
 * funded, and it carries the class, since when, and when the platform tries
 * it next (action-service.ts, releaseAction). The funded rows of the same
 * kind and tier wait with it, since the same model serves them: one of them
 * is tried when the wait ends, so a fault costs one refused call per kind of
 * work per wait, and every row it holds up says so, not only the one that
 * happened to be tried.
 */
import {
  isProviderBillingError,
  isProviderCredentialsError,
  isTransientApiError,
  LlmBudgetExceededError,
} from "../llm/errors.js";

export const PLATFORM_FAULT_REASONS = ["credits_fault", "credentials_fault", "provider_unavailable"] as const;
export type PlatformFaultReason = (typeof PLATFORM_FAULT_REASONS)[number];

/** The two classes an operator must act on. */
export const DEPLOYMENT_FAULT_REASONS = ["credits_fault", "credentials_fault"] as const;
export type DeploymentFaultReason = (typeof DEPLOYMENT_FAULT_REASONS)[number];

/** One short phrase per class, safe to publish. Reads after "because of" or "waiting on". */
export const PLATFORM_FAULT_LABELS: Record<PlatformFaultReason, string> = {
  credits_fault:
    "a deployment fault: the platform's account with a model provider is out of credits (the operator's to fix, not the work's)",
  credentials_fault:
    "a deployment fault: a model provider rejected the platform's credentials (the operator's to fix, not the work's)",
  provider_unavailable:
    "a provider or network failure on the platform's side that outlasted its retries (not the work's fault)",
};

export function isPlatformFaultReason(v: unknown): v is PlatformFaultReason {
  return typeof v === "string" && (PLATFORM_FAULT_REASONS as readonly string[]).includes(v);
}

export function isDeploymentFaultReason(v: unknown): v is DeploymentFaultReason {
  return typeof v === "string" && (DEPLOYMENT_FAULT_REASONS as readonly string[]).includes(v);
}

/** The deployment fault behind a failure, or null when it is something else. */
export function deploymentFaultOf(err: unknown): DeploymentFaultReason | null {
  if (isProviderBillingError(err)) return "credits_fault";
  if (isProviderCredentialsError(err)) return "credentials_fault";
  return null;
}

/**
 * The platform fault behind a failure: a deployment fault, any other
 * transient provider failure, or null for a failure that is the work's own
 * (a genuine error) or the run's own budget.
 */
export function platformFaultOf(err: unknown): PlatformFaultReason | null {
  if (err instanceof LlmBudgetExceededError) return null;
  // A claim another Steward holds (steward-lease.ts) is retryable and is
  // nobody's fault: the row is simply open again.
  if ((err as { name?: unknown } | null)?.name === "StewardBusyError") return null;
  const deployment = deploymentFaultOf(err);
  if (deployment) return deployment;
  return isTransientApiError(err) ? "provider_unavailable" : null;
}

/**
 * How long a ledger row waits before the platform tries it again after its
 * n-th consecutive platform fault: 30 seconds, doubling, to 10 minutes.
 *
 * A wait, and not a limit on anyone: the row stays open and funded and is
 * retried for as long as the fault lasts. Money cannot pace this (CLAUDE.md,
 * "Constraints on agents"): a call the provider refuses for credits or
 * credentials is answered before anything is billed, so a row retried at
 * once is a loop that has stopped spending, and the row with the most
 * backing would be picked first every time, starving every other row and,
 * through the runner's pause, every other lane. The wait is on the row,
 * where its payer reads it (`waiting_on`, `waiting_since`,
 * `next_attempt_at` in the ledger view; a plan item's reason; the review
 * briefing).
 */
export const FAULT_RETRY_BASE_SECONDS = 30;
export const FAULT_RETRY_MAX_SECONDS = 600;

export function faultRetrySeconds(consecutiveFaults: number): number {
  const n = Math.max(1, Math.floor(consecutiveFaults));
  return Math.min(FAULT_RETRY_MAX_SECONDS, FAULT_RETRY_BASE_SECONDS * 2 ** Math.min(n - 1, 10));
}

/** A ledger row's wait on a platform fault, as public surfaces describe it. */
export interface FaultWait {
  reason: PlatformFaultReason;
  /** The class in words. */
  reason_label: string;
  /** When the row first failed on it, ISO 8601. */
  since: string | null;
  /** When the platform tries the row next, ISO 8601. */
  next_attempt_at: string | null;
  /** Attempts at this kind of work the fault has stopped in a row; none is counted against the work. */
  attempts: number;
}

const isoOrNull = (v: Date | string | null | undefined): string | null =>
  v instanceof Date ? v.toISOString() : v ? new Date(v).toISOString() : null;

export interface FaultWaitRow {
  fault_reason?: string | null;
  fault_since?: Date | string | null;
  fault_attempts?: number | null;
  retry_after?: Date | string | null;
}

/** The wait a row's columns describe, or null when it is not waiting on a fault. */
export function faultWait(row: FaultWaitRow | null | undefined): FaultWait | null {
  if (!row || !isPlatformFaultReason(row.fault_reason)) return null;
  return {
    reason: row.fault_reason,
    reason_label: PLATFORM_FAULT_LABELS[row.fault_reason],
    since: isoOrNull(row.fault_since),
    next_attempt_at: isoOrNull(row.retry_after),
    attempts: Number(row.fault_attempts ?? 0),
  };
}

const minute = (iso: string | null): string => (iso ? `${iso.slice(0, 16).replace("T", " ")} UTC` : "");

/**
 * The wait in one sentence, for a plan item's reason, a commission's note
 * and the review briefing. Says what happens to the money, because that is
 * the payer's next question: the budget stays held for this work and no
 * failed attempt is charged.
 *
 * The decision on held money (#971): a commission the platform cannot run
 * yet keeps its hold, and the hold counts toward the daily rate of the UTC
 * day it was placed on, as any work not yet run does (day-use.ts). Freeing
 * it would let a mandate place a second day's worth of work behind the same
 * fault, and all of it would run, past the rate its funder set, the moment
 * the fault cleared. The hold does not carry into the next day's rate, and
 * what a pass leaves unspent returns when it runs. No limit is added and
 * none is lifted; the state and its reason are what the payer is shown.
 */
export function faultWaitSentence(w: FaultWait): string {
  return (
    `waiting on ${w.reason_label}` +
    (w.since ? `, since ${minute(w.since)}` : "") +
    `. The platform retries it on its own` +
    (w.next_attempt_at ? ` (next attempt about ${minute(w.next_attempt_at)})` : "") +
    `; nothing about the work has failed and no attempt is charged. Its budget stays held for it ` +
    `meanwhile and counts toward the daily rate of the day it was placed on, not of later days`
  );
}

/** How the wait is described wherever a tool or a route returns it. */
export const FAULT_WAIT_DESCRIPTION =
  "An open row that carries `waiting_on` is not merely queued: the platform tried it and a platform " +
  "fault stopped the attempt (`waiting_on` is one of credits_fault, credentials_fault, " +
  "provider_unavailable; `waiting_since` and `next_attempt_at` say since when and when it is tried " +
  "next). Nothing about the work failed and no attempt is charged. The platform retries it on its own " +
  "until it runs; its budget stays held for it meanwhile, counted toward the daily rate of the day it " +
  "was placed on and not of later days. Commissioning it again does not help.";

/**
 * What a tool tells an agent whose call a platform fault stopped, in place
 * of the provider's raw text. `what` names what could not run.
 */
export function faultToolNote(reason: PlatformFaultReason, what: string): string {
  return (
    `${what} could not run because of ${PLATFORM_FAULT_LABELS[reason]}. ` +
    (isDeploymentFaultReason(reason)
      ? `The operator has been told; do not raise_issue for it, and retrying in this run will not help.`
      : `One retry is reasonable; if it fails again, go on without it.`)
  );
}
