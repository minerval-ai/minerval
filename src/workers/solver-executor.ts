/**
 * The solver executor (docs/mathematics.md §7.9): the drain over the action
 * ledger's `attempt_proof` kind, run as its own process (`npm run
 * worker:solver`) so an hours-long attempt never stalls the local runner's
 * other lanes.
 *
 * Same posture as the steward and engine executors: a dumb loop over
 * covered rows, no selection judgment of its own. Per tick: the solver
 * breaker, the ledger's next covered `attempt_proof` action, the claim and
 * its published statement and prior attempts, the largest funder, the
 * attempt row, the run under a usage context whose job is the funding job,
 * the action completed with the metered amount, and then the Steward
 * invoked directly on `attempt_completed` under the same job (§6.4), never
 * through the queue.
 *
 * Money spent must reach the escrow: a transient failure before any spend
 * releases the action; after spend the action completes with the metered
 * amount and the attempt records `failed` or `budget`. The formalization is
 * re-read at report time and the attempt marked `stale_formalization` if it
 * changed under the run. The loop exits when SOLVER_ENABLED is false.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { rawQuery, closeDb } from "../db/client.js";
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { runMathSolver, type MathSolverResult } from "../llm/agents/math-solver.js";
import {
  checkSolverBudget,
  SolverFailureBreaker,
} from "../llm/solver-budget.js";
import {
  claimAction,
  completeAction,
  largestActionFunder,
  nextRunnableAction,
  releaseAction,
  type RunnableAction,
} from "../services/action-service.js";
import {
  closeAttempt,
  effortForVariant,
  findAttemptPlanItem,
  getFormalization,
  getPublishedFormalization,
  listPriorAttempts,
  openAttempt,
  parseAttemptGroup,
  publishAttempt,
  sweepOrphanedAttempts,
  type AttemptRow,
  type CloseStatus,
  type FormalizationRow,
} from "../services/attempt-service.js";
import { invokeStewardDirect } from "./steward-direct.js";
import { assertSkillToolsRegistered } from "../llm/tools/skill-tools.js";

export type SolverDrainStatus =
  | "processed"
  | "empty"
  | "budget"
  | "transient"
  | "disabled"
  | "skipped";

export interface SolverProcessResult {
  status: SolverDrainStatus;
  actionId?: string;
  attemptId?: string;
  claimId?: string;
  attemptStatus?: string;
  outcome?: string | null;
  billedMicroUsd?: number;
  ok?: boolean;
  error?: string;
}

interface Logger {
  info: (...a: unknown[]) => void;
  warn: (...a: unknown[]) => void;
  error: (...a: unknown[]) => void;
}

const consoleLogger: Logger = {
  info: (...a) => console.log("[solver]", ...a),
  warn: (...a) => console.warn("[solver]", ...a),
  error: (...a) => console.error("[solver]", ...a),
};

/** Release the action with a note in the log; the next pass decides again. */
async function refuse(action: RunnableAction, note: string, logger: Logger): Promise<void> {
  logger.warn(`releasing action ${action.id} (${action.exclusion_group}): ${note}`);
  await releaseAction(action.id).catch(() => {});
}

/** One line for the Steward's context (§7.6): the attempt id, the outcome, and what happened. */
export function stewardContextLine(attempt: AttemptRow): string {
  const outcome = attempt.outcome ?? "none";
  const report = (attempt.report ?? {}) as Record<string, unknown>;
  const validation = report.validation as Record<string, unknown> | undefined;
  let line: string;
  switch (attempt.status) {
    case "completed":
      line =
        outcome === "proof" || outcome === "disproof"
          ? `the solver reports a checked ${outcome} (lean_check ${attempt.lean_check_id ?? "?"})`
          : validation?.downgraded_from
            ? `the solver claimed a ${String(validation.downgraded_from)} the harness downgraded to ${outcome}: ${String(validation.reason ?? "")}`
            : outcome === "none"
              ? "the solver ended without a report"
              : `the solver reports a ${outcome} result`;
      break;
    case "refused":
      line = "the model refused the attempt";
      break;
    case "budget":
      line = "the attempt reached its cost ceiling without a report";
      break;
    case "cancelled":
      line = "the attempt was halted by the operator";
      break;
    case "stale_formalization":
      line = "the formal statement changed while the attempt ran; the result does not bind";
      break;
    case "failed":
      line = `the attempt failed: ${attempt.error ?? "unknown error"}`;
      break;
    default:
      line = `the attempt closed as ${attempt.status}`;
  }
  return (
    `proof attempt ${attempt.id} closed as ${attempt.status} (variant ${attempt.variant}, ` +
    `outcome ${outcome}, ${(attempt.spent_micro_usd / 1_000_000).toFixed(2)} USD, ` +
    `${attempt.turns} turns): ${line}. Fetch it with get_proof_attempt.`
  );
}

/**
 * Take the next covered `attempt_proof` action, if any, and run it to a
 * closed attempt. Exposed for tests and for a harness; the process loop
 * below calls it on an interval.
 */
export async function processNextSolverAction(
  opts: { logger?: Logger; model?: string } = {}
): Promise<SolverProcessResult> {
  const logger = opts.logger ?? consoleLogger;
  const config = loadConfig();
  if (!config.solverEnabled) return { status: "disabled" };

  try {
    await checkSolverBudget();
  } catch (err) {
    if (err instanceof LlmBudgetExceededError) return { status: "budget", error: err.message };
    throw err;
  }

  // A dead worker's attempt closes as orphaned before its reopened action
  // is served again, or the one-running-attempt rule would refuse it.
  const orphaned = await sweepOrphanedAttempts().catch(() => [] as string[]);
  for (const id of orphaned) logger.warn(`attempt ${id} had no heartbeat; marked orphaned`);

  const action = await nextRunnableAction(["attempt_proof"]);
  if (!action) return { status: "empty" };
  if (!action.claim_id) {
    await refuse(action, "attempt_proof action carries no claim_id", logger);
    return { status: "skipped", actionId: action.id };
  }
  if (!(await claimAction(action.id))) return { status: "empty" };

  // The claim and its published statement. The group names the statement;
  // a group that does not is served the claim's current published one.
  const [claim] = await rawQuery<{ id: string; text: string; state: string }>(
    `SELECT id, text, state FROM claims WHERE id = $1`,
    [action.claim_id]
  );
  if (!claim || claim.state !== "active") {
    await refuse(action, `claim ${action.claim_id} is ${claim?.state ?? "missing"}`, logger);
    return { status: "skipped", actionId: action.id, claimId: action.claim_id };
  }
  const group = parseAttemptGroup(action.exclusion_group);
  const formalization: FormalizationRow | null = group
    ? await getFormalization(group.formalizationId)
    : await getPublishedFormalization(claim.id);
  if (!formalization || formalization.status !== "published") {
    await refuse(
      action,
      `formalization ${formalization?.id ?? group?.formalizationId ?? "(none)"} is ` +
        `${formalization?.status ?? "missing"}, not published`,
      logger
    );
    return { status: "skipped", actionId: action.id, claimId: claim.id };
  }
  if (formalization.claim_id !== claim.id) {
    await refuse(action, `formalization ${formalization.id} belongs to another claim`, logger);
    return { status: "skipped", actionId: action.id, claimId: claim.id };
  }

  const funder = await largestActionFunder(action.id).catch(() => ({}) as { jobId?: string; userId?: string; grantId?: string });
  const planItem = await findAttemptPlanItem(funder.grantId, claim.id);
  const isCalibration = planItem?.is_calibration === true;
  if (isCalibration) {
    try {
      await checkSolverBudget({ calibration: true });
    } catch (err) {
      if (err instanceof LlmBudgetExceededError) {
        await refuse(action, `calibration cap reached: ${err.message}`, logger);
        return { status: "budget", actionId: action.id, claimId: claim.id, error: err.message };
      }
      throw err;
    }
  }

  const opened = await openAttempt({
    action,
    claimId: claim.id,
    formalization,
    grantId: funder.grantId ?? null,
    jobId: funder.jobId ?? null,
    model: opts.model,
    planItem,
  });
  if (!opened.ok) {
    await refuse(action, `${opened.code}: ${opened.message}`, logger);
    return { status: "skipped", actionId: action.id, claimId: claim.id, error: opened.message };
  }
  const attempt = opened.attempt;
  const priorAttempts = await listPriorAttempts(formalization.id, attempt.id);
  logger.info(
    `attempt ${attempt.id} opened on claim ${claim.id} (variant ${attempt.variant}, ` +
      `ceiling ${(attempt.ceiling_micro_usd / 1_000_000).toFixed(2)} USD` +
      `${isCalibration ? ", calibration" : ""})`
  );

  let billedMicroUsd = 0;
  let result: MathSolverResult | null = null;
  let failure: unknown = null;
  try {
    const metered = await runWithUsageContext(
      {
        ...(funder.userId ? { userId: funder.userId } : {}),
        ...(funder.jobId ? { jobId: funder.jobId } : {}),
        claimId: claim.id,
      },
      () =>
        withCostMeter(() =>
          runMathSolver({
            attempt,
            claim: { id: claim.id, text: claim.text },
            formalization,
            priorAttempts: priorAttempts.map((p) => ({
              id: p.id,
              variant: p.variant,
              effort: p.effort,
              status: p.status,
              outcome: p.outcome,
              finishedAt: p.finished_at ? p.finished_at.toISOString() : null,
              report: p.report,
              notebook: p.notebook,
            })),
            variant: attempt.variant,
            effort: effortForVariant(attempt.variant),
            ceilingMicroUsd: attempt.ceiling_micro_usd,
            model: opts.model ?? attempt.model,
          })
        )
    );
    billedMicroUsd = metered.billedMicroUsd;
    result = metered.value;
  } catch (err) {
    failure = err;
    // Whatever the meter saw before the failure is real spend.
    billedMicroUsd = await spentSoFar(attempt.id);
  }

  // A failure before any spend is not the attempt's fault: the action goes
  // back to open and the attempt row records why it went nowhere.
  if (failure && billedMicroUsd <= 0 && (failure instanceof LlmBudgetExceededError || isTransientApiError(failure))) {
    const msg = failure instanceof Error ? failure.message : String(failure);
    await closeAttempt(attempt.id, {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "failed",
      outcome: null,
      error: msg,
      spentMicroUsd: 0,
    });
    await releaseAction(action.id).catch(() => {});
    logger.warn(`attempt ${attempt.id} failed before any spend; action released: ${msg}`);
    return {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "transient",
      actionId: action.id,
      attemptId: attempt.id,
      claimId: claim.id,
      ok: false,
      error: msg,
    };
  }

  // Close the attempt. The formalization is re-read first: a statement that
  // changed under the run makes the result stale whatever it says.
  const fresh = await getFormalization(formalization.id);
  const stale =
    !fresh || fresh.status !== "published" || fresh.source_hash !== formalization.source_hash;

  let close: { status: CloseStatus; outcome: string | null; error: string | null };
  if (failure) {
    const msg = failure instanceof Error ? failure.message : String(failure);
    close = {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "failed",
      outcome: null,
      error: msg,
    };
  } else if (stale) {
    close = {
      status: "stale_formalization",
      outcome: result!.outcome,
      error: `the formalization changed during the attempt (${fresh?.status ?? "missing"})`,
    };
  } else {
    close = { status: result!.status, outcome: result!.outcome, error: result!.error };
  }

  const closed = await closeAttempt(attempt.id, {
    status: close.status,
    outcome: close.outcome as AttemptRow["outcome"],
    report: result?.report ?? null,
    leanProof: result?.leanProof ?? null,
    // A stale statement never moves a bounty: the check does not bind.
    leanCheckId: stale ? null : (result?.leanCheckId ?? null),
    error: close.error,
    spentMicroUsd: billedMicroUsd,
    turns: result?.turns,
    servedModels: result?.servedModels,
  });
  const closedAttempt = closed?.attempt ?? attempt;

  await completeAction(action.id, billedMicroUsd, {
    meteredJobId: funder.jobId ?? null,
  }).catch((err) =>
    logger.error(
      `completeAction failed for ${action.id} (allocation consumption missed; ` +
        `reconciliation needed): ${err instanceof Error ? err.message : err}`
    )
  );
  logger.info(
    `attempt ${attempt.id} closed as ${closedAttempt.status} (outcome ` +
      `${closedAttempt.outcome ?? "none"}, ${(billedMicroUsd / 1_000_000).toFixed(2)} USD)` +
      (closed?.bountyMoved ? `; bounty ${closed.bountyMoved} is house_result_pending` : "")
  );

  // The Steward, directly and on the strong tier, under the same job. Then
  // publication, which refuses while a house_result_pending bounty waits.
  let stewardError: string | undefined;
  try {
    await invokeStewardDirect({
      trigger: "attempt_completed",
      claimId: claim.id,
      context: stewardContextLine(closedAttempt),
      ...(funder.jobId ? { jobId: funder.jobId } : {}),
      ...(funder.userId ? { userId: funder.userId } : {}),
    });
  } catch (err) {
    stewardError = err instanceof Error ? err.message : String(err);
    logger.error(`Steward attempt_completed failed for attempt ${attempt.id}: ${stewardError}`);
  }
  if (!stewardError) {
    await publishAttempt(attempt.id).catch((err) =>
      logger.error(`publishAttempt failed for ${attempt.id}: ${err instanceof Error ? err.message : err}`)
    );
  }

  const transient = !!failure && isTransientApiError(failure) && !(failure instanceof LlmBudgetExceededError);
  return {
    status: failure ? (failure instanceof LlmBudgetExceededError ? "budget" : transient ? "transient" : "processed") : "processed",
    actionId: action.id,
    attemptId: attempt.id,
    claimId: claim.id,
    attemptStatus: closedAttempt.status,
    outcome: closedAttempt.outcome,
    billedMicroUsd,
    ok: !failure && close.status === "completed",
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
    ...(stewardError ? { error: `steward: ${stewardError}` } : {}),
  };
}

/** The attempt's metered spend so far, as its own heartbeat recorded it. */
async function spentSoFar(attemptId: string): Promise<number> {
  const [row] = await rawQuery<{ spent: number | string | null }>(
    `SELECT spent_micro_usd::bigint AS spent FROM proof_attempts WHERE id = $1`,
    [attemptId]
  );
  return Number(row?.spent ?? 0);
}

export interface SolverWorkerOptions {
  logger?: Logger;
  /** Pause between ticks that found nothing to do or were told to rest. */
  idleMs?: number;
  /** Pause after a budget or breaker stop. */
  restMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Test seam: stop after this many ticks. */
  maxTicks?: number;
}

/**
 * The process loop: tick until SOLVER_ENABLED is false. A daily-cap stop
 * rests for `restMs`; a run of transient failures trips the breaker and
 * rests the same way; an empty ledger polls at `idleMs`.
 */
export async function runSolverWorker(opts: SolverWorkerOptions = {}): Promise<{ ticks: number }> {
  const logger = opts.logger ?? consoleLogger;
  const idleMs = opts.idleMs ?? 30_000;
  const restMs = opts.restMs ?? 10 * 60_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const breaker = new SolverFailureBreaker();
  let ticks = 0;
  for (;;) {
    if (opts.maxTicks !== undefined && ticks >= opts.maxTicks) return { ticks };
    ticks++;
    let r: SolverProcessResult;
    try {
      r = await processNextSolverAction({ logger });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTransientApiError(err) || err instanceof LlmBudgetExceededError) {
        logger.warn(`transient failure: ${msg}`);
        if (breaker.recordFailure()) {
          logger.error(`${breaker.failures} consecutive transient failures; resting`);
          breaker.reset();
          await sleep(restMs);
        } else {
          await sleep(idleMs);
        }
        continue;
      }
      logger.error(`tick failed: ${msg}`);
      await sleep(idleMs);
      continue;
    }
    if (r.status === "disabled") {
      logger.info("SOLVER_ENABLED is false; exiting the loop");
      return { ticks };
    }
    if (r.status === "transient") {
      if (breaker.recordFailure()) {
        logger.error(`${breaker.failures} consecutive transient failures; resting`);
        breaker.reset();
        await sleep(restMs);
      } else {
        await sleep(idleMs);
      }
      continue;
    }
    breaker.reset();
    if (r.status === "budget") {
      logger.warn(`solver budget stop: ${r.error ?? "daily cap"}; resting`);
      await sleep(restMs);
      continue;
    }
    if (r.status === "empty" || r.status === "skipped") {
      await sleep(idleMs);
      continue;
    }
    // processed: look again at once.
  }
}

const invokedDirectly =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (invokedDirectly) {
  (async () => {
    await import("dotenv/config");
    assertSkillToolsRegistered();
    const config = loadConfig();
    if (!config.solverEnabled) {
      console.log("[solver] SOLVER_ENABLED is false; nothing to do");
      await closeDb();
      process.exit(0);
    }
    const shutdown = async () => {
      console.log("[solver] shutting down");
      await closeDb();
      process.exit(0);
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    await runSolverWorker();
    await closeDb();
    process.exit(0);
  })().catch((err) => {
    console.error("[solver] fatal:", err);
    process.exit(1);
  });
}
