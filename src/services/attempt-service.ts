/**
 * Solver attempts (docs/mathematics.md §7): the `proof_attempts` row's
 * lifecycle, from a claimed `attempt_proof` action to a closed, and later
 * published, record.
 *
 * Everything the solver agent and its worker write about an attempt goes
 * through here, so the write surface is one file: the row itself, its
 * notebook, the `lean_checks` rows the harness records on the solver's
 * behalf, and the one bounty transition the design gives the worker (§8.1):
 * an attempt that closes with an accepted check on a statement carrying an
 * `open` bounty moves that bounty to `house_result_pending` in the same
 * transaction, so no prize claim can be filed against a proof the platform
 * already has. Publication (§7.7) is separate and later: the report and
 * notebook become public only once the Steward has acted on
 * `attempt_completed`, and never while a `house_result_pending` bounty is
 * undecided.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { owlsToMicroUsd } from "./owl.js";
import type { AttemptOutcome, AttemptSummary } from "./claim-extras-types.js";
import { getMandateAllocationPolicy, getEffectiveAllocationPolicy } from "./allocation-policy-service.js";
import { estimateSolverAttemptCostMicroUsd } from "./cost-estimate-service.js";
import type { PlanItem } from "./grant-service.js";

export type AttemptStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelling"
  | "cancelled"
  | "refused"
  | "budget"
  | "orphaned"
  | "stale_formalization";

export type AttemptVariant = "standard" | "max";

export const ATTEMPT_OUTCOMES: readonly AttemptOutcome[] = [
  "proof",
  "disproof",
  "partial",
  "reduction",
  "negative",
  "none",
];

/** Statuses a closed attempt can carry; `running` and `cancelling` are live. */
export const TERMINAL_ATTEMPT_STATUSES: readonly AttemptStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "refused",
  "budget",
  "orphaned",
  "stale_formalization",
];

/** Bounty statuses under which a claim counts as bounty-bearing (§7.7). */
const LIVE_BOUNTY_STATUSES = [
  "requested",
  "confirm_pending",
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
];

/** The variant's effort (§7.2): `standard` runs at `high`, `max` at `max`. */
export function effortForVariant(variant: string): "high" | "max" {
  return variant === "max" ? "max" : "high";
}

/** `ceiling = cost_est × (1 + ATTEMPT_OVERAGE_FRACTION)` (§7.3), never below one micro-dollar. */
export function attemptCeilingMicroUsd(
  costEstMicroUsd: number,
  overageFraction: number = loadConfig().attemptOverageFraction
): number {
  return Math.max(1, Math.round(costEstMicroUsd * (1 + overageFraction)));
}

/**
 * The exclusion group `attempt:<formalization_id>:<n>` (§7.2) names the
 * statement the attempt runs against and its epoch.
 */
export function parseAttemptGroup(
  group: string
): { formalizationId: string; epoch: number } | null {
  const m = /^attempt:([0-9a-f-]{36}):(\d+)$/i.exec(group);
  if (!m) return null;
  return { formalizationId: m[1]!, epoch: Number(m[2]) };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface AttemptRow {
  id: string;
  claim_id: string;
  formalization_id: string;
  action_id: string | null;
  run_id: string | null;
  grant_id: string | null;
  job_id: string | null;
  model: string;
  variant: AttemptVariant;
  effort: string;
  status: AttemptStatus;
  outcome: AttemptOutcome | null;
  report: Record<string, unknown> | null;
  lean_proof: string | null;
  lean_check_id: string | null;
  notebook: Record<string, string>;
  is_calibration: boolean;
  ceiling_micro_usd: number;
  spent_micro_usd: number;
  turns: number;
  compactions: number;
  served_models: string[] | null;
  published_at: Date | null;
  started_at: Date;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  error: string | null;
}

export interface FormalizationRow {
  id: string;
  claim_id: string;
  version: number;
  status: string;
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  image_digest: string;
  namespace: string;
  statement_source: string;
  source_hash: string;
  expr_hash: string;
  pp_type: string;
  correspondence: string | null;
  published_at: Date | null;
  review_period_ends_at: Date | null;
}

const ATTEMPT_COLUMNS = `
  id, claim_id, formalization_id, action_id, run_id, grant_id, job_id, model,
  variant, effort, status, outcome, report, lean_proof, lean_check_id, notebook,
  is_calibration, ceiling_micro_usd::bigint AS ceiling_micro_usd,
  spent_micro_usd::bigint AS spent_micro_usd, turns, compactions, served_models,
  published_at, started_at, heartbeat_at, finished_at, error`;

const FORMALIZATION_COLUMNS = `
  id, claim_id, version, status, pin_id, lean_toolchain, mathlib_rev, mathlib_tag,
  image_digest, namespace, statement_source, source_hash, expr_hash, pp_type,
  correspondence, published_at, review_period_ends_at`;

function coerceAttempt(row: AttemptRow): AttemptRow {
  return {
    ...row,
    ceiling_micro_usd: Number(row.ceiling_micro_usd),
    spent_micro_usd: Number(row.spent_micro_usd),
    turns: Number(row.turns),
    compactions: Number(row.compactions),
    notebook: (row.notebook ?? {}) as Record<string, string>,
    served_models: Array.isArray(row.served_models) ? row.served_models : null,
  };
}

export async function getAttempt(attemptId: string): Promise<AttemptRow | null> {
  const [row] = await rawQuery<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM proof_attempts WHERE id = $1`,
    [attemptId]
  );
  return row ? coerceAttempt(row) : null;
}

export async function listClaimAttempts(claimId: string): Promise<AttemptRow[]> {
  const rows = await rawQuery<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM proof_attempts
      WHERE claim_id = $1
      ORDER BY started_at DESC`,
    [claimId]
  );
  return rows.map(coerceAttempt);
}

/** Every closed attempt on a formalization, oldest first: the prior attempts a repeat attempt reads. */
export async function listPriorAttempts(
  formalizationId: string,
  excludeAttemptId?: string
): Promise<AttemptRow[]> {
  const rows = await rawQuery<AttemptRow>(
    `SELECT ${ATTEMPT_COLUMNS} FROM proof_attempts
      WHERE formalization_id = $1
        AND status NOT IN ('running', 'cancelling')
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY started_at ASC`,
    [formalizationId, excludeAttemptId ?? null]
  );
  return rows.map(coerceAttempt);
}

export async function getFormalization(id: string): Promise<FormalizationRow | null> {
  const [row] = await rawQuery<FormalizationRow>(
    `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations WHERE id = $1`,
    [id]
  );
  return row ?? null;
}

export async function getPublishedFormalization(
  claimId: string
): Promise<FormalizationRow | null> {
  const [row] = await rawQuery<FormalizationRow>(
    `SELECT ${FORMALIZATION_COLUMNS} FROM claim_formalizations
      WHERE claim_id = $1 AND status = 'published'
      ORDER BY version DESC LIMIT 1`,
    [claimId]
  );
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Opening
// ---------------------------------------------------------------------------

/** `SUM(llm_usage.cost_micro_usd WHERE claim_id AND agent = 'math_solver')` (§7.3). */
export async function claimLifetimeAttemptSpendMicroUsd(claimId: string): Promise<number> {
  const [row] = await rawQuery<{ spent: number | string | null }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
       FROM llm_usage
      WHERE claim_id = $1 AND agent = 'math_solver'`,
    [claimId]
  );
  return Number(row?.spent ?? 0);
}

/**
 * The claim's lifetime cap in micro-USD: the policy key, or the plan item's
 * `lifetime_cap_owls` bounded at twice the policy key (§7.3).
 */
export function lifetimeCapMicroUsd(policyCapOwls: number, planCapOwls?: number | null): number {
  const owls =
    planCapOwls !== undefined && planCapOwls !== null && Number.isFinite(planCapOwls)
      ? Math.min(Math.max(0, planCapOwls), 2 * policyCapOwls)
      : policyCapOwls;
  return owlsToMicroUsd(owls);
}

/** The mandate's `attempt_proof` plan item for a claim, when the mandate names one. */
export async function findAttemptPlanItem(
  grantId: string | null | undefined,
  claimId: string
): Promise<PlanItem | null> {
  if (!grantId) return null;
  const [row] = await rawQuery<{ plan: { items?: PlanItem[] } | null }>(
    `SELECT plan FROM grants WHERE id = $1`,
    [grantId]
  );
  const items = row?.plan?.items ?? [];
  return items.find((i) => i.action === "attempt_proof" && i.claim_id === claimId) ?? null;
}

export type OpenAttemptResult =
  | { ok: true; attempt: AttemptRow; costEstMicroUsd: number }
  | {
      ok: false;
      code: "NOT_PUBLISHED" | "ALREADY_RUNNING" | "LIFETIME_CAP";
      message: string;
    };

/**
 * Open the attempt row for a claimed `attempt_proof` action: the model from
 * SOLVER_MODEL, the variant from the action, the effort from the variant,
 * the ceiling from the cost estimate (the action's, which is what the
 * ledger covered, else the live p80 or the policy prior), after the
 * lifetime-cap check and the one-running-attempt-per-statement check.
 */
export async function openAttempt(input: {
  action: { id: string; variant: string; cost_est_micro_usd: number };
  claimId: string;
  formalization: FormalizationRow;
  grantId?: string | null;
  jobId?: string | null;
  model?: string;
  planItem?: PlanItem | null;
}): Promise<OpenAttemptResult> {
  const config = loadConfig();
  const formalization = input.formalization;
  if (formalization.status !== "published") {
    return {
      ok: false,
      code: "NOT_PUBLISHED",
      message: `formalization ${formalization.id} is ${formalization.status}, not published`,
    };
  }
  const [running] = await rawQuery<{ id: string }>(
    `SELECT id FROM proof_attempts
      WHERE formalization_id = $1 AND status IN ('running', 'cancelling')
      LIMIT 1`,
    [formalization.id]
  );
  if (running) {
    return {
      ok: false,
      code: "ALREADY_RUNNING",
      message: `attempt ${running.id} is already running on formalization ${formalization.id}`,
    };
  }

  const policy = input.grantId
    ? await getMandateAllocationPolicy(input.grantId)
    : await getEffectiveAllocationPolicy();
  const cap = lifetimeCapMicroUsd(
    policy.attempt_claim_lifetime_cap_owls,
    input.planItem?.lifetime_cap_owls
  );
  const spent = await claimLifetimeAttemptSpendMicroUsd(input.claimId);
  if (spent >= cap) {
    return {
      ok: false,
      code: "LIFETIME_CAP",
      message:
        `claim ${input.claimId} has spent ${spent} of its ${cap} micro-USD lifetime ` +
        `attempt cap`,
    };
  }

  const variant: AttemptVariant = input.action.variant === "max" ? "max" : "standard";
  const model = input.model ?? config.solverModel;
  const costEst =
    Number(input.action.cost_est_micro_usd) > 0
      ? Number(input.action.cost_est_micro_usd)
      : await estimateSolverAttemptCostMicroUsd({
          model,
          variant,
          grantId: input.grantId ?? null,
        });
  const ceiling = attemptCeilingMicroUsd(costEst, config.attemptOverageFraction);

  const [row] = await rawQuery<AttemptRow>(
    `INSERT INTO proof_attempts
       (claim_id, formalization_id, action_id, grant_id, job_id, model, variant,
        effort, status, is_calibration, ceiling_micro_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10)
     RETURNING ${ATTEMPT_COLUMNS}`,
    [
      input.claimId,
      formalization.id,
      input.action.id,
      input.grantId ?? null,
      input.jobId ?? null,
      model,
      variant,
      effortForVariant(variant),
      input.planItem?.is_calibration === true,
      ceiling,
    ]
  );
  return { ok: true, attempt: coerceAttempt(row!), costEstMicroUsd: costEst };
}

// ---------------------------------------------------------------------------
// The live attempt: what the harness writes each turn
// ---------------------------------------------------------------------------

/** Stamp the agent_runs id once withAgent has opened the run. */
export async function stampAttemptRun(attemptId: string, runId: string | null): Promise<void> {
  if (!runId) return;
  await rawQuery(`UPDATE proof_attempts SET run_id = $2 WHERE id = $1`, [attemptId, runId]);
}

/**
 * The per-turn heartbeat (§7.9): turns, spend, served models, and the
 * action's `updated_at`, so the reopen sweep sees a live worker.
 */
export async function updateAttemptProgress(input: {
  attemptId: string;
  actionId?: string | null;
  turns: number;
  spentMicroUsd: number;
  servedModels: readonly string[];
}): Promise<void> {
  await rawQuery(
    `UPDATE proof_attempts
        SET heartbeat_at = now(), turns = $2, spent_micro_usd = $3,
            served_models = $4::jsonb
      WHERE id = $1`,
    [
      input.attemptId,
      Math.max(0, Math.round(input.turns)),
      Math.max(0, Math.round(input.spentMicroUsd)),
      JSON.stringify([...input.servedModels]),
    ]
  );
  if (input.actionId) {
    await rawQuery(`UPDATE actions SET updated_at = now() WHERE id = $1`, [input.actionId]);
  }
}

/** The attempt's current status, polled each turn for `cancelling`. */
export async function readAttemptStatus(attemptId: string): Promise<AttemptStatus | null> {
  const [row] = await rawQuery<{ status: AttemptStatus }>(
    `SELECT status FROM proof_attempts WHERE id = $1`,
    [attemptId]
  );
  return row?.status ?? null;
}

/** The operator's `solver_paused` switch (§7.3); a missing row is "not paused". */
export async function readSolverPaused(): Promise<boolean> {
  const [row] = await rawQuery<{ value: unknown }>(
    `SELECT value FROM platform_flags WHERE key = 'solver_paused'`
  );
  if (!row) return false;
  const v = row.value;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  if (v && typeof v === "object") {
    const paused = (v as { paused?: unknown }).paused;
    return paused === true;
  }
  return false;
}

/** Set or clear the switch (the operator's path; tests use it too). */
export async function setSolverPaused(paused: boolean): Promise<void> {
  await rawQuery(
    `INSERT INTO platform_flags (key, value) VALUES ('solver_paused', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(paused)]
  );
}

/** Per-section and per-notebook bounds; the notebook is a working record, not a dump. */
export const NOTEBOOK_MAX_SECTION_CHARS = 40_000;
export const NOTEBOOK_MAX_SECTIONS = 200;

export async function writeNotebookSection(
  attemptId: string,
  section: string,
  content: string
): Promise<Record<string, string>> {
  const [row] = await rawQuery<{ notebook: Record<string, string> }>(
    `UPDATE proof_attempts
        SET notebook = COALESCE(notebook, '{}'::jsonb) || jsonb_build_object($2::text, $3::text)
      WHERE id = $1
      RETURNING notebook`,
    [attemptId, section, content]
  );
  return row?.notebook ?? {};
}

export async function readNotebook(attemptId: string): Promise<Record<string, string>> {
  const [row] = await rawQuery<{ notebook: Record<string, string> | null }>(
    `SELECT notebook FROM proof_attempts WHERE id = $1`,
    [attemptId]
  );
  return row?.notebook ?? {};
}

// ---------------------------------------------------------------------------
// Lean checks recorded for an attempt
// ---------------------------------------------------------------------------

export interface AttemptLeanCheckInput {
  attemptId: string;
  formalizationId: string;
  runId?: string | null;
  kind: "proof" | "disproof";
  submissionSha256: string;
  submissionSource: string;
  verdict: "accepted" | "rejected" | "error";
  checks: unknown;
  diagnostics: unknown;
  truncated: boolean;
  resource: unknown;
  pinId: string;
  imageDigest: string;
  checkerVersion: string;
  costMicroUsd: number;
  finishedAt?: string | null;
}

export interface AttemptLeanCheckRow {
  id: string;
  formalization_id: string;
  attempt_id: string | null;
  kind: "proof" | "disproof";
  mode: string;
  verdict: "accepted" | "rejected" | "error";
  submission_sha256: string;
  submission_source: string;
  checks: unknown;
  diagnostics: unknown;
  truncated: boolean;
  resource: unknown;
  pin_id: string;
  image_digest: string;
  checker_version: string;
  cost_micro_usd: number;
  created_at: Date;
  finished_at: Date | null;
}

const LEAN_CHECK_COLUMNS = `
  id, formalization_id, attempt_id, kind, mode, verdict, submission_sha256,
  submission_source, checks, diagnostics, truncated, resource, pin_id, image_digest,
  checker_version, cost_micro_usd::bigint AS cost_micro_usd, created_at, finished_at`;

/**
 * Record one attempt-mode check the harness ran. The table's unique
 * constraint makes an identical (formalization, sha256, checker version,
 * mode) re-run land on the stored row; the attempt that re-ran it is
 * recorded on the row so the report validator can find it.
 */
export async function recordAttemptLeanCheck(
  input: AttemptLeanCheckInput
): Promise<AttemptLeanCheckRow> {
  const [row] = await rawQuery<AttemptLeanCheckRow>(
    `INSERT INTO lean_checks
       (formalization_id, mode, kind, submission_sha256, submission_source,
        submitted_by, attempt_id, run_id, verdict, checks, diagnostics, truncated,
        resource, pin_id, image_digest, checker_version, cost_micro_usd, finished_at)
     VALUES ($1, 'attempt', $2, $3, $4, 'math_solver', $5, $6, $7, $8::jsonb, $9::jsonb,
             $10, $11::jsonb, $12, $13, $14, $15, $16)
     ON CONFLICT (formalization_id, submission_sha256, checker_version, mode)
       DO UPDATE SET attempt_id = EXCLUDED.attempt_id, run_id = EXCLUDED.run_id,
                     verdict = EXCLUDED.verdict, checks = EXCLUDED.checks,
                     diagnostics = EXCLUDED.diagnostics, truncated = EXCLUDED.truncated,
                     resource = EXCLUDED.resource,
                     cost_micro_usd = lean_checks.cost_micro_usd + EXCLUDED.cost_micro_usd,
                     finished_at = EXCLUDED.finished_at
     RETURNING ${LEAN_CHECK_COLUMNS}`,
    [
      input.formalizationId,
      input.kind,
      input.submissionSha256,
      input.submissionSource,
      input.attemptId,
      input.runId ?? null,
      input.verdict,
      JSON.stringify(input.checks ?? {}),
      JSON.stringify(input.diagnostics ?? []),
      input.truncated,
      JSON.stringify(input.resource ?? {}),
      input.pinId,
      input.imageDigest,
      input.checkerVersion,
      Math.max(0, Math.round(input.costMicroUsd)),
      input.finishedAt ? new Date(input.finishedAt) : new Date(),
    ]
  );
  return { ...row!, cost_micro_usd: Number(row!.cost_micro_usd) };
}

/** A stored attempt-mode check for this statement and submission hash, for dedup. */
export async function findStoredAttemptCheck(
  formalizationId: string,
  submissionSha256: string
): Promise<AttemptLeanCheckRow | null> {
  const [row] = await rawQuery<AttemptLeanCheckRow>(
    `SELECT ${LEAN_CHECK_COLUMNS} FROM lean_checks
      WHERE formalization_id = $1 AND submission_sha256 = $2 AND mode = 'attempt'
      ORDER BY created_at DESC LIMIT 1`,
    [formalizationId, submissionSha256]
  );
  return row ? { ...row, cost_micro_usd: Number(row.cost_micro_usd) } : null;
}

/** The check row a report names, only if this attempt wrote it. */
export async function findAttemptLeanCheck(
  attemptId: string,
  leanCheckId: string
): Promise<AttemptLeanCheckRow | null> {
  const [row] = await rawQuery<AttemptLeanCheckRow>(
    `SELECT ${LEAN_CHECK_COLUMNS} FROM lean_checks
      WHERE id = $1 AND attempt_id = $2 AND mode = 'attempt'`,
    [leanCheckId, attemptId]
  );
  return row ? { ...row, cost_micro_usd: Number(row.cost_micro_usd) } : null;
}

export async function listAttemptLeanChecks(attemptId: string): Promise<AttemptLeanCheckRow[]> {
  const rows = await rawQuery<AttemptLeanCheckRow>(
    `SELECT ${LEAN_CHECK_COLUMNS} FROM lean_checks
      WHERE attempt_id = $1
      ORDER BY created_at ASC`,
    [attemptId]
  );
  return rows.map((r) => ({ ...r, cost_micro_usd: Number(r.cost_micro_usd) }));
}

// ---------------------------------------------------------------------------
// Closing, publication, cancellation
// ---------------------------------------------------------------------------

export type CloseStatus = Exclude<AttemptStatus, "running" | "cancelling">;

export interface CloseAttemptInput {
  status: CloseStatus;
  outcome?: AttemptOutcome | null;
  report?: Record<string, unknown> | null;
  leanProof?: string | null;
  leanCheckId?: string | null;
  error?: string | null;
  spentMicroUsd?: number;
  turns?: number;
  servedModels?: readonly string[];
}

export interface CloseAttemptResult {
  attempt: AttemptRow;
  /** The bounty moved to `house_result_pending`, when one was `open` on the statement. */
  bountyMoved: string | null;
}

/**
 * Close the attempt and, in the same transaction, move an `open` bounty on
 * its statement to `house_result_pending` when the close carries an
 * accepted check from this attempt (§8.1). A close of an attempt that is
 * already closed changes nothing.
 */
export async function closeAttempt(
  attemptId: string,
  input: CloseAttemptInput
): Promise<CloseAttemptResult | null> {
  return withTransaction(async (tx) => {
    const [current] = await tx.query<AttemptRow>(
      `SELECT ${ATTEMPT_COLUMNS} FROM proof_attempts WHERE id = $1 FOR UPDATE`,
      [attemptId]
    );
    if (!current) return null;
    if (current.status !== "running" && current.status !== "cancelling") {
      return { attempt: coerceAttempt(current), bountyMoved: null };
    }

    let acceptedCheckId: string | null = null;
    if (input.leanCheckId) {
      const [check] = await tx.query<{ id: string; verdict: string }>(
        `SELECT id, verdict FROM lean_checks
          WHERE id = $1 AND attempt_id = $2 AND formalization_id = $3 AND mode = 'attempt'`,
        [input.leanCheckId, attemptId, current.formalization_id]
      );
      if (check?.verdict === "accepted") acceptedCheckId = check.id;
    }

    const [row] = await tx.query<AttemptRow>(
      `UPDATE proof_attempts
          SET status = $2, outcome = $3, report = $4::jsonb, lean_proof = $5,
              lean_check_id = $6, error = $7,
              spent_micro_usd = COALESCE($8, spent_micro_usd),
              turns = COALESCE($9, turns),
              served_models = COALESCE($10::jsonb, served_models),
              finished_at = now(), heartbeat_at = now()
        WHERE id = $1
        RETURNING ${ATTEMPT_COLUMNS}`,
      [
        attemptId,
        input.status,
        input.outcome ?? null,
        input.report ? JSON.stringify(input.report) : null,
        input.leanProof ?? null,
        acceptedCheckId,
        input.error ?? null,
        input.spentMicroUsd !== undefined ? Math.max(0, Math.round(input.spentMicroUsd)) : null,
        input.turns !== undefined ? Math.max(0, Math.round(input.turns)) : null,
        input.servedModels ? JSON.stringify([...input.servedModels]) : null,
      ]
    );

    let bountyMoved: string | null = null;
    if (acceptedCheckId && input.status === "completed") {
      const [bounty] = await tx.query<{ id: string }>(
        `UPDATE bounties
            SET status = 'house_result_pending', updated_at = now()
          WHERE formalization_id = $1 AND status = 'open'
          RETURNING id`,
        [current.formalization_id]
      );
      bountyMoved = bounty?.id ?? null;
    }
    return { attempt: coerceAttempt(row!), bountyMoved };
  });
}

/**
 * Publish the report and notebook (§7.7): only for a closed attempt, and
 * never while a `house_result_pending` bounty on its statement is
 * undecided. Idempotent; returns whether the row is now published.
 */
export async function publishAttempt(attemptId: string, tx?: TxQuery): Promise<boolean> {
  const q = tx ? tx.query.bind(tx) : rawQuery;
  const rows = await q<{ id: string; published_at: Date | null }>(
    `UPDATE proof_attempts p
        SET published_at = COALESCE(p.published_at, now())
      WHERE p.id = $1
        AND p.status NOT IN ('running', 'cancelling')
        AND NOT EXISTS (SELECT 1 FROM bounties b
                         WHERE b.formalization_id = p.formalization_id
                           AND b.status = 'house_result_pending')
      RETURNING p.id, p.published_at`,
    [attemptId]
  );
  return rows.length > 0 && rows[0]!.published_at !== null;
}

/** A live attempt heartbeats every turn; this long without one is a dead worker (§7.2). */
export const ATTEMPT_ORPHAN_HOURS = 3;

/**
 * Mark attempts whose worker died as `orphaned` (§7.9): live rows with no
 * heartbeat for ATTEMPT_ORPHAN_HOURS. The reopen sweep returns their
 * actions to open on the same clock; the spend to that point is already on
 * the meter. Returns the ids it closed.
 */
export async function sweepOrphanedAttempts(
  hours: number = ATTEMPT_ORPHAN_HOURS
): Promise<string[]> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE proof_attempts
        SET status = 'orphaned', finished_at = now(),
            error = COALESCE(error, 'no heartbeat for ' || $1::text || ' hours; the worker died')
      WHERE status IN ('running', 'cancelling')
        AND COALESCE(heartbeat_at, started_at) < now() - make_interval(hours => $1)
      RETURNING id`,
    [Math.max(1, Math.round(hours))]
  );
  return rows.map((r) => r.id);
}

/** The operator's cancel (§7.3): a running attempt becomes `cancelling`; the loop polls it. */
export async function cancelAttempt(attemptId: string): Promise<AttemptRow | null> {
  const [row] = await rawQuery<AttemptRow>(
    `UPDATE proof_attempts SET status = 'cancelling'
      WHERE id = $1 AND status = 'running'
      RETURNING ${ATTEMPT_COLUMNS}`,
    [attemptId]
  );
  return row ? coerceAttempt(row) : null;
}

// ---------------------------------------------------------------------------
// Read models
// ---------------------------------------------------------------------------

/** Whether the claim carries a live bounty (§7.7): what makes an unpublished attempt opaque. */
export async function claimHasLiveBounty(claimId: string): Promise<boolean> {
  const [row] = await rawQuery<{ id: string }>(
    `SELECT id FROM bounties WHERE claim_id = $1 AND status = ANY($2) LIMIT 1`,
    [claimId, LIVE_BOUNTY_STATUSES]
  );
  return !!row;
}

export async function bountyForFormalization(
  formalizationId: string
): Promise<{ id: string; status: string; claim_id: string } | null> {
  const [row] = await rawQuery<{ id: string; status: string; claim_id: string }>(
    `SELECT id, status, claim_id FROM bounties
      WHERE formalization_id = $1 AND status = ANY($2)
      ORDER BY created_at DESC LIMIT 1`,
    [formalizationId, LIVE_BOUNTY_STATUSES]
  );
  return row ?? null;
}

/** The public subset of a stored report. */
export function publicReport(report: Record<string, unknown> | null): AttemptSummary["report"] {
  if (!report) return null;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.map((x) => String(x)) : [];
  return {
    informal_argument: String(report.informal_argument ?? ""),
    approaches_tried: strings(report.approaches_tried),
    obstruction: String(report.obstruction ?? ""),
    what_would_help: String(report.what_would_help ?? ""),
    confidence: Number(report.confidence ?? 0),
  };
}

/**
 * The attempt as the claim page and the attempt log see it: the report
 * and notebook only once published; and on a bounty-bearing claim an
 * unpublished attempt shows only its id, variant, status, dates, and cost,
 * never its outcome (§7.7).
 */
export function serializeAttemptSummary(
  row: AttemptRow,
  opts: { bountyBearing: boolean }
): AttemptSummary {
  const published = row.published_at !== null;
  const opaque = !published && opts.bountyBearing;
  return {
    id: row.id,
    claim_id: row.claim_id,
    variant: row.variant,
    effort: row.effort,
    status: row.status,
    outcome: opaque ? null : row.outcome,
    is_calibration: row.is_calibration,
    spent_micro_usd: row.spent_micro_usd,
    turns: row.turns,
    started_at: row.started_at.toISOString(),
    finished_at: row.finished_at ? row.finished_at.toISOString() : null,
    published_at: row.published_at ? row.published_at.toISOString() : null,
    report: published ? publicReport(row.report) : null,
    notebook: published ? row.notebook : null,
  };
}

export interface TranscriptStep {
  seq: number;
  kind: string;
  content: unknown;
  created_at: string;
}

/** The last `tail` steps of the attempt's run (all steps when `tail` is absent). */
export async function getAttemptTranscript(
  runId: string | null,
  tail?: number
): Promise<TranscriptStep[]> {
  if (!runId) return [];
  const limit = tail && tail > 0 ? Math.floor(tail) : null;
  const rows = await rawQuery<TranscriptStep & { created_at: Date }>(
    `SELECT seq, kind, content, created_at
       FROM (SELECT seq, kind, content, created_at FROM agent_steps
              WHERE run_id = $1
              ORDER BY seq DESC
              LIMIT COALESCE($2::int, 2147483647)) t
      ORDER BY seq ASC`,
    [runId, limit]
  );
  return rows.map((r) => ({
    seq: r.seq,
    kind: r.kind,
    content: r.content,
    created_at: new Date(r.created_at).toISOString(),
  }));
}

export interface AttemptForSteward {
  attempt: {
    id: string;
    claim_id: string;
    formalization_id: string;
    action_id: string | null;
    run_id: string | null;
    model: string;
    variant: AttemptVariant;
    effort: string;
    status: AttemptStatus;
    outcome: AttemptOutcome | null;
    is_calibration: boolean;
    ceiling_micro_usd: number;
    spent_micro_usd: number;
    turns: number;
    served_models: string[] | null;
    started_at: string;
    finished_at: string | null;
    published_at: string | null;
    error: string | null;
  };
  report: Record<string, unknown> | null;
  lean_proof: string | null;
  lean_check_id: string | null;
  notebook: Record<string, string>;
  lean_checks: Array<{
    id: string;
    kind: string;
    verdict: string;
    submission_sha256: string;
    checks: unknown;
    truncated: boolean;
    resource: unknown;
    pin_id: string;
    checker_version: string;
    created_at: string;
  }>;
  formalization: {
    id: string;
    version: number;
    status: string;
    namespace: string;
    statement_source: string;
    source_hash: string;
    expr_hash: string;
    pin_id: string;
    correspondence: string | null;
    published_at: string | null;
  } | null;
  bounty: { id: string; status: string } | null;
  transcript_tail?: TranscriptStep[];
}

/**
 * What `get_proof_attempt` returns (§7.6): the report, the notebook, the
 * `lean_checks` rows the server wrote, and the formalization; the
 * transcript only when a tail is asked for.
 */
export async function getAttemptForSteward(
  attemptId: string,
  opts: { transcriptTail?: number } = {}
): Promise<AttemptForSteward | null> {
  const row = await getAttempt(attemptId);
  if (!row) return null;
  const [checks, formalization, bounty] = await Promise.all([
    listAttemptLeanChecks(attemptId),
    getFormalization(row.formalization_id),
    bountyForFormalization(row.formalization_id),
  ]);
  const out: AttemptForSteward = {
    attempt: {
      id: row.id,
      claim_id: row.claim_id,
      formalization_id: row.formalization_id,
      action_id: row.action_id,
      run_id: row.run_id,
      model: row.model,
      variant: row.variant,
      effort: row.effort,
      status: row.status,
      outcome: row.outcome,
      is_calibration: row.is_calibration,
      ceiling_micro_usd: row.ceiling_micro_usd,
      spent_micro_usd: row.spent_micro_usd,
      turns: row.turns,
      served_models: row.served_models,
      started_at: row.started_at.toISOString(),
      finished_at: row.finished_at ? row.finished_at.toISOString() : null,
      published_at: row.published_at ? row.published_at.toISOString() : null,
      error: row.error,
    },
    report: row.report,
    lean_proof: row.lean_proof,
    lean_check_id: row.lean_check_id,
    notebook: row.notebook,
    lean_checks: checks.map((c) => ({
      id: c.id,
      kind: c.kind,
      verdict: c.verdict,
      submission_sha256: c.submission_sha256,
      checks: c.checks,
      truncated: c.truncated,
      resource: c.resource,
      pin_id: c.pin_id,
      checker_version: c.checker_version,
      created_at: new Date(c.created_at).toISOString(),
    })),
    formalization: formalization
      ? {
          id: formalization.id,
          version: formalization.version,
          status: formalization.status,
          namespace: formalization.namespace,
          statement_source: formalization.statement_source,
          source_hash: formalization.source_hash,
          expr_hash: formalization.expr_hash,
          pin_id: formalization.pin_id,
          correspondence: formalization.correspondence,
          published_at: formalization.published_at
            ? new Date(formalization.published_at).toISOString()
            : null,
        }
      : null,
    bounty: bounty ? { id: bounty.id, status: bounty.status } : null,
  };
  if (opts.transcriptTail && opts.transcriptTail > 0) {
    out.transcript_tail = await getAttemptTranscript(row.run_id, opts.transcriptTail);
  }
  return out;
}

export interface PublicAttempt extends AttemptSummary {
  formalization_id: string;
  model: string;
  lean_proof: string | null;
  lean_check_id: string | null;
  lean_checks: Array<{ id: string; kind: string; verdict: string; created_at: string }> | null;
  transcript?: TranscriptStep[];
}

/**
 * GET /attempts/:id (§11.1): the summary plus, once published, the Lean
 * proof and the check rows; the transcript only for service callers.
 */
export async function getAttemptPublic(
  attemptId: string,
  opts: { includeTranscript?: boolean } = {}
): Promise<PublicAttempt | null> {
  const row = await getAttempt(attemptId);
  if (!row) return null;
  const bountyBearing = await claimHasLiveBounty(row.claim_id);
  const summary = serializeAttemptSummary(row, { bountyBearing });
  const published = row.published_at !== null;
  const checks = published ? await listAttemptLeanChecks(attemptId) : [];
  const out: PublicAttempt = {
    ...summary,
    formalization_id: row.formalization_id,
    model: row.model,
    lean_proof: published ? row.lean_proof : null,
    lean_check_id: published ? row.lean_check_id : null,
    lean_checks: published
      ? checks.map((c) => ({
          id: c.id,
          kind: c.kind,
          verdict: c.verdict,
          created_at: new Date(c.created_at).toISOString(),
        }))
      : null,
  };
  if (opts.includeTranscript) {
    out.transcript = await getAttemptTranscript(row.run_id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Steward's mechanical close (§7.6)
// ---------------------------------------------------------------------------

export type MarkSolvedResult =
  | {
      ok: true;
      attempt_id: string;
      formalization_id: string;
      lean_check_id: string;
      outcome: AttemptOutcome;
      bounty: { id: string; status: string; previous_status: string } | null;
      published_at: string | null;
    }
  | {
      ok: false;
      code: string;
      message: string;
      /** On HUMAN_CLAIM_PENDING: the live claims filed before the result, in priority order. */
      pending_prize_claims?: Array<{ id: string; status: string; submitted_at: string }>;
    };

/**
 * The prize-claim statuses that end a claim (prize-claim-service's
 * TERMINAL_PRIZE_CLAIM_STATUSES); any other status is a live claim with
 * priority over a platform result (§8.1).
 */
const TERMINAL_PRIZE_CLAIM_STATUSES = ["paid", "rejected", "voided", "withdrawn", "superseded", "forfeited"];

/**
 * `mark_problem_solved_by_platform`: verify the accepted check belongs to
 * the attempt and the formalization, move the bounty from
 * `house_result_pending` (or `open`) to `resolved_internally` with a note,
 * publish the attempt, and return the record. Refused for anything but a
 * checked proof or disproof, and refused while a human prize claim filed
 * earlier is live on the bounty: a claim filed before the attempt completed
 * is judged first and, if accepted, wins; a platform result never blocks it
 * (§8.1).
 */
export async function markProblemSolvedByPlatform(input: {
  formalizationId: string;
  attemptId: string;
  leanCheckId: string;
  reason: string;
}): Promise<MarkSolvedResult> {
  const attempt = await getAttempt(input.attemptId);
  if (!attempt) {
    return { ok: false, code: "ATTEMPT_NOT_FOUND", message: `no attempt ${input.attemptId}` };
  }
  if (attempt.formalization_id !== input.formalizationId) {
    return {
      ok: false,
      code: "FORMALIZATION_MISMATCH",
      message:
        `attempt ${attempt.id} ran against formalization ${attempt.formalization_id}, ` +
        `not ${input.formalizationId}`,
    };
  }
  if (attempt.status !== "completed") {
    return {
      ok: false,
      code: "ATTEMPT_NOT_COMPLETED",
      message: `attempt ${attempt.id} closed as ${attempt.status}; only a completed attempt settles a statement`,
    };
  }
  if (attempt.outcome !== "proof" && attempt.outcome !== "disproof") {
    return {
      ok: false,
      code: "NOT_A_RESULT",
      message:
        `attempt ${attempt.id} recorded outcome ${attempt.outcome ?? "none"}; a partial ` +
        `result, a reduction, or a negative report settles nothing`,
    };
  }
  const check = await findAttemptLeanCheck(attempt.id, input.leanCheckId);
  if (!check) {
    return {
      ok: false,
      code: "CHECK_NOT_FOUND",
      message: `lean check ${input.leanCheckId} was not written by attempt ${attempt.id}`,
    };
  }
  if (check.formalization_id !== input.formalizationId) {
    return {
      ok: false,
      code: "CHECK_FORMALIZATION_MISMATCH",
      message: `lean check ${check.id} is against formalization ${check.formalization_id}`,
    };
  }
  if (check.verdict !== "accepted") {
    return {
      ok: false,
      code: "CHECK_NOT_ACCEPTED",
      message: `lean check ${check.id} has verdict ${check.verdict}; only an accepted check settles a statement`,
    };
  }
  if (check.kind !== attempt.outcome) {
    return {
      ok: false,
      code: "CHECK_KIND_MISMATCH",
      message: `lean check ${check.id} is a ${check.kind} but the attempt's outcome is ${attempt.outcome}`,
    };
  }

  return withTransaction(async (tx) => {
    const [bounty] = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM bounties
        WHERE formalization_id = $1 AND status IN ('house_result_pending', 'open')
        ORDER BY created_at DESC LIMIT 1
        FOR UPDATE`,
      [input.formalizationId]
    );
    let bountyOut: { id: string; status: string; previous_status: string } | null = null;
    if (bounty) {
      const live = await tx.query<{ id: string; status: string; submitted_at: Date }>(
        `SELECT id, status, submitted_at FROM prize_claims
          WHERE bounty_id = $1 AND status <> ALL($2::text[])
          ORDER BY submitted_at ASC, id ASC`,
        [bounty.id, TERMINAL_PRIZE_CLAIM_STATUSES]
      );
      if (live.length > 0) {
        const pending = live.map((c) => ({
          id: c.id,
          status: c.status,
          submitted_at: new Date(c.submitted_at).toISOString(),
        }));
        return {
          ok: false,
          code: "HUMAN_CLAIM_PENDING",
          message:
            `bounty ${bounty.id} has ${pending.length} live prize claim(s) filed before the platform's result ` +
            `(${pending.map((c) => `${c.id} ${c.status}, filed ${c.submitted_at}`).join("; ")}); ` +
            "a claim filed earlier is judged first and, if accepted, wins, and a platform result never " +
            "blocks it. Record your assessment and leave the bounty to the prize path; this tool can be " +
            "called again once every earlier claim has reached a terminal status.",
          pending_prize_claims: pending,
        };
      }
      await tx.query(
        `UPDATE bounties
            SET status = 'resolved_internally', resolved_at = now(),
                resolution_note = $2, updated_at = now()
          WHERE id = $1`,
        [bounty.id, input.reason]
      );
      bountyOut = { id: bounty.id, status: "resolved_internally", previous_status: bounty.status };
    }
    await publishAttempt(attempt.id, tx);
    const [row] = await tx.query<{ published_at: Date | null }>(
      `SELECT published_at FROM proof_attempts WHERE id = $1`,
      [attempt.id]
    );
    return {
      ok: true,
      attempt_id: attempt.id,
      formalization_id: input.formalizationId,
      lean_check_id: check.id,
      outcome: attempt.outcome as AttemptOutcome,
      bounty: bountyOut,
      published_at: row?.published_at ? new Date(row.published_at).toISOString() : null,
    };
  });
}
