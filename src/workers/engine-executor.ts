/**
 * The engine executor — the drain over the action ledger's non-steward
 * kinds: grant_planning, ingest, mandate_review, lookout_run,
 * consistency_sweep, formalize.
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
 *  - lookout_run: run one of a mandate's lookouts (llm/agents/lookout.ts)
 *    — a cheap standing watch reading its brief, the queued inputs, the
 *    graph and the web, and raising candidates. Metered and consumed the
 *    same way; the lookout's next due time is stamped after the run.
 *  - ingest: enqueue the source for extraction (the enqueue is this
 *    action's unit of work; the action stays 'running' and is completed
 *    by the extraction worker with the metered cost, so the funders'
 *    pro-rata split follows the real spend).
 *  - formalize: the claim's formal statement (docs/mathematics.md §5.4,
 *    §6.4): a direct Steward invocation on the strong tier with trigger
 *    `formalize` drafts, elaborates, and records `reviewed`; when it did,
 *    a second direct invocation in a fresh context with trigger
 *    `formalization_review` publishes or returns it to draft. Completed
 *    with the two passes' summed metered cost.
 *  - curate (#363): one Curator run around the anchor claim, reading every
 *    live curation request on it, under the largest funder. Metered and
 *    consumed like the rest; the requests it read are marked consumed.
 *  - audit (#363): one Audit Agent run for the audit_runs row named in
 *    target_ref, under its funder (a Governance mandate, or the bounty's
 *    prize-review reserve for a prize audit). The run row records its
 *    completion and findings count.
 *
 * The unfunded fallback lane: with BACKGROUND_FALLBACK_LANE_ENABLED and no
 * mandate that could fund the kind (no active General mandate for curate,
 * no active Governance mandate for audit), an uncovered curate or audit row
 * runs attributed to nobody, as the Steward's fallback lane does. It exists
 * for fresh dev databases and corpus runs; a deployment with its mandates
 * seeded never takes it.
 */
import { rawQuery } from "../db/client.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { runGrantor } from "../llm/agents/grantor.js";
import { runMandateReview } from "../llm/agents/mandate-review.js";
import { runLookout } from "../llm/agents/lookout.js";
import { recordLookoutRun } from "../services/lookout-service.js";
import { partitionFromRef } from "../services/consistency-service.js";
import { runConsistencySweep } from "./consistency-sweep.js";
import { runCurator } from "../llm/agents/curator.js";
import { runAudit } from "../llm/agents/audit-agent.js";
import {
  consumeCurationRequests,
  describeCurationRequests,
  liveCurationRequests,
} from "../services/curation-service.js";
import {
  getGeneralMandate,
  getGovernanceMandateIds,
} from "../services/allocation-policy-service.js";
import { getPlatformAccountId, getReserveJob } from "../services/bounty-service.js";
import { loadConfig } from "../config.js";
import { submitSource } from "../services/source-service.js";
import { fundGrantSelfActions } from "../services/allocation-service.js";
import { invokeStewardDirect } from "./steward-direct.js";
import {
  claimAction,
  completeAction,
  ensureCurateAction,
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

  const action =
    (await nextRunnableAction([
      "grant_planning",
      "mandate_review",
      "lookout_run",
      "consistency_sweep",
      "curate",
      "audit",
      "ingest",
      "formalize",
    ])) ?? (await nextFallbackAction());
  if (!action || !(await claimAction(action.id))) return { status: "empty" };

  if (action.kind === "ingest") return runIngestAction(action);
  if (action.kind === "formalize") return runFormalizeAction(action, opts);
  if (action.kind === "lookout_run") return runLookoutAction(action, opts);
  if (action.kind === "consistency_sweep") return runConsistencySweepAction(action);
  if (action.kind === "curate") return runCurateAction(action);
  if (action.kind === "audit") return runAuditAction(action);
  return runGrantAgentAction(action, opts);
}

/** Unfunded fallback-lane Curator runs this process (CURATOR_MAX_RUNS). */
let fallbackCuratorRuns = 0;

/** Test hook. */
export function resetFallbackCuratorRuns(): void {
  fallbackCuratorRuns = 0;
}

/**
 * The oldest uncovered curate or audit row the fallback lane may run, or
 * null. Only with BACKGROUND_FALLBACK_LANE_ENABLED, and only for a kind no
 * mandate could fund: an active General mandate owns curation's funding,
 * an active Governance mandate (or a bounty's reserve) owns audit's.
 */
async function nextFallbackAction(): Promise<RunnableAction | null> {
  const config = loadConfig();
  if (!config.backgroundFallbackLaneEnabled) return null;
  const kinds: string[] = [];
  const curatorCap = config.curatorMaxRuns ?? 0;
  if (!(await getGeneralMandate()) && (curatorCap <= 0 || fallbackCuratorRuns < curatorCap)) {
    kinds.push("curate");
  }
  if ((await getGovernanceMandateIds()).length === 0) kinds.push("audit");
  if (kinds.length === 0) return null;
  const [row] = await rawQuery<RunnableAction>(
    `SELECT a.id, a.kind, a.exclusion_group, a.variant, a.claim_id,
            a.target_ref, a.cost_est_micro_usd, a.updated_at,
            0::bigint AS coverage_micro_usd
       FROM actions a
      WHERE a.status = 'open' AND a.kind = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL)
        -- A prize audit is the bounty reserve's to fund, never the lane's.
        AND NOT EXISTS (SELECT 1 FROM audit_runs ar
                         WHERE ar.action_id = a.id AND ar.bounty_id IS NOT NULL)
      ORDER BY a.updated_at ASC
      LIMIT 1`,
    [kinds]
  );
  if (row?.kind === "curate") fallbackCuratorRuns++;
  return row ?? null;
}

/** Who a covered run is metered to: the largest funder, as a usage context. */
async function funderContext(
  action: RunnableAction
): Promise<{ jobId: string | null; userId: string | null; grantId?: string }> {
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  if (funder.grantId) {
    const [grant] = await rawQuery<{ funder_user_id: string }>(
      `SELECT funder_user_id FROM grants WHERE id = $1`,
      [funder.grantId]
    );
    return {
      jobId: funder.jobId ?? null,
      userId: grant?.funder_user_id ?? null,
      grantId: funder.grantId,
    };
  }
  return { jobId: funder.jobId ?? null, userId: funder.userId ?? null };
}

/**
 * curate (#363): one Curator run around the anchor claim, reading every
 * live curation request on it. The requests it read are consumed when the
 * run ends, whatever the outcome short of a retryable failure (a genuine
 * failure consumes them too: a poison concern must not keep reopening a
 * funded row; its requester can raise it again). A request that arrived
 * mid-run reopens the row for the next funding pass.
 */
async function runCurateAction(action: RunnableAction): Promise<EngineProcessResult> {
  const anchorClaimId = action.claim_id;
  const [claim] = anchorClaimId
    ? await rawQuery<{ state: string }>(`SELECT state FROM claims WHERE id = $1`, [anchorClaimId])
    : [];
  const requests = anchorClaimId && claim?.state === "active"
    ? await liveCurationRequests(anchorClaimId)
    : [];
  if (!anchorClaimId || requests.length === 0) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder = await funderContext(action);
  const settle = async (billedMicroUsd: number) => {
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    await consumeCurationRequests(requests.map((r) => r.id), action.id).catch(() => {});
    // Concerns raised while this run held the row wait on the next funding.
    const [more] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM curation_requests
        WHERE anchor_claim_id = $1 AND consumed_at IS NULL`,
      [anchorClaimId]
    ).catch(() => [{ n: 0 }]);
    if (Number(more?.n ?? 0) > 0) await ensureCurateAction(anchorClaimId).catch(() => null);
  };
  let billedMicroUsd = 0;
  try {
    const metered = await runWithUsageContext(
      { userId: funder.userId, jobId: funder.jobId, claimId: anchorClaimId },
      () =>
        withCostMeter(() =>
          runCurator({
            trigger: "curation_request",
            claimId: anchorClaimId,
            context:
              `${requests.length} structural concern${requests.length === 1 ? "" : "s"} ` +
              `about this claim are waiting, and this run was funded to answer them:\n` +
              describeCurationRequests(requests),
          })
        )
    );
    billedMicroUsd = metered.billedMicroUsd;
    await settle(billedMicroUsd);
    return {
      status: "processed",
      actionId: action.id,
      kind: "curate",
      grantId: funder.grantId,
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
        kind: "curate",
        grantId: funder.grantId,
        error: msg,
      };
    }
    await settle(billedMicroUsd);
    return {
      status: "processed",
      actionId: action.id,
      kind: "curate",
      grantId: funder.grantId,
      ok: false,
      error: msg,
    };
  }
}

/**
 * audit (#363): one Audit Agent run for the audit_runs row in target_ref.
 * A prize audit runs under its bounty's reserve job and the platform
 * account, the prize review's own context; every other audit under its
 * largest funder. The run row is closed out (completion, findings count)
 * whatever the outcome short of a retryable failure, so an audit that
 * failed reads as finished-with-nothing rather than forever pending.
 */
async function runAuditAction(action: RunnableAction): Promise<EngineProcessResult> {
  const auditRunId = action.target_ref ?? "";
  const [run] = auditRunId
    ? await rawQuery<{
        id: string;
        audit_type: string;
        context: string;
        completed_at: Date | null;
        bounty_id: string | null;
      }>(
        `SELECT id, audit_type, context, completed_at, bounty_id
           FROM audit_runs WHERE id = $1`,
        [auditRunId]
      )
    : [];
  if (!run || run.completed_at) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  let context = await funderContext(action);
  if (run.bounty_id) {
    const job = await getReserveJob(run.bounty_id).catch(() => null);
    const platformId = await getPlatformAccountId().catch(() => null);
    context = { jobId: job?.id ?? null, userId: platformId };
  }
  const close = async (billedMicroUsd: number) => {
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: context.jobId,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    await rawQuery(
      `UPDATE audit_runs
          SET completed_at = now(),
              findings_count = (SELECT count(*) FROM audit_findings WHERE run_id = $1)
        WHERE id = $1`,
      [run.id]
    ).catch(() => {});
  };
  try {
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: context.userId, jobId: context.jobId },
      () =>
        withCostMeter(() =>
          runAudit({ auditType: run.audit_type, context: run.context, runId: run.id })
        )
    );
    await close(billedMicroUsd);
    return {
      status: "processed",
      actionId: action.id,
      kind: "audit",
      grantId: context.grantId,
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
        kind: "audit",
        grantId: context.grantId,
        error: msg,
      };
    }
    await close(0);
    return {
      status: "processed",
      actionId: action.id,
      kind: "audit",
      grantId: context.grantId,
      ok: false,
      error: msg,
    };
  }
}

/**
 * formalize: two direct Steward passes on the strong tier under the
 * action's largest funder (§6.4), the second only when the first left a
 * `reviewed` statement, each metered against the funding job; the action
 * completes with the summed cost.
 */
async function runFormalizeAction(
  action: RunnableAction,
  opts: { model?: string }
): Promise<EngineProcessResult> {
  const claimId = action.claim_id;
  const [claim] = claimId
    ? await rawQuery<{ id: string; state: string }>(
        `SELECT id, state FROM claims WHERE id = $1`,
        [claimId]
      )
    : [];
  if (!claimId || !claim || claim.state !== "active") {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  let userId = funder.userId;
  if (!userId && funder.grantId) {
    const [grant] = await rawQuery<{ funder_user_id: string }>(
      `SELECT funder_user_id FROM grants WHERE id = $1`,
      [funder.grantId]
    );
    userId = grant?.funder_user_id;
  }
  const passOpts = {
    claimId,
    ...(funder.jobId ? { jobId: funder.jobId } : {}),
    ...(userId ? { userId } : {}),
    ...(opts.model ? { model: opts.model } : {}),
  };
  let billedMicroUsd = 0;
  try {
    const first = await invokeStewardDirect({
      ...passOpts,
      trigger: "formalize",
      context:
        "Write the claim's formal statement: draft, elaborate, review for vacuity, " +
        "and record it with publish_formalization.",
    });
    billedMicroUsd += first.billedMicroUsd;

    // The second pass runs only when the first left a statement to review.
    const [reviewed] = await rawQuery<{ id: string }>(
      `SELECT id FROM claim_formalizations
        WHERE claim_id = $1 AND status = 'reviewed'
        ORDER BY version DESC LIMIT 1`,
      [claimId]
    );
    if (reviewed) {
      const second = await invokeStewardDirect({
        ...passOpts,
        trigger: "formalization_review",
        context: reviewed.id,
      });
      billedMicroUsd += second.billedMicroUsd;
    }

    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId ?? null,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    return {
      status: "processed",
      actionId: action.id,
      kind: "formalize",
      grantId: funder.grantId,
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
        kind: "formalize",
        grantId: funder.grantId,
        error: msg,
      };
    }
    // A genuine failure after spend: complete with what was metered so the
    // money reaches the escrow, and let the reconcile sweep decide whether
    // the claim still wants a statement on its own cadence.
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId ?? null,
    }).catch(() => {});
    return {
      status: "processed",
      actionId: action.id,
      kind: "formalize",
      grantId: funder.grantId,
      ok: false,
      error: msg,
    };
  }
}

/**
 * lookout_run: one run of the lookout named in target_ref, under its
 * mandate's funder and budget job, metered and consumed against the
 * covering allocation. The run's end is stamped on the lookout (next due
 * time, counters, note) whatever happened, so a failing lookout backs off
 * rather than reopening on every sweep.
 */
async function runLookoutAction(
  action: RunnableAction,
  opts: { model?: string }
): Promise<EngineProcessResult> {
  const lookoutId = action.target_ref ?? "";
  const [lookout] = await rawQuery<{
    id: string;
    status: string;
    grant_id: string;
    grant_status: string;
    funder_user_id: string;
    budget_job_id: string;
  }>(
    `SELECT l.id, l.status, g.id AS grant_id, g.status AS grant_status,
            g.funder_user_id, g.budget_job_id
       FROM lookouts l JOIN grants g ON g.id = l.grant_id
      WHERE l.id = $1`,
    [lookoutId]
  );
  if (!lookout || lookout.status !== "active" || lookout.grant_status !== "active") {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  try {
    let note: string | null = null;
    let flagsRaised = 0;
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: lookout.funder_user_id, jobId: funder.jobId ?? null },
      () =>
        withCostMeter(async () => {
          const run = await runLookout({ lookoutId: lookout.id, model: opts.model });
          note = run.note;
          flagsRaised = run.flagsRaised;
        })
    );
    await recordLookoutRun({ lookoutId: lookout.id, note, flagsRaised }).catch(() => {});
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId ?? null,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    return {
      status: "processed",
      actionId: action.id,
      kind: "lookout_run",
      grantId: lookout.grant_id,
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
        kind: "lookout_run",
        grantId: lookout.grant_id,
        error: msg,
      };
    }
    // A genuine failure: stamp the run as failed (the lookout backs off to
    // at least six hours before it is due again) and retire the group; the
    // reconcile sweep reopens it when the lookout is next due.
    await recordLookoutRun({
      lookoutId: lookout.id,
      note: `(run failed: ${msg.slice(0, 300)})`,
      flagsRaised: 0,
      failed: true,
    }).catch(() => {});
    await cancelGroup(action.exclusion_group);
    return {
      status: "processed",
      actionId: action.id,
      kind: "lookout_run",
      grantId: lookout.grant_id,
      ok: false,
      error: msg,
    };
  }
}

/**
 * consistency_sweep (#330): one Consistency Checker sweep over the
 * partition named in target_ref, under the General mandate's funder,
 * metered and consumed against the covering allocation. The checker runs
 * on its own model (CONSISTENCY_MODEL), not the Steward override the drain
 * may carry. A partition that no longer exists cancels the row; a failed
 * sweep cancels it too, and the reconcile sweep reopens it while the
 * partition is still due.
 */
async function runConsistencySweepAction(action: RunnableAction): Promise<EngineProcessResult> {
  const partition = await partitionFromRef(action.target_ref ?? "");
  // The funder is whoever covered this row (the General mandate, by
  // fundGrantSelfActions), read from the allocation itself rather than a
  // cached mandate lookup that can lag a mandate's creation.
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  const [grant] = funder.grantId
    ? await rawQuery<{ id: string; funder_user_id: string; budget_job_id: string }>(
        `SELECT id, funder_user_id, budget_job_id FROM grants WHERE id = $1`,
        [funder.grantId]
      )
    : [];
  if (!partition || !grant) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const general = { grantId: grant.id, budgetJobId: grant.budget_job_id };
  try {
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: grant.funder_user_id, jobId: funder.jobId ?? general.budgetJobId },
      () => withCostMeter(() => runConsistencySweep({ partition }))
    );
    await completeAction(action.id, billedMicroUsd, {
      meteredJobId: funder.jobId ?? general.budgetJobId,
    }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${
          err instanceof Error ? err.message : err
        }`
      )
    );
    return {
      status: "processed",
      actionId: action.id,
      kind: "consistency_sweep",
      grantId: general.grantId,
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
        kind: "consistency_sweep",
        grantId: general.grantId,
        error: msg,
      };
    }
    await cancelGroup(action.exclusion_group);
    return {
      status: "processed",
      actionId: action.id,
      kind: "consistency_sweep",
      grantId: general.grantId,
      ok: false,
      error: msg,
    };
  }
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
              grantId: grant.id,
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
