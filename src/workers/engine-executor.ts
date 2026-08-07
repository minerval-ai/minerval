/**
 * The engine executor — the drain over the action ledger's non-steward
 * kinds: grant_planning, ingest, mandate_review.
 *
 * Same posture as the steward executor: a dumb loop over covered rows.
 * Grants fund their own planning, review, and ingest actions from escrow
 * (allocation-service.fundGrantSelfActions), coverage makes them
 * runnable, and this worker runs whatever the ledger says — no selection
 * judgment of its own.
 *
 *  - grant_planning: run the Grantor over the grant's scope, store the
 *    plan, hand it to the funder for approval. Metered, consumed from the
 *    covering allocations on completion.
 *  - mandate_review: run the mandate's Grantmaker in review mode
 *    (llm/agents/mandate-review.ts) — surveying graph and web, writing
 *    the mandate's valuations, growing its plan, moving money. Metered
 *    and consumed the same way.
 *  - ingest: enqueue the source for extraction (the enqueue is this
 *    action's unit of work; the action stays 'running' and is completed
 *    by the extraction worker with the metered cost, so the funders'
 *    pro-rata split follows the real spend).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { runGrantor } from "../llm/agents/grantor.js";
import { runMandateReview } from "../llm/agents/mandate-review.js";
import { submitSource } from "../services/source-service.js";
import { fundGrantSelfActions } from "../services/allocation-service.js";
import {
  claimAction,
  completeAction,
  largestActionFunder,
  nextRunnableAction,
  releaseAction,
  type RunnableAction,
} from "../services/action-service.js";

export type EngineDrainStatus =
  | "processed"
  | "empty"
  | "budget"
  | "transient";

export interface EngineProcessResult {
  status: EngineDrainStatus;
  actionId?: string;
  kind?: string;
  grantId?: string;
  ok?: boolean;
  error?: string;
}

/** Cancel a group whose subject is gone; the ledger must not spin on it. */
async function cancelGroup(exclusionGroup: string): Promise<void> {
  await rawQuery(
    `UPDATE actions SET status = 'cancelled', updated_at = now()
      WHERE exclusion_group = $1 AND status IN ('open', 'running')`,
    [exclusionGroup]
  );
}

/**
 * Run one covered engine action, if any. Calls the self-funding pass
 * first so a freshly opened planning/review/ingest row doesn't wait for
 * the scheduler's sweep to be covered.
 */
export async function processNextEngineAction(
  opts: { model?: string } = {}
): Promise<EngineProcessResult> {
  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }
  await fundGrantSelfActions().catch(() => 0);

  const action = await nextRunnableAction([
    "grant_planning",
    "mandate_review",
    "ingest",
  ]);
  if (!action || !(await claimAction(action.id))) return { status: "empty" };

  if (action.kind === "ingest") return runIngestAction(action);
  return runGrantAgentAction(action, opts);
}

/**
 * grant_planning + mandate_review: an agent run for the grant named in
 * target_ref, metered and consumed against the covering allocations.
 */
async function runGrantAgentAction(
  action: RunnableAction,
  opts: { model?: string }
): Promise<EngineProcessResult> {
  const grantId = action.target_ref ?? "";
  const [grant] = await rawQuery<{
    id: string;
    funder_user_id: string;
    budget_job_id: string;
    name: string;
    scope_claim_id: string | null;
    scope_query: string | null;
    status: string;
    budget_micro_usd: number;
  }>(
    `SELECT g.id, g.funder_user_id, g.budget_job_id, g.name,
            g.scope_claim_id, g.scope_query, g.status, j.budget_micro_usd
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1`,
    [grantId]
  );
  const wantedStatus = action.kind === "grant_planning" ? "planning" : "active";
  if (!grant || grant.status !== wantedStatus) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }

  const config = loadConfig();
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  try {
    let continueRequested = false;
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: grant.funder_user_id, jobId: funder.jobId ?? null },
      () =>
        withCostMeter(async () => {
          if (action.kind === "grant_planning") {
            const plan = await runGrantor({
              grantName: grant.name,
              scopeClaimId: grant.scope_claim_id,
              scopeQuery: grant.scope_query,
              budgetOwls: Math.floor(
                Number(grant.budget_micro_usd) / config.owlCostMicroUsd
              ),
              model: opts.model,
            });
            await rawQuery(
              `UPDATE grants
                  SET plan = $2::jsonb, status = 'pending_approval',
                      plan_cursor = 0, updated_at = now()
                WHERE id = $1 AND status = 'planning'`,
              [grant.id, JSON.stringify(plan)]
            );
          } else {
            const review = await runMandateReview({
              grantId: grant.id,
              model: opts.model,
            });
            continueRequested = review.continueRequested;
          }
        })
    );
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId ?? null,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    if (continueRequested) {
      // The agent judged one pass wasn't enough: reopen its review action
      // so the next drain iteration funds and runs another, bounded by
      // the passes-per-day funding cap (fundGrantSelfActions).
      await rawQuery(
        `UPDATE actions SET status = 'open', updated_at = now()
          WHERE id = $1 AND status = 'done'`,
        [action.id]
      ).catch(() => {});
    }
    return {
      status: "processed",
      actionId: action.id,
      kind: action.kind,
      grantId: grant.id,
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmBudgetExceededError) {
      await releaseAction(action.id).catch(() => {});
      return { status: "budget", actionId: action.id, error: msg };
    }
    if (isTransientApiError(err)) {
      await releaseAction(action.id).catch(() => {});
      return {
        status: "transient",
        actionId: action.id,
        kind: action.kind,
        grantId: grant.id,
        error: msg,
      };
    }
    // Genuine failure: surface it on the grant's budget job and retire
    // the group — the reconcile sweep reopens planning/review actions on
    // its cadence, which is exactly the retry pacing we want (no hot
    // loop on a poison run).
    await rawQuery(
      `UPDATE budget_jobs SET error = $2, updated_at = now() WHERE id = $1`,
      [grant.budget_job_id, msg]
    ).catch(() => {});
    await cancelGroup(action.exclusion_group);
    return {
      status: "processed",
      actionId: action.id,
      kind: action.kind,
      grantId: grant.id,
      ok: false,
      error: msg,
    };
  }
}

/**
 * ingest: enqueue the source for extraction, attributed to the largest
 * funder (whose mandate also records the source in its pipeline). The
 * action stays 'running'; the extraction worker completes it with the
 * metered cost (url-extraction.ts), which is when the funders' pro-rata
 * shares are consumed.
 */
async function runIngestAction(
  action: RunnableAction
): Promise<EngineProcessResult> {
  const url = action.target_ref ?? "";
  if (!url) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  const grantId = funder.grantId;
  const [owner] = grantId
    ? await rawQuery<{ id: string; funder_user_id: string }>(
        `SELECT id, funder_user_id FROM grants WHERE id = $1`,
        [grantId]
      )
    : [];
  try {
    const { sourceId, jobId } = await submitSource(
      { url },
      // meterJobId: a grant-funded ingest meters its extraction to the
      // grant's budget job, so the escrow's llm_usage accounting sees it.
      owner
        ? { userId: owner.funder_user_id, meterJobId: funder.jobId }
        : {}
    );
    if (owner) {
      await rawQuery(
        `INSERT INTO grant_sources (grant_id, source_id, url, job_id)
         VALUES ($1, $2, $3, $4)`,
        [owner.id, sourceId, url, jobId]
      );
    }
    return {
      status: "processed",
      actionId: action.id,
      kind: "ingest",
      grantId: owner?.id,
      ok: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await releaseAction(action.id).catch(() => {});
    return {
      status: "transient",
      actionId: action.id,
      kind: "ingest",
      error: msg,
    };
  }
}

/** Drain every runnable engine action (bounded); for workers and tests. */
export async function drainEngineActions(
  opts: { maxTasks?: number; model?: string } = {}
): Promise<{ processed: number; budgetHit: boolean }> {
  const cap = opts.maxTasks ?? 20;
  let processed = 0;
  while (processed < cap) {
    const r = await processNextEngineAction({ model: opts.model });
    if (r.status === "empty") return { processed, budgetHit: false };
    if (r.status === "budget") return { processed, budgetHit: true };
    if (r.status === "transient") return { processed, budgetHit: true };
    processed++;
  }
  return { processed, budgetHit: false };
}
