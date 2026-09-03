/**
 * The prize-check worker (docs/mathematics.md §8.4, §8.6): the executor of
 * `prize_review` actions.
 *
 * The check runs first, before any agent, as a DB-backed job: a prize check
 * may run fifteen minutes, which is the pipeline's crash-reclaim window, and
 * a strong-model run held idle for the check would be lost with the
 * process. Each pass claims the oldest `queued` prize claim per statement
 * version whose statement has no other claim in checking, check_error,
 * checked, in_review, or in_challenge_window (strict per-statement
 * serialization) with FOR UPDATE SKIP LOCKED, under the global concurrency
 * cap and the per-day check budget; refuses a source whose hash matches an
 * attempt-mode check as a copy of the platform's own work; submits to the
 * checker in `prize` mode; polls; meters the check; records the lean_checks
 * row; and applies the transitions. An accepted check runs the Contribution
 * Reviewer inside a usage context whose job is the bounty's reserve, and,
 * when the Reviewer admits, invokes the Steward directly on `prize_claim`.
 * A checker error requeues up to PRIZE_CHECK_MAX_ATTEMPTS, then check_error
 * holds the statement's queue for an operator.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  getLeanCheckerClient,
  leanUsageCostMicroUsd,
  leanUsageModel,
  waitForCheck,
  LeanCheckerUnavailable,
  type CheckRecord,
  type LeanCheckerClient,
} from "../services/lean-checker-client.js";
import { meterExternalUsage } from "../services/usage-service.js";
import { getUsageContext, runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { runContributionReview } from "../llm/agents/contribution-reviewer.js";
import { recordLeanCheck } from "../services/formalization-service.js";
import { claimAction, completeAction } from "../services/action-service.js";
import { requestAudit } from "../services/queue-service.js";
import { invokeStewardDirect } from "./steward-direct.js";
import {
  getPrizeClaimById,
  transitionPrizeClaim,
  admitPrizeClaim,
  reopenBountyAfterClaimClosed,
  QUEUE_HOLDING_STATUSES,
  type PrizeClaimRow,
} from "../services/prize-claim-service.js";
import { getLeanSourceForContribution } from "../services/attachment-service.js";
import { getBountyById, getReserveJob, getPlatformAccountId, setBountyStatus } from "../services/bounty-service.js";
import { asRunner } from "../services/prize-pool-service.js";

export type PrizeCheckStatus =
  | "processed"
  | "empty"
  | "capped"
  | "no_checker";

export interface PrizeCheckResult {
  status: PrizeCheckStatus;
  prizeClaimId?: string;
  verdict?: string;
  outcome?: string;
  error?: string;
}

/** The reclaim sweep: `checking` rows older than the window return to `queued`. */
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
    const pc = await getPrizeClaimById(row.id);
    if (pc) {
      await rawQuery(
        `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, 'prize_claim:queued', $2, 'prize_check_pipeline')`,
        [pc.claim_id, `prize claim ${pc.id}: check reclaimed after ${config.prizeCheckReclaimMinutes} minutes without a result`]
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
export async function runStewardOnAdmitted(prizeClaimId: string, opts: { model?: string } = {}): Promise<number> {
  const pc = await getPrizeClaimById(prizeClaimId);
  if (!pc || pc.status !== "in_review") return 0;
  const ctx = await reviewContext(pc);
  const { billedMicroUsd } = await invokeStewardDirect({
    trigger: "prize_claim",
    claimId: pc.claim_id,
    context: `prize claim ${pc.id}: the checker accepted a ${pc.direction} and the Reviewer admitted it; judge fidelity with get_prize_claim and decide with decide_prize_claim.`,
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

/**
 * Run one prize check end to end: claim, check, record, transition, and
 * (on acceptance) the Reviewer and the Steward under the reserve job.
 */
export async function processNextPrizeCheck(opts: {
  client?: LeanCheckerClient | null;
  pollMs?: number;
  model?: string;
} = {}): Promise<PrizeCheckResult> {
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
  const capacity = await prizeCheckCapacity();
  if (!capacity.ok) return { status: "capped", error: capacity.reason };
  const pc = await claimNextQueuedPrizeClaim();
  if (!pc) return { status: "empty" };

  const actionId = await findReviewAction(pc.id);
  if (actionId) await claimAction(actionId).catch(() => false);
  const ctx = await reviewContext(pc);
  let outcome: PrizeCheckResult = { status: "processed", prizeClaimId: pc.id };
  const { billedMicroUsd } = await runWithUsageContext(
    { jobId: ctx.jobId, userId: ctx.userId, claimId: ctx.claimId, agent: "prize_check" },
    () =>
      withCostMeter(async () => {
        outcome = await runCheckAndTransitions(pc, client, { pollMs: opts.pollMs, model: opts.model });
      })
  );
  if (actionId) {
    await completeAction(actionId, billedMicroUsd, { meteredJobId: ctx.jobId ?? null }).catch((err) =>
      console.error(`[prize-check] completeAction failed for ${actionId}: ${err instanceof Error ? err.message : err}`)
    );
  }
  return outcome;
}

async function runCheckAndTransitions(
  pc: PrizeClaimRow,
  client: LeanCheckerClient,
  opts: { pollMs?: number; model?: string }
): Promise<PrizeCheckResult> {
  const config = loadConfig();
  const lean = await getLeanSourceForContribution(pc.contribution_id);
  const [f] = await rawQuery<{ statement_source: string; pin_id: string }>(
    `SELECT statement_source, pin_id FROM claim_formalizations WHERE id = $1`,
    [pc.formalization_id]
  );
  if (!lean || !f) {
    await rejectAtCheck(pc, null, "the submission carries no Lean source or its statement is gone");
    return { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: "rejected" };
  }
  // A submission matching an attempt-mode check is a copy of the platform's
  // own work: rejected at stage check before any submission (§8.1).
  if (await matchesAttemptCheck(lean.sha256)) {
    await rejectAtCheck(pc, null, "the source matches a proof the platform's own solver produced; a copy of the platform's work is not eligible");
    return { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: "copy_of_attempt" };
  }

  let record: CheckRecord;
  try {
    const submitted = await client.submitCheck({
      mode: "prize",
      kind: pc.direction,
      statement_source: f.statement_source,
      submission_source: lean.source,
      replay: "module",
    });
    record = submitted.status === "done" ? submitted : await waitForCheck(client, submitted.check_id, { pollMs: opts.pollMs });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await handleCheckError(pc, msg);
    return { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: msg };
  }
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
    const row = await recordLeanCheck({
      formalizationId: pc.formalization_id,
      record,
      submissionSource: lean.source,
      submittedBy: `contributor:${pc.claimant_id}`,
      prizeClaimId: pc.id,
      costMicroUsd: cost,
    });
    leanCheckId = row.id;
  }
  if (record.verdict === "accepted") {
    await withTransaction(async (tx) => {
      const moved = await transitionPrizeClaim(tx, pc.id, "checking", "checked", {
        actor: "prize_check_pipeline",
        reason: "the checker accepted the submission: every gate passed",
        set: { leanCheckId },
      });
      if (!moved) return;
      await tx.query(`UPDATE contributions SET review_status = 'pending' WHERE id = $1`, [pc.contribution_id]);
      await setBountyStatus(tx, pc.bounty_id, "open", "claim_pending", `prize claim ${pc.id} passed the checker; the gate closes to new filings`);
    });
    // The Reviewer runs inside this usage context, attributed to the
    // reserve, never to the claimant.
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
    return { status: "processed", prizeClaimId: pc.id, verdict: "accepted", outcome: after?.status ?? "checked" };
  }
  if (record.verdict === "rejected") {
    const gate = record.failed_gate ?? "unknown";
    const detail = record.failed_gate ? record.checks?.[record.failed_gate]?.detail : "";
    await rejectAtCheck(pc, leanCheckId, `rejected at the ${gate} gate${detail ? `: ${detail}` : ""}`);
    return { status: "processed", prizeClaimId: pc.id, verdict: "rejected", outcome: "rejected" };
  }
  await handleCheckError(pc, record.error_reason ?? "the checker could not decide");
  return { status: "processed", prizeClaimId: pc.id, verdict: "error", outcome: "error", error: record.error_reason ?? undefined };
}

/** rejected at stage check: the gate summary on the record, the cooldown started, no reputation event. */
async function rejectAtCheck(pc: PrizeClaimRow, leanCheckId: string | null, summary: string): Promise<void> {
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

/** error: requeue up to the attempt cap, then check_error holds the statement's queue. */
async function handleCheckError(pc: PrizeClaimRow, message: string): Promise<void> {
  const config = loadConfig();
  const current = await getPrizeClaimById(pc.id);
  if (!current || current.status !== "checking") return;
  if (current.check_attempts < config.prizeCheckMaxAttempts) {
    await transitionPrizeClaim(asRunner(), pc.id, "checking", "queued", {
      actor: "prize_check_pipeline",
      reason: `the checker returned an error (${message}); attempt ${current.check_attempts} of ${config.prizeCheckMaxAttempts}, requeued`,
    });
    return;
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

/** Drain every runnable prize check (bounded); for workers and tests. */
export async function drainPrizeChecks(opts: { maxTasks?: number; client?: LeanCheckerClient | null; pollMs?: number; model?: string } = {}): Promise<{ processed: number }> {
  const cap = opts.maxTasks ?? 10;
  let processed = 0;
  while (processed < cap) {
    const r = await processNextPrizeCheck(opts);
    if (r.status !== "processed") break;
    processed++;
  }
  return { processed };
}

export { LeanCheckerUnavailable, getBountyById };
