/**
 * The prize-check worker (docs/mathematics.md §8.4, §8.6): the executor of
 * `prize_review` actions, in two steps so a check never blocks a lane.
 *
 * The check runs first, before any agent, as a DB-backed job: a prize check
 * may run twenty minutes, which is longer than the pipeline's crash-reclaim
 * window, and a worker held idle for it would hold every other lane too. So
 * one tick of this worker does at most one unit of work and returns:
 *
 *  1. Submit. Claim the oldest `queued` prize claim per statement version
 *     whose statement holds no other live claim (strict per-statement
 *     serialization, FOR UPDATE SKIP LOCKED), under the concurrency cap and
 *     the per-day budget; refuse a source whose hash matches an attempt-mode
 *     check as a copy of the platform's own work; post to the checker in
 *     `prize` mode; remember the checker's `check_id`; poll once; return.
 *  2. Poll. On later ticks, `getCheck` once per `checking` row, one request
 *     each, never a wait. The first finished record is landed: the check is
 *     metered, the `lean_checks` row written, the transitions applied, and
 *     on acceptance the Contribution Reviewer runs inside a usage context
 *     whose job is the bounty's reserve and, when it admits, the Steward is
 *     invoked directly on `prize_claim` (§6.4).
 *
 * The schema has no column for the checker's check id, so the id lives in
 * an in-process map keyed by prize claim id. After a restart the map is
 * empty and the worker re-submits each `checking` row with `force: false`:
 * the checker dedupes an identical submission (statement, source, kind,
 * replay, mode) against the record it already holds, queued, running, or
 * done, and answers with that record, so the id is recovered without a
 * second run. A retry after a checker error (`check_attempts > 1`) submits
 * with `force: true`, because the same dedupe would otherwise hand back the
 * error it is retrying.
 *
 * Each poll heartbeats the row's `updated_at`, so the reclaim sweep
 * (`checking` rows untouched for PRIZE_CHECK_RECLAIM_MINUTES) trips only for
 * a dead worker, never for a live poll; a check that has not finished within
 * PRIZE_CHECK_POLL_TIMEOUT_MS is an error like a checker timeout. A checker
 * error requeues up to PRIZE_CHECK_MAX_ATTEMPTS, then `check_error` holds
 * the statement's queue for an operator.
 *
 * The tick also carries three bounded sweeps, one unit each, so nothing on
 * the prize path is a dead end: a `checked` claim whose Reviewer run was
 * lost is reviewed again under the reserve (the ordinary pipeline and its
 * recovery sweep skip `claim_prize`, §8.4); an `in_review` claim the Audit
 * agent sent back is put in front of the Steward again for a fresh decision
 * (§8.5); and an `in_review` claim with no Steward decision for 24 hours is
 * re-invoked, at most once a day.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  getLeanCheckerClient,
  leanUsageCostMicroUsd,
  leanUsageModel,
  LeanCheckerUnavailable,
  type CheckRecord,
  type LeanCheckerClient,
  type SubmitCheckInput,
} from "../services/lean-checker-client.js";
import { meterExternalUsage } from "../services/usage-service.js";
import { getUsageContext, runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { runContributionReview } from "../llm/agents/contribution-reviewer.js";
import { recordLeanCheck } from "../services/formalization-service.js";
import { claimAction, completeAction } from "../services/action-service.js";
import { requestAudit } from "../services/queue-service.js";
import { invokeStewardDirect } from "./steward-direct.js";
import { MAX_REVIEW_ATTEMPTS, REVIEW_RECLAIM_MINUTES } from "./contribution-pipeline.js";
import {
  getPrizeClaimById,
  transitionPrizeClaim,
  updatePrizeClaimFields,
  admitPrizeClaim,
  reopenBountyAfterClaimClosed,
  QUEUE_HOLDING_STATUSES,
  type PrizeClaimRow,
} from "../services/prize-claim-service.js";
import { getLeanSourceForContribution } from "../services/attachment-service.js";
import { getBountyById, getReserveJob, getPlatformAccountId, setBountyStatus } from "../services/bounty-service.js";
import { asRunner } from "../services/prize-pool-service.js";

export type PrizeCheckStatus =
  /** A verdict landed, a Reviewer or Steward run happened: one unit of work. */
  | "processed"
  /** A claim was submitted to the checker and is now in flight. */
  | "submitted"
  /** In-flight checks were polled; none finished; nothing new to submit. */
  | "polling"
  | "empty"
  | "capped"
  | "no_checker";

export interface PrizeCheckResult {
  status: PrizeCheckStatus;
  prizeClaimId?: string;
  checkId?: string;
  verdict?: string;
  outcome?: string;
  error?: string;
  /** Checks polled this tick that are still running. */
  inFlight?: number;
}

/** A check that has not finished within this is an error, as waitForCheck's default timeout. */
export const PRIZE_CHECK_POLL_TIMEOUT_MS = 20 * 60_000;

/** How long a claim may sit `in_review` without a Steward decision before the worker re-invokes. */
export const IN_REVIEW_REINVOKE_HOURS = 24;

interface InFlightCheck {
  checkId: string;
  /** When the checker received it (its own clock after a recovery). */
  submittedAt: number;
}

// The checker's check id per prize claim, for this process only: the schema
// carries no column for it, and a restart recovers it by re-submitting with
// force: false (see the module comment).
const inFlightChecks = new Map<string, InFlightCheck>();

/** The remembered check for a prize claim, if this process submitted or recovered it. */
export function inFlightCheckFor(prizeClaimId: string): InFlightCheck | undefined {
  return inFlightChecks.get(prizeClaimId);
}

/** Test hook: forget every remembered check id, as a restart would. */
export function resetInFlightChecksForTests(): void {
  inFlightChecks.clear();
}

/**
 * The reclaim sweep: `checking` rows nobody has polled for the window
 * (every poll heartbeats `updated_at`) return to `queued`.
 */
export async function reclaimStalePrizeChecks(): Promise<number> {
  const config = loadConfig();
  const rows = await rawQuery<{ id: string }>(
    `UPDATE prize_claims SET status = 'queued', updated_at = now()
      WHERE status = 'checking'
        AND updated_at < now() - ($1 || ' minutes')::interval
      RETURNING id`,
    [String(config.prizeCheckReclaimMinutes)]
  );
  for (const row of rows) {
    inFlightChecks.delete(row.id);
    const pc = await getPrizeClaimById(row.id);
    if (pc) {
      await rawQuery(
        `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, 'prize_claim:queued', $2, 'prize_check_pipeline')`,
        [pc.claim_id, `prize claim ${pc.id}: check reclaimed after ${config.prizeCheckReclaimMinutes} minutes without a poll`]
      );
    }
  }
  return rows.length;
}

/**
 * Route a claim the Arbitrator accepted (an overturned escalation) into
 * admission: the ordinary arbitration path marks the contribution
 * `accepted` while the prize claim still reads `checked`; the worker
 * completes the admit on its next pass.
 */
export async function reconcileArbitratedAdmissions(): Promise<number> {
  const rows = await rawQuery<{ contribution_id: string }>(
    `SELECT pc.contribution_id FROM prize_claims pc
       JOIN contributions c ON c.id = pc.contribution_id
      WHERE pc.status = 'checked' AND c.review_status = 'accepted'
        AND EXISTS (SELECT 1 FROM arbitration_results ar WHERE ar.contribution_id = c.id AND ar.outcome = 'overturn')`
  );
  let admitted = 0;
  for (const row of rows) {
    const res = await admitPrizeClaim({ contributionId: row.contribution_id, review: null, actor: "dispute_arbitrator" });
    if (res.ok) {
      admitted++;
      await runStewardOnAdmitted(res.prize_claim_id).catch((err) =>
        console.error("[prize-check] steward invocation failed:", err instanceof Error ? err.message : err)
      );
    }
  }
  return admitted;
}

/** Under the caps? The concurrency cap counts `checking` rows; the day cap counts prize-mode checks today. */
export async function prizeCheckCapacity(): Promise<{ ok: boolean; reason?: string }> {
  const config = loadConfig();
  const [row] = await rawQuery<{ checking: string; today: string }>(
    `SELECT (SELECT COUNT(*) FROM prize_claims WHERE status = 'checking')::int AS checking,
            (SELECT COUNT(*) FROM lean_checks WHERE mode = 'prize'
              AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::int AS today`
  );
  if (Number(row?.checking ?? 0) >= config.prizeCheckMaxConcurrent) {
    return { ok: false, reason: `concurrency cap (${config.prizeCheckMaxConcurrent}) reached` };
  }
  if (config.prizeChecksPerDay > 0 && Number(row?.today ?? 0) >= config.prizeChecksPerDay) {
    return { ok: false, reason: `daily check budget (${config.prizeChecksPerDay}) reached` };
  }
  return { ok: true };
}

/**
 * Claim the next queued prize claim: the oldest by (submitted_at, id) per
 * statement version whose statement holds no other claim in a
 * queue-holding status. The row is locked and moved to `checking` in one
 * transaction so two workers never pick the same claim.
 */
export async function claimNextQueuedPrizeClaim(): Promise<PrizeClaimRow | null> {
  return withTransaction(async (tx) => {
    const [row] = await tx.query<{ id: string }>(
      `SELECT pc.id FROM prize_claims pc
        WHERE pc.status = 'queued'
          AND NOT EXISTS (SELECT 1 FROM prize_claims h
                           WHERE h.formalization_id = pc.formalization_id
                             AND h.id <> pc.id AND h.status = ANY($1))
          AND NOT EXISTS (SELECT 1 FROM prize_claims e
                           WHERE e.formalization_id = pc.formalization_id
                             AND e.status = 'queued'
                             AND (e.submitted_at, e.id) < (pc.submitted_at, pc.id))
        ORDER BY pc.submitted_at ASC, pc.id ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED`,
      [[...QUEUE_HOLDING_STATUSES]]
    );
    if (!row) return null;
    return transitionPrizeClaim(tx, row.id, "queued", "checking", {
      actor: "prize_check_pipeline",
      reason: "claimed for the cold-lane check",
      set: { checkAttemptsDelta: 1 },
    });
  });
}

async function findReviewAction(prizeClaimId: string): Promise<string | null> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE kind = 'prize_review' AND target_ref = $1 AND status IN ('open', 'running') LIMIT 1`,
    [prizeClaimId]
  );
  return row?.id ?? null;
}

/** The usage context a prize review runs under: the reserve job, the platform, the claim. */
async function reviewContext(pc: PrizeClaimRow): Promise<{ jobId: string | null; userId: string; claimId: string }> {
  const job = await getReserveJob(pc.bounty_id);
  const userId = await getPlatformAccountId();
  return { jobId: job?.id ?? null, userId, claimId: pc.claim_id };
}

/** After the Reviewer admits, the Steward runs directly on `prize_claim` (§6.4). */
export async function runStewardOnAdmitted(
  prizeClaimId: string,
  opts: { model?: string; context?: string } = {}
): Promise<number> {
  const pc = await getPrizeClaimById(prizeClaimId);
  if (!pc || pc.status !== "in_review") return 0;
  const ctx = await reviewContext(pc);
  const { billedMicroUsd } = await invokeStewardDirect({
    trigger: "prize_claim",
    claimId: pc.claim_id,
    context:
      opts.context ??
      `prize claim ${pc.id}: the checker accepted a ${pc.direction} and the Reviewer admitted it; judge fidelity with get_prize_claim and decide with decide_prize_claim.`,
    jobId: ctx.jobId ?? undefined,
    userId: ctx.userId,
    ...(opts.model ? { model: opts.model } : {}),
  });
  // The direct invocation meters under its own scoped meter, which shadows
  // the worker's; add its cost here so the prize_review action consumes
  // the Steward's run from the reserve too, not only the check and the
  // Reviewer.
  const meter = getUsageContext().meter;
  if (meter) meter.billedMicroUsd += billedMicroUsd;
  return billedMicroUsd;
}

/** Copy of the platform's own work: the hash matches an attempt-mode check on any statement. */
export async function matchesAttemptCheck(sha256: string): Promise<boolean> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM lean_checks WHERE mode = 'attempt' AND submission_sha256 = $1 LIMIT 1`,
    [sha256]
  );
  return !!row;
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

export interface PrizeCheckTickOptions {
  client?: LeanCheckerClient | null;
  model?: string;
}

/**
 * One tick: the sweeps, then a poll of every in-flight check, then one
 * submission. At most one model-running unit of work per tick, and never a
 * wait on the checker beyond a single request.
 */
export async function processNextPrizeCheck(opts: PrizeCheckTickOptions = {}): Promise<PrizeCheckResult> {
  const config = loadConfig();
  // No checker configured (or a deployment whose config never named one):
  // the lane reports it and touches nothing.
  const client =
    opts.client !== undefined
      ? opts.client
      : typeof config.leanCheckerUrl === "string" && config.leanCheckerUrl.trim()
        ? getLeanCheckerClient(config)
        : null;
  if (!client) return { status: "no_checker" };
  await reclaimStalePrizeChecks().catch(() => 0);
  await reconcileArbitratedAdmissions().catch(() => 0);

  const sentBack = await reinvokeSentBackClaim(opts).catch((err) => {
    console.error("[prize-check] send-back sweep failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (sentBack) return sentBack;
  const stale = await reinvokeStaleInReviewClaim(opts).catch((err) => {
    console.error("[prize-check] in_review sweep failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (stale) return stale;
  const recovered = await recoverPendingPrizeReview(opts).catch((err) => {
    console.error("[prize-check] reviewer recovery failed:", err instanceof Error ? err.message : err);
    return null;
  });
  if (recovered) return recovered;

  const polled = await pollInFlightChecks(client, opts);
  if (polled.landed) return polled.landed;

  const capacity = await prizeCheckCapacity();
  if (!capacity.ok) return { status: "capped", error: capacity.reason, inFlight: polled.running };
  const submitted = await submitNextPrizeCheck(client, opts);
  if (submitted) return { ...submitted, inFlight: polled.running + (submitted.status === "submitted" ? 1 : 0) };
  return polled.running > 0 ? { status: "polling", inFlight: polled.running } : { status: "empty" };
}

// ---------------------------------------------------------------------------
// Step 1: submit
// ---------------------------------------------------------------------------

type Prepared =
  | { input: SubmitCheckInput; sha256: string }
  | { refusal: string; outcome: string };

/** The checker's input for a claim, or the reason it is refused before any submission. */
async function prepareSubmission(pc: PrizeClaimRow): Promise<Prepared> {
  const lean = await getLeanSourceForContribution(pc.contribution_id);
  const [f] = await rawQuery<{ statement_source: string; pin_id: string }>(
    `SELECT statement_source, pin_id FROM claim_formalizations WHERE id = $1`,
    [pc.formalization_id]
  );
  if (!lean || !f) {
    return { refusal: "the submission carries no Lean source or its statement is gone", outcome: "rejected" };
  }
  // A submission matching an attempt-mode check is a copy of the platform's
  // own work: rejected at stage check before any submission (§8.1).
  if (await matchesAttemptCheck(lean.sha256)) {
    return {
      refusal: "the source matches a proof the platform's own solver produced; a copy of the platform's work is not eligible",
      outcome: "copy_of_attempt",
    };
  }
  return {
    sha256: lean.sha256,
    input: {
      mode: "prize",
      kind: pc.direction,
      statement_source: f.statement_source,
      submission_source: lean.source,
      replay: "module",
    },
  };
}

/** Claim the next queued prize claim and put it in front of the checker. */
async function submitNextPrizeCheck(client: LeanCheckerClient, opts: PrizeCheckTickOptions): Promise<PrizeCheckResult | null> {
  const pc = await claimNextQueuedPrizeClaim();
  if (!pc) return null;
  const actionId = await findReviewAction(pc.id);
  if (actionId) await claimAction(actionId).catch(() => false);

  const prepared = await prepareSubmission(pc);
  if ("refusal" in prepared) {
    await rejectAtCheck(pc, null, prepared.refusal);
    await settleAction(actionId, 0, null);
    return { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: prepared.outcome };
  }
  let record: CheckRecord;
  try {
    // A retry after a checker error forces a fresh run: the checker would
    // otherwise dedupe the identical submission against the error record.
    record = await client.submitCheck({ ...prepared.input, force: pc.check_attempts > 1 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await handleCheckError(pc, msg);
    return { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: msg };
  }
  const entry = { checkId: record.check_id, submittedAt: Date.parse(record.created_at) || Date.now() };
  inFlightChecks.set(pc.id, entry);
  // One poll now, a single request: a deduplicated or instant record lands
  // in the same tick; a running check waits for a later tick.
  if (record.status !== "done") {
    try {
      record = await client.getCheck(entry.checkId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await handleCheckError(pc, msg);
      return { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: msg };
    }
  }
  const landed = await pollOne(pc, record, opts, entry);
  if (landed) return landed;
  return { status: "submitted", prizeClaimId: pc.id, checkId: record.check_id };
}

// ---------------------------------------------------------------------------
// Step 2: poll and land
// ---------------------------------------------------------------------------

/**
 * Poll every `checking` row once. The first finished check is landed and
 * returned; the rest stay in flight for the next tick.
 */
async function pollInFlightChecks(
  client: LeanCheckerClient,
  opts: PrizeCheckTickOptions
): Promise<{ landed: PrizeCheckResult | null; running: number }> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM prize_claims WHERE status = 'checking' ORDER BY updated_at ASC`
  );
  let running = 0;
  for (const row of rows) {
    const pc = await getPrizeClaimById(row.id);
    if (!pc || pc.status !== "checking") continue;
    let entry = inFlightChecks.get(pc.id);
    let record: CheckRecord;
    try {
      if (!entry) {
        // A restart lost the id: re-submit with force: false and the
        // checker answers with the record it already holds for this
        // submission (queued, running, or done), or runs it if it has none.
        const prepared = await prepareSubmission(pc);
        if ("refusal" in prepared) {
          await rejectAtCheck(pc, null, prepared.refusal);
          await settleAction(await findReviewAction(pc.id), 0, null);
          return { landed: { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: prepared.outcome }, running };
        }
        record = await client.submitCheck({ ...prepared.input, force: false });
        entry = { checkId: record.check_id, submittedAt: Date.parse(record.created_at) || Date.now() };
        inFlightChecks.set(pc.id, entry);
        if (record.status !== "done") record = await client.getCheck(entry.checkId);
      } else {
        record = await client.getCheck(entry.checkId);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      inFlightChecks.delete(pc.id);
      await handleCheckError(pc, msg);
      return { landed: { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: msg }, running };
    }
    const landed = await pollOne(pc, record, opts, entry);
    if (landed) return { landed, running };
    running++;
  }
  return { landed: null, running };
}

/**
 * One look at a record: land it when done, time it out when overdue, or
 * heartbeat the row and leave it in flight.
 */
async function pollOne(
  pc: PrizeClaimRow,
  record: CheckRecord,
  opts: PrizeCheckTickOptions,
  entry: InFlightCheck | undefined = inFlightChecks.get(pc.id)
): Promise<PrizeCheckResult | null> {
  if (record.status === "done") {
    inFlightChecks.delete(pc.id);
    return landVerdict(pc, record, opts);
  }
  if (entry && Date.now() - entry.submittedAt > PRIZE_CHECK_POLL_TIMEOUT_MS) {
    inFlightChecks.delete(pc.id);
    const msg = `check ${entry.checkId} did not finish within ${PRIZE_CHECK_POLL_TIMEOUT_MS} ms`;
    await handleCheckError(pc, msg);
    return { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: msg };
  }
  await rawQuery(`UPDATE prize_claims SET updated_at = now() WHERE id = $1 AND status = 'checking'`, [pc.id]).catch(() => []);
  return null;
}

/**
 * Land a finished check: meter it, record it, apply the transitions, and on
 * acceptance run the Reviewer and the Steward under the reserve job. The
 * prize_review action completes with what the landing cost.
 */
async function landVerdict(pc: PrizeClaimRow, record: CheckRecord, opts: PrizeCheckTickOptions): Promise<PrizeCheckResult> {
  const actionId = await findReviewAction(pc.id);
  const ctx = await reviewContext(pc);
  let outcome: PrizeCheckResult = { status: "processed", prizeClaimId: pc.id, checkId: record.check_id };
  const { billedMicroUsd } = await runWithUsageContext(
    { jobId: ctx.jobId, userId: ctx.userId, claimId: ctx.claimId, agent: "prize_check" },
    () =>
      withCostMeter(async () => {
        outcome = { ...outcome, ...(await applyVerdict(pc, record, opts)) };
      })
  );
  // A requeued error keeps the action running for the next landing; every
  // other outcome closes it.
  if (outcome.outcome !== "requeued") await settleAction(actionId, billedMicroUsd, ctx.jobId);
  return outcome;
}

async function settleAction(actionId: string | null, billedMicroUsd: number, jobId: string | null): Promise<void> {
  if (!actionId) return;
  await completeAction(actionId, billedMicroUsd, { meteredJobId: jobId }).catch((err) =>
    console.error(`[prize-check] completeAction failed for ${actionId}: ${err instanceof Error ? err.message : err}`)
  );
}

async function applyVerdict(pc: PrizeClaimRow, record: CheckRecord, opts: PrizeCheckTickOptions): Promise<PrizeCheckResult> {
  const config = loadConfig();
  const cost = leanUsageCostMicroUsd(record.resource, config);
  await meterExternalUsage({
    provider: "lean",
    model: leanUsageModel(record.pin_id),
    units: record.resource?.wall_ms ?? 0,
    unitKind: "wall_ms",
    costMicroUsd: cost,
  });
  let leanCheckId: string | null = null;
  if (record.verdict && record.verdict !== "error") {
    const lean = await getLeanSourceForContribution(pc.contribution_id);
    const row = await recordLeanCheck({
      formalizationId: pc.formalization_id,
      record,
      submissionSource: lean?.source ?? "",
      submittedBy: `contributor:${pc.claimant_id}`,
      prizeClaimId: pc.id,
      costMicroUsd: cost,
    });
    leanCheckId = row.id;
  }
  if (record.verdict === "accepted") {
    const moved = await withTransaction(async (tx) => {
      const m = await transitionPrizeClaim(tx, pc.id, "checking", "checked", {
        actor: "prize_check_pipeline",
        reason: "the checker accepted the submission: every gate passed",
        set: { leanCheckId },
      });
      if (!m) return false;
      // `pending` for the Reviewer, claimed at once: the ordinary pipeline
      // and its recovery sweep skip claim_prize, and the stamp is belt and
      // braces against a second Reviewer attributed to the contributor.
      await tx.query(
        `UPDATE contributions SET review_status = 'pending', review_claimed_at = now(), review_attempts = review_attempts + 1 WHERE id = $1`,
        [pc.contribution_id]
      );
      await setBountyStatus(tx, pc.bounty_id, "open", "claim_pending", `prize claim ${pc.id} passed the checker; the gate closes to new filings`);
      return true;
    });
    if (!moved) return { status: "processed", prizeClaimId: pc.id, verdict: "accepted", outcome: "moved" };
    const after = await reviewAndInvoke(pc, opts);
    return { status: "processed", prizeClaimId: pc.id, verdict: "accepted", outcome: after };
  }
  if (record.verdict === "rejected") {
    const gate = record.failed_gate ?? "unknown";
    const detail = record.failed_gate ? record.checks?.[record.failed_gate]?.detail : "";
    await rejectAtCheck(pc, leanCheckId, `rejected at the ${gate} gate${detail ? `: ${detail}` : ""}`);
    return { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: "rejected" };
  }
  const requeued = await handleCheckError(pc, record.error_reason ?? "the checker could not decide");
  return {
    status: "processed",
    prizeClaimId: pc.id,
    verdict: "error",
    outcome: requeued ? "requeued" : "error",
    error: record.error_reason ?? undefined,
  };
}

/**
 * The Reviewer inside the current usage context, attributed to the reserve
 * and never to the claimant; then the Steward when the Reviewer admitted.
 * Returns the prize claim's status afterwards.
 */
async function reviewAndInvoke(pc: PrizeClaimRow, opts: PrizeCheckTickOptions): Promise<string> {
  try {
    await runContributionReview({ contributionId: pc.contribution_id, ...(opts.model ? { model: opts.model } : {}) });
  } catch (err) {
    console.error("[prize-check] reviewer run failed:", err instanceof Error ? err.message : err);
  }
  const after = await getPrizeClaimById(pc.id);
  if (after?.status === "in_review") {
    await runStewardOnAdmitted(pc.id, { model: opts.model }).catch((err) =>
      console.error("[prize-check] steward invocation failed:", err instanceof Error ? err.message : err)
    );
  }
  return (await getPrizeClaimById(pc.id))?.status ?? after?.status ?? "checked";
}

/** rejected at stage check: the gate summary on the record, the cooldown started, no reputation event. */
async function rejectAtCheck(pc: PrizeClaimRow, leanCheckId: string | null, summary: string): Promise<void> {
  inFlightChecks.delete(pc.id);
  await withTransaction(async (tx) => {
    const moved = await transitionPrizeClaim(tx, pc.id, "checking", "rejected", {
      actor: "prize_check_pipeline",
      reason: `the checker rejected the submission: ${summary}`,
      set: { rejectedStage: "check", leanCheckId },
    });
    if (!moved) return;
    await tx.query(`UPDATE contributions SET review_status = 'rejected' WHERE id = $1`, [pc.contribution_id]);
    await reopenBountyAfterClaimClosed(tx, pc.bounty_id);
  });
}

/**
 * error: requeue up to the attempt cap (returns true), then check_error
 * holds the statement's queue (returns false).
 */
async function handleCheckError(pc: PrizeClaimRow, message: string): Promise<boolean> {
  const config = loadConfig();
  inFlightChecks.delete(pc.id);
  const current = await getPrizeClaimById(pc.id);
  if (!current || current.status !== "checking") return false;
  if (current.check_attempts < config.prizeCheckMaxAttempts) {
    await transitionPrizeClaim(asRunner(), pc.id, "checking", "queued", {
      actor: "prize_check_pipeline",
      reason: `the checker returned an error (${message}); attempt ${current.check_attempts} of ${config.prizeCheckMaxAttempts}, requeued`,
    });
    return true;
  }
  await transitionPrizeClaim(asRunner(), pc.id, "checking", "check_error", {
    actor: "prize_check_pipeline",
    reason: `the checker failed ${current.check_attempts} times (${message}); the statement's queue is held for an operator`,
  });
  await requestAudit({
    auditType: "anomaly_investigation",
    triggeredBy: "prize_check_error",
    dedupeKey: `prize_check_error:${pc.id}`,
    context:
      `Prize claim ${pc.id} on claim ${pc.claim_id} hit ${current.check_attempts} checker errors (${message}). ` +
      `The statement's queue is held. Investigate whether the checker, the pin, or the submission is at fault; an operator resolves it from GET /operator/prizes.`,
  }).catch(() => null);
  return false;
}

/** An operator releases a check_error hold: back to queued for another try. */
export async function retryCheckError(prizeClaimId: string, actor: string): Promise<boolean> {
  const moved = await transitionPrizeClaim(asRunner(), prizeClaimId, "check_error", "queued", {
    actor,
    reason: "the operator released the check_error hold; requeued",
    set: { checkAttemptsDelta: -1 },
  });
  if (moved) {
    await rawQuery(`UPDATE prize_claims SET check_attempts = GREATEST(check_attempts, 0) WHERE id = $1`, [prizeClaimId]);
  }
  return moved !== null;
}

// ---------------------------------------------------------------------------
// The sweeps: no dead ends on the prize path
// ---------------------------------------------------------------------------

/**
 * A `checked` claim whose Reviewer run never concluded (a crash, a thrown
 * run) is reviewed again under the reserve, on the ordinary pipeline's
 * reclaim window and attempt cap; the ordinary pipeline itself skips
 * claim_prize, so nobody else will.
 */
export async function recoverPendingPrizeReview(opts: PrizeCheckTickOptions = {}): Promise<PrizeCheckResult | null> {
  const [row] = await rawQuery<{ id: string; contribution_id: string }>(
    `SELECT pc.id, pc.contribution_id FROM prize_claims pc
       JOIN contributions c ON c.id = pc.contribution_id
      WHERE pc.status = 'checked' AND c.contribution_type = 'claim_prize' AND c.review_status = 'pending'
        AND (c.review_claimed_at IS NULL OR c.review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
        AND c.review_attempts < ${MAX_REVIEW_ATTEMPTS}
      ORDER BY pc.updated_at ASC
      LIMIT 1`
  );
  if (!row) return null;
  const claimed = await rawQuery<{ id: string }>(
    `UPDATE contributions SET review_claimed_at = now(), review_attempts = review_attempts + 1
      WHERE id = $1 AND review_status = 'pending'
        AND (review_claimed_at IS NULL OR review_claimed_at < now() - interval '${REVIEW_RECLAIM_MINUTES} minutes')
      RETURNING id`,
    [row.contribution_id]
  );
  if (claimed.length === 0) return null;
  const pc = await getPrizeClaimById(row.id);
  if (!pc || pc.status !== "checked") return null;
  const actionId = await findReviewAction(pc.id);
  const ctx = await reviewContext(pc);
  let after = "checked";
  const { billedMicroUsd } = await runWithUsageContext(
    { jobId: ctx.jobId, userId: ctx.userId, claimId: ctx.claimId, agent: "prize_check" },
    () =>
      withCostMeter(async () => {
        after = await reviewAndInvoke(pc, opts);
      })
  );
  if (after !== "checked") await settleAction(actionId, billedMicroUsd, ctx.jobId);
  return { status: "processed", prizeClaimId: pc.id, verdict: "review_recovered", outcome: after };
}

/**
 * The Audit agent's send-back returned the claim to `in_review` (§8.5);
 * the Steward is re-invoked on `prize_claim` for a fresh decision with a
 * new decision id, and so a new audit. The send-back mark is cleared first,
 * so a run that ends without a decision is picked up by the 24-hour sweep
 * rather than re-invoked every tick.
 */
export async function reinvokeSentBackClaim(opts: PrizeCheckTickOptions = {}): Promise<PrizeCheckResult | null> {
  const [row] = await rawQuery<{ id: string; claim_id: string }>(
    `SELECT id, claim_id FROM prize_claims
      WHERE status = 'in_review' AND audit_outcome = 'send_back'
      ORDER BY updated_at ASC
      LIMIT 1`
  );
  if (!row) return null;
  const [note] = await rawQuery<{ reasoning: string }>(
    `SELECT reasoning FROM audit_log
      WHERE claim_id = $1 AND action = 'prize_claim:audit_send_back' AND reasoning LIKE $2
      ORDER BY created_at DESC LIMIT 1`,
    [row.claim_id, `prize claim ${row.id}:%`]
  );
  const updated = await updatePrizeClaimFields(asRunner(), row.id, { auditOutcome: null }, {
    actor: "prize_check_pipeline",
    reason: "the audit sent the acceptance back; the Steward is re-invoked on prize_claim for a fresh decision",
    action: "steward_reinvoked",
  });
  if (!updated || updated.status !== "in_review") return null;
  const why = note?.reasoning ? note.reasoning.replace(/^prize claim [^:]+:\s*/, "") : "the audit sent the previous acceptance back";
  let after = "in_review";
  try {
    await runStewardOnAdmitted(row.id, {
      model: opts.model,
      context:
        `prize claim ${row.id}: the Audit agent sent the previous acceptance back (${why.slice(0, 600)}). ` +
        `Read the record with get_prize_claim, judge fidelity afresh, and decide again with decide_prize_claim; a new decision opens a new window and a new audit.`,
    });
  } catch (err) {
    console.error("[prize-check] steward re-invocation after send-back failed:", err instanceof Error ? err.message : err);
  }
  after = (await getPrizeClaimById(row.id))?.status ?? after;
  return { status: "processed", prizeClaimId: row.id, verdict: "send_back", outcome: after };
}

/**
 * An `in_review` claim with no Steward decision for IN_REVIEW_REINVOKE_HOURS
 * is re-invoked, at most once per claim per window: the re-invocation's
 * audit row bumps `updated_at`, which is what the sweep keys on. One per
 * tick.
 */
export async function reinvokeStaleInReviewClaim(opts: PrizeCheckTickOptions = {}): Promise<PrizeCheckResult | null> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM prize_claims
      WHERE status = 'in_review' AND steward_decision IS NULL
        AND audit_outcome IS DISTINCT FROM 'send_back'
        AND updated_at < now() - interval '${IN_REVIEW_REINVOKE_HOURS} hours'
      ORDER BY updated_at ASC
      LIMIT 1`
  );
  if (!row) return null;
  const updated = await updatePrizeClaimFields(asRunner(), row.id, {}, {
    actor: "prize_check_pipeline",
    reason: `in_review for over ${IN_REVIEW_REINVOKE_HOURS} hours without a Steward decision; re-invoked on prize_claim`,
    action: "steward_reinvoked",
  });
  if (!updated || updated.status !== "in_review") return null;
  let after = "in_review";
  try {
    await runStewardOnAdmitted(row.id, {
      model: opts.model,
      context:
        `prize claim ${row.id}: admitted by the Reviewer over ${IN_REVIEW_REINVOKE_HOURS} hours ago and still undecided. ` +
        `Read the record with get_prize_claim, judge fidelity, and decide with decide_prize_claim.`,
    });
  } catch (err) {
    console.error("[prize-check] steward re-invocation on a stale in_review claim failed:", err instanceof Error ? err.message : err);
  }
  after = (await getPrizeClaimById(row.id))?.status ?? after;
  return { status: "processed", prizeClaimId: row.id, verdict: "in_review_stale", outcome: after };
}

/** Drain every runnable prize check (bounded); for workers and tests. */
export async function drainPrizeChecks(opts: PrizeCheckTickOptions & { maxTasks?: number } = {}): Promise<{ processed: number }> {
  const cap = opts.maxTasks ?? 10;
  let processed = 0;
  while (processed < cap) {
    const r = await processNextPrizeCheck(opts);
    if (r.status !== "processed" && r.status !== "submitted") break;
    processed++;
  }
  return { processed };
}

export { LeanCheckerUnavailable, getBountyById };
