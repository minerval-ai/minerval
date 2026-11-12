/**
 * The engine executor — the drain over the action ledger's non-steward
 * kinds: grant_planning, ingest, mandate_review, lookout_run, correspondent_run,
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
 *  - correspondent_run: run one of a mandate's Correspondents (#563,
 *    llm/agents/correspondent.ts)
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
 *    target_ref, under its funder (the General mandate, or the bounty's
 *    prize-review reserve for a prize audit). The run row records its
 *    completion and findings count.
 *  - request (Part VIII): one Researcher run on the request named in
 *    target_ref, its ceiling the row's funding, under the largest funder.
 *    A `scope` row's run returns a quote, which becomes the request's
 *    budget and opens its `full` row; a `full` row's run records its
 *    outcome as work for the request's keeper to judge.
 *
 * The unfunded fallback lane: with BACKGROUND_FALLBACK_LANE_ENABLED and no
 * mandate that could fund the kind (no active General mandate, which owns
 * both curation and audit), an uncovered curate or audit row
 * runs attributed to nobody, as the Steward's fallback lane does. It exists
 * for fresh dev databases and corpus runs; a deployment with its mandates
 * seeded never takes it.
 */
import { rawQuery } from "../db/client.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import { runAtLabel, runWithUsageContext, withPassBudget, type RunFunding } from "../llm/usage-context.js";
import { runGrantor } from "../llm/agents/grantor.js";
import { mandateEventsTick } from "../services/mandate-event-service.js";
import { runMandateReview } from "../llm/agents/mandate-review.js";
import { runLookout } from "../llm/agents/lookout.js";
import { recordLookoutRun } from "../services/lookout-service.js";
import { runCorrespondent } from "../llm/agents/correspondent.js";
import { recordCorrespondentRun } from "../services/correspondent-service.js";
import { cachedItemBody } from "../services/feed-service.js";
import { focusForGroup } from "../services/ingest-focus-service.js";
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
} from "../services/allocation-policy-service.js";
import { getPlatformAccountId, getReserveJob } from "../services/bounty-service.js";
import { loadConfig } from "../config.js";
import { submitSource } from "../services/source-service.js";
import { fundGrantSelfActions } from "../services/allocation-service.js";
import type { OperatingPolicy } from "../services/operating-policy-service.js";
import { invokeStewardDirect } from "./steward-direct.js";
import { runResearcher } from "../llm/agents/researcher.js";
import { renderResearchReport } from "../services/research-commission-service.js";
import { deliverReply, resumeMessages, sessionPrivateReasons, takeSessionForResume } from "../services/session-service.js";
import { runConsistencyChecker } from "../llm/agents/consistency-checker.js";
import {
  carriedNotebook,
  closeResearchRun,
  latestRequestRun,
  modelForTier,
  openResearchRun,
  getResearchRun,
  readResearcherPaused,
} from "../services/research-run-service.js";
import {
  examinationForRequest,
  getExaminationRow,
  linkResearchRun,
  type ExaminationRow,
} from "../services/examination-service.js";
import {
  documentUnderReview,
  getRequest,
  notifyRequestKeeper,
  recordWork,
  requestBrief,
  setRequestBudget,
  workLabel,
  type RequestView,
} from "../services/request-service.js";
import { REQUEST_OUTCOMES, type RequestOutcome } from "../schemas/kinds.js";
import {
  claimAction,
  completeAction,
  closeRequestActions,
  ensureCurateAction,
  grantmakerShareLeftMicroUsd,
  reviewPassBudgetMicroUsd,
  ensureRequestActions,
  largestActionFunder,
  actionFunderGrants,
  recordGrantSource,
  nextRunnableAction,
  releaseAction,
  actionBudgetMicroUsd,
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
  // No checkBudget() pre-check: every engine action runs as the allocations'
  // funder, which the process-wide breaker exempts; checked out here,
  // outside that context, it would read the unattributed lane's counters
  // and stall funded work. A run with no funder behind it still meets the
  // breaker on its first model call, which requeues it.
  // A mandate whose work produced something since its last review gets its
  // review reopened here, then funded just below like its other own rows.
  await mandateEventsTick().catch(() => ({ recorded: 0, woken: 0 }));
  await fundGrantSelfActions().catch(() => 0);

  // Request rows wait, funded, while the operator has the researcher off
  // or paused: the run that would take them up is the Researcher's.
  const researcherOn =
    loadConfig().researcherEnabled && !(await readResearcherPaused().catch(() => true));
  const action =
    (await nextRunnableAction([
      "resume",
      "grant_planning",
      "mandate_review",
      "lookout_run",
      "correspondent_run",
      "consistency_sweep",
      "curate",
      "audit",
      "ingest",
      "formalize",
      ...(researcherOn ? (["request", "research"] as const) : []),
    ])) ?? (await nextFallbackAction());
  if (!action) return { status: "empty" };

  // Every kind runs at the label of its ledger row, which is the label of
  // the work that opened the row (src/labels.ts). The whole of the kind's
  // handler is inside, not only the agent's run: what it enqueues before
  // and after (a job for an ingest, a follow-up, a reopened row) is work
  // this row started, and takes its label the same way.
  return runAtLabel(action.sensitivity_label, `ledger action ${action.id}`, async (): Promise<EngineProcessResult> => {
    if (!(await claimAction(action.id, action.sensitivity_label))) return { status: "empty" };

    if (action.kind === "ingest") return runIngestAction(action);
    if (action.kind === "formalize") return runFormalizeAction(action, opts);
    if (action.kind === "lookout_run") return runLookoutAction(action, opts);
    if (action.kind === "correspondent_run") return runCorrespondentAction(action, opts);
    if (action.kind === "consistency_sweep") return runConsistencySweepAction(action);
    if (action.kind === "curate") return runCurateAction(action);
    if (action.kind === "audit") return runAuditAction(action);
    if (action.kind === "request") return runRequestAction(action);
    if (action.kind === "research") return runResearchAction(action);
    if (action.kind === "resume") return runResumeAction(action);
    return runGrantAgentAction(action, opts);
  });
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
 * mandate could fund: an active General mandate owns curation's funding
 * and audit's (a bounty's reserve also pays for its own audits).
 */
async function nextFallbackAction(): Promise<RunnableAction | null> {
  const config = loadConfig();
  if (!config.backgroundFallbackLaneEnabled) return null;
  const kinds: string[] = [];
  const curatorCap = config.curatorMaxRuns ?? 0;
  const general = await getGeneralMandate();
  if (!general && (curatorCap <= 0 || fallbackCuratorRuns < curatorCap)) {
    kinds.push("curate");
  }
  if (!general) kinds.push("audit");
  if (kinds.length === 0) return null;
  const [row] = await rawQuery<RunnableAction>(
    `SELECT a.id, a.kind, a.exclusion_group, a.variant, a.claim_id,
            a.target_ref, a.cost_est_micro_usd, a.updated_at, a.sensitivity_label,
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

/** The pass budget for running `action`: its allocations, or its estimate when more. */
function actionBudget(action: RunnableAction, source: string): { microUsd: number; source: string; funding: RunFunding } {
  return { microUsd: actionBudgetMicroUsd(action), source, funding: { actionId: action.id } };
}

/**
 * A Curator or Audit run's budget: the larger of what its allocations
 * cover and the configured run budget (curateRunBudgetOwls,
 * auditRunBudgetOwls; 5 owls). The allocations are priced at the action's
 * expected cost, which is what funders are asked to cover; the run works
 * to what the work needs, and what it spends past its allocations is
 * metered to the funding mandate (#671's split of price and budget).
 */
function maintenanceBudget(
  action: RunnableAction,
  kind: "curate" | "audit",
  what: string
): { microUsd: number; source: string; funding: RunFunding } {
  const config = loadConfig();
  const owls = kind === "curate" ? config.curateRunBudgetOwls : config.auditRunBudgetOwls;
  const floor = Math.round((owls ?? 5) * (config.owlCostMicroUsd ?? 1_000_000));
  const covered = actionBudgetMicroUsd(action);
  const funding = { actionId: action.id };
  return covered >= floor
    ? { microUsd: covered, source: `the allocations funding ${what}`, funding }
    : { microUsd: floor, source: `${what}'s run budget, which its funding mandate covers`, funding };
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
  // A request the Curator keeps has its own row, with no anchor claim (#722).
  if (!action.claim_id && action.target_ref) return runRequestCurateAction(action);
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
        withPassBudget(maintenanceBudget(action, "curate", "this curation"), () =>
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
 * curate, on a request the Curator keeps (#722): work on it has come back,
 * and the keeper decides whether it has been met (Part VIII). The run is
 * anchored on the request rather than a claim: its brief is the request as
 * filed and the work returned, each with the research run whose full
 * report get_research_run serves. A request closed, or passed to a
 * Steward, while its row waited is cancelled.
 */
async function runRequestCurateAction(action: RunnableAction): Promise<EngineProcessResult> {
  const requestId = action.target_ref ?? "";
  const request = requestId ? await getRequest(requestId) : null;
  if (!request || request.keeper.kind !== "curator" || ["met", "declined", "withdrawn", "moot"].includes(request.state)) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder = await funderContext(action);
  const settle = async (billedMicroUsd: number) => {
    await completeAction(action.id, billedMicroUsd, { meteredJobId: funder.jobId }).catch((err) =>
      console.error(
        `[engine] completeAction failed for ${action.id}: ${err instanceof Error ? err.message : err}`
      )
    );
  };
  let billedMicroUsd = 0;
  try {
    const metered = await runWithUsageContext({ userId: funder.userId, jobId: funder.jobId }, () =>
      withPassBudget(actionBudget(action, "the allocations funding this curation"), () =>
        runCurator({
          trigger: "request_returned",
          claimId: null,
          requestId,
          context: requestKeeperBrief(request),
        })
      )
    );
    billedMicroUsd = metered.billedMicroUsd;
    await settle(billedMicroUsd);
    return { status: "processed", actionId: action.id, kind: "curate", grantId: funder.grantId, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmBudgetExceededError) {
      await releaseAction(action.id).catch(() => {});
      return { status: "budget", actionId: action.id, error: msg };
    }
    if (isTransientApiError(err)) {
      await releaseAction(action.id).catch(() => {});
      return { status: "transient", actionId: action.id, kind: "curate", grantId: funder.grantId, error: msg };
    }
    await settle(billedMicroUsd);
    return { status: "processed", actionId: action.id, kind: "curate", grantId: funder.grantId, ok: false, error: msg };
  }
}

/**
 * The Curator's brief for a request it keeps: the request as filed, and
 * every piece of work on it with the run that holds its full report. No
 * funder is named (the agents that judge a request never see who paid).
 */
export function requestKeeperBrief(request: RequestView): string {
  const work = request.work.length
    ? request.work
        .map(
          (w, i) =>
            `${i + 1}. ${w.outcome ? workLabel(w) : `${w.by} (under way)`}: ${w.summary}` +
            (w.research_run_id ? ` [get_research_run ${w.research_run_id}]` : "")
        )
        .join("\n")
    : "No work is recorded on it yet.";
  return [
    `Work has come back on a request you keep (Part VIII: you keep the requests that bear on several nodes, on a source, or on nothing the graph holds yet). Read what was found, from the full report where a research run holds it, and decide whether the request has been met: close it as met, or as declined or moot with why, or sharpen it with revise_request (budget_usd prices what the rest would take) and leave it open. The Steward of each node it bears on has been told separately and weighs the work for that node.`,
    "",
    `Request ${request.id}`,
    `Asks for: ${request.ask}`,
    `Why: ${request.why}`,
    `What would satisfy it: ${request.satisfied_by}`,
    request.bears_on.length
      ? `Bears on: ${request.bears_on.map((n) => `${n.kind} ${n.id} ("${n.text}")`).join("; ")}`
      : null,
    request.bears_on_sources.length
      ? `Bears on sources: ${request.bears_on_sources.map((src) => `${src.title}${src.url ? ` (${src.url})` : ""}`).join("; ")}`
      : null,
    request.bears_on_text ? `Bears on, in words: ${request.bears_on_text}` : null,
    `State: ${request.state}`,
    "",
    "Work on it:",
    work,
  ]
    .filter((l) => l !== null)
    .join("\n");
}

/**
 * A decomposition's plan opens with a pass on its claim: a reassessment
 * when the claim has been assessed, else its first (the item's kind is
 * resolved when it materializes). Prepended unless the Grantmaker already
 * put one first.
 */
function withOpeningPass<P extends { items?: Array<{ action: string; claim_id?: string }> }>(
  plan: P,
  claimId: string | null
): P {
  if (!claimId) return plan;
  const items = plan.items ?? [];
  const first = items[0];
  if (first && first.claim_id === claimId && ["assess", "reassess", "deepen"].includes(first.action)) {
    return plan;
  }
  return {
    ...plan,
    items: [
      {
        action: "reassess",
        claim_id: claimId,
        rationale: "The claim this decomposition was funded for: a fresh pass on it comes first.",
      },
      ...items,
    ],
  };
}

/**
 * request (Part VIII): one Researcher run on the request in target_ref.
 * The brief is the request as filed; the ceiling is what the row's funders
 * put behind it; the run is metered to the largest of them. A scoping
 * pass (variant `scope`, standard tier) returns a quote that becomes the
 * request's budget, which opens the full work for funding; the full work
 * (variant `full`, strong tier) records its outcome on the request and
 * tells the keeper. Neither the brief nor what the keeper reads names a
 * funder. A request closed while its row waited is cancelled, its money
 * returned.
 */
/**
 * resume: a paused session of the Curator, the Consistency Checker, the Audit
 * Agent or a Correspondent got back what it waited for (session-service.ts).
 * The agent is rebuilt from the input its run was called with, and continues
 * the conversation it left with the answers appended, under the budget this
 * row was commissioned with. It may pause again.
 */
async function runResumeAction(action: RunnableAction): Promise<EngineProcessResult> {
  const taken = action.target_ref ? await takeSessionForResume(action.target_ref) : null;
  if (!taken) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const { session, replies } = taken;
  const funder = await funderContext(action);
  const messages = await resumeMessages(session, replies, {});
  const resume = { sessionId: session.id, messages, privateReasons: sessionPrivateReasons(session, replies) };
  const input = (session.context?.input ?? {}) as never;
  let billedMicroUsd = 0;
  let failure: unknown = null;
  try {
    // The resumed run continues the paused run's transcript, so it works at
    // the session's label. The row that resumes it was opened at that label
    // (session-service.ts, commissionResumption), and the session is what
    // holds what the paused run read.
    const metered = await runAtLabel(session.sensitivity_label, `paused session ${session.id}`, () => runWithUsageContext(
      { userId: funder.userId, jobId: funder.jobId, ...(session.node_id ? { claimId: session.node_id } : {}) },
      () =>
        withPassBudget(actionBudget(action, "the budget resuming this paused session"), async () => {
          switch (session.role) {
            case "curator":
              await runCurator(input, resume);
              return;
            case "audit":
              await runAudit(input, resume);
              return;
            case "consistency_checker":
              await runConsistencyChecker(input, resume);
              return;
            case "correspondent": {
              const run = await runCorrespondent(input, resume);
              const correspondentId = (session.context?.input as { correspondentId?: string } | undefined)?.correspondentId;
              if (correspondentId) {
                await recordCorrespondentRun({ correspondentId, note: run.note, cursorTo: null }).catch(() => {});
              }
              return;
            }
            default:
              throw new Error(`No resumption for a ${session.role} session.`);
          }
        })
    ));
    billedMicroUsd = metered.billedMicroUsd;
  } catch (err) {
    failure = err;
  }
  if (failure && billedMicroUsd === 0 && (failure instanceof LlmBudgetExceededError || isTransientApiError(failure))) {
    // Nothing ran: the session is ready again, and the row waits.
    await rawQuery(`UPDATE agent_sessions SET status = 'ready', updated_at = now() WHERE id = $1 AND status = 'running'`, [session.id]);
    await releaseAction(action.id).catch(() => {});
    return {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "transient",
      actionId: action.id,
      kind: "resume",
      grantId: funder.grantId,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }
  await completeAction(action.id, billedMicroUsd, { meteredJobId: funder.jobId }).catch((err) =>
    console.error(`[engine] completeAction failed for ${action.id}: ${err instanceof Error ? err.message : err}`)
  );
  return {
    status: "processed",
    ok: !failure,
    actionId: action.id,
    kind: "resume",
    grantId: funder.grantId,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
  };
}

async function runResearchAction(action: RunnableAction): Promise<EngineProcessResult> {
  const runId = action.target_ref ?? "";
  const run = runId ? await getResearchRun(runId) : null;
  if (!run) {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder = await funderContext(action);
  const ceiling = actionBudgetMicroUsd(action);
  const [node] = run.claim_id
    ? await rawQuery<{ id: string; text: string; domains: string[] | null; kind: string | null }>(
        `SELECT id, text, domains, kind FROM claims WHERE id = $1`,
        [run.claim_id]
      ).catch(() => [])
    : [];
  const claim = node ? { id: node.id, text: node.text, domains: node.domains ?? [], kind: node.kind ?? "claim" } : null;
  // A Steward may commission research as an examination of a document in
  // its claim's map (#865), opened when it was commissioned.
  const examination = run.examination_id ? await getExaminationRow(run.examination_id).catch(() => null) : null;

  let billedMicroUsd = 0;
  let result: Awaited<ReturnType<typeof runResearcher>> | null = null;
  let failure: unknown = null;
  try {
    const metered = await runWithUsageContext(
      { userId: funder.userId, jobId: funder.jobId, ...(claim ? { claimId: claim.id } : {}) },
      () =>
        withPassBudget(
          { microUsd: ceiling, source: "the budget the agent that commissioned this research gave it", funding: { actionId: action.id } },
          () =>
            runResearcher({
              run: {
                id: run.id,
                claim_id: run.claim_id,
                grant_id: run.grant_id,
                requested_by: run.requested_by,
                task: run.task,
                model: run.model,
                model_tier: run.model_tier,
                effort: run.effort,
                include_constitution: run.include_constitution,
                ceiling_micro_usd: run.ceiling_micro_usd,
                notebook: run.notebook,
                job_id: run.job_id,
              },
              claim,
              examination: researcherExamination(examination),
            })
        )
    );
    result = metered.value;
    billedMicroUsd = metered.billedMicroUsd;
  } catch (err) {
    failure = err;
  }

  if (failure && billedMicroUsd === 0 && (failure instanceof LlmBudgetExceededError || isTransientApiError(failure))) {
    // Nothing ran and it was not the research's fault: the row waits again.
    await releaseAction(action.id).catch(() => {});
    return {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "transient",
      actionId: action.id,
      kind: "research",
      grantId: funder.grantId,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }

  const closed = await closeResearchRun(run.id, {
    status: failure || !result ? "failed" : result.status,
    report: result?.report ?? null,
    spentMicroUsd: billedMicroUsd,
    turns: result?.turns,
    servedModels: result?.servedModels,
    error: failure ? (failure instanceof Error ? failure.message : String(failure)) : (result?.error ?? null),
  }).catch(() => null);
  await completeAction(action.id, billedMicroUsd, { meteredJobId: funder.jobId }).catch((err) =>
    console.error(`[engine] completeAction failed for ${action.id}: ${err instanceof Error ? err.message : err}`)
  );

  // The report goes back to whoever asked: the waiting session, or the node's inbox.
  const [route] = await rawQuery<{ reply_to_session: string | null; deliver_to_node: string | null }>(
    `SELECT reply_to_session, deliver_to_node FROM research_runs WHERE id = $1`,
    [run.id]
  );
  const text = renderResearchReport({
    id: run.id,
    status: closed?.status ?? (failure ? "failed" : (result?.status ?? "failed")),
    spent_micro_usd: billedMicroUsd,
    ceiling_micro_usd: Number(run.ceiling_micro_usd),
    report: result?.report ?? null,
    notebook: closed?.notebook ?? run.notebook ?? {},
    error: failure ? (failure instanceof Error ? failure.message : String(failure)) : (result?.error ?? null),
  });
  await deliverReply({
    sessionId: route?.reply_to_session ?? null,
    kind: "research",
    ref: run.id,
    text,
    fallback: route?.deliver_to_node
      ? { nodeId: route.deliver_to_node, trigger: "research_report", sender: { kind: "researcher", ref: run.id } }
      : null,
  }).catch((err: unknown) => console.error(`[engine] delivering research ${run.id} failed:`, err instanceof Error ? err.message : err));

  return {
    status: "processed",
    ok: !failure && !!result?.report,
    actionId: action.id,
    kind: "research",
    grantId: funder.grantId,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
  };
}

/** An examination as the Researcher is launched on it. */
function researcherExamination(x: ExaminationRow | null) {
  return x
    ? { id: x.id, source_id: x.source_id, source_title: x.source_title, source_url: x.source_url, facets: x.facets, scope: x.scope }
    : null;
}

async function runRequestAction(action: RunnableAction): Promise<EngineProcessResult> {
  const requestId = action.target_ref ?? "";
  const request = requestId ? await getRequest(requestId) : null;
  if (!request || ["met", "declined", "withdrawn", "moot"].includes(request.state)) {
    await cancelGroup(action.exclusion_group);
    if (requestId) await closeRequestActions(requestId).catch(() => {});
    return { status: "empty" };
  }
  const scoping = action.variant === "scope";
  const funder = await funderContext(action);
  const ceiling = actionBudgetMicroUsd(action);
  const tier = scoping ? "standard" : "strong";
  // The tier and effort the full work runs on, which a scoping run prices
  // (#732): fixed here, so the quote is for the run it funds.
  const fullWork = { tier: "strong", model: modelForTier("strong"), effort: "high" } as const;
  // What the full work was priced at, the row's cost (the scoping quote or
  // its keeper's figure), beside the budget this run was given (#885). A
  // commission's budget is its payer's choice and may be below it; the run
  // is told when it is, and the work log says so.
  const funding = scoping ? {} : { budgetMicroUsd: ceiling, quoteMicroUsd: Number(action.cost_est_micro_usd) || null };
  // What the run may record on (#728): a run taking up a request on one
  // node runs with that node (provenance, instances, its domain skills);
  // one on several records on any of them, each call naming its node.
  const nodes = scoping || request.bears_on.length === 0
    ? []
    : await rawQuery<{ id: string; text: string; domains: string[] | null; kind: string | null }>(
        `SELECT id, text, domains, kind FROM claims WHERE id = ANY($1::uuid[]) AND state = 'active'`,
        [request.bears_on.map((n) => n.id)]
      ).catch(() => []);
  const asNode = (n: (typeof nodes)[number]) => ({ id: n.id, text: n.text, domains: n.domains ?? [], kind: n.kind ?? "claim" });
  const claim = nodes.length === 1 ? asNode(nodes[0]!) : null;
  const requestNodes = nodes.length > 1 ? nodes.map(asNode) : [];
  // The next stage begins where the last stopped (#730): the run opens
  // with the latest earlier run's notebook and report.
  const prior = await latestRequestRun(requestId).catch(() => null);
  const run = await openResearchRun({
    claimId: claim?.id ?? null,
    grantId: funder.grantId ?? null,
    requestedBy: scoping ? "request_scope" : "request",
    requesterRunId: null,
    jobId: funder.jobId,
    task: requestBrief(request),
    model: scoping ? modelForTier(tier) : fullWork.model,
    modelTier: scoping ? tier : fullWork.tier,
    effort: scoping ? null : fullWork.effort,
    includeConstitution: true,
    ceilingMicroUsd: ceiling,
    requestId,
    notebook: prior ? carriedNotebook(prior) : null,
  });
  // A request bearing on one document alone asks for a review of it
  // (#865): the full work examines the document, every stage onto the same
  // examination, so what it covers and finds goes on the document's page.
  // Scoping only prices the work, and examines nothing.
  const underReview = documentUnderReview(request);
  const reviewed = scoping ? null : underReview;
  // A scoping run prices the review from how long the document is.
  const documentReview =
    scoping && underReview
      ? await rawQuery<{ chars: number | null; segments: string }>(
          `SELECT CASE WHEN raw_content IS NULL OR raw_content = '' THEN NULL ELSE length(raw_content) END AS chars,
                  (SELECT COUNT(*) FROM source_segments WHERE source_id = $1) AS segments
             FROM sources WHERE id = $1`,
          [underReview.id]
        )
          .then(([r]) => ({
            title: underReview.title,
            url: underReview.url,
            chars: r?.chars == null ? null : Number(r.chars),
            segments: Number(r?.segments ?? 0),
          }))
          .catch(() => null)
      : null;
  let examination: ExaminationRow | null = null;
  if (reviewed) {
    examination = await examinationForRequest({ requestId, sourceId: reviewed.id, brief: run.task }).catch((err) => {
      console.error(`[engine] opening the review of ${reviewed.id} for request ${requestId} failed: ${err instanceof Error ? err.message : err}`);
      return null;
    });
    if (examination) await linkResearchRun(examination.id, run.id);
  }
  await recordWork({
    requestId,
    byLabel: "Researcher",
    researchRunId: run.id,
    outcome: null,
    summary: scoping ? "Being scoped by the Researcher." : "Taken up by the Researcher.",
    fundedByJobId: funder.jobId,
    ...funding,
  }).catch(() => null);

  let billedMicroUsd = 0;
  let result: Awaited<ReturnType<typeof runResearcher>> | null = null;
  let failure: unknown = null;
  try {
    const metered = await runWithUsageContext(
      { userId: funder.userId, jobId: funder.jobId, ...(claim ? { claimId: claim.id } : {}) },
      () =>
        withPassBudget({ microUsd: ceiling, source: "the allocations funding this request", funding: { actionId: action.id } }, () =>
          runResearcher({
            run: {
              id: run.id,
              claim_id: run.claim_id,
              grant_id: run.grant_id,
              requested_by: run.requested_by,
              task: run.task,
              model: run.model,
              model_tier: run.model_tier,
              effort: run.effort,
              include_constitution: run.include_constitution,
              ceiling_micro_usd: run.ceiling_micro_usd,
              notebook: run.notebook,
              job_id: run.job_id,
            },
            claim,
            requestNodes,
            priorRun: prior ? { id: prior.id, status: prior.status, requestedBy: prior.requested_by } : null,
            fullWork: scoping ? fullWork : null,
            quoteMicroUsd: funding.quoteMicroUsd ?? null,
            examination: researcherExamination(examination),
            documentReview,
          })
        )
    );
    result = metered.value;
    billedMicroUsd = metered.billedMicroUsd;
  } catch (err) {
    failure = err;
  }

  await closeResearchRun(run.id, {
    status: failure || !result ? "failed" : result.status,
    report: result?.report ?? null,
    spentMicroUsd: billedMicroUsd,
    turns: result?.turns,
    servedModels: result?.servedModels,
    error: failure ? (failure instanceof Error ? failure.message : String(failure)) : (result?.error ?? null),
  }).catch(() => null);

  if (failure && billedMicroUsd === 0 && (failure instanceof LlmBudgetExceededError || isTransientApiError(failure))) {
    // Nothing ran and it was not the request's fault: the row goes back to
    // waiting on its funding.
    await releaseAction(action.id).catch(() => {});
    return {
      status: failure instanceof LlmBudgetExceededError ? "budget" : "transient",
      actionId: action.id,
      kind: "request",
      grantId: funder.grantId,
      error: failure instanceof Error ? failure.message : String(failure),
    };
  }

  // Settle first: completing the row supersedes its siblings, so the full
  // row a quote opens must come after.
  await completeAction(action.id, billedMicroUsd, { meteredJobId: funder.jobId }).catch((err) =>
    console.error(
      `[engine] completeAction failed for ${action.id}: ${err instanceof Error ? err.message : err}`
    )
  );

  const report = result?.report ?? null;
  const answer = typeof report?.answer === "string" ? report.answer.trim() : "";
  const outcomeRaw = typeof report?.request_outcome === "string" ? report.request_outcome : null;
  const usd = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
  const ended = failure ? "failed" : (result?.status ?? "no report");

  if (scoping) {
    const quote = usd(report?.budget_quote_usd);
    // The plan the quote prices (#732), recorded with it for funders.
    const plan = typeof report?.plan === "string" ? report.plan.trim() : "";
    const terminal = outcomeRaw && outcomeRaw !== "scoped" && (REQUEST_OUTCOMES as readonly string[]).includes(outcomeRaw)
      ? (outcomeRaw as RequestOutcome)
      : null;
    if (terminal) {
      await recordWork({
        requestId,
        byLabel: "Researcher",
        researchRunId: run.id,
        outcome: terminal,
        summary: (answer || `Scoping returned ${terminal}.`).slice(0, 4000),
        fundedByJobId: funder.jobId,
      }).catch(() => null);
      // The work as recorded, and where the full report is (#718).
      await notifyRequestKeeper(
        requestId,
        `scoping it returned ${terminal}: ${(answer || `Scoping returned ${terminal}.`).slice(0, 4000)}`,
        { researchRunId: run.id }
      ).catch(() => false);
    } else if (quote) {
      await recordWork({
        requestId,
        byLabel: "Researcher",
        researchRunId: run.id,
        outcome: null,
        summary: (`Scoped at about $${quote.toFixed(2)}. ${answer}` + (plan ? `\n\nPlan: ${plan}` : "")).slice(0, 8000),
        fundedByJobId: funder.jobId,
      }).catch(() => null);
      // The quote is the request's budget: the full work opens at that price.
      await setRequestBudget({ requestId, budgetUsd: quote }).catch((err) =>
        console.error(`[engine] setting request ${requestId}'s budget failed: ${err instanceof Error ? err.message : err}`)
      );
    } else {
      await recordWork({
        requestId,
        byLabel: "Researcher",
        researchRunId: run.id,
        outcome: null,
        summary: `The scoping run ended without a quote (${ended}); the request is open to be scoped again.`,
        fundedByJobId: funder.jobId,
      }).catch(() => null);
      await ensureRequestActions(requestId).catch(() => null);
    }
  } else {
    const outcome = outcomeRaw && (REQUEST_OUTCOMES as readonly string[]).includes(outcomeRaw)
      ? (outcomeRaw as RequestOutcome)
      : null;
    const remaining = usd(report?.remaining_budget_usd);
    const summary = outcome
      ? (answer || `Returned ${outcome}.`) + (remaining ? ` The rest would cost about $${remaining.toFixed(2)}.` : "")
      : `The run ended without a report (${ended}); the request is open to be taken up again.`;
    await recordWork({
      requestId,
      byLabel: "Researcher",
      researchRunId: run.id,
      outcome,
      summary: summary.slice(0, 4000),
      fundedByJobId: funder.jobId,
      ...funding,
    }).catch(() => null);
    if (outcome) {
      await notifyRequestKeeper(requestId, `the Researcher returned ${outcome}: ${summary.slice(0, 4000)}`, {
        researchRunId: run.id,
      }).catch(() => false);
    } else {
      await ensureRequestActions(requestId).catch(() => null);
    }
  }

  return {
    status: "processed",
    actionId: action.id,
    kind: "request",
    grantId: funder.grantId,
    ok: !failure && !!report,
    ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
  };
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
        withPassBudget(maintenanceBudget(action, "audit", "this audit"), () =>
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
  // The two passes share the action's budget: the review gets what the
  // drafting pass left, or the funding job's remaining budget when drafting
  // spent it all (a review given nothing to work with is no review).
  const budget = actionBudgetMicroUsd(action);
  try {
    const first = await invokeStewardDirect({
      ...passOpts,
      passBudget: { microUsd: budget, source: "the allocations funding this formalization" },
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
        ...(budget - billedMicroUsd > 0
          ? { passBudget: { microUsd: budget - billedMicroUsd, source: "what the drafting pass left of this formalization's allocations" } }
          : {}),
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
        withPassBudget(actionBudget(action, "the mandate's allocation for this lookout run"), async () => {
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
 * correspondent_run (#563): one run of the Correspondent named in
 * target_ref, under its mandate's funder and budget job, metered and
 * consumed against the covering allocation, as a lookout run is. The run's
 * end is stamped whatever happened: a successful run moves the change
 * cursor to the end of the window it read; a failed one leaves the cursor
 * and backs off.
 */
async function runCorrespondentAction(
  action: RunnableAction,
  opts: { model?: string }
): Promise<EngineProcessResult> {
  const correspondentId = action.target_ref ?? "";
  const [row] = await rawQuery<{
    id: string;
    status: string;
    grant_id: string;
    grant_status: string;
    funder_user_id: string;
  }>(
    `SELECT c.id, c.status, g.id AS grant_id, g.status AS grant_status, g.funder_user_id
       FROM correspondents c JOIN grants g ON g.id = c.grant_id
      WHERE c.id::text = $1`,
    [correspondentId]
  );
  if (!row || row.status !== "active" || row.grant_status !== "active") {
    await cancelGroup(action.exclusion_group);
    return { status: "empty" };
  }
  const funder: { jobId?: string; userId?: string; grantId?: string } =
    await largestActionFunder(action.id).catch(() => ({}));
  try {
    let note: string | null = null;
    let cursorTo: string | null = null;
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: row.funder_user_id, jobId: funder.jobId ?? null },
      () =>
        withPassBudget(actionBudget(action, "the mandate's allocation for this correspondent run"), async () => {
          const run = await runCorrespondent({ correspondentId: row.id, model: opts.model });
          note = run.note;
          cursorTo = run.cursorTo;
        })
    );
    await recordCorrespondentRun({ correspondentId: row.id, note, cursorTo }).catch(() => {});
    await completeAction(action.id, billedMicroUsd, { meteredJobId: funder.jobId ?? null }).catch((err) =>
      console.error(`[engine] completeAction failed for ${action.id}: ${err instanceof Error ? err.message : err}`)
    );
    return { status: "processed", actionId: action.id, kind: "correspondent_run", grantId: row.grant_id, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof LlmBudgetExceededError) {
      await releaseAction(action.id).catch(() => {});
      return { status: "budget", actionId: action.id, error: msg };
    }
    if (isTransientApiError(err)) {
      await releaseAction(action.id).catch(() => {});
      return { status: "transient", actionId: action.id, kind: "correspondent_run", grantId: row.grant_id, error: msg };
    }
    await recordCorrespondentRun({
      correspondentId: row.id,
      note: `(run failed: ${msg.slice(0, 300)})`,
      cursorTo: null,
      failed: true,
    }).catch(() => {});
    await cancelGroup(action.exclusion_group);
    return {
      status: "processed",
      actionId: action.id,
      kind: "correspondent_run",
      grantId: row.grant_id,
      ok: false,
      error: msg,
    };
  }
}

/**
 * consistency_sweep (#330): one Consistency Checker sweep over the
 * partition named in target_ref, under the funder of whichever mandate
 * covered it (the General mandate on its own lane, or a mandate whose plan
 * names the partition: a `sweep` item, #831), metered and consumed
 * against the covering allocation. The checker runs
 * on its own model (CONSISTENCY_MODEL, or CONSISTENCY_STRONG_MODEL for the
 * strong variant, #756), not the Steward override the drain
 * may carry. A partition that no longer exists cancels the row; a failed
 * sweep cancels it too, and the reconcile sweep reopens it while the
 * partition is still due.
 */
async function runConsistencySweepAction(action: RunnableAction): Promise<EngineProcessResult> {
  const partition = await partitionFromRef(action.target_ref ?? "");
  // The funder is whoever covered this row (the General mandate, or a
  // mandate funding a sweep item of its plan, both by fundGrantSelfActions;
  // or a mandate that valued the row), read from the allocation itself rather than a
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
      () =>
        withPassBudget(
          actionBudget(action, "a mandate's allocation for this sweep, priced by the partition's size"),
          () =>
            // The strong variant reads with the stronger model (#756), and
            // the sweep is told how its budget was priced.
            runConsistencySweep({
              partition,
              variant: action.variant === "strong" ? "strong" : "standard",
              model: action.variant === "strong" ? loadConfig().consistencyStrongModel : undefined,
            })
        )
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
    mandate: {
      origin?: string;
      grantmaker_share_owls?: number | null;
      operating_policy?: OperatingPolicy | null;
    } | null;
  }>(
    `SELECT g.id, g.funder_user_id, g.budget_job_id, g.name,
            g.scope_claim_id, g.scope_query, g.status, j.budget_micro_usd, g.mandate
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
        withPassBudget(actionBudget(action, "the mandate's allocation for this pass"), async () => {
          if (action.kind === "grant_planning") {
            let plan = await runGrantor({
              grantId: grant.id,
              model: opts.model,
            });
            // A decomposition (claim-mandate-service.ts) was approved when
            // it was paid for: its plan runs as drafted, and always opens
            // with a fresh pass on the claim it is about.
            const decomposition = grant.mandate?.origin === "deep_decomposition";
            if (decomposition) plan = withOpeningPass(plan, grant.scope_claim_id);
            await rawQuery(
              `UPDATE grants
                  SET plan = $2::jsonb, status = $3,
                      plan_cursor = 0, updated_at = now()
                WHERE id = $1 AND status = 'planning'`,
              [grant.id, JSON.stringify(plan), decomposition ? "active" : "pending_approval"]
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
    // A decomposition's plan is live as drafted: its standing orders are
    // placed now, not a sweep later (a no-op for a plan awaiting approval).
    if (action.kind === "grant_planning") {
      const { materializeLivePlan } = await import("../services/action-service.js");
      await materializeLivePlan(grant.id);
    }
    // A mandate whose passes have a share of their own reopens a review only
    // while the share holds something.
    const share = await grantmakerShareLeftMicroUsd(grant).catch(() => null);
    if (continueRequested && (!share || share.leftMicroUsd > 0)) {
      // The agent judged a fresh pass the better way on: reopen its review
      // action at the pass budget as it stands now, so the next drain
      // iteration funds and runs another out of the mandate's day
      // (fundGrantSelfActions). The policy is read fresh: this pass may
      // have changed its own figure.
      // The pass itself is done and settled: a failure here leaves the row
      // closed for the sweep to reopen on its cadence, and is not the run's.
      try {
        const [now] = await rawQuery<{ mandate: typeof grant.mandate }>(
          `SELECT mandate FROM grants WHERE id = $1`,
          [grant.id]
        );
        const estimate = await reviewPassBudgetMicroUsd(
          { id: grant.id, mandate: now?.mandate ?? grant.mandate },
          "review",
          share
        );
        await rawQuery(
          `UPDATE actions SET status = 'open', cost_est_micro_usd = $2, updated_at = now()
            WHERE id = $1 AND status = 'done'`,
          [action.id, estimate]
        );
      } catch (err) {
        console.error(
          `[engine] continue_review could not reopen ${action.id}: ${err instanceof Error ? err.message : err}`
        );
      }
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
 * ingest: enqueue the source for extraction, metered to the largest
 * funder; every funding mandate records the source in its pipeline. The
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
    // A page a lookout already fetched to read it (a feed item, #305) is
    // extracted from what was read, not downloaded again.
    const cached = await cachedItemBody(url).catch(() => null);
    // A scoped ingest's group carries its focus (ingest-focus-service.ts).
    const focus = await focusForGroup(action.exclusion_group);
    const { sourceId, jobId } = await submitSource(
      cached ? { url, content: cached.body, ...(cached.title ? { title: cached.title } : {}) } : { url },
      // meterJobId: a grant-funded ingest meters its extraction to the
      // grant's budget job, so the escrow's llm_usage accounting sees it.
      owner
        ? { userId: owner.funder_user_id, meterJobId: funder.jobId }
        : {},
      {
        focus,
        ingestGroup: action.exclusion_group,
        ...(owner ? { grantId: owner.id } : {}),
      }
    );
    // Every mandate paying for the run has the source in its pipeline, not
    // only the largest funder (#657).
    const funders = await actionFunderGrants(action.id).catch(() => [] as string[]);
    for (const fundingGrantId of new Set([...(owner ? [owner.id] : []), ...funders])) {
      await recordGrantSource(fundingGrantId, sourceId, url, jobId);
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
