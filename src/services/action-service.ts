/**
 * The action ledger — the mechanical layer of the allocation engine.
 *
 * One row per potential action (src/db/schema.ts `actions`). Alternative
 * ways of doing the same thing share an exclusion_group; at most one
 * sibling runs. Everything here is MECHANISM — pure functions of the
 * ledger and the allocations on it. Judgment (what is valuable, which
 * variant to back, how much) lives upstream in mandate_valuations and in
 * each mandate's allocator.
 *
 * The rules, in full:
 *  - coverage(action) = SUM(unspent, unreleased allocations on its group
 *    that are unpinned or pinned to it) ≥ cost_est → the action is
 *    RUNNABLE.
 *  - Among runnable siblings, the most-backed wins (tie → cheapest).
 *  - When a winner finishes: it is `done`; its siblings are `superseded`;
 *    pinned allocations on losers are RELEASED back to their funders (a
 *    vote for a losing way of doing it is returned, not spent); the
 *    metered cost is consumed pro rata from the winner's covering
 *    allocations.
 */
import { oneSourceForAddressSql } from "./layer-service.js";
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { currentLabel, labelInContext, runAtLabel } from "../llm/usage-context.js";
import { runAtMandateLabelOutsideAnyRun } from "./label-service.js";
import { STEWARD_ERROR_REASON_LABELS, stewardErrorReasonOf } from "./steward-park-reason.js";
import {
  FAULT_RETRY_BASE_SECONDS,
  FAULT_RETRY_MAX_SECONDS,
  faultWait,
  faultWaitSentence,
  isDeploymentFaultReason,
  isPlatformFaultReason,
  platformFaultOf,
  type FaultWait,
  type FaultWaitRow,
  type PlatformFaultReason,
} from "./deployment-fault.js";
import { errorProvider } from "../llm/errors.js";
import { noteDeploymentFault } from "./deployment-fault-service.js";
import {
  estimateConsistencyNodeCostMicroUsd,
  estimateLedgerKindCostMicroUsd,
  stewardTierCostEstimates,
  type ConsistencyNodeCost,
} from "./cost-estimate-service.js";
import { getMandateAllocationPolicy } from "./allocation-policy-service.js";
import { reviewPassBudget, type OperatingPolicy } from "./operating-policy-service.js";
import { capMicroUsd, microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { groupAtLabel, ingestGroup, normalizeFocus, recordIngestFocus } from "./ingest-focus-service.js";
import { oneLabelOnly } from "./judgment-version-service.js";
import { slotColumnSql } from "./steward-lease.js";
import {
  duePartitions,
  listPartitions,
  partitionRef,
  reclaimAbandonedSweeps,
  type PartitionStatus,
} from "./consistency-service.js";
import { CLOSED_REQUEST_STATES, NODE_KINDS, type NodeKind } from "../schemas/kinds.js";
import { PROPOSAL_TYPE_FOR_KIND } from "../schemas/common.js";
import { mergedAliasRefusal } from "./claim-alias-service.js";
import { ownWorkSql } from "./mirrored-node-service.js";
import { AFTER_INGESTS_MAX_WAIT_HOURS } from "./grant-service.js";
import { retiredNodeRefusal } from "./claim-lifecycle-service.js";
import { actionUnavailable } from "../llm/tools/feature-tools.js";
export { allocationDayUseSql } from "./day-use.js";

export type ActionKind =
  // A paused agent session resumed (session-service.ts): group
  // `resume:<session id>:<n>`, target_ref the session. The Curator, the
  // Consistency Checker, the Audit Agent and Correspondents resume through
  // it; a Steward resumes through a pass on its node.
  | "resume"
  // Research an agent commissioned from its own budget (commission kind
  // research, research-commission-service.ts): group `research:<run id>`,
  // target_ref the research run. Its report returns to the agent's session.
  | "research"
  | "assess"
  | "reassess"
  | "ingest"
  | "grant_planning"
  // A mandate's periodic review pass: its Grantmaker acting with the
  // discretion of anyone entrusted with a mandate — surveying its
  // territory (the graph and the open web), valuing the open ledger,
  // growing its own plan, and moving money (regrants). Bounded by its
  // metered cap and the mandate's escrow, never by narrowed affordances.
  | "mandate_review"
  // Write a claim's formal statement (docs/mathematics.md §5.4): the Steward
  // drafts, elaborates against the checker, and records `reviewed`; a
  // fresh-context Steward pass on the strong model then publishes or sends
  // it back. Two passes per statement, because "every line correct, wrong
  // theorem" is the failure no checker catches.
  | "formalize"
  // A solver attempt on a published statement (§7.2): group
  // `attempt:<formalization_id>:<n>`, variants `standard` and `max`. A
  // closed attempt never reopens; a later attempt is a new group. Bounded
  // by its dollar ceiling, the claim's lifetime cap, and the solver's daily
  // breaker, never selected by them.
  | "attempt_proof"
  // The review of one prize claim (§8.6): the cold-lane check, the Reviewer
  // run, the Steward's `prize_claim` run, and the audit — self-funded from
  // the platform-owned prize-review reserve minted when the bounty opened,
  // outside any mandate's day room, so a claim never waits on a paused
  // escrow and the claimant is never charged.
  | "prize_review"
  // One run of a mandate's lookout (docs/allocation.md, "Lookouts"): a
  // cheap standing watch that reads its brief, the graph, and the open
  // web on a heartbeat or when an event is queued for it, and raises
  // CANDIDATES — a reassess or an ingest valued on the mandate's behalf
  // within its delegated ceiling (#695), a note for the next review pass.
  // Group `lookout:<lookout_id>`; self-funded from the mandate's escrow
  // like a review pass, out of the mandate's day the same way.
  | "lookout_run"
  // One run of a mandate's Correspondent (#563; docs/allocation.md,
  // "Correspondents"): reads what changed in its scope and the graph, and
  // writes one update for its audience. Woken like a lookout (heartbeat, a
  // material change in scope, a poke). Group `correspondent:<id>`;
  // self-funded from the mandate's escrow out of its day like a lookout run.
  | "correspondent_run"
  // One Consistency Checker sweep (#330; docs/allocation.md, "Consistency
  // sweeps"): a cheap agent reading one partition of the graph (a tag, or
  // the residual bucket) for assessments that do not cohere, raising
  // flags. Group `consistency:<tag_id|residual>`, target_ref the same.
  // The platform's own work: self-funded from the General mandate's escrow
  // like a review pass, out of its day. A mandate buys one too, by a
  // `sweep` item in its plan (funded from its own escrow and day, like an
  // ingest item, #831) or by valuing an open row.
  | "consistency_sweep"
  // Reconcile the graph around one anchor claim (#363): the Curator's
  // merges, splits, and cross-claim edges. Group `curate:<claim_id>`, one
  // variant; opened (or reopened) only by a curation request
  // (curation-service.requestCuration) and run once some mandate values and
  // funds it. Maintenance is chosen, never induced: nothing bills a
  // Curator run to whoever happened to be nearby. A request the Curator
  // keeps (Part VIII) has a row of its own, group `curate:request:<id>`,
  // claim_id null and target_ref the request, opened when work on it comes
  // back: a request on several nodes or on none has no anchor claim (#722).
  | "curate"
  // One Audit Agent run (#363): group `audit:<audit_runs.id>`, target_ref the
  // run id. Opened by requestAudit behind its dedupe key; funded by a
  // mandate that values it (the platform's General mandate, as upkeep) or,
  // for a prize audit, from the bounty's prize-review reserve. A mandate never
  // values or funds an audit whose subject it is (audit_runs.subject_grant_id).
  | "audit"
  // Take up one request (Part VIII): a Researcher run on the request as
  // filed, its outcome recorded as work for the keeper to judge. Group
  // `request:<request_id>`, target_ref the request id, one open variant at
  // a time: `scope` (a cheap pass that returns a quote) while the request
  // has no budget, then `full`, costed at the request's budget. Valued by
  // mandates like any action, and fundable by anyone.
  | "request"
  // One Redactor run on a page that is to be shown below its label
  // (showing-service.ts): group `redact:<showing_pages.id>`, target_ref the
  // page, at the page's label. Opened when a showing takes in a version and
  // again each time Audit returns the work; it runs when a mandate that
  // values it or the person who asked pays for it.
  | "redact";

/**
 * A node's assess group, at a label: the label of the work in progress
 * unless one is named. Work at each label on a node has its own group
 * (groupAtLabel in ingest-focus-service.ts), so an internal assessment of a
 * public claim neither waits on public work nor is visible on its row. The
 * same holds for the other groups keyed by something several labels can
 * work on: curate, formalize, ingest and a consistency partition.
 */
export const ASSESS_GROUP = (claimId: string, label?: string) => groupAtLabel(`assess:${claimId}`, label);
/**
 * SQL expression for the same key: the assess group of the node whose id is
 * `idSql`, at the label `labelSql`. The plain key where `public` is the
 * only label.
 */
export const ASSESS_GROUP_SQL = (idSql: string, labelSql: string) =>
  oneLabelOnly() ? `'assess:' || ${idSql}::text` : `minerval_group_at('assess:' || ${idSql}::text, ${labelSql})`;
export const PLANNING_GROUP = (grantId: string) => `plan:${grantId}`;
/** An ingest's group: per URL, and per focus for a scoped ingest (ingest-focus-service.ts). */
export const INGEST_GROUP = (url: string, focus?: string | null, label?: string) => ingestGroup(url, focus, label);
export const REVIEW_GROUP = (grantId: string) => `review:${grantId}`;
export const LOOKOUT_GROUP = (lookoutId: string) => `lookout:${lookoutId}`;
export const CORRESPONDENT_GROUP = (correspondentId: string) => `correspondent:${correspondentId}`;
export const CONSISTENCY_GROUP = (ref: string, label?: string) => groupAtLabel(`consistency:${ref}`, label);
export const CURATE_GROUP = (claimId: string, label?: string) => groupAtLabel(`curate:${claimId}`, label);
/** The Curator's row for one request it keeps (#722). */
export const CURATE_REQUEST_GROUP = (requestId: string) => `curate:request:${requestId}`;
export const AUDIT_GROUP = (auditRunId: string) => `audit:${auditRunId}`;
export const REQUEST_GROUP = (requestId: string) => `request:${requestId}`;
/** One statement per claim at a time: one group, one variant (§5.4). */
export const FORMALIZE_GROUP = (claimId: string, label?: string) => groupAtLabel(`formalize:${claimId}`, label);
/** `attempt:<formalization_id>:<n>` — a closed attempt never reopens (§7.2). */
export const ATTEMPT_GROUP = (formalizationId: string, n: number) =>
  `attempt:${formalizationId}:${n}`;

/** The two solver variants every attempt group carries as siblings (§7.2). */
export const ATTEMPT_VARIANTS = ["standard", "max"] as const;


/**
 * A formalize item whose claim still has no published statement is wanted
 * again after this long: the same pacing as the mandate's review pass, so
 * a returned-to-draft statement is retried without a hot loop.
 */
const FORMALIZE_RETRY_HOURS = 24;

/** A live attempt stamps updated_at every turn; only a dead worker trips this. */
const ATTEMPT_REOPEN_HOURS = 3;

/**
 * An extraction job still unfinished after this many days has lost its queue
 * message: the extraction queue keeps a message four days (SQS's default;
 * infra/lib/queue-stack.ts sets none). The running ingest row behind it is
 * then reopened like any row whose worker died. Until then an unfinished job
 * means the extraction is queued or being read, and the row is left running
 * (reconcileActions).
 */
const INGEST_JOB_LOST_DAYS = 4;

/**
 * Whether a live commission pays for actions row `a` (SQL fragment). A
 * commissioned row runs as soon as it has one, at its payer's budget; the
 * row's own cost estimate only gates the allocator's increments.
 */
export const COMMISSIONED_SQL = `
  EXISTS (SELECT 1 FROM minerval_whole.allocation_money al
           WHERE al.exclusion_group = a.exclusion_group
             AND al.released_at IS NULL
             AND al.commissioned_by IS NOT NULL
             AND al.spent_micro_usd < al.amount_micro_usd
             AND (al.action_id IS NULL OR al.action_id = a.id))`;

/** Coverage subquery for one actions row `a` (SQL fragment). */
export const COVERAGE_SQL = `
  COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
              FROM minerval_whole.allocation_money al
             WHERE al.exclusion_group = a.exclusion_group
               AND al.released_at IS NULL
               AND (al.action_id IS NULL OR al.action_id = a.id)), 0)`;

/** The statuses of a ledger row whose work is over. A row in one of these is reopened by its group's next piece of work. */
export const FINISHED_STATUSES_SQL = `('done', 'superseded', 'cancelled')`;

/**
 * Whether actions row `a` may be picked now (SQL fragment): it is not inside
 * the wait a platform fault put on it (releaseAction; the wait and its
 * reason are in deployment-fault.ts). Every executor's selection carries
 * this, so a row a dead provider keeps failing is passed over for the rows
 * behind it instead of being picked first every time (#971).
 */
export const NOT_WAITING_ON_FAULT_SQL = `(a.retry_after IS NULL OR a.retry_after <= now())`;

/**
 * What an upsert that can reopen a finished row does with the row's display
 * text and its target (SQL fragment for its SET list). Every producer below
 * stamps a new row with the label of the work that opens it (currentLabel),
 * and the executors run a row at its label. A row's label never changes
 * (the database's label_fixed_guard). A group whose subject several labels
 * can work on (a node, a document, a partition) has a key for each label
 * (groupAtLabel), and every other group belongs to a row that carries one
 * label of its own (a mandate, a request, a lookout), so a row is only ever
 * reopened by work at its own label.
 *
 * A reopened row is the new work's row: its display text and its target
 * are replaced. A row that is open or running keeps both.
 */
export const LABEL_ON_REOPEN_SQL = `label = CASE WHEN actions.status IN ${FINISHED_STATUSES_SQL} THEN EXCLUDED.label ELSE actions.label END,
           target_ref = CASE WHEN actions.status IN ${FINISHED_STATUSES_SQL} THEN EXCLUDED.target_ref
                             ELSE actions.target_ref END`;

// ---------------------------------------------------------------------------
// Producers: keep the ledger's open rows in sync with the graph's state.
// Idempotent upserts, called from enqueue paths and the scheduler sweep.
// ---------------------------------------------------------------------------

/**
 * Ensure the assess/reassess exclusion group for one claim exists with a
 * row per variant (standard always; strong when a strong model is
 * configured). Kind is 'assess' for a first pass, 'reassess' when a
 * current assessment exists. Refreshes cost estimates on existing rows.
 */
export async function ensureAssessActions(claimId: string): Promise<void> {
  const config = loadConfig();
  const tiers = await stewardTierCostEstimates();
  // A first pass or a fresh one, at the label of the work that asks: a
  // label with no version of its own on the node has not assessed it yet,
  // whatever another label holds.
  const assessedHere = oneLabelOnly()
    ? `EXISTS (SELECT 1 FROM assessments_in_force x
                     WHERE x.claim_id = c.id)`
    : `EXISTS (SELECT 1 FROM assessments_versions x
                     WHERE x.claim_id = c.id AND x.sensitivity_label = $2)`;
  const [claim] = await rawQuery<{ text: string; assessed: boolean }>(
    `SELECT c.text,
            ${assessedHere}
              AS assessed
       FROM claims c
      WHERE c.id = $1 AND c.state = 'active'${ownWorkSql("c")}`,
    oneLabelOnly() ? [claimId] : [claimId, currentLabel()]
  );
  // No row for a node that is not active, and none for a mirrored node at
  // its own label, where the assessment is the public graph's
  // (mirrored-node-service.ts).
  if (!claim) return;
  const kind = claim.assessed ? "reassess" : "assess";
  const group = ASSESS_GROUP(claimId);
  const label = claim.text.slice(0, 300);
  const variants: Array<[string, number]> = [
    ["standard", tiers.standardMicroUsd],
  ];
  if (config.stewardStrongModel) {
    variants.push(["strong", tiers.strongMicroUsd]);
  }
  for (const [variant, cost] of variants) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd, sensitivity_label)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             kind = EXCLUDED.kind,
             ${LABEL_ON_REOPEN_SQL},
             -- One row per (group, variant), holding the claim's CURRENT
             -- potential action: a done/superseded/cancelled row reopens
             -- when fresh work is wanted (the next pass), a running row is
             -- left alone. History lives in assessments and llm_usage.
             status = CASE WHEN actions.status = 'running'
                           THEN actions.status ELSE 'open' END,
             updated_at = now()`,
      [kind, group, variant, claimId, label, Math.round(cost), currentLabel()]
    );
  }
}

/**
 * Ensure the anchor claim's `curate` row exists and is open (#363). Called
 * by requestCuration after it records a live request, and by the executor
 * when a run finishes with requests still waiting (ones that arrived
 * mid-run). A done/superseded/cancelled row reopens: fresh concerns are
 * fresh work, and fresh work needs fresh funding. A running row is left
 * alone. Returns the row id, or null when the anchor is not an active
 * claim or no live request on it says what is wrong (#955): a curate row is
 * opened only for a defect someone named.
 */
export async function ensureCurateAction(anchorClaimId: string): Promise<string | null> {
  // A mirrored node is the public graph's to curate, at its own label: a
  // concern that involves one is anchored on this deployment's node, or
  // raised at a label that reads it (mirrored-node-service.ts).
  const [claim] = await rawQuery<{ text: string }>(
    `SELECT c.text FROM claims c
      WHERE c.id = $1 AND c.state = 'active'${ownWorkSql("c")}
        AND EXISTS (SELECT 1 FROM curation_requests r
                     WHERE r.anchor_claim_id = c.id AND r.consumed_at IS NULL)`,
    [anchorClaimId]
  );
  if (!claim) return null;
  const cost = await estimateLedgerKindCostMicroUsd("curate");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('curate', $1, 'standard', $2, $3, $4, $5)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
           ${LABEL_ON_REOPEN_SQL},
           status = CASE WHEN actions.status = 'running'
                         THEN actions.status ELSE 'open' END,
           updated_at = now()
     RETURNING id`,
    [
      CURATE_GROUP(anchorClaimId),
      anchorClaimId,
      `Curate around: ${claim.text.slice(0, 280)}`,
      Math.max(1, Math.round(cost)),
      currentLabel(),
    ]
  );
  return row?.id ?? null;
}

/**
 * Open (or reopen) the Curator's row for a request it keeps (#722), when
 * work on it has come back for the keeper to judge. The Curator keeps the
 * requests that bear on several nodes, on a source, or on nothing the
 * graph holds yet; none has an anchor claim, so the row carries the
 * request in target_ref and runs a request-anchored brief. Commissioned
 * like any curation run. Null when the request is closed or has
 * passed to a Steward.
 */
export async function ensureRequestCurateAction(requestId: string): Promise<string | null> {
  const [req] = await rawQuery<{ ask: string; sensitivity_label: string }>(
    `SELECT ask, sensitivity_label FROM requests
      WHERE id = $1 AND keeper_kind = 'curator'
        AND state NOT IN ('met', 'declined', 'withdrawn', 'moot')`,
    [requestId]
  );
  if (!req) return null;
  const cost = await estimateLedgerKindCostMicroUsd("curate");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('curate', $1, 'standard', NULL, $2, $3, $4, $5)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
           ${LABEL_ON_REOPEN_SQL},
           status = CASE WHEN actions.status = 'running'
                         THEN actions.status ELSE 'open' END,
           updated_at = now()
     RETURNING id`,
    [
      CURATE_REQUEST_GROUP(requestId),
      requestId,
      `Judge work returned on a request: ${req.ask.slice(0, 260)}`,
      Math.max(1, Math.round(cost)),
      // The request's label: judging work on a request is the request's
      // work, whoever brought the work back (src/labels.ts).
      req.sensitivity_label,
    ]
  );
  return row?.id ?? null;
}

/**
 * Open the `audit` row for one audit_runs row (#363) and link the run to
 * it. Idempotent: a second call for the same run returns the same row.
 *
 * The label names the audit's type and cause, never its context: the
 * ledger is public (every allocation number is inspectable), and an
 * audit's context can name a contributor under a bad-faith flag or a
 * suspension. The context stays on the audit_runs row the agent reads.
 */
export async function ensureAuditAction(input: {
  auditRunId: string;
  auditType: string;
  triggeredBy: string;
  claimId?: string | null;
}): Promise<string> {
  const cost = await estimateLedgerKindCostMicroUsd("audit");
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('audit', $1, 'standard', $2, $3, $4, $5, $6)
     ON CONFLICT (exclusion_group, variant) DO UPDATE SET updated_at = now()
     RETURNING id`,
    [
      AUDIT_GROUP(input.auditRunId),
      input.claimId ?? null,
      input.auditRunId,
      `Audit: ${input.auditType.replace(/_/g, " ")} (${input.triggeredBy.replace(/_/g, " ")})`,
      Math.max(1, Math.round(cost)),
      currentLabel(),
    ]
  );
  await rawQuery(`UPDATE audit_runs SET action_id = $2 WHERE id = $1`, [
    input.auditRunId,
    row!.id,
  ]);
  return row!.id;
}

/**
 * Open the request's row for its next piece of work (Part VIII): the
 * `full` row at its budget when it has one, else the `scope` row, whose
 * pass returns the quote that becomes the budget. Called when a request is
 * filed, when its budget is set or revised, and when a scoping pass
 * returns: each is a reason for fresh work, so a done row reopens (a
 * running one is left alone). A closed request's rows are closed instead.
 * Returns the open row's id, or null when there is none.
 */
export async function ensureRequestActions(requestId: string): Promise<string | null> {
  const [req] = await rawQuery<{ ask: string; state: string; budget_micro_usd: string | null; sensitivity_label: string; asked_above: boolean }>(
    `SELECT ask, state, budget_micro_usd, sensitivity_label, (asked_of_face_id IS NOT NULL) AS asked_above FROM requests WHERE id = $1`,
    [requestId]
  );
  if (!req || (CLOSED_REQUEST_STATES as readonly string[]).includes(req.state)) {
    await closeRequestActions(requestId);
    return null;
  }
  // A request that asked for work at a label above, and paid for it there
  // (ask-above-service.ts), has no row at this label: the work is done by
  // an agent that reads what the asker could not, and a row here would buy
  // the same question from one that cannot.
  if (req.asked_above) return null;
  const group = REQUEST_GROUP(requestId);
  const budget = req.budget_micro_usd == null ? null : Number(req.budget_micro_usd);
  const variant = budget != null ? "full" : "scope";
  const cost = budget ?? (await estimateLedgerKindCostMicroUsd("request_scope"));
  const label = `${variant === "scope" ? "Scope the request" : "Take up the request"}: ${req.ask.slice(0, 260)}`;
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO actions
       (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
     VALUES ('request', $1, $2, $3, $4, $5, $6)
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
           ${LABEL_ON_REOPEN_SQL},
           status = CASE WHEN actions.status = 'running'
                         THEN actions.status ELSE 'open' END,
           updated_at = now()
     RETURNING id`,
    // The request's own label, not the caller's: the row is the request's
    // next piece of work, and it is reopened from a route that sets a
    // budget, from a keeper's pass and from the sweep as well as from the
    // request's own runs. The scoping, the research and the review of a
    // document that the row pays for all run at it (src/labels.ts).
    [group, variant, requestId, label, Math.max(1, Math.round(cost)), req.sensitivity_label]
  );
  // Once a budget exists the scoping pass has nothing left to answer.
  if (variant === "full") {
    await rawQuery(
      `UPDATE actions SET status = 'superseded', updated_at = now()
        WHERE exclusion_group = $1 AND variant = 'scope' AND status = 'open'`,
      [group]
    );
  }
  return row?.id ?? null;
}

/**
 * Close a request's ledger rows once it is closed: nothing will take it up,
 * so its open rows are cancelled and every unspent allocation on its group
 * is returned. A person's owls come back to their balance; a mandate's
 * placement simply stops counting against its escrow. A running row is left
 * to finish (its run settles its own funders).
 */
export async function closeRequestActions(requestId: string): Promise<void> {
  const group = REQUEST_GROUP(requestId);
  await withTransaction(async (tx) => {
    const running = await tx.query<{ id: string }>(
      `SELECT id FROM actions WHERE exclusion_group = $1 AND status = 'running'`,
      [group]
    );
    await tx.query(
      `UPDATE actions SET status = 'cancelled', updated_at = now()
        WHERE exclusion_group = $1 AND status = 'open'`,
      [group]
    );
    if (running.length > 0) return;
    const live = await tx.query<{ id: string; user_id: string | null; unspent: string }>(
      `SELECT id, user_id, (amount_micro_usd - spent_micro_usd)::bigint AS unspent
         FROM minerval_whole.allocation_money
        WHERE exclusion_group = $1 AND released_at IS NULL
        FOR UPDATE`,
      [group]
    );
    for (const al of live) {
      await tx.query(`UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`, [al.id]);
      if (al.user_id && Number(al.unspent) > 0) {
        await tx.query(
          `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, idempotency_key)
           VALUES ($1, $2, 'refund', $3)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [al.user_id, Number(al.unspent), `release:${al.id}`]
        );
      }
    }
  });
}

/**
 * Sweep the whole ledger into sync:
 *  - open assess/reassess groups for every pending claim;
 *  - open ingest actions for unexecuted grant-plan ingest items, and
 *    advance plan cursors past ingest items whose action is done;
 *  - open grant_planning actions for grants awaiting their planning run;
 *  - open valuation actions for mandates whose Grantmaker is due to
 *    re-judge the open ledger (VALUATION_CADENCE_HOURS);
 *  - cancel assess groups whose claim is no longer pending/active;
 *  - release actions stuck 'running' by a crashed worker.
 * Bounded work per sweep; returns counts for the scheduler's log line.
 */
export async function reconcileActions(): Promise<{
  assessEnsured: number;
  cancelled: number;
  /** Mandates whose plan could not be materialized this sweep (logged). */
  plansFailed: number;
}> {
  // A pending slot with no open row. A node's own row is its slot for work
  // at its own label; work asked for at another label waits in
  // steward_slots, one row per node and label (steward-lease.ts), which
  // only a deployment with more than one label has.
  const pending = await rawQuery<{ id: string; sensitivity_label: string }>(
    `SELECT c.id, c.sensitivity_label FROM claims c
      WHERE c.state = 'active' AND c.steward_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.exclusion_group = ${ASSESS_GROUP_SQL("c.id", "c.sensitivity_label")}
                           AND a.status IN ('open', 'running'))
      LIMIT 500`
  );
  if (!oneLabelOnly()) {
    pending.push(
      ...(await rawQuery<{ id: string; sensitivity_label: string }>(
        `SELECT s.claim_id AS id, s.sensitivity_label FROM steward_slots s
           JOIN claims c ON c.id = s.claim_id AND c.state = 'active'
          WHERE s.steward_state = 'pending'
            AND NOT EXISTS (SELECT 1 FROM actions a
                             WHERE a.exclusion_group = minerval_group_at('assess:' || s.claim_id::text, s.sensitivity_label)
                               AND a.status IN ('open', 'running'))
          LIMIT 500`
      ))
    );
  }
  for (const row of pending) {
    // One claim's failure (a bad row, a transient DB error) must not take
    // the rest of the sweep with it: log and move on (#416).
    try {
      // The rows are opened at the label of the slot that is pending, and
      // the pass they pay for runs at it.
      const label = row.sensitivity_label;
      await runAtLabel(label, `claim ${row.id}`, () => ensureAssessActions(row.id));
    } catch (err) {
      console.error(
        `[reconcile] ensureAssessActions failed for claim ${row.id}: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Ingest + planning + valuation actions from live grants.
  const grants = await rawQuery<PlanGrantRow>(
    `SELECT id, name, status, policy, plan, plan_cursor, scope_claim_id, mandate FROM grants
      WHERE status IN ('active', 'planning')`
  );
  const ctx = newMaterializeContext();
  let plansFailed = 0;
  // A mandate decides for its work: the planning row, the review row and
  // every row its plan becomes are opened at the mandate's label
  // (runAtMandateLabel in label-service.ts), not at the sweep's, which has
  // none, and not at the label of whichever claim a plan item names.
  for (const g of grants) {
    if (!(await runAtMandateLabelOutsideAnyRun(g.id, () => reconcileMandate(g, ctx)))) plansFailed++;
  }

  // A formalize row is pointless once the claim carries a published
  // statement (an ordinary pass may have published one); an attempt row is
  // pointless once its statement is no longer published (§7.2).
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind = 'formalize'
        AND EXISTS (SELECT 1 FROM claim_formalizations f
                     WHERE f.claim_id = a.claim_id AND f.status = 'published')`
  );
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind = 'attempt_proof'
        AND NOT EXISTS (SELECT 1 FROM claim_formalizations f
                         WHERE f.id::text = split_part(a.exclusion_group, ':', 2)
                           AND f.status = 'published')`
  );

  await openDueAgentRuns();

  // Consistency sweeps (#330): an exclusive set of a standard and a strong
  // variant per partition due a sweep (#756). Off (and any open rows
  // cancelled) when sweeps are disabled. How many run is the General
  // mandate's money (fundGrantSelfActions), not a count (#749).
  await reconcileConsistencySweeps();

  // Curation (#363): a curate row wants its anchor still active and at
  // least one live request to read; a request's row, its request open and
  // kept by the Curator. A merge can retire the anchor out from
  // under an open row; a run that read everything leaves nothing to do.
  // Only mandates place on curate rows, so releasing a cancelled group's
  // placements is just the mandates' exposure dropping; left live, they
  // would hold that money against a row nothing will reopen.
  await rawQuery(
    `WITH gone AS (
       UPDATE actions a SET status = 'cancelled', updated_at = now()
        WHERE a.status = 'open' AND a.kind = 'curate'
          AND CASE
                -- A request's row (#722) wants the request still open and
                -- still the Curator's to keep.
                WHEN a.claim_id IS NULL AND a.target_ref IS NOT NULL THEN
                  NOT EXISTS (SELECT 1 FROM requests rq
                               WHERE rq.id::text = a.target_ref
                                 AND rq.keeper_kind = 'curator'
                                 AND rq.state NOT IN ('met', 'declined', 'withdrawn', 'moot'))
                ELSE
                  NOT EXISTS (SELECT 1 FROM claims c
                               WHERE c.id = a.claim_id AND c.state = 'active')
                  OR NOT EXISTS (SELECT 1 FROM curation_requests r
                                  WHERE r.anchor_claim_id = a.claim_id
                                    AND r.consumed_at IS NULL)
              END
        RETURNING a.exclusion_group
     )
     UPDATE minerval_whole.allocation_money al SET released_at = now()
      WHERE al.exclusion_group IN (SELECT exclusion_group FROM gone)
        AND al.released_at IS NULL AND al.grant_id IS NOT NULL
        AND al.spent_micro_usd = 0`
  );
  // The officers' waiting curation items follow their rows (#955): retired
  // with the reason when the row closed, rewritten from its live requests.
  await import("./maintenance-funding.js")
    .then((m) => m.refreshCurationInboxItems())
    .catch((err) => console.warn("[reconcile] refreshing curation items failed:", err instanceof Error ? err.message : err));

  // Close groups whose claim left the candidate set (assessed elsewhere,
  // archived, or mid-run on the express lane long enough to have finished).
  const cancelled = await rawQuery<{ id: string }>(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND NOT EXISTS (SELECT 1 FROM claims c
                         WHERE c.id = a.claim_id AND c.state = 'active'
                           AND ${slotColumnSql("steward_state", "c", "a.sensitivity_label")} IN ('pending', 'running'))
      RETURNING a.id`
  );

  // Requests closed by their keeper (or withdrawn) while a row stood open:
  // closing the request closes its rows, and this catches any it missed.
  const closedRequests = await rawQuery<{ target_ref: string }>(
    `SELECT DISTINCT a.target_ref FROM actions a
       JOIN requests r ON r.id::text = a.target_ref
      WHERE a.kind = 'request' AND r.state IN ('met', 'declined', 'withdrawn', 'moot')
        AND (a.status = 'open'
             OR (a.status <> 'running' AND EXISTS (
                  SELECT 1 FROM minerval_whole.allocation_money al
                   WHERE al.exclusion_group = a.exclusion_group
                     AND al.released_at IS NULL AND al.spent_micro_usd < al.amount_micro_usd)))`
  );
  for (const r of closedRequests) await closeRequestActions(r.target_ref);

  // A worker that died mid-run leaves its action 'running' forever;
  // return it to open so coverage can send it again. Generous window —
  // real runs (a deep steward pass) can be long. Ingest actions get a much
  // longer window: they legitimately stay 'running' while the async
  // extraction worker holds them (which completes or cancels them itself),
  // and reopening one early re-submits the source — a second metered
  // extraction charged to the same funders. A solver attempt stamps
  // updated_at every turn (§7.9), so three untouched hours means a dead
  // worker, not a long proof.
  //
  // An ingest whose extraction is still queued or being read is not dead,
  // however long it has waited: the extractions are read one after another,
  // so a mandate that plans twenty-five sources at once has rows that read
  // `running` for hours with nothing wrong, and on 2026-11-13 a stopped
  // drain left ten of them waiting twenty hours. Nothing stamps such a row
  // while it queues, so the 24 hours alone would reopen it, the executor
  // would submit the source a second time, and both extractions would be
  // read and metered to the same funders. It is left running while its
  // extraction job is unfinished (INGEST_JOB_LOST_DAYS says for how long).
  await rawQuery(
    `UPDATE actions a SET status = 'open', updated_at = now()
      WHERE a.status = 'running'
        AND ((a.kind NOT IN ('ingest', 'attempt_proof') AND a.updated_at < now() - interval '60 minutes')
             OR (a.kind = 'ingest' AND a.updated_at < now() - interval '24 hours'
                 AND NOT EXISTS (
                   SELECT 1 FROM jobs j
                    WHERE j.type = 'url_extraction' AND j.status IN ('pending', 'processing')
                      AND j.input->>'url' = a.target_ref
                      -- Submitted for this run of the row: the executor
                      -- claims the row, then creates the job.
                      AND j.created_at >= a.updated_at - interval '1 minute'
                      AND j.created_at > now() - make_interval(days => ${INGEST_JOB_LOST_DAYS})))
             OR (a.kind = 'attempt_proof' AND a.updated_at < now() - make_interval(hours => ${ATTEMPT_REOPEN_HOURS})))`
  );

  return { assessEnsured: pending.length, cancelled: cancelled.length, plansFailed };
}

/**
 * The rows of the standing agents a mandate funds that have fallen due: one
 * open row per active lookout or Correspondent on an active mandate whose
 * heartbeat has passed or that has an input waiting. Cheap (two indexed
 * queries over small tables) and idempotent, so the scheduler calls it on
 * every tick between sweeps as well as in the sweep
 * (allocation-scheduler.ts): a lookout told it runs every 3 hours runs
 * within a tick (STANDING_ORDER_RETRY_MINUTES) of falling due, never on
 * the six-hourly sweep's cadence, which nobody told it of (2026-11-13: a
 * breaking-news lookout posted at 21:33 and due at once had not run by
 * 22:00 and would not have until the next sweep at 03:31). The rows are
 * funded on the executor's tick by fundGrantSelfActions.
 */
export async function openDueAgentRuns(): Promise<void> {
  // Lookout runs: one open row per active lookout on an active mandate
  // whose heartbeat has fallen due or that has an unconsumed event
  // waiting. Due-ness is the lookout's own state (next_due_at, stamped by
  // the executor after each run), so a closed row reopens exactly when the
  // lookout says it is due and never on a fixed sweep cadence — an
  // event-only lookout (heartbeat 0) opens nothing until something is
  // queued for it. The funding side (fundGrantSelfActions) pays for each
  // run out of the mandate's pace and escrow, with no count of runs; this
  // only says what is wanted.
  const lookoutCost = capMicroUsd("lookout_run");
  const dueLookouts = await rawQuery<{ id: string; title: string; sensitivity_label: string }>(
    `SELECT l.id, l.title, l.sensitivity_label
       FROM lookouts l
       JOIN grants g ON g.id = l.grant_id
      WHERE l.status = 'active' AND g.status = 'active'
        AND ((l.heartbeat_hours > 0 AND l.next_due_at <= now())
             OR EXISTS (SELECT 1 FROM lookout_events e
                         WHERE e.lookout_id = l.id AND e.consumed_at IS NULL))
      LIMIT 200`
  );
  for (const l of dueLookouts) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('lookout_run', $1, 'standard', $2, $3, $4, $5)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             ${LABEL_ON_REOPEN_SQL},
             updated_at = now()
         WHERE actions.status IN ('done', 'superseded', 'cancelled')`,
      // A lookout decides for its work: its run is opened at its label.
      [LOOKOUT_GROUP(l.id), l.id, `Lookout run: "${l.title}"`, lookoutCost, l.sensitivity_label]
    );
  }

  // Correspondent runs (#563): the same rule as a lookout's. Due when its
  // heartbeat has passed, when someone poked it, or when a change in its
  // scope is waiting and its min_wake_hours have passed since the last run
  // (that spacing is its audience's, set for their attention; a heartbeat
  // and a poke are not held by it). What runs is the mandate's money.
  const correspondentCost = capMicroUsd("correspondent_run");
  const dueCorrespondents = await rawQuery<{ id: string; title: string; sensitivity_label: string }>(
    `SELECT c.id, c.title, c.sensitivity_label
       FROM correspondents c
       JOIN grants g ON g.id = c.grant_id
      WHERE c.status = 'active' AND g.status = 'active'
        AND ((c.heartbeat_hours > 0 AND c.next_due_at <= now())
             OR EXISTS (SELECT 1 FROM correspondent_events e
                         WHERE e.correspondent_id = c.id AND e.consumed_at IS NULL
                           AND (e.kind <> 'graph_change'
                                OR c.last_run_at IS NULL
                                OR c.last_run_at + make_interval(hours => c.min_wake_hours) <= now())))
      LIMIT 200`
  );
  for (const c of dueCorrespondents) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('correspondent_run', $1, 'standard', $2, $3, $4, $5)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             ${LABEL_ON_REOPEN_SQL},
             updated_at = now()
         WHERE actions.status IN ('done', 'superseded', 'cancelled')`,
      // And so does a correspondent: its run is opened at its label.
      [CORRESPONDENT_GROUP(c.id), c.id, `Correspondent run: "${c.title}"`, correspondentCost, c.sensitivity_label]
    );
  }
}

/**
 * A live mandate's sitting row: its planning row while it is being planned,
 * or its Grantmaker's review row while it is active and no session of its
 * Grantmaker is live. Idempotent (the conditional upserts below). Called at
 * the mandate's label: by the sweep for every live mandate, and for a new
 * one at funding and between sweeps (openFirstSittings), so a mandate's
 * first sitting never waits for the six-hourly sweep.
 */
async function openMandateSittingRow(g: Pick<PlanGrantRow, "id" | "name" | "status" | "mandate">): Promise<void> {
  // A mandate whose Grantmaker passes have a share of the budget of their
  // own (a decomposition: claim-mandate-service.ts) budgets each pass from
  // what the share has left, and opens no review once it is spent.
  const share = await grantmakerShareLeftMicroUsd(g);
  if (g.status === "planning") {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('grant_planning', $1, 'standard', $2, $3, $4, $5)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             ${LABEL_ON_REOPEN_SQL},
             updated_at = now()
         -- A grant still in 'planning' with a closed planning action
         -- wants a fresh run (a failed write, a pushed-back plan).
         WHERE actions.status NOT IN ('open', 'running')`,
      [
        PLANNING_GROUP(g.id),
        g.id,
        `Planning run for the mandate "${g.name}"`,
        await reviewPassBudgetMicroUsd(g, "planning", share),
        currentLabel(),
      ]
    );
  }

  // The mandate's review pass: its Grantmaker's session, opened fresh when
  // none is live — its Grantmaker stewarding the mandate with discretion. Every active mandate gets one, the General
  // mandate included: its valuations come from a formula rather than from
  // per-action judgment, but the formula's knobs are exactly the kind of
  // thing a steward should revise as evidence about allocation itself
  // accumulates, and it has the same pacing, regranting and scope
  // decisions to make as any other. Exempting it left the platform's own
  // lane as the one mandate no agent was ever asked to think about.
  if (g.status === "active" && share && share.leftMicroUsd <= 0) {
    await rawQuery(
      `UPDATE actions SET status = 'cancelled', updated_at = now()
        WHERE exclusion_group = $1 AND status = 'open'`,
      [REVIEW_GROUP(g.id)]
    );
  } else if (g.status === "active") {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('mandate_review', $1, 'standard', $2, $3, $4, $5)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             ${LABEL_ON_REOPEN_SQL},
             updated_at = now()
         WHERE actions.status IN ('done', 'superseded', 'cancelled')
           -- A mandate's Grantmaker works in one long session that wakes
           -- on what it subscribed to and on the check-ins it set
           -- (mandate-review.ts). A fresh pass opens only when it has
           -- none live: the first, after fresh_start, or after a session
           -- expired or closed.
           AND NOT EXISTS (
             SELECT 1 FROM grants gg JOIN agent_sessions sx ON sx.id = gg.grantmaker_session_id
              WHERE gg.id::text = EXCLUDED.target_ref
                AND sx.status IN ('running', 'waiting', 'ready'))`,
      [
        REVIEW_GROUP(g.id),
        g.id,
        `Mandate review for "${g.name}"`,
        await reviewPassBudgetMicroUsd(g, "review", share),
        currentLabel(),
      ]
    );
  }
}

/**
 * One live mandate's rows in the sweep: its planning row while it is being
 * planned, its review row on the review cadence, and its plan. Called at
 * the mandate's label. Returns false when the plan could not be
 * materialized (logged and reported).
 */
async function reconcileMandate(g: PlanGrantRow, ctx: MaterializeContext): Promise<boolean> {
  await openMandateSittingRow(g);

  // The plan itself: every item becomes a ledger row or carries a stated
  // reason why it cannot (materializeGrantPlan). One mandate's failure is
  // logged and reported, never allowed to abort the other mandates' plans
  // (#416: a silent abort here left plan items "queued" for days).
  try {
    await materializeGrantPlan(g, ctx);
  } catch (err) {
    await reportPlanFailure(g, err);
    return false;
  }
  return true;
}

/**
 * Open a new mandate's first sitting now: its planning row if it is being
 * planned, its Grantmaker's first review row if it is active. Called where a
 * mandate is funded or approved, so its Grantmaker sits within the
 * executor's next tick, which funds the row from the mandate's escrow
 * (fundGrantSelfActions), and not at the next six-hourly sweep: on
 * 2026-11-13 a breaking-news mandate funded at 21:25 sat at 21:31 only
 * because a deploy restarted the process. Idempotent, at the mandate's
 * label. Never throws: the between-sweeps pass (openFirstSittings) and the
 * sweep retry.
 */
export async function openMandateFirstSitting(grantId: string): Promise<void> {
  try {
    const [g] = await rawQuery<Pick<PlanGrantRow, "id" | "name" | "status" | "mandate">>(
      `SELECT id, name, status, mandate FROM grants WHERE id = $1 AND status IN ('active', 'planning')`,
      [grantId]
    );
    if (g) await runAtMandateLabelOutsideAnyRun(g.id, () => openMandateSittingRow(g));
  } catch (err) {
    console.error(
      `[reconcile] first sitting of mandate ${grantId} not opened: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Between sweeps: the first sitting of every live mandate that has never had
 * one (no planning row while it is planned, no review row once it is
 * active). Only first sittings: a later one opens on what its Grantmaker
 * subscribed to and the check-ins it set (mandate-review.ts), and the sweep
 * reopens one for a mandate whose session ended. This catches every path
 * that makes a mandate (funding, approval, a regrant's spawn, a
 * decomposition) within one scheduler tick. Returns how many it opened.
 */
export async function openFirstSittings(): Promise<number> {
  const fresh = await rawQuery<{ id: string }>(
    `SELECT g.id FROM grants g
      WHERE (g.status = 'planning'
             AND NOT EXISTS (SELECT 1 FROM actions a
                              WHERE a.exclusion_group = 'plan:' || g.id::text))
         OR (g.status = 'active'
             AND NOT EXISTS (SELECT 1 FROM actions a
                              WHERE a.exclusion_group = 'review:' || g.id::text))
      LIMIT 200`
  );
  for (const g of fresh) await openMandateFirstSitting(g.id);
  return fresh.length;
}

/**
 * How much of the work a mandate set going has not settled: rows waiting to
 * run or running that hold an unreleased allocation of the mandate's (its
 * standing orders, its own and its officers' and lookouts' commissions),
 * open or running ingest rows its plan names, and plan items waiting for
 * their ingests (`after`). The mandate's own upkeep (its Grantmaker's
 * sittings, its lookouts' and Correspondents' runs) is not counted: it is
 * not work the mandate is waiting on. What a `work_settled` subscription
 * waits to see reach zero (subscription-router.ts).
 */
export async function mandateWorkInFlight(grantId: string): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT (
       (SELECT count(*) FROM actions a
         WHERE a.status IN ('open', 'running')
           AND a.kind NOT IN ('grant_planning', 'mandate_review', 'lookout_run', 'correspondent_run', 'resume')
           AND EXISTS (SELECT 1 FROM minerval_whole.allocation_money al
                        WHERE al.grant_id = $1 AND al.released_at IS NULL
                          AND al.exclusion_group = a.exclusion_group
                          AND (al.action_id IS NULL OR al.action_id = a.id)))
       + (SELECT count(*) FROM actions a
           WHERE a.status IN ('open', 'running') AND a.kind = 'ingest'
             AND a.target_ref IN (
               SELECT it->>'url' FROM grants g, jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
                WHERE g.id = $1 AND it->>'action' = 'ingest'))
       + (SELECT count(*) FROM grants g, jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
           WHERE g.id = $1 AND it->'ledger'->>'status' = 'waiting'
             AND it->'ledger' ? 'after_wait_from'
             -- Past its most, an item no longer waits for its ingests (an
             -- order that then waits for room is not work set going).
             AND (it->'ledger'->>'after_wait_from')::timestamptz
                   > now() - make_interval(hours => ${AFTER_INGESTS_MAX_WAIT_HOURS}))
     )::int AS n`,
    [grantId]
  );
  return Number(row?.n ?? 0);
}

/**
 * The fewest assessed nodes a sweep is priced for. Every sweep pays for its
 * briefing, its skills and its searches beyond the partition whatever the
 * partition's size, so a small one is priced as if it held this many.
 */
export const CONSISTENCY_SWEEP_MIN_NODES = 20;

export interface ConsistencySweepPrice {
  /** What the row is priced at, and so the sweep's budget, in micro-USD. */
  microUsd: number;
  /** The variant's expected cost per assessed node, in micro-USD. */
  perNodeMicroUsd: number;
  /** Where that per-node figure came from (estimateConsistencyNodeCostMicroUsd). */
  basis: ConsistencyNodeCost["basis"];
  /** The nodes priced: the partition's assessed nodes, at least CONSISTENCY_SWEEP_MIN_NODES. */
  nodesPriced: number;
  /** The variant's ceiling, in micro-USD. */
  capMicroUsd: number;
  /** True when the ceiling, not the size, set the price. */
  capped: boolean;
}

/**
 * What one sweep of a partition costs (#756): the variant's expected cost
 * per assessed node (observed once its sweeps have run, else its model's
 * price times the expected tokens a node takes; cost-estimate-service
 * estimateConsistencyNodeCostMicroUsd) times the partition's assessed
 * nodes (at least CONSISTENCY_SWEEP_MIN_NODES), with the variant's cap as
 * the ceiling only. The price follows the work, so a big tag or the
 * residual bucket gets the budget to be read; what a sweep does not spend
 * settles back.
 */
export function consistencySweepPrice(
  variant: "standard" | "strong",
  assessedNodes: number,
  perNode: ConsistencyNodeCost
): ConsistencySweepPrice {
  const config = loadConfig();
  const ceiling =
    variant === "strong"
      ? owlsToMicroUsd(config.capConsistencySweepStrongOwls)
      : capMicroUsd("consistency_sweep");
  const nodesPriced = Math.max(CONSISTENCY_SWEEP_MIN_NODES, Math.max(0, Math.floor(assessedNodes)));
  const bySize = Math.round(perNode.microUsd * nodesPriced);
  return {
    microUsd: Math.min(ceiling, bySize),
    perNodeMicroUsd: perNode.microUsd,
    basis: perNode.basis,
    nodesPriced,
    capMicroUsd: ceiling,
    capped: bySize > ceiling,
  };
}

/** A sweep of `variant` over `assessedNodes`, priced at the current per-node estimate (#756). */
export async function priceConsistencySweep(
  variant: "standard" | "strong",
  assessedNodes: number
): Promise<ConsistencySweepPrice> {
  return consistencySweepPrice(
    variant,
    assessedNodes,
    await estimateConsistencyNodeCostMicroUsd(variant, CONSISTENCY_SWEEP_MIN_NODES)
  );
}

async function reconcileConsistencySweeps(): Promise<void> {
  const config = loadConfig();
  if (!config.consistencySweepsEnabled) {
    await rawQuery(
      `UPDATE actions SET status = 'cancelled', updated_at = now()
        WHERE kind = 'consistency_sweep' AND status = 'open'`
    );
    return;
  }
  // A sweep whose process died leaves its row 'running'; close it so the
  // coverage record reads true and the partition can be due again.
  await reclaimAbandonedSweeps();
  // Where a deployment has more than one label the rows are opened label
  // by label. A row names its partition's tag and is priced by how many
  // judged nodes the partition holds, so it is made from what the label it
  // is at reads: the partitions are listed inside each label, and a label
  // opens a row only for a partition where a judgment of its own has been
  // recorded since that label last swept it. Each label's rows have that
  // label's own key (CONSISTENCY_GROUP).
  if (oneLabelOnly()) return openDueConsistencySweeps(config.consistencyMinTagClaims);
  const { everyLabel } = await import("./label-service.js");
  for (const label of await everyLabel()) {
    await runAtLabel(label, `consistency sweeps at ${label}`, () => openDueConsistencySweeps(config.consistencyMinTagClaims));
  }
}

/** Open the rows of the partitions due a sweep at the label of the work in progress, and close those no longer due. */
async function openDueConsistencySweeps(minTagClaims: number): Promise<void> {
  // Every due partition gets its rows: a partition is due at most once
  // per re-sweep interval, and the General mandate's escrow and day room
  // decide how many are bought.
  const due = (await duePartitions(minTagClaims)).filter((p) => oneLabelOnly() || p.changedAtOwnLabel > 0);
  const refs = due.map((p) => CONSISTENCY_GROUP(partitionRef(p)));
  // A partition no longer due loses its open rows, so open rows never
  // pile up across days, unless a live mandate's plan names it (a sweep
  // item still waiting for its sweep, #831): those rows are the mandate's
  // to fund, and the plan materializer reopens them anyway.
  await rawQuery(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.kind = 'consistency_sweep' AND a.status = 'open'${oneLabelOnly() ? "" : " AND a.sensitivity_label = minerval_write_label()"}
        AND NOT (a.exclusion_group = ANY($1::text[]))
        AND NOT EXISTS (SELECT 1 FROM minerval_whole.allocation_money al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL)
        AND NOT EXISTS (
              SELECT 1 FROM grants g,
                     jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) item
               WHERE g.status = 'active'
                 AND item->>'action' = 'sweep'
                 AND item->'ledger'->>'exclusion_group' = a.exclusion_group
                 AND item->'ledger'->>'status' IN ('open', 'running'))`,
    [refs]
  );
  const perNode = {
    standard: await estimateConsistencyNodeCostMicroUsd("standard", CONSISTENCY_SWEEP_MIN_NODES),
    strong: await estimateConsistencyNodeCostMicroUsd("strong", CONSISTENCY_SWEEP_MIN_NODES),
  };
  for (const p of due) {
    const ref = partitionRef(p);
    // Each variant is priced by the partition's size (#756). A row still
    // open takes the new price too, so a partition that grew while its row
    // waited is funded for what it now holds.
    for (const variant of ["standard", "strong"] as const) {
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
         VALUES ('consistency_sweep', $1, $2, $3, $4, $5, $6)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
               ${LABEL_ON_REOPEN_SQL},
               updated_at = now()
           WHERE actions.status IN ('done', 'superseded', 'cancelled')
              OR (actions.status = 'open'
                  AND actions.cost_est_micro_usd <> EXCLUDED.cost_est_micro_usd)`,
        [
          CONSISTENCY_GROUP(ref),
          variant,
          ref,
          `Consistency sweep${variant === "strong" ? " (strong)" : ""}: ${p.label}`,
          consistencySweepPrice(variant, p.assessed, perNode[variant]).microUsd,
          currentLabel(),
        ]
      );
    }
  }
}

/**
 * Open (or keep) the formalize row for a claim that has no published
 * statement: group `formalize:<claim_id>`, one variant. A closed row is
 * wanted again after FORMALIZE_RETRY_HOURS while the claim still lacks a
 * published statement (a returned-to-draft statement retried on the
 * review cadence); a claim with a published statement opens nothing.
 */
export async function ensureFormalizeAction(
  claimId: string,
  costEstMicroUsd: number
): Promise<void> {
  await rawQuery(
    `INSERT INTO actions
       (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd, sensitivity_label)
     SELECT 'formalize', $1, 'standard', c.id,
            'Formalize: ' || left(c.text, 280), $3, $4
       FROM claims c
      WHERE c.id = $2 AND c.state = 'active'${ownWorkSql("c")}
        AND NOT EXISTS (SELECT 1 FROM claim_formalizations f
                         WHERE f.claim_id = c.id AND f.status = 'published')
     ON CONFLICT (exclusion_group, variant) DO UPDATE
       SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
           ${LABEL_ON_REOPEN_SQL},
           status = 'open', updated_at = now()
       WHERE actions.status IN ('done', 'cancelled', 'superseded')
         AND actions.updated_at < now() - make_interval(hours => ${FORMALIZE_RETRY_HOURS})`,
    [FORMALIZE_GROUP(claimId), claimId, Math.round(costEstMicroUsd), currentLabel()]
  );
}

/**
 * Open the next attempt group on a claim's published statement when the
 * plan asks for more attempts than the ledger has opened: group
 * `attempt:<formalization_id>:<n>` with `n` one more than the closed
 * attempts on that statement, and the two variants as sibling rows. Each
 * plan item entitles one group; a group still open or running blocks the
 * next; a claim without a published statement opens nothing; and the next
 * group waits out the mandate's `attempt_cooldown_days` after the last
 * closed attempt unless the item entitling it states a reason (§7.2).
 *
 * Whether a reason is good enough is the Grantmaker's judgment, stated in
 * the item's public rationale and open to audit, not a test of its length
 * (#763): the skill tells it to say what changed since the last attempt,
 * and the Audit Agent reads the item and its rationale (plan_items in
 * query_sql). What
 * bounds repeated attempts on one claim is money: the per-claim lifetime
 * cap and the Grantmaker's valuation.
 */
export interface EnsureAttemptResult {
  /** The published statement the groups hang off, when there is one. */
  formalizationId: string | null;
  /** Attempt groups on that statement after this call. */
  groups: number;
  /** True when this call opened a new group. */
  opened: boolean;
  /** Why no group was opened, in words the plan's author can act on. */
  reason: string | null;
}

export async function ensureAttemptActions(
  claimId: string,
  wantedGroups: number,
  costs: { standard: number; max: number },
  opts: { cooldownDays?: number; rationales?: readonly string[] } = {}
): Promise<EnsureAttemptResult> {
  const [formalization] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_formalizations
      WHERE claim_id = $1 AND status = 'published'`,
    [claimId]
  );
  if (!formalization) {
    return {
      formalizationId: null,
      groups: 0,
      opened: false,
      reason:
        "the claim has no published formal statement; an attempt opens only " +
        "once a formalize item has published one (docs/mathematics.md §7.2)",
    };
  }
  const [state] = await rawQuery<{ groups: number; live: number }>(
    `SELECT COUNT(DISTINCT exclusion_group)::int AS groups,
            COUNT(*) FILTER (WHERE status IN ('open', 'running'))::int AS live
       FROM actions
      WHERE kind = 'attempt_proof' AND exclusion_group LIKE $1`,
    [`attempt:${formalization.id}:%`]
  );
  const groups = Number(state?.groups ?? 0);
  const live = Number(state?.live ?? 0);
  const base = { formalizationId: formalization.id, groups, opened: false };
  if (live > 0) {
    return {
      ...base,
      reason: "an earlier attempt on this statement is still open or running; the next group opens when it closes",
    };
  }
  if (groups >= wantedGroups) return { ...base, reason: null };
  const cooldownDays = Math.max(0, Number(opts.cooldownDays ?? 0));
  if (cooldownDays > 0) {
    const [last] = await rawQuery<{ finished_at: Date }>(
      `SELECT finished_at FROM proof_attempts
        WHERE formalization_id = $1 AND finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1`,
      [formalization.id]
    );
    const withinCooldown =
      !!last && new Date(last.finished_at).getTime() > Date.now() - cooldownDays * 86_400_000;
    if (withinCooldown) {
      const rationales = opts.rationales ?? [];
      const rationale = rationales[groups] ?? rationales[rationales.length - 1] ?? "";
      if (!rationale.trim()) {
        return {
          ...base,
          reason:
            `the last attempt closed within the mandate's ${cooldownDays}-day cooldown; ` +
            "the entitling item's rationale must say what changed since then (a new lemma formalized, " +
            "a route the prior report could not pursue) for the attempt to open sooner",
        };
      }
    }
  }
  const n = groups + 1;
  for (const variant of ATTEMPT_VARIANTS) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, claim_id, target_ref, label, cost_est_micro_usd, sensitivity_label)
       SELECT 'attempt_proof', $1, $2, c.id, $3,
              'Attempt ' || $4::text || ' (' || $2 || '): ' || left(c.text, 260), $5, $7
         FROM claims c
        WHERE c.id = $6 AND c.state = 'active'
       ON CONFLICT (exclusion_group, variant) DO NOTHING`,
      [
        ATTEMPT_GROUP(formalization.id, n),
        variant,
        formalization.id,
        String(n),
        Math.round(costs[variant]),
        claimId,
        currentLabel(),
      ]
    );
  }
  return { formalizationId: formalization.id, groups: n, opened: true, reason: null };
}

// ---------------------------------------------------------------------------
// Plan-to-ledger materialization: every plan item becomes a ledger row or
// carries a stated reason why it cannot, written back onto the item itself
// (`ledger`) so the mandate's Grantmaker, the dashboard, and the Audit
// Agent all read the same state (#416).
// ---------------------------------------------------------------------------

/**
 * A plan item's standing on the ledger, as stored on the item:
 *  - open / running / done / cancelled mirror the row (superseded reads as
 *    done: a sibling won);
 *  - waiting: a precondition the platform satisfies on its own (a statement
 *    still to be published, a live earlier attempt, a cooldown);
 *  - blocked: something the plan's author must change (a claim that is not
 *    active, a formalize item on a claim whose domains carry no
 *    publish_formalization tool, a materializer error).
 */
export type PlanItemLedgerStatus =
  | "open"
  | "running"
  | "done"
  | "cancelled"
  | "waiting"
  | "blocked";

export interface PlanItemLedger {
  status: PlanItemLedgerStatus;
  /** For waiting/blocked (always) and closed rows (when useful): why. */
  reason?: string;
  action_id?: string;
  exclusion_group?: string;
  /** ISO timestamp of the sweep or call that last wrote this. */
  checked_at: string;
  /**
   * sweep items only: when the item first opened its partition's rows. A
   * sweep of the partition that finishes after this is the one the item
   * asked for (the rows are shared and reopened, so the row's own status
   * cannot say).
   */
  since?: string;
  /**
   * assess/reassess/deepen: the commission this item's standing order
   * placed on the node's pass (standing-order-service.ts), once it has.
   */
  order?: { budget_owls: number; tier: "standard" | "strong"; placed_at: string };
  /**
   * deepen only: the node's children this item has ordered a pass on (or
   * found already paid for), so each is ordered once per item.
   */
  children?: string[];
  /**
   * deepen only: the node's unassessed children the item has not been able
   * to commission yet, by id, so its standing names them (#961).
   */
  children_waiting?: string[];
  /**
   * deepen only, while the item still waits on its children: when the
   * node's own pass was seen finished.
   */
  ran_at?: string;
  /**
   * assess/reassess/deepen with `after`: when the item first waited for the
   * ingests it names, which its wait is counted from
   * (AFTER_INGESTS_MAX_WAIT_HOURS).
   */
  after_wait_from?: string;
}

/** The plan item shape the materializer reads (a loose PlanItem). */
export interface MaterializablePlanItem {
  action: string;
  url?: string;
  claim_id?: string;
  variant?: string;
  rationale?: string;
  /** assess/reassess/deepen: the budget of each pass the item commissions; absent = the row's estimate. */
  budget_owls?: number;
  /** assess/reassess/deepen: the plan's ingest urls its pass waits for (grant-service.ts, PlanItem.after). */
  after?: string[];
  /** ingest only: read the document for this subject (ingest-focus-service.ts). */
  focus?: string;
  /** sweep only: a topic tag's slug, or "residual". */
  partition?: string;
  /** In place of claim_id: the ref of a propose item in the same plan (#656). */
  claim_ref?: string;
  /** propose only: its label, the kind and wording proposed, and the contribution it filed. */
  ref?: string;
  kind?: string;
  text?: string;
  contribution_id?: string;
  /**
   * assess/reassess/deepen: set when the Grantmaker withdrew the item
   * (amend_plan_items). It orders nothing more, and what it had placed and
   * not yet started is released (plan-amend-service.ts).
   */
  withdrawn?: { at: string; note?: string; returned_owls?: number };
  ledger?: PlanItemLedger;
  [key: string]: unknown;
}

export interface PlanGrantRow {
  id: string;
  name: string;
  status: string;
  policy: string;
  plan: { strategy?: string; items?: MaterializablePlanItem[] } | null;
  plan_cursor: number;
  scope_claim_id?: string | null;
  mandate?: {
    grantmaker_share_owls?: number | null;
    scope_ref?: string | null;
    operating_policy?: OperatingPolicy | null;
  } | null;
}

/**
 * For a mandate whose Grantmaker passes have a share of the budget of
 * their own (`mandate.grantmaker_share_owls`, a decomposition's tenth):
 * the share and what is left of it after the planning and review passes
 * metered so far. Null for every other mandate, whose passes are funded
 * out of its day like the rest of its work.
 */
export async function grantmakerShareLeftMicroUsd(g: {
  id: string;
  mandate?: { grantmaker_share_owls?: number | null } | null;
}): Promise<{ totalMicroUsd: number; leftMicroUsd: number } | null> {
  const owls = Number(g.mandate?.grantmaker_share_owls ?? 0);
  if (!(owls > 0)) return null;
  const totalMicroUsd = Math.round(owls * (loadConfig().owlCostMicroUsd ?? 1_000_000));
  const [row] = await rawQuery<{ spent: string }>(
    `SELECT COALESCE(SUM(metered_cost_micro_usd), 0)::bigint AS spent
       FROM actions
      WHERE kind IN ('grant_planning', 'mandate_review') AND target_ref = $1
        AND status = 'done'`,
    [g.id]
  );
  return { totalMicroUsd, leftMicroUsd: totalMicroUsd - Number(row?.spent ?? 0) };
}

/**
 * The budget a mandate's review or planning pass is opened at: the one
 * figure every site that opens or reopens that row writes as its estimate
 * (the reconcile sweep, the wake on new events, continue_review), so the
 * row never carries a stale or unrelated one (#820: it carried the public
 * assessment price cap, a deployment constant that knows nothing about the
 * mandate).
 *
 *  - a review pass: the figure the mandate's operating policy names
 *    (review_pass_owls), or the platform's default while it names none;
 *  - a planning pass: the platform's default, since it runs before there
 *    is a policy;
 *  - a mandate whose Grantmaker passes have a share of their own (a
 *    decomposition): half the share for the opening plan, and what the
 *    share has left for each review.
 *
 * A ceiling: it is held against the mandate's day and escrow while the pass
 * runs and settles to what the pass metered. When the day or the escrow
 * cannot fund it whole, the pass is started with what there is and told so
 * (allocation-service.ts, fundGrantSelfActions).
 */
export async function reviewPassBudgetMicroUsd(
  g: {
    id: string;
    mandate?: { grantmaker_share_owls?: number | null; operating_policy?: OperatingPolicy | null } | null;
  },
  pass: "review" | "planning" = "review",
  /** The share, when the caller has already read it; undefined reads it. */
  share?: { totalMicroUsd: number; leftMicroUsd: number } | null
): Promise<number> {
  const own = share === undefined ? await grantmakerShareLeftMicroUsd(g) : share;
  if (own) return Math.max(1, Math.round(pass === "planning" ? own.totalMicroUsd / 2 : own.leftMicroUsd));
  return reviewPassBudget(pass === "review" ? g.mandate?.operating_policy : null).microUsd;
}

export interface PlanItemOutcome {
  index: number;
  action: string;
  claim_id?: string;
  url?: string;
  ledger: PlanItemLedger;
}

/** Per-sweep memo of the cost estimates the rows carry. */
interface MaterializeContext {
  /** What an ingest row is priced at: the ledger's own figure for ingests (estimateLedgerKindCostMicroUsd). */
  ingestCostMicroUsd: () => Promise<number>;
  formalizeCostMicroUsd: () => Promise<number>;
  /** The graph's sweep partitions, read once per sweep when a plan names one. */
  partitions: () => Promise<PartitionStatus[]>;
}

function newMaterializeContext(): MaterializeContext {
  // The strong-tier estimate the formalize rows carry (two strong passes),
  // computed once per sweep and only when some plan asks for one.
  let strongPassMicroUsd: number | null = null;
  let partitions: Promise<PartitionStatus[]> | null = null;
  let ingestMicroUsd: Promise<number> | null = null;
  return {
    partitions: () =>
      (partitions ??= listPartitions(loadConfig().consistencyMinTagClaims)),
    ingestCostMicroUsd: () => (ingestMicroUsd ??= estimateLedgerKindCostMicroUsd("ingest")),
    formalizeCostMicroUsd: async () => {
      if (strongPassMicroUsd === null) {
        strongPassMicroUsd = (await stewardTierCostEstimates()).strongMicroUsd;
      }
      return Math.round(strongPassMicroUsd * 2);
    },
  };
}

/** Whether the claim is one a formal statement is for: the formalize gate. */
async function formalizeToolGap(claimId: string): Promise<string | null> {
  // Lazy: steward-direct pulls the LLM tool registry in, which this
  // mechanism module must not load at import time (queue-service imports
  // us; the registry imports the services).
  const { missingTriggerTools } = await import("../workers/steward-direct.js");
  const { skills, missing } = await missingTriggerTools("formalize", claimId);
  if (missing.length === 0) return null;
  return (
    `the claim's recorded domains point to ${
      skills.length > 0 ? `the skill(s) ${skills.join(", ")}` : "no skill"
    }, none of which declares ${missing.join(", ")} for the Steward; a formalize ` +
    "run would be refused. Tag the claim with the domain whose skill declares " +
    "the tool (mathematics; a Steward pass with set_claim_domains) or drop the item"
  );
}

/** The ledger status one exclusion group (or one row) reads as. */
/**
 * A finished ingest of this address (and focus) at another label that the
 * work in progress reads, or null. Work at each label has its own ingest
 * group, and an ingest finished at a label this one reads has already put
 * the document's claims where this work reads them.
 */
async function ingestDoneAtALabelRead(
  url: string,
  focus: string | null
): Promise<Awaited<ReturnType<typeof groupLedger>>> {
  if (oneLabelOnly()) return null;
  const own = currentLabel();
  const [reads] = await rawQuery<{ labels: string[] }>(
    `SELECT minerval_labels_readable_from(ARRAY[$1::text]) AS labels`,
    [own]
  );
  const groups = (reads?.labels ?? []).filter((l) => l !== own).map((l) => INGEST_GROUP(url, focus, l));
  if (groups.length === 0) return null;
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE exclusion_group = ANY($1::text[]) AND status = 'done'
      ORDER BY updated_at DESC LIMIT 1`,
    [groups]
  );
  return row ? groupLedger({ actionId: row.id }) : null;
}

async function groupLedger(
  where: { group: string } | { actionId: string }
): Promise<{
  status: "open" | "running" | "done" | "cancelled";
  action_id: string;
  exclusion_group: string;
  /** The row's wait on a platform fault, when it is open and has one. */
  fault?: FaultWait;
} | null> {
  type Row = { id: string; status: string; exclusion_group: string } & FaultWaitRow;
  const rows =
    "group" in where
      ? await rawQuery<Row>(
          `SELECT id, status, exclusion_group, fault_reason, fault_since, fault_attempts, retry_after FROM actions
            WHERE exclusion_group = $1
            ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'open' THEN 1
                                 WHEN 'done' THEN 2 WHEN 'superseded' THEN 3
                                 ELSE 4 END, updated_at DESC
            LIMIT 1`,
          [where.group]
        )
      : await rawQuery<Row>(
          `SELECT id, status, exclusion_group, fault_reason, fault_since, fault_attempts, retry_after
             FROM actions WHERE id = $1`,
          [where.actionId]
        );
  const row = rows[0];
  if (!row) return null;
  const status =
    row.status === "running" || row.status === "open" || row.status === "cancelled"
      ? row.status
      : "done";
  const fault = status === "open" ? faultWait(row) : null;
  return { status, action_id: row.id, exclusion_group: row.exclusion_group, ...(fault ? { fault } : {}) };
}

interface ClaimStanding {
  id: string;
  state: string;
  steward_state: string;
  published: boolean;
  /** When the claim's current assessment was made; null while unassessed. */
  assessed_at: Date | null;
  /** The public class of the last genuine failure a Steward lane recorded, if any. */
  steward_error_reason: string | null;
  steward_attempts: number;
}

async function claimStanding(claimId: string): Promise<ClaimStanding | null> {
  const [row] = await rawQuery<ClaimStanding>(
    `SELECT c.id, c.state, ${slotColumnSql("steward_state")} AS steward_state,
            ${slotColumnSql("steward_error_reason")} AS steward_error_reason,
            COALESCE(${slotColumnSql("steward_attempts")}, 0) AS steward_attempts,
            EXISTS (SELECT 1 FROM claim_formalizations f
                     WHERE f.claim_id = c.id AND f.status = 'published') AS published,
            -- Each kind keeps its current assessment in its own table: a
            -- proposition's verdict, a quantity's estimate, a question's
            -- standing. GREATEST skips the NULLs of the other two.
            GREATEST(
              (SELECT MAX(x.assessed_at) FROM assessments_in_force x
                WHERE x.claim_id = c.id),
              (SELECT MAX(q.assessed_at) FROM quantity_estimates_in_force q
                WHERE q.claim_id = c.id),
              (SELECT MAX(qa.assessed_at) FROM question_assessments_in_force qa
                WHERE qa.claim_id = c.id)
            ) AS assessed_at
       FROM claims c WHERE c.id = $1`,
    [claimId]
  );
  return row ?? null;
}

/** Was the claim assessed after the moment `sinceIso` (an item's standing was written)? */
function assessedSince(claim: ClaimStanding, sinceIso: string | undefined): boolean {
  if (!claim.assessed_at || !sinceIso) return false;
  const since = Date.parse(sinceIso);
  return Number.isFinite(since) && new Date(claim.assessed_at).getTime() > since;
}

const nowIso = () => new Date().toISOString();
const waiting = (reason: string): PlanItemLedger => ({ status: "waiting", reason, checked_at: nowIso() });
const blocked = (reason: string): PlanItemLedger => ({ status: "blocked", reason, checked_at: nowIso() });
const fromRow = (
  row: { status: PlanItemLedgerStatus; action_id: string; exclusion_group: string; fault?: FaultWait },
  reason?: string
): PlanItemLedger => {
  // An open row a platform fault is holding says so (#971): the item reads
  // open, with the reason a payer would otherwise have to guess.
  const why = reason ?? (row.status === "open" && row.fault ? faultWaitSentence(row.fault) : undefined);
  return {
    status: row.status,
    action_id: row.action_id,
    exclusion_group: row.exclusion_group,
    ...(why ? { reason: why } : {}),
    checked_at: nowIso(),
  };
};

/**
 * Materialize one mandate's whole plan: cursor bookkeeping and ingest rows
 * (any live grant), and the stewarding, formal-statement and attempt rows
 * (an active mandate only, since they cost strong-tier money), then write
 * each item's ledger standing back onto the plan. Returns every item's
 * outcome in plan order. Throws only on a failure outside any one item
 * (loading the grant, the plan write); a single item's error becomes that
 * item's `blocked` reason.
 */
export async function materializeGrantPlan(
  g: PlanGrantRow,
  ctx: MaterializeContext = newMaterializeContext()
): Promise<PlanItemOutcome[]> {
  const items = g.plan?.items ?? [];
  const outcomes: PlanItemOutcome[] = [];

  // Plan cursor bookkeeping. An ingest item whose ledger action is DONE is
  // finished work: the cursor moves past it. Done AND cancelled both move
  // the cursor: a cancelled ingest (a poison URL the executor retired) must
  // not wedge the plan forever behind it. A group with only open/running
  // rows still blocks. Only ingest items are cursor-driven: every other
  // kind reports through its own ledger standing below.
  let cursor = g.plan_cursor;
  while (cursor < items.length) {
    const item = items[cursor]!;
    if (item.action !== "ingest" || !item.url) break;
    const [closed] = await rawQuery<{ id: string }>(
      `SELECT id FROM actions
        WHERE exclusion_group = $1 AND status IN ('done', 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM actions o
                           WHERE o.exclusion_group = $1
                             AND o.status IN ('open', 'running'))
        LIMIT 1`,
      [INGEST_GROUP(item.url, normalizeFocus(item.focus))]
    );
    if (!closed && !(await ingestDoneAtALabelRead(item.url, normalizeFocus(item.focus)))) break;
    cursor++;
  }
  if (cursor !== g.plan_cursor) {
    await rawQuery(
      `UPDATE grants SET plan_cursor = $2, updated_at = now()
        WHERE id = $1 AND plan_cursor = $3`,
      [g.id, cursor, g.plan_cursor]
    );
  }

  const active = g.status === "active";
  const notActive = waiting(
    `the mandate is ${g.status}, not active; this work opens once it is`
  );

  // Proposals first (#656): a propose item files its contribution and reads
  // its review, and an item that names it by claim_ref takes the node's id
  // once there is one. From then on it is an ordinary item, so everything
  // below, and every reader of the plan, sees a claim_id.
  const early = await materializeProposals(g, items, { active, notActive });

  // attempt_proof entitlement is per claim across items: the n-th item on a
  // claim entitles the n-th group, and its rationale is what may waive the
  // cooldown (§7.2). Resolve each claim once, then read every item's group.
  const attemptItems = new Map<string, number[]>();
  for (let i = 0; i < items.length; i++) {
    const it = items[i]!;
    if (it.action !== "attempt_proof" || !it.claim_id) continue;
    const list = attemptItems.get(it.claim_id) ?? [];
    list.push(i);
    attemptItems.set(it.claim_id, list);
  }
  const attemptResults = new Map<string, EnsureAttemptResult>();
  // No attempt group opens while the solver's feature is off; the items say
  // why (materializePlanItem).
  if (active && attemptItems.size > 0 && !actionUnavailable("attempt_proof")) {
    const policy = await getMandateAllocationPolicy(g.id);
    const owl = loadConfig().owlCostMicroUsd;
    const costs = {
      standard: Math.round(policy.est_attempt_standard_cost_owls * owl),
      max: Math.round(policy.est_attempt_max_cost_owls * owl),
    };
    for (const [claimId, indices] of attemptItems) {
      try {
        // Rows the mandate's plan asks for: at the mandate's label, as for
        // a formalize row below.
        attemptResults.set(
          claimId,
          await ensureAttemptActions(claimId, indices.length, costs, {
            cooldownDays: Number(policy.attempt_cooldown_days ?? 0),
            rationales: indices.map((i) => String(items[i]!.rationale ?? "")),
          })
        );
      } catch (err) {
        console.error(
          `[reconcile] ensureAttemptActions failed for claim ${claimId} (mandate ${g.id}): ${
            err instanceof Error ? err.message : String(err)
          }`
        );
      }
    }
  }

  const ensuredFormalize = new Set<string>();
  // Standing orders are asked for in plan order, and each is placed when
  // the pace's room covers it: one the pace turns away waits without holding
  // the ones after it (#956). The queue carries the room across the look.
  const orderQueue: { rateRoomMicroUsd: number | null } = { rateRoomMicroUsd: null };
  let started = -1;
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    let ledger: PlanItemLedger;
    try {
      ledger = (await materializeWithdrawn(item, i, items, g.id)) ?? early.get(i) ?? await materializePlanItem(item, i, {
        grantId: g.id,
        orderQueue,
        ctx,
        cursor,
        active,
        notActive,
        ensuredFormalize,
        attemptOrdinal: attemptItems.get(item.claim_id ?? "")?.indexOf(i) ?? -1,
        attemptResult: attemptResults.get(item.claim_id ?? "") ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] plan item ${i} (${item.action}) of mandate ${g.id} failed: ${msg}`);
      ledger = blocked(`the materializer failed on this item: ${msg}`);
    }
    if (active && item.action === "ingest" && item.url && (ledger.status === "running" || ledger.status === "done")) {
      await attributeIngestedSource(g.id, item.url, normalizeFocus(item.focus)).catch((err: unknown) =>
        console.error(
          `[reconcile] attributing ${item.url} to mandate ${g.id} failed: ${err instanceof Error ? err.message : String(err)}`
        )
      );
    }
    outcomes.push({
      index: i,
      action: item.action,
      ...(item.claim_id ? { claim_id: item.claim_id } : {}),
      ...(item.url ? { url: item.url } : {}),
      ledger,
    });
    if (!sameLedger(item.ledger, ledger)) {
      // One item at a time, by path: an extend_plan append racing this
      // sweep must not be overwritten by a whole-array write.
      await rawQuery(
        `UPDATE grants
            SET plan = jsonb_set(plan, $2::text[], $3::jsonb)
          WHERE id = $1 AND jsonb_array_length(COALESCE(plan->'items', '[]'::jsonb)) > $4`,
        [g.id, ["items", String(i), "ledger"], JSON.stringify(ledger), i]
      );
    }
    // Work that has started: it ran, is running, or was retired on the
    // ledger. One meaning everywhere an agent meets the word (adjust_plan,
    // amend_plan_items): an order that is placed and still waiting its turn
    // has not started, so its Grantmaker can still change or withdraw it.
    if (
      ledger.status === "running" || ledger.status === "done" ||
      (ledger.status === "cancelled" && ledger.action_id) ||
      ledger.ran_at
    ) {
      started = i;
    }
  }
  // The cursor marks the plan's started prefix, which adjust_plan keeps: it
  // moves past the last item whose work has started. (The direct steward
  // lane used to move it as it claimed each claim item; with every pass a
  // commission, the items' own standing says where the plan has got to.)
  if (started + 1 > cursor) {
    await rawQuery(
      `UPDATE grants SET plan_cursor = GREATEST(plan_cursor, $2), updated_at = now() WHERE id = $1`,
      [g.id, started + 1]
    );
  }
  return outcomes;
}

/**
 * Whether a stewarding item that names ingests (`after`) waits for them:
 * the waiting standing, naming each unread ingest and the hour it waits
 * until, or none, with a note when the wait ran out. An ingest is read when
 * it has rows and none of them is open or running (done, or cancelled as
 * unreadable); one with no row yet has not been read. The wait counts from
 * `since`, when the item first waited, and lasts at most
 * AFTER_INGESTS_MAX_WAIT_HOURS (grant-service.ts says why).
 */
async function ingestsGate(
  urls: readonly string[],
  since: string | undefined
): Promise<{ wait: PlanItemLedger | null; note: string | null; from?: string }> {
  const unread = await rawQuery<{ url: string }>(
    `SELECT u.url FROM unnest($1::text[]) u(url)
      WHERE NOT EXISTS (SELECT 1 FROM actions a WHERE a.kind = 'ingest' AND a.target_ref = u.url)
         OR EXISTS (SELECT 1 FROM actions a
                     WHERE a.kind = 'ingest' AND a.target_ref = u.url AND a.status IN ('open', 'running'))`,
    [[...urls]]
  );
  if (unread.length === 0) return { wait: null, note: null };
  const from = since && Number.isFinite(new Date(since).getTime()) ? since : nowIso();
  const until = new Date(new Date(from).getTime() + AFTER_INGESTS_MAX_WAIT_HOURS * 3_600_000);
  const names = unread.map((r) => r.url).join(", ");
  if (until.getTime() <= Date.now()) {
    return {
      wait: null,
      from,
      note:
        `placed without waiting longer for ${unread.length} of the ingests it names (${names}): ` +
        `an item waits at most ${AFTER_INGESTS_MAX_WAIT_HOURS} hours for its ingests; a reassess item ` +
        `after they are read is the way to weigh them`,
    };
  }
  return {
    wait: {
      status: "waiting",
      reason:
        `waiting for ${unread.length} of the ingests it names to be read before its pass is placed ` +
        `(${names}); it is placed at the next look after they are, and at the latest at ` +
        `${until.toISOString().slice(0, 16).replace("T", " ")} UTC, the most an item waits ` +
        `(${AFTER_INGESTS_MAX_WAIT_HOURS} hours), so a stuck extraction cannot hold it forever. ` +
        `It holds no money while it waits.`,
      after_wait_from: from,
      checked_at: nowIso(),
    },
    note: null,
  };
}

function sameLedger(a: PlanItemLedger | undefined, b: PlanItemLedger): boolean {
  if (!a) return false;
  return (
    a.status === b.status &&
    (a.reason ?? null) === (b.reason ?? null) &&
    (a.action_id ?? null) === (b.action_id ?? null) &&
    (a.exclusion_group ?? null) === (b.exclusion_group ?? null) &&
    JSON.stringify(a.order ?? null) === JSON.stringify(b.order ?? null) &&
    JSON.stringify(a.children ?? null) === JSON.stringify(b.children ?? null) &&
    JSON.stringify(a.children_waiting ?? null) === JSON.stringify(b.children_waiting ?? null)
  );
}

const STEWARDING_KINDS = new Set(["assess", "reassess", "deepen"]);

/**
 * The standing of a stewarding item its Grantmaker withdrew
 * (amend_plan_items), or null for any other item. What the item had placed
 * and not yet started is released, on every look until nothing is left, so
 * a withdrawal that raced a placement still ends with the money back. A
 * pass that was already running finishes: money that is being spent is not
 * taken from under a run.
 */
async function materializeWithdrawn(
  item: MaterializablePlanItem,
  index: number,
  items: readonly MaterializablePlanItem[],
  grantId: string
): Promise<PlanItemLedger | null> {
  if (!item.withdrawn || !STEWARDING_KINDS.has(item.action)) return null;
  const prior = item.ledger;
  // Settled: the work ran before the withdrawal, or the withdrawal is recorded.
  if (prior?.status === "done") return prior;
  if (prior?.status === "cancelled" && !prior.action_id) return prior;
  const orders = await import("./standing-order-service.js");
  const said =
    `withdrawn by the mandate's Grantmaker on ${String(item.withdrawn.at).slice(0, 10)}` +
    (item.withdrawn.note ? ` (${item.withdrawn.note})` : "");
  // What the withdrawal itself released (plan-amend-service.ts), plus
  // anything placed since: a sweep can race the tool by one placement.
  let back = Math.round(Number(item.withdrawn.returned_owls ?? 0) * loadConfig().owlCostMicroUsd);
  if (item.claim_id) {
    if (prior?.order) back += await orders.releaseStandingOrder(grantId, item.claim_id);
    for (const child of prior?.children ?? []) {
      // A child another item of this plan ordered in its own right keeps that order.
      const theirs = items.some(
        (other, j) => j !== index && other.claim_id === child && !other.withdrawn && other.ledger?.order
      );
      if (!theirs) back += await orders.releaseStandingOrder(grantId, child);
    }
  }
  const row = prior?.action_id ? await groupLedger({ actionId: prior.action_id }) : null;
  if (prior?.ran_at || (prior?.order && row?.status === "done")) {
    return {
      status: "done",
      ...(prior.action_id ? { action_id: prior.action_id } : {}),
      ...(prior.exclusion_group ? { exclusion_group: prior.exclusion_group } : {}),
      ...(prior.order ? { order: prior.order } : {}),
      ...(prior.children?.length ? { children: prior.children } : {}),
      reason: `${said}, after its node's pass had run; nothing more is ordered for it`,
      checked_at: nowIso(),
    };
  }
  if (prior?.order && row?.status === "running") {
    return {
      ...fromRow(row, `${said}, after its pass had begun: that pass finishes and settles, and nothing more is ordered for it`),
      order: prior.order,
      ...(prior.children?.length ? { children: prior.children } : {}),
    };
  }
  return {
    status: "cancelled",
    reason:
      `${said} before its pass began. ` +
      (back > 0
        ? `The ${microUsdToOwls(back)} owls it held are back in the escrow and in the pace's room.`
        : "It held no money."),
    checked_at: nowIso(),
  };
}

async function materializePlanItem(
  item: MaterializablePlanItem,
  index: number,
  o: {
    grantId: string;
    orderQueue: { rateRoomMicroUsd: number | null };
    ctx: MaterializeContext;
    cursor: number;
    active: boolean;
    notActive: PlanItemLedger;
    attemptOrdinal: number;
    attemptResult: EnsureAttemptResult | null;
    ensuredFormalize: Set<string>;
  }
): Promise<PlanItemLedger> {
  const kind = item.action;

  if (kind === "ingest") {
    if (!item.url) return blocked("an ingest item needs a url");
    // A scoped ingest (a focus) is its own group, so the same URL can be
    // read for another subject, or whole, without colliding.
    const focus = normalizeFocus(item.focus);
    const group = INGEST_GROUP(item.url, focus);
    if (index < o.cursor) {
      // The cursor passed this item. Its row, when one exists, says whether
      // the ingest actually ran: the cursor moves past the last item whose
      // work has started and takes any ingest item before it along, and
      // such a row stays open, funded from the escrow
      // (fundGrantSelfActions), until it runs. Forcing "done" on position
      // hid exactly those (#427). Only an item with no row at all (executed
      // before the ledger recorded plan work) reads done on position alone.
      const row = (await groupLedger({ group })) ?? (await ingestDoneAtALabelRead(item.url, focus));
      return row ? fromRow(row) : { status: "done", checked_at: nowIso() };
    }
    // A document already read at a label this work reads has been read for
    // this work too: its claims and instances are there to read. The item
    // is met by that row, at no cost, as it was when a group had one row
    // whatever the label. A fresh reading at this label is its own row.
    if (!(await groupLedger({ group }))) {
      const elsewhere = await ingestDoneAtALabelRead(item.url, focus);
      if (elsewhere) return fromRow(elsewhere);
    }
    // An unexecuted one gets (or keeps) its open row, funded by the grant's
    // own escrow (fundGrantSelfActions). The focus is recorded first, so the
    // executor never runs a scoped row without it.
    if (focus) await recordIngestFocus(group, item.url, focus);
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('ingest', $1, 'standard', $2, $3, $4, $5)
       ON CONFLICT (exclusion_group, variant) DO NOTHING`,
      [
        group,
        item.url,
        focus ? `Ingest ${item.url} (focus: ${focus.slice(0, 120)})` : `Ingest ${item.url}`,
        await o.ctx.ingestCostMicroUsd(),
        currentLabel(),
      ]
    );
    const row = await groupLedger({ group });
    return row ? fromRow(row) : blocked("no ingest row could be opened for this url");
  }

  if (kind === "sweep") return materializeSweepItem(item, o);

  if (!item.claim_id) return blocked(`a ${kind} item needs a claim_id`);
  const claim = await claimStanding(item.claim_id);
  if (!claim) return blocked(`claim ${item.claim_id} does not exist`);
  if (claim.state !== "active") {
    // A merged node names its survivor (#884), and any other retired node
    // its reason and successors (#962), so the plan can be rewritten for them.
    const merged = await mergedAliasRefusal(item.claim_id);
    const retired = merged ? null : await retiredNodeRefusal(item.claim_id).catch(() => null);
    const why = merged?.message ?? retired;
    return blocked(
      `claim ${item.claim_id} is ${claim.state}, not active; the ledger only carries work on active claims` +
        (why ? `. ${why}` : "")
    );
  }

  if (kind === "assess" || kind === "reassess" || kind === "deepen") {
    // A stewarding item is consumed once its pass has run: a finished row
    // stays finished (re-enqueueing on every sweep would loop the claim
    // through the Steward forever). The pass may also have run on another
    // lane while the row sat open (a reader's order, the background
    // drain): no lane but the ledger's own closes the row, the sweep then
    // retires it as "assessed elsewhere", and the item read cancelled, or
    // was queued again, for work that ran (#427). An assessment dated after
    // the item's standing was written says the pass ran: the item reads
    // done and keeps reading done.
    if (item.ledger?.status === "done") return item.ledger;
    const orders = await import("./standing-order-service.js");
    // The node's own pass, once it has run. A deepen item has a second half
    // (its children's passes), so it is not finished by this alone.
    let ran: PlanItemLedger | null = null;
    if (item.ledger?.ran_at && item.ledger.action_id) {
      // Seen finished on an earlier sweep. The row is the node's current
      // potential pass and may have reopened since, for someone else's ask.
      ran = {
        status: "done",
        action_id: item.ledger.action_id,
        exclusion_group: item.ledger.exclusion_group,
        ran_at: item.ledger.ran_at,
        checked_at: nowIso(),
      };
    } else if (item.ledger?.action_id) {
      const prior = await groupLedger({ actionId: item.ledger.action_id });
      if (prior) {
        if (prior.status === "done") {
          ran = fromRow(prior);
        } else if (prior.status !== "running" && assessedSince(claim, item.ledger.checked_at)) {
          // The pass the item asked for ran without the item's money: the
          // order is withdrawn, so its budget is not left held on the row.
          await orders.releaseStandingOrder(o.grantId, claim.id);
          ran = fromRow(
            { ...prior, status: "done" },
            "the pass ran on another lane after this item opened its row " +
              "(the claim was stewarded outside the ledger row)"
          );
        } else if (prior.status === "cancelled") {
          // A park is the one retirement another item cannot fix: the claim
          // is out of every lane's candidate set, so re-adding only buys one
          // more pass that fails the same way. Say so, with the class of
          // the error (never its raw text, which this explanation would
          // publish, #846), and leave the item reading cancelled until the
          // park clears (#834; the park itself is reported to maintainers
          // by reportStewardPark). Any other retirement — assessed elsewhere,
          // a pass that ran on the express lane — is spent work: the item
          // falls through below and opens a fresh row, which is what the
          // funder paid for.
          if (claim.steward_state === "error") {
            // The order's money comes back too: it would otherwise stay
            // held against the escrow on a row nothing will run.
            const back = await orders.releaseStandingOrder(o.grantId, claim.id);
            return fromRow(
              prior,
              `the row was retired unrun: the Steward parked this claim as ` +
                `'error' after ${claim.steward_attempts} failed ` +
                `pass${claim.steward_attempts === 1 ? "" : "es"}, which ` +
                `takes it out of the queue. Another item will not help: a ` +
                `park is not retried on its own, and it is reported to ` +
                `maintainers. A commission on the node buys another attempt. ` +
                (back > 0 || item.ledger.order
                  ? `The budget this item commissioned is back in the escrow. `
                  : "") +
                `Reason: ` +
                `${STEWARD_ERROR_REASON_LABELS[stewardErrorReasonOf(claim.steward_error_reason)]}.`
            );
          }
        }
      }
    }
    // An assess item asks for a first assessment; a claim that already
    // carries one has what the item asked for (the reassess kind is the ask
    // for a fresh pass). Read done rather than queue a pass the plan did
    // not ask for.
    if (kind === "assess" && !item.ledger?.action_id && claim.assessed_at) {
      const row = await groupLedger({ group: ASSESS_GROUP(claim.id) });
      const reason =
        "the claim already carries an assessment; a reassess item asks for a fresh pass";
      return row && row.status === "done"
        ? fromRow(row, reason)
        : { status: "done", reason, checked_at: nowIso() };
    }
    if (ran && kind !== "deepen") return ran;
    if (!o.active) return o.notActive;

    // Order of work: an item that names the plan's ingests it should read
    // (after) waits, placing nothing, until they have been read, so its
    // pass weighs the sources the plan bought for it. Only before anything
    // is placed: a pass already ordered or run is left alone.
    let afterNote: string | null = null;
    let afterFrom: string | undefined;
    if (!ran && !item.ledger?.order && !item.ledger?.action_id && Array.isArray(item.after) && item.after.length > 0) {
      const gate = await ingestsGate(item.after, item.ledger?.after_wait_from);
      if (gate.wait) return gate.wait;
      afterNote = gate.note;
      afterFrom = gate.from;
    }

    // The item is a standing order (#849): the mandate commissions the pass
    // whole, at the item's budget or the row's estimate, on the item's
    // tier. What the pace cannot cover yet waits and is asked for
    // again; what could never fit is blocked, with the figures either way.
    // An item that names no tier (one stored before items had to, #956)
    // places nothing new: what it already placed is found, the rest reads
    // blocked until its Grantmaker names one.
    const tier = orders.orderTier(item.variant);
    const budgetMicroUsd =
      Number(item.budget_owls) > 0 ? Math.round(Number(item.budget_owls) * loadConfig().owlCostMicroUsd) : null;
    let own: PlanItemLedger;
    if (ran) {
      own = ran;
    } else {
      const res = await orders.placeStandingOrder({
        grantId: o.grantId,
        claimId: claim.id,
        tier,
        budgetMicroUsd,
        // The kind of pass and nothing else: a Steward serves the graph, so
        // neither which mandate paid nor the Grantmaker's reasons reach it.
        // What a mandate's agents find goes in as a contribution (§19).
        brief:
          `A funded mandate scheduled a ${kind} pass on this claim.` +
          (kind === "deepen" ? " Its deferred subclaims were released into the queue." : ""),
        queue: o.orderQueue,
      });
      if (res.state === "blocked") {
        own = blocked(res.reason);
      } else if (res.state === "waiting") {
        own = waiting(res.reason);
      } else {
        const row = await groupLedger({ actionId: res.actionId });
        if (!row) {
          own = blocked("no assess row could be opened for this claim");
        } else if (res.state === "placed") {
          own = {
            ...fromRow(row),
            order: {
              budget_owls: res.budgetMicroUsd / loadConfig().owlCostMicroUsd,
              tier: res.tier,
              placed_at: nowIso(),
            },
          };
        } else {
          // Paid for already: by this item on an earlier sweep (its order
          // is on the item), or by anyone else, whose pass meets the item.
          const mine = item.ledger?.action_id === row.action_id ? item.ledger.order : undefined;
          own = mine
            ? { ...fromRow(row), order: mine }
            : fromRow(
                row,
                row.status === "open" || row.status === "running"
                  ? "a pass on this node is already paid for; this item is met when it finishes, at no cost to the mandate"
                  : undefined
              );
        }
      }
    }
    if (afterNote && !own.reason) own = { ...own, reason: afterNote };
    // A wait that ran out stays run out: an order that then waits for room
    // keeps the time its wait began, so the next look does not start it again.
    if (afterFrom && !own.order && !own.action_id) own = { ...own, after_wait_from: afterFrom };
    if (kind !== "deepen") return own;

    // deepen's second half: the node's deferred children are released
    // (#98's brake, lifted for them by a funder's say-so), and each child
    // that carries no assessment and is queued for a pass gets one from the
    // mandate, like the node's own. A child that has an assessment is left
    // alone, however it came to be queued (#961). One level; idempotent, so
    // it runs on every sweep until every child is dealt with, which catches
    // the children the node's pass mints. An item that names no tier
    // releases and orders nothing.
    // A deferred stub is released by work at the stub's own label: a
    // node's row is its own label's to change (the database refuses
    // another's), so a mandate at one label leaves another label's stubs
    // as that label's own economics left them.
    if (tier) {
      await rawQuery(
        `UPDATE claims SET steward_state = 'pending', updated_at = now()
          WHERE state = 'active' AND steward_state = 'deferred'
            AND id IN (SELECT child_claim_id FROM claim_relationships
                        WHERE parent_claim_id = $1)${oneLabelOnly() ? "" : ` AND sensitivity_label = '${currentLabel()}'`}`,
        [claim.id]
      );
    }
    const kids = await orders.orderChildPasses({
      grantId: o.grantId,
      parentId: claim.id,
      tier,
      budgetMicroUsd,
      already: item.ledger?.children ?? [],
      queue: o.orderQueue,
    });
    const withChildren = (l: PlanItemLedger, reason?: string): PlanItemLedger => {
      const { reason: _own, children_waiting: _was, ...rest } = l;
      return {
        ...rest,
        ...(reason ? { reason } : {}),
        ...(kids.children.length > 0 ? { children: kids.children } : {}),
        ...(kids.notOrdered.length > 0 ? { children_waiting: kids.notOrdered } : {}),
      };
    };
    const say = (...parts: Array<string | null | undefined>) =>
      parts.filter(Boolean).join(" Also: ") || undefined;
    if (own.status === "done") {
      // The node's pass ran; the item is done once its children are ordered.
      const ranAt = own.ran_at ?? nowIso();
      if (kids.waiting) {
        return withChildren(
          { ...own, status: "waiting", ran_at: ranAt },
          say(`the pass on the node ran; ${kids.waiting}`, kids.blocked, kids.note)
        );
      }
      if (kids.blocked) {
        return withChildren(
          { ...own, status: "blocked", ran_at: ranAt },
          say(`the pass on the node ran; ${kids.blocked}`, kids.note)
        );
      }
      const { ran_at: _seen, ...finished } = own;
      return withChildren(finished, say(own.reason, kids.note));
    }
    if (!tier && own.status === "blocked" && kids.notOrdered.length > 0) {
      // One reason for the node and its children: nothing is ordered until a tier is named.
      return withChildren(
        own,
        say(`${own.reason}. The same holds for its ${kids.notOrdered.length} unassessed children`, kids.note)
      );
    }
    return withChildren(own, say(own.reason, kids.waiting, kids.blocked, kids.note));
  }

  // A kind whose feature this deployment has switched off opens no work
  // (llm/tools/feature-tools.ts). New plans are refused such an item where
  // they are written (validatePlanItems); this is for one a plan already
  // held when the feature went off. Without it a formalize item would reopen
  // its row every FORMALIZE_RETRY_HOURS for a pass that can only log that it
  // could not proceed. Work the item finished before then still reads done.
  const unavailable = actionUnavailable(kind);
  const switchedOff = unavailable
    ? blocked(`${unavailable}, so the item opens no work; it becomes work if that is switched on`)
    : null;

  if (kind === "formalize") {
    if (claim.published) {
      const row = await groupLedger({ group: FORMALIZE_GROUP(claim.id) });
      const reason = "the claim already carries a published formal statement";
      return row
        ? fromRow({ ...row, status: "done" }, reason)
        : { status: "done", reason, checked_at: nowIso() };
    }
    if (switchedOff) return switchedOff;
    if (!o.active) return o.notActive;
    const gap = await formalizeToolGap(claim.id);
    if (gap) return blocked(gap);
    // One statement per claim at a time (§5.4): a second formalize item on
    // the same claim reads the same row rather than upserting it again.
    if (!o.ensuredFormalize.has(claim.id)) {
      // The row is the mandate's work and is opened at the mandate's label,
      // which whoever materializes the plan has set (materializePlanItems,
      // reconcileActions); from inside a Grantmaker's run it is that run's.
      const cost = await o.ctx.formalizeCostMicroUsd();
      await ensureFormalizeAction(claim.id, cost);
      o.ensuredFormalize.add(claim.id);
    }
    const row = await groupLedger({ group: FORMALIZE_GROUP(claim.id) });
    if (!row) return blocked("no formalize row could be opened for this claim");
    if (row.status === "done" || row.status === "cancelled") {
      return fromRow(
        row,
        `the last formalize run ended ${row.status} without a published statement; ` +
          `the sweep reopens the row ${FORMALIZE_RETRY_HOURS} hours after it closed while the claim still lacks one`
      );
    }
    return fromRow(row);
  }

  if (kind === "attempt_proof") {
    if (switchedOff) return item.ledger?.status === "done" ? item.ledger : switchedOff;
    if (!o.active) return o.notActive;
    const res = o.attemptResult;
    if (!res || !res.formalizationId) {
      return waiting(
        res?.reason ??
          "the claim has no published formal statement; an attempt opens only " +
            "once a formalize item has published one (docs/mathematics.md §7.2)"
      );
    }
    const n = o.attemptOrdinal + 1;
    if (n <= res.groups) {
      const row = await groupLedger({ group: ATTEMPT_GROUP(res.formalizationId, n) });
      if (row) return fromRow(row);
    }
    return waiting(
      res.reason ??
        "this item's attempt group opens when the earlier groups on the statement have closed"
    );
  }

  return blocked(`unknown plan item kind "${kind}"`);
}

/**
 * A `sweep` plan item (#831): a mandate buying one Consistency Checker
 * sweep of a partition. It opens (or keeps) the partition's two rows, the
 * same exclusive pair the platform's own lane opens for a due partition
 * and priced the same way (consistencySweepPrice), and its funding is the
 * mandate's own escrow and day (fundGrantSelfActions), like an ingest
 * item. Unlike the platform's lane it does not wait for the partition to
 * be due: a funder may buy a re-sweep of a region that changed a little,
 * or a strong read of one the cheap reader already covered. One item buys
 * one sweep: the first sweep of the partition to finish after the item
 * opened its rows, whoever paid for it, consumes it.
 */
async function materializeSweepItem(
  item: MaterializablePlanItem,
  o: { ctx: MaterializeContext; active: boolean; notActive: PlanItemLedger }
): Promise<PlanItemLedger> {
  const config = loadConfig();
  const name = String(item.partition ?? "").trim().toLowerCase();
  if (!name) return blocked('a sweep item needs a partition: a topic tag\'s slug or "residual"');
  // Already consumed: a done item stays done.
  if (item.ledger?.status === "done") return item.ledger;
  if (!config.consistencySweepsEnabled) {
    return blocked(
      "this deployment runs no consistency sweeps (CONSISTENCY_SWEEPS_ENABLED is off), " +
        "so no sweep row can open; the item becomes work if they are switched on"
    );
  }
  const partitions = await o.ctx.partitions();
  let partition: PartitionStatus | undefined;
  if (name === "residual") {
    partition = partitions.find((p) => p.partition === "residual");
    if (!partition) return blocked("the residual bucket holds no live claims; nothing to sweep");
  } else {
    const { resolveTagBySlug } = await import("./tag-service.js");
    const tag = await resolveTagBySlug(name);
    if (!tag) return blocked(`no topic tag "${name}"; name a tag by its slug, as graph reads return it`);
    partition = partitions.find((p) => p.partition === "tag" && p.tag_id === tag.id);
    if (!partition) {
      return blocked(
        `the tag "${tag.slug}" carries fewer than ${config.consistencyMinTagClaims} live claims, ` +
          `so it is not a partition of its own: its claims are swept with the residual bucket ` +
          `(partition "residual")`
      );
    }
  }
  const ref = partition.partition === "tag" ? partition.tag_id! : "residual";
  const group = CONSISTENCY_GROUP(ref);
  const since = item.ledger?.since;
  if (since) {
    const [finished] = await rawQuery<{ id: string }>(
      `SELECT id FROM consistency_sweeps
        WHERE status = 'done' AND partition = $1
          AND tag_id IS NOT DISTINCT FROM $2::uuid
          AND finished_at > $3::timestamptz
        LIMIT 1`,
      [partition.partition, partition.tag_id, since]
    );
    if (finished) {
      const row = await groupLedger({ group });
      const reason = "a sweep of the partition finished after this item opened its rows";
      return row
        ? { ...fromRow({ ...row, status: "done" }, reason), since }
        : { status: "done", reason, exclusion_group: group, since, checked_at: nowIso() };
    }
  }
  if (!o.active) return o.notActive;
  if (partition.assessed === 0) {
    return waiting(
      `the partition "${partition.label}" holds no assessed nodes yet; a sweep reads ` +
        "assessments against each other, so its rows open once some exist"
    );
  }
  const perNode = {
    standard: await estimateConsistencyNodeCostMicroUsd("standard", CONSISTENCY_SWEEP_MIN_NODES),
    strong: await estimateConsistencyNodeCostMicroUsd("strong", CONSISTENCY_SWEEP_MIN_NODES),
  };
  for (const variant of ["standard", "strong"] as const) {
    // A row already running keeps its price; any other is (re)opened at
    // the partition's current size, as the platform lane does.
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd, sensitivity_label)
       VALUES ('consistency_sweep', $1, $2, $3, $4, $5, $6)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET status = 'open', cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             ${LABEL_ON_REOPEN_SQL},
             updated_at = now()
         WHERE actions.status IN ('done', 'superseded', 'cancelled')
            OR (actions.status = 'open'
                AND actions.cost_est_micro_usd <> EXCLUDED.cost_est_micro_usd)`,
      [
        group,
        variant,
        ref,
        `Consistency sweep${variant === "strong" ? " (strong)" : ""}: ${partition.label}`,
        consistencySweepPrice(variant, partition.assessed, perNode[variant]).microUsd,
        currentLabel(),
      ]
    );
  }
  const row = await groupLedger({ group });
  if (!row) return blocked("no sweep row could be opened for this partition");
  return { ...fromRow(row), since: since ?? nowIso() };
}

/**
 * Write one field of one plan item, by path, while the item at that index
 * is still the same kind of item (an adjust_plan racing the sweep replaces
 * the plan's remainder).
 */
async function setPlanItemField(
  grantId: string,
  index: number,
  action: string,
  field: string,
  value: string,
  run: { query: (q: string, p?: unknown[]) => Promise<unknown[]> } = { query: rawQuery }
): Promise<void> {
  await run.query(
    `UPDATE grants
        SET plan = jsonb_set(plan, $2::text[], to_jsonb($3::text))
      WHERE id = $1 AND plan->'items'->$4::int->>'action' = $5`,
    [grantId, ["items", String(index), field], value, index, action]
  );
}

/**
 * File a propose item's contribution, once (#656). The sweep and an
 * extend_plan in the same minute both materialize the plan, and a second
 * filing is a second review paid from the escrow, so a mandate files its
 * proposals one at a time, under a lock. An identical proposal this mandate has already
 * filed (through submit_contribution, or a filing whose id never reached
 * the item) is adopted rather than filed and paid for again.
 */
async function fileProposal(
  grantId: string,
  index: number,
  item: MaterializablePlanItem
): Promise<{ contributionId: string } | { problem: string }> {
  const type = PROPOSAL_TYPE_FOR_KIND[item.kind as NodeKind];
  const text = String(item.text ?? "").trim();
  // Lazy: contribution-service reaches queue-service, which imports this module.
  const { submitGrantContribution } = await import("./contribution-service.js");
  return withTransaction(async (tx) => {
    await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`plan-propose:${grantId}`]);
    const [now] = await tx.query<{ contribution_id: string | null }>(
      `SELECT plan->'items'->$2::int->>'contribution_id' AS contribution_id FROM grants WHERE id = $1`,
      [grantId, index]
    );
    if (now?.contribution_id) return { contributionId: now.contribution_id };
    const [prior] = await tx.query<{ id: string }>(
      `SELECT id FROM contributions
        WHERE grant_id = $1 AND research_run_id IS NULL
          AND contribution_type = $2 AND proposed_canonical_form = $3
        ORDER BY submitted_at DESC LIMIT 1`,
      [grantId, type, text]
    );
    let contributionId = prior?.id;
    if (!contributionId) {
      // The Grantmaker's own door (§19): the same checks, the same escrow
      // reservation for the review, the same public record.
      const filed = await submitGrantContribution({
        grantId,
        input: { contribution_type: type, proposed_text: text, content: String(item.rationale ?? "") },
      });
      if (!filed.success || !filed.contribution_id) return { problem: filed.message };
      contributionId = filed.contribution_id;
    }
    await setPlanItemField(grantId, index, "propose", "contribution_id", contributionId, tx);
    return { contributionId };
  });
}

interface ProposalStanding {
  ledger: PlanItemLedger;
  /** The node the proposal became or landed on, once accepted. */
  claimId: string | null;
}

/** Where one propose item stands: filed (when the mandate is live), then as its review reads. */
async function materializeProposeItem(
  g: PlanGrantRow,
  index: number,
  item: MaterializablePlanItem,
  o: { active: boolean; notActive: PlanItemLedger }
): Promise<ProposalStanding> {
  // Accepted and bound: a done proposal stays done.
  if (item.claim_id && item.ledger?.status === "done") return { ledger: item.ledger, claimId: item.claim_id };
  if (!(NODE_KINDS as readonly unknown[]).includes(item.kind) || !String(item.text ?? "").trim()) {
    return { ledger: blocked("a propose item needs a kind (claim, quantity, question) and text"), claimId: null };
  }
  let contributionId = item.contribution_id ?? null;
  if (!contributionId) {
    // Nothing is filed, and no review paid for, before the mandate is live.
    if (!o.active) return { ledger: o.notActive, claimId: null };
    const filed = await fileProposal(g.id, index, item);
    if ("problem" in filed) {
      return {
        ledger: blocked(`the proposal was not filed: ${filed.problem} It is tried again on the next sweep.`),
        claimId: null,
      };
    }
    contributionId = filed.contributionId;
    item.contribution_id = contributionId;
  }
  const [c] = await rawQuery<{
    review_status: string;
    claim_id: string | null;
    reasoning: string | null;
    node_text: string | null;
    node_kind: string | null;
    minted: boolean | null;
  }>(
    `SELECT c.review_status, c.claim_id, n.text AS node_text, n.kind AS node_kind,
            n.created_at >= c.submitted_at AS minted,
            (SELECT r.reasoning FROM contribution_reviews r
              WHERE r.contribution_id = c.id AND NOT r.superseded
              ORDER BY r.reviewed_at DESC LIMIT 1) AS reasoning
       FROM contributions c LEFT JOIN claims n ON n.id = c.claim_id
      WHERE c.id::text = $1 AND c.grant_id = $2`,
    [contributionId, g.id]
  );
  if (!c) return { ledger: blocked(`contribution ${contributionId} is not one of this mandate's`), claimId: null };
  if (c.review_status === "accepted" && c.claim_id) {
    if (item.claim_id !== c.claim_id) {
      await setPlanItemField(g.id, index, "propose", "claim_id", c.claim_id);
      item.claim_id = c.claim_id;
    }
    const node = `${c.node_kind ?? "node"} "${(c.node_text ?? "").slice(0, 240)}" (${c.claim_id})`;
    return {
      ledger: {
        status: "done",
        reason:
          (c.minted
            ? `accepted (contribution ${contributionId}): it entered the graph as the ${node}`
            : `accepted (contribution ${contributionId}): the graph already held it, and it landed on the ${node}`) +
          (c.node_kind && c.node_kind !== item.kind
            ? `; proposed as a ${item.kind}, and the Matcher settled its kind`
            : ""),
        checked_at: nowIso(),
      },
      claimId: c.claim_id,
    };
  }
  if (c.review_status === "rejected") {
    return {
      ledger: blocked(
        `the Contribution Reviewer rejected the proposal (contribution ${contributionId}): ` +
          `${(c.reasoning ?? "(no reasoning recorded)").slice(0, 400)} ` +
          `Reword it in a new propose item, or drop the items that name it.`
      ),
      claimId: null,
    };
  }
  return {
    ledger: waiting(
      c.review_status === "escalated"
        ? `contribution ${contributionId} was escalated to the Dispute Arbitrator, who decides it`
        : `contribution ${contributionId} awaits the Contribution Reviewer; its review is paid from the escrow`
    ),
    claimId: null,
  };
}

/**
 * The plan's proposals (#656): each propose item's standing, the claim_id
 * written onto every item whose claim_ref names an accepted proposal, the
 * standing of the ones still waiting on (or blocked by) theirs, and the
 * mandate's scope bound to the proposal its scope_ref names. Returns the
 * standings decided here by item index; an item absent from the map is
 * materialized as the ordinary item it is (or has just become).
 */
async function materializeProposals(
  g: PlanGrantRow,
  items: MaterializablePlanItem[],
  o: { active: boolean; notActive: PlanItemLedger }
): Promise<Map<number, PlanItemLedger>> {
  const early = new Map<number, PlanItemLedger>();
  const byRef = new Map<string, ProposalStanding>();
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.action !== "propose") continue;
    let standing: ProposalStanding;
    try {
      standing = await materializeProposeItem(g, i, item, o);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[reconcile] plan item ${i} (propose) of mandate ${g.id} failed: ${msg}`);
      standing = { ledger: blocked(`the materializer failed on this item: ${msg}`), claimId: null };
    }
    early.set(i, standing.ledger);
    if (item.ref) byRef.set(item.ref, standing);
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    if (item.action === "propose" || item.claim_id || !item.claim_ref) continue;
    const proposal = byRef.get(item.claim_ref);
    if (!proposal) {
      early.set(i, blocked(`claim_ref "${item.claim_ref}" names no propose item in this plan`));
    } else if (proposal.claimId) {
      await setPlanItemField(g.id, i, item.action, "claim_id", proposal.claimId);
      item.claim_id = proposal.claimId;
    } else if (proposal.ledger.status === "blocked") {
      early.set(i, blocked(`the proposal "${item.claim_ref}" this item is for did not become a node: ${proposal.ledger.reason}`));
    } else {
      early.set(
        i,
        waiting(`the proposal "${item.claim_ref}" this item is for is not a node yet; the item takes the node's id when it is accepted`)
      );
    }
  }
  // A mandate scoped to a proposal is scoped to the node it became.
  const scoped = g.mandate?.scope_ref ? byRef.get(g.mandate.scope_ref)?.claimId : null;
  if (scoped && !g.scope_claim_id) {
    await rawQuery(
      `UPDATE grants
          SET scope_claim_id = $2::uuid,
              mandate = jsonb_set(COALESCE(mandate, '{}'::jsonb), '{scope_claim_id}', to_jsonb($2::text))
        WHERE id = $1 AND scope_claim_id IS NULL`,
      [g.id, scoped]
    );
    g.scope_claim_id = scoped;
  }
  return early;
}

/**
 * Materialize one mandate's plan now, outside the sweep: the extend_plan
 * and adjust_plan tools call this so the Grantmaker learns, in the same
 * turn, whether each item became work and if not why. Returns the outcomes
 * for the requested item indices (all items when none are given).
 */
export async function materializePlanItems(
  grantId: string,
  indices?: readonly number[]
): Promise<PlanItemOutcome[]> {
  const [g] = await rawQuery<PlanGrantRow>(
    `SELECT id, name, status, policy, plan, plan_cursor, scope_claim_id, mandate FROM grants WHERE id = $1`,
    [grantId]
  );
  if (!g) return [];
  // A mandate decides for its work. The scheduler materializes a plan
  // outside any run, and the rows the plan becomes (standing orders, formal
  // statements, attempts, ingests, sweeps, the note of a source in its
  // pipeline) are opened at the mandate's label. From inside the
  // Grantmaker's run they are that run's, which was opened at the same one.
  const outcomes = await runAtMandateLabelOutsideAnyRun(g.id, () => materializeGrantPlan(g));
  if (!indices) return outcomes;
  const wanted = new Set(indices);
  return outcomes.filter((o) => wanted.has(o.index));
}

/**
 * Materialize a live mandate's plan now if any of its items is not settled.
 * Called when a plan goes live (funded, approved, a decomposition's plan
 * drafted), so its proposals are filed (#656) and its standing orders placed
 * (#849) then and not a sweep later, and at the start of each review pass:
 * the pass then reads each proposal's outcome, the items bound to its node,
 * and where every order stands. Never throws; the sweep retries on its
 * cadence.
 */
export async function materializeLivePlan(grantId: string): Promise<void> {
  try {
    const [open] = await rawQuery<{ id: string }>(
      `SELECT g.id FROM grants g, jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
        WHERE g.id = $1 AND g.status = 'active'
          AND COALESCE(it->'ledger'->>'status', '') NOT IN ('done', 'cancelled')
        LIMIT 1`,
      [grantId]
    );
    if (open) await materializePlanItems(grantId);
  } catch (err) {
    console.error(
      `[reconcile] plan of mandate ${grantId} not materialized: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

/**
 * Bring up to date every live mandate whose plan has a stewarding item
 * still in motion: an order waiting for room, one placed and not yet run,
 * or an item not yet materialized. The scheduler calls this between full
 * sweeps (STANDING_ORDER_RETRY_MINUTES), so room that opens in the day's
 * rate or the escrow is used within minutes, and a finished pass reads
 * done. Returns how many plans it materialized.
 */
export async function materializeStandingOrders(): Promise<number> {
  const grants = await rawQuery<{ id: string }>(
    `SELECT DISTINCT g.id FROM grants g, jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) it
      WHERE g.status = 'active' AND it->>'action' IN ('assess', 'reassess', 'deepen')
        AND COALESCE(it->'ledger'->>'status', '') IN ('', 'waiting', 'open', 'running')`
  );
  let done = 0;
  for (const g of grants) {
    try {
      await materializePlanItems(g.id);
      done++;
    } catch (err) {
      console.error(
        `[reconcile] standing orders of mandate ${g.id} not materialized: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return done;
}

/** A mandate whose plan failed to materialize: log it and file a report. */
async function reportPlanFailure(g: PlanGrantRow, err: unknown): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`[reconcile] plan materialization failed for mandate ${g.id} ("${g.name}"): ${msg}`);
  try {
    // The agents' own channel (#366), used by the machinery for itself:
    // repeats collapse onto one row, so a sweep failing every six hours is
    // one issue with a rising count, not a flood.
    const { raiseIssue } = await import("./report-service.js");
    await raiseIssue({
      agent: "allocation_scheduler",
      origin: "internal",
      kind: "system_failure",
      severity: "degraded",
      surface: "reconcileActions / plan-to-ledger materialization",
      title: `plan materialization failed for mandate ${g.id}`,
      body:
        `The reconcile sweep could not materialize the plan of the mandate "${g.name}" ` +
        `(${g.id}); its items keep whatever ledger standing they last had. Error: ${msg.slice(0, 2000)}`,
      contextRefs: { grant_id: g.id },
    });
  } catch (reportErr) {
    console.error(
      `[reconcile] could not file the report for mandate ${g.id}: ${
        reportErr instanceof Error ? reportErr.message : String(reportErr)
      }`
    );
  }
}

// ---------------------------------------------------------------------------
// Resolution and execution bookkeeping.
// ---------------------------------------------------------------------------

export interface RunnableAction {
  id: string;
  kind: ActionKind;
  exclusion_group: string;
  variant: string;
  claim_id: string | null;
  target_ref: string | null;
  cost_est_micro_usd: number;
  coverage_micro_usd: number;
  /** True when a commission pays for it: it runs at exactly the budget its payer chose. */
  commissioned?: boolean;
  updated_at: Date;
  /** The label of the work that opened the row; the executor runs it at this (src/labels.ts). */
  sensitivity_label: string;
}

/**
 * The budget a run of `action` works within: what its funders covered, or
 * its expected cost when that is more (a covered action has met its
 * estimate; the fallback lane's rows carry no coverage at all).
 */
export function actionBudgetMicroUsd(action: {
  cost_est_micro_usd: number | string;
  coverage_micro_usd: number | string;
  commissioned?: boolean;
}): number {
  // A commission's budget is its payer's choice, made from the costing
  // skill's figures; it is never raised to the row's estimate.
  if (action.commissioned) return Number(action.coverage_micro_usd) || 0;
  return Math.max(Number(action.cost_est_micro_usd) || 0, Number(action.coverage_micro_usd) || 0);
}

/**
 * The next action the mechanism says to run, for the given kinds: among
 * open actions someone has commissioned, resolve each exclusion group to its
 * winner (most backing, tie → cheapest), then take the winner with the most
 * backing overall. Pure function of commissions; no valuations involved.
 */
export async function nextRunnableAction(
  kinds: ActionKind[]
): Promise<RunnableAction | null> {
  const rows = await rawQuery<RunnableAction>(
    `SELECT a.id, a.kind, a.exclusion_group, a.variant, a.claim_id,
            a.target_ref, a.cost_est_micro_usd, a.updated_at, a.sensitivity_label,
            ${COVERAGE_SQL} AS coverage_micro_usd,
            ${COMMISSIONED_SQL} AS commissioned
       FROM actions a
      WHERE a.status = 'open' AND a.kind = ANY($1)
        AND ${COVERAGE_SQL} > 0
        -- Every run is commissioned: whole, from one payer, at a budget
        -- someone set. Money placed without a commission funds nothing.
        AND ${COMMISSIONED_SQL}
        AND ${NOT_WAITING_ON_FAULT_SQL}
      ORDER BY coverage_micro_usd DESC, a.updated_at ASC
      LIMIT 20`,
    [kinds]
  );
  if (rows.length === 0) return null;
  // Resolve groups: one winner per group, most backing then cheapest.
  const byGroup = new Map<string, RunnableAction[]>();
  for (const row of rows) {
    const list = byGroup.get(row.exclusion_group) ?? [];
    list.push(row);
    byGroup.set(row.exclusion_group, list);
  }
  const winners: RunnableAction[] = [];
  for (const siblings of byGroup.values()) {
    siblings.sort(
      (x, y) =>
        Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
        Number(x.cost_est_micro_usd) - Number(y.cost_est_micro_usd)
    );
    winners.push(siblings[0]!);
  }
  // Most backing first; coverage ties go to the STALEST action, so a
  // freshly reopened row (a chaining review pass) queues behind work that
  // hasn't had a turn — no starvation by enthusiasm.
  winners.sort(
    (x, y) =>
      Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
      new Date(x.updated_at).getTime() - new Date(y.updated_at).getTime()
  );
  return winners[0]!;
}

/**
 * Atomically move an open action to running. False if someone else won.
 *
 * An executor passes the label it read with the row and is about to run at.
 * The claim then also fails if the row has since finished and been reopened
 * by work at another label, so a run never starts at a label its row no
 * longer has.
 */
export async function claimAction(actionId: string, atLabel?: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE actions SET status = 'running', updated_at = now()
      WHERE id = $1 AND status = 'open'${atLabel === undefined ? "" : " AND sensitivity_label = $2"}
      RETURNING id`,
    atLabel === undefined ? [actionId] : [actionId, atLabel]
  );
  return rows.length > 0;
}

/**
 * Return a running action to open: its run did not happen, through no fault
 * of the work, and coverage is unspent.
 *
 * `cause` is the failure that ended the attempt, when there was one. If it
 * is a platform fault (a provider out of credits, rejected credentials, a
 * provider that stayed unavailable through the client's retries), the row
 * waits before the executors pick it again and says so: the fault's public
 * class, since when, and when it is tried next (deployment-fault.ts, which
 * also says why this is a wait and why money cannot pace it). The funded
 * rows of the same kind and tier wait with it: those an executor would
 * pick, which is those with a live commission. The wait doubles with each
 * consecutive fault on that kind of work, from 30 seconds to 10 minutes,
 * and ends as soon as a row of that kind and tier runs, whether or not that
 * row had been waiting (completeAction). A deployment
 * fault is also recorded for maintainers (deployment-fault-service.ts).
 * Returns the fault's class, or null when the row is simply open again.
 *
 * With no cause, or a cause that is not a platform fault (a budget stop, a
 * busy claim), the row is simply open again.
 */
export async function releaseAction(actionId: string, cause?: unknown): Promise<PlatformFaultReason | null> {
  const reason = cause === undefined ? null : platformFaultOf(cause);
  if (!reason) {
    await rawQuery(
      `UPDATE actions SET status = 'open', updated_at = now()
        WHERE id = $1 AND status = 'running'`,
      [actionId]
    );
    return null;
  }
  // The count is the kind's, not the row's: whichever row is tried next
  // continues the same doubling.
  const [released] = await rawQuery<{ id: string }>(
    `UPDATE actions t
        SET status = 'open', updated_at = now(),
            fault_reason = $2,
            fault_since = COALESCE(t.fault_since, now()),
            fault_attempts = lane.attempts + 1,
            retry_after = now() + make_interval(secs =>
              LEAST($4::int, $3::int * power(2, LEAST(lane.attempts, 10)))::int)
       FROM (SELECT COALESCE(MAX(o.fault_attempts), 0) AS attempts
               FROM actions me JOIN actions o ON o.kind = me.kind AND o.variant = me.variant
                                             AND o.status IN ('open', 'running')
              WHERE me.id = $1) lane
      WHERE t.id = $1 AND t.status = 'running'
      RETURNING t.id`,
    [actionId, reason, FAULT_RETRY_BASE_SECONDS, FAULT_RETRY_MAX_SECONDS]
  );
  if (released) {
    // The rows of the same kind and tier that an executor would pick wait
    // with it (the same model serves them), and say so. The test is the
    // executors' own (nextRunnableAction): money on the row and a live
    // commission. A row with money and no commission is one no executor
    // picks, so marking it would say it waits on the fault when it waits on
    // a payer, and nothing would ever try it and clear the mark.
    await rawQuery(
      `UPDATE actions a
          SET fault_reason = t.fault_reason,
              fault_since = COALESCE(a.fault_since, t.fault_since),
              fault_attempts = t.fault_attempts,
              retry_after = t.retry_after
         FROM actions t
        WHERE t.id = $1 AND a.id <> t.id AND a.status = 'open'
          AND a.kind = t.kind AND a.variant = t.variant
          AND ${COVERAGE_SQL} > 0
          AND ${COMMISSIONED_SQL}`,
      [actionId]
    );
  }
  // The client's seam has already recorded a fault it stamped with a provider.
  if (isDeploymentFaultReason(reason) && !errorProvider(cause)) {
    await noteDeploymentFault(cause, { surface: `ledger action ${actionId}` });
  }
  return reason;
}

/**
 * The class of the platform fault `actionId` is waiting on right now, or
 * null: the row is open, carries a fault, and its next attempt is still
 * ahead. An executor reads it after a transient failure to tell a row that
 * now paces itself (the drain may go on to other work) from one that could
 * be picked again at once (the drain must stop, as it always has).
 */
export async function actionWaitingOn(actionId: string): Promise<PlatformFaultReason | null> {
  const [row] = await rawQuery<{ fault_reason: string | null }>(
    `SELECT fault_reason FROM actions
      WHERE id = $1 AND status = 'open' AND fault_reason IS NOT NULL AND retry_after > now()`,
    [actionId]
  );
  return isPlatformFaultReason(row?.fault_reason) ? row.fault_reason : null;
}

/**
 * A row that has just been paid for joins the wait its kind and tier are
 * already in, if they are in one: the same model serves it, so trying it at
 * once would be one more refused call, and its payer should read why it is
 * not starting. Returns the wait it joined, or null when there is none.
 */
export async function joinFaultWait(actionId: string): Promise<FaultWait | null> {
  const [row] = await rawQuery<FaultWaitRow>(
    `UPDATE actions a
        SET fault_reason = t.fault_reason, fault_since = COALESCE(a.fault_since, t.fault_since),
            fault_attempts = t.fault_attempts, retry_after = t.retry_after
       FROM (SELECT o.fault_reason, o.fault_since, o.fault_attempts, o.retry_after
               FROM actions me JOIN actions o ON o.kind = me.kind AND o.variant = me.variant
              WHERE me.id = $1 AND o.id <> me.id AND o.status = 'open'
                AND o.fault_reason IS NOT NULL AND o.retry_after > now()
              ORDER BY o.retry_after DESC LIMIT 1) t
      WHERE a.id = $1 AND a.status = 'open'
      RETURNING a.fault_reason, a.fault_since, a.fault_attempts, a.retry_after`,
    [actionId]
  );
  return faultWait(row);
}

/**
 * A row has just run, so whatever platform fault its kind of work was
 * waiting on is over for that kind: the rows of the same kind and tier stop
 * waiting, and rows of other kinds waiting on the same class are tried now
 * rather than at the end of their own wait (one whose provider is still down
 * fails and waits again, having cost one refused call).
 *
 * `waitedOn` is the class the row that ran had itself been waiting on, if
 * any. The rows of its kind and tier are cleared whether or not it carried
 * one (completeAction calls this for any run that metered spend): the row an executor picks when a wait ends is the one with the most
 * backing, which is often a row commissioned after the fault and never
 * marked, and when only a marked row's own run cleared the others, nine
 * sweeps finished on 2026-11-13 and thirteen rows went on reading as waiting.
 */
async function endFaultWaits(actionId: string, waitedOn: string | null): Promise<void> {
  const cleared = await rawQuery<{ fault_reason: string }>(
    `WITH waiting AS (
       SELECT a.id, a.fault_reason
         FROM actions t JOIN actions a ON a.kind = t.kind AND a.variant = t.variant
        WHERE t.id = $1 AND a.id <> t.id AND a.status = 'open' AND a.fault_reason IS NOT NULL
        FOR UPDATE OF a
     )
     UPDATE actions a
        SET fault_reason = NULL, fault_since = NULL, fault_attempts = 0, retry_after = NULL
       FROM waiting w
      WHERE a.id = w.id
      RETURNING w.fault_reason`,
    [actionId]
  );
  const classes = new Set(cleared.map((r) => r.fault_reason));
  if (waitedOn) classes.add(waitedOn);
  if (classes.size === 0) return;
  await rawQuery(
    `UPDATE actions SET retry_after = now()
      WHERE status = 'open' AND fault_reason = ANY($1::text[]) AND retry_after > now()`,
    [[...classes]]
  );
}

/**
 * Complete a run: the winner is done with its metered cost recorded, its
 * siblings are superseded, losing pinned allocations are released back to
 * their funders (users get a ledger credit; mandate exposure simply
 * drops), the metered cost is consumed pro rata from the winner's
 * covering allocations — and the covering allocations then SETTLE: their
 * unspent remainders release too, exactly like a cap-charge settling to
 * the metered actual. Cost estimates deliberately run high, so without
 * settlement every completed action would strand (estimate − actual) as
 * outstanding exposure forever, silently eating its funders' headroom.
 * Returns the consumed total.
 *
 * The whole close runs in ONE transaction: the done-transition is guarded
 * (a second completer for the same action is a no-op, so two settlements
 * can never both consume the same unspent coverage), and the covering
 * allocations are locked with a held `FOR UPDATE` until commit.
 * `meteredJobId` records which budget job the run's llm_usage metering was
 * attributed to, so escrow accounting can de-duplicate the pro-rata shares
 * against that job's metered total (regrant-service.grantEscrowSpend).
 */
export async function completeAction(
  actionId: string,
  meteredMicroUsd: number,
  opts: { meteredJobId?: string | null } = {}
): Promise<number> {
  // A row that runs ends the wait its kind and tier were in (endFaultWaits),
  // whether or not it had been waiting itself; `waitedOn` is the platform
  // fault it had been waiting on, if any.
  let waitedOn: string | null = null;
  let closed = false;
  const consumed = await withTransaction(async (tx) => {
    // Guarded transition: only a live (running, or reconcile-reopened)
    // action completes; a done/superseded/cancelled row is already closed
    // and its coverage already consumed — return 0 and touch nothing.
    const [action] = await tx.query<{
      id: string;
      exclusion_group: string;
      waited_on: string | null;
    }>(
      `UPDATE actions a SET status = 'done', metered_cost_micro_usd = $2,
              metered_job_id = $3, updated_at = now()
         FROM (SELECT id, fault_reason FROM actions WHERE id = $1 FOR UPDATE) prior
        WHERE a.id = prior.id AND a.status IN ('running', 'open')
        RETURNING a.id, a.exclusion_group, prior.fault_reason AS waited_on`,
      [actionId, Math.round(meteredMicroUsd), opts.meteredJobId ?? null]
    );
    if (!action) return 0;
    closed = true;
    waitedOn = action.waited_on;

    await tx.query(
      `UPDATE actions SET status = 'superseded', updated_at = now()
        WHERE exclusion_group = $1 AND id <> $2 AND status IN ('open', 'running')`,
      [action.exclusion_group, actionId]
    );

    // Lock every live allocation on the group for the duration of the
    // close (plain FOR UPDATE: wait, don't skip — a skipped row would be
    // silently exempted from consumption).
    const allocations = await tx.query<{
      id: string;
      grant_id: string | null;
      user_id: string | null;
      claim_id: string | null;
      action_id: string | null;
      amount: number;
      unspent: number;
    }>(
      `SELECT id, grant_id, user_id, claim_id, action_id,
              amount_micro_usd::bigint AS amount,
              (amount_micro_usd - spent_micro_usd)::bigint AS unspent
         FROM minerval_whole.allocation_money
        WHERE exclusion_group = $1 AND released_at IS NULL
          AND spent_micro_usd < amount_micro_usd
        ORDER BY created_at ASC
        FOR UPDATE`,
      [action.exclusion_group]
    );

    const refundUser = async (r: {
      id: string;
      user_id: string | null;
      claim_id: string | null;
      unspent: number;
      key: string;
    }) => {
      if (r.user_id && Number(r.unspent) > 0) {
        await tx.query(
          `INSERT INTO owl_ledger
             (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
           VALUES ($1, $2, 'refund', $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [r.user_id, Number(r.unspent), r.claim_id, r.key]
        );
      }
    };

    // Release losing pinned allocations: returned, not spent. User-funded
    // ones get their unspent remainder back on the owl ledger.
    const losers = allocations.filter(
      (a) => a.action_id !== null && a.action_id !== actionId
    );
    for (const r of losers) {
      await tx.query(
        `UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `release:${r.id}` });
    }

    // Consume the metered cost pro rata from the winner's covering
    // allocations (pinned to it, or unpinned on the group).
    const covering = allocations.filter(
      (a) => a.action_id === null || a.action_id === actionId
    );
    let consumed = 0;
    if (meteredMicroUsd > 0) {
      const totalUnspent = covering.reduce((s, r) => s + Number(r.unspent), 0);
      const toConsume = Math.min(Math.round(meteredMicroUsd), totalUnspent);
      for (const [i, row] of covering.entries()) {
        const share =
          i === covering.length - 1
            ? toConsume - consumed
            : Math.floor((toConsume * Number(row.unspent)) / totalUnspent);
        const take = Math.min(Number(row.unspent), Math.max(0, share));
        if (take <= 0) continue;
        await tx.query(
          `UPDATE minerval_whole.allocation_money
              SET spent_micro_usd = spent_micro_usd + $2
            WHERE id = $1`,
          [row.id, take]
        );
        consumed += take;
        row.unspent = Number(row.unspent) - take;
      }
    }

    // OVERAGE: the run cost more than its funders had promised. The money is
    // already gone — the LLM calls happened and are metered against the
    // funder's job — so the only question is whether the ledger admits it.
    //
    // It used to not. Consumption is clamped at `totalUnspent` above, so a run
    // metering 5.76 owls against a 1.93 allocation recorded 1.93 and the rest
    // vanished: absent from allocation shares, and cancelled out of the
    // non-ledger term (which subtracts actions.metered_cost, so the very row
    // recording the overspend erased it). Measured on the General mandate's
    // first epoch: 23.57 owls of real spend counted in NO term of
    // grantCommittedMicroUsd, which is why the escrow read 112 owls left when
    // 79 was the truth. An escrow that cannot see a third of its own spend is
    // not the hard ceiling the design leans on.
    //
    // So a MANDATE's overage is recorded as what it actually is: an
    // allocation, already spent. A settled row (spent = amount) sits outside
    // the live-placement unique index, so this never collides with a future
    // placement on the same group. Two things follow for free — the escrow's
    // committed total includes it, and because day room sums the amounts
    // placed today, an expensive run draws down TODAY's room by its own
    // overspend rather than leaving the pace target to describe fiction.
    //
    // A USER's overage stays absorbed by the platform: their cap is a promise
    // ("the ceiling was theirs to rely on"), and a buyer must never be billed
    // past the number on the button. Only grant-funded allocations are
    // extended, and when a group has none, the shortfall stays off-ledger —
    // where the corrected non-ledger term now counts it instead of hiding it.
    const shortfall = Math.round(meteredMicroUsd) - consumed;
    if (shortfall > 0) {
      const byGrant = new Map<string, number>();
      for (const r of covering) {
        if (!r.grant_id) continue;
        byGrant.set(r.grant_id, (byGrant.get(r.grant_id) ?? 0) + Number(r.amount));
      }
      const totalWeight = [...byGrant.values()].reduce((s, n) => s + n, 0);
      if (totalWeight > 0) {
        // Pro rata by what each mandate had promised: the funder that backed
        // most of the work carries most of the overspend.
        const entries = [...byGrant.entries()];
        let assigned = 0;
        for (const [i, [grantId, weight]] of entries.entries()) {
          const share =
            i === entries.length - 1
              ? shortfall - assigned
              : Math.floor((shortfall * weight) / totalWeight);
          if (share <= 0) continue;
          const claimId =
            covering.find((r) => r.grant_id === grantId)?.claim_id ?? null;
          await tx.query(
            // The record of a shortfall met, at the label of the row that ran.
            `INSERT INTO action_allocations
               (exclusion_group, action_id, claim_id, grant_id,
                amount_micro_usd, spent_micro_usd, released_at, sensitivity_label)
             VALUES ($1, $2, $3, $4, $5, $5, now(), COALESCE($6, (SELECT sensitivity_label FROM actions WHERE id = $2)))`,
            [action.exclusion_group, actionId, claimId, grantId, share, labelInContext()]
          );
          assigned += share;
          consumed += share;
        }
      }
    }

    // SETTLEMENT: whatever the covering allocations still hold beyond the
    // metered cost releases back to its funders — a mandate's headroom
    // returns, a person's owls return to their balance. The ceiling was
    // theirs to rely on; the meter is what they pay.
    for (const r of covering) {
      if (Number(r.unspent) <= 0) continue;
      await tx.query(
        `UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `settle:${r.id}` });
    }
    // Recorded with the settlement, so a subscriber waiting on this run is
    // told exactly when its money has come back (event-service.ts).
    const [done] = await tx.query<{ kind: string; claim_id: string | null; target_ref: string | null; label: string; grants: string[] }>(
      `SELECT a.kind, a.claim_id, a.target_ref, a.label,
              ARRAY(SELECT DISTINCT al.grant_id::text FROM minerval_whole.allocation_money al
                     WHERE al.action_id = a.id AND al.grant_id IS NOT NULL) AS grants
         FROM actions a WHERE a.id = $1`,
      [actionId]
    );
    if (done) {
      const { recordEvent } = await import("./event-service.js");
      await recordEvent(
        {
          kind: "run_settled",
          actionId,
          nodeId: done.claim_id,
          grantId: done.grants[0] ?? null,
          refs: { work_kind: done.kind, target_ref: done.target_ref, grants: done.grants },
          summary: `${done.label} finished, spending ${Math.round(meteredMicroUsd / 10_000) / 100} owls.`,
          payload: { spent_micro_usd: Math.round(meteredMicroUsd) },
        },
        tx
      );
    }
    return consumed;
  });
  // A run that metered spend was served by its provider. One that closed
  // having spent nothing (work that turned out to have nothing to do) says
  // nothing about the provider, and ending the wait on it would restart the
  // doubling at 30 seconds through a long fault; such a row ends the wait
  // only if it had been waiting itself, as it always has.
  if (closed && (waitedOn || meteredMicroUsd > 0)) {
    await endFaultWaits(actionId, waitedOn).catch((err) =>
      console.warn(`[actions] ending fault waits failed: ${err instanceof Error ? err.message : err}`)
    );
  }
  return consumed;
}

/**
 * Metering attribution for a covered run: the largest covering allocator.
 * A mandate yields its budget-job id (which also stamps the funding
 * disclosure); a person yields their user id.
 */
/** Every mandate with money on this action's run (largestActionFunder's rows). */
export async function actionFunderGrants(actionId: string): Promise<string[]> {
  const rows = await rawQuery<{ grant_id: string }>(
    `SELECT DISTINCT al.grant_id
       FROM minerval_whole.allocation_money al
       JOIN actions a ON a.id = $1
      WHERE al.exclusion_group = a.exclusion_group
        AND al.released_at IS NULL
        AND al.grant_id IS NOT NULL
        AND (al.action_id IS NULL OR al.action_id = a.id)`,
    [actionId]
  );
  return rows.map((r) => r.grant_id);
}

/**
 * Put a source in a mandate's pipeline (grant_sources), once per
 * extraction job: what pipeline_report lists and the mandate's
 * source_ingested event is recorded from.
 */
export async function recordGrantSource(
  grantId: string,
  sourceId: string,
  url: string,
  jobId: string | null
): Promise<void> {
  await rawQuery(
    `INSERT INTO grant_sources (grant_id, source_id, url, job_id, sensitivity_label)
     SELECT $1, $2, $3, $4, $5
      WHERE NOT EXISTS (SELECT 1 FROM grant_sources
                         WHERE grant_id = $1 AND source_id = $2
                           AND job_id IS NOT DISTINCT FROM $4::uuid)`,
    [grantId, sourceId, url, jobId, currentLabel()]
  );
}

/**
 * A mandate's ingest item whose per-URL row is running or done without it
 * (someone else ingested the URL, or is ingesting it) still names a source
 * the mandate asked for: attribute it, with the extraction that read it for
 * this focus, so pipeline_report lists it with its real status instead of
 * the item reading done over an empty pipeline (#657). Once per URL.
 */
async function attributeIngestedSource(grantId: string, url: string, focus: string | null): Promise<void> {
  // A run this mandate put money on is attributed by the executor, to every
  // funder, when it submits (engine-executor.ts runIngestAction).
  const [have] = await rawQuery(
    `SELECT 1 WHERE EXISTS (SELECT 1 FROM grant_sources WHERE grant_id = $1 AND url = $2)
                 OR EXISTS (SELECT 1 FROM minerval_whole.allocation_money WHERE grant_id = $1 AND exclusion_group = $3)`,
    [grantId, url, INGEST_GROUP(url, focus)]
  );
  if (have) return;
  const [source] = await rawQuery<{ id: string }>(`SELECT id FROM sources WHERE url = $1${oneSourceForAddressSql() || " LIMIT 1"}`, [url]);
  if (!source) return;
  const [job] = await rawQuery<{ id: string }>(
    `SELECT id FROM jobs
      WHERE type = 'url_extraction' AND input->>'sourceId' = $1
        AND input->>'focus' IS NOT DISTINCT FROM $2
      ORDER BY created_at DESC LIMIT 1`,
    [source.id, focus]
  );
  // The row says the mandate has this source in its pipeline. It is the
  // mandate's record, written while its plan is materialized, so it carries
  // the mandate's label like the rest of the plan's rows. (Before mandates
  // carried a label it took the source's.) The source is found by its URL
  // whatever its label, as it always was: a mandate at one label that names
  // the URL of a document held at another learns here that the graph holds
  // it, which is for the reads to close, not for this row's label.
  await recordGrantSource(grantId, source.id, url, job?.id ?? null);
}

export async function largestActionFunder(
  actionId: string
): Promise<{ jobId?: string; userId?: string; grantId?: string }> {
  const [row] = await rawQuery<{
    grant_id: string | null;
    user_id: string | null;
    budget_job_id: string | null;
  }>(
    `SELECT al.grant_id, al.user_id, g.budget_job_id
       FROM minerval_whole.allocation_money al
       JOIN actions a ON a.id = $1
       LEFT JOIN grants g ON g.id = al.grant_id
      WHERE al.exclusion_group = a.exclusion_group
        AND al.released_at IS NULL
        AND (al.action_id IS NULL OR al.action_id = a.id)
      GROUP BY al.grant_id, al.user_id, g.budget_job_id
      ORDER BY SUM(al.amount_micro_usd - al.spent_micro_usd) DESC
      LIMIT 1`,
    [actionId]
  );
  if (!row) return {};
  if (row.budget_job_id) {
    return { jobId: row.budget_job_id, grantId: row.grant_id ?? undefined };
  }
  if (row.user_id) return { userId: row.user_id };
  return {};
}
