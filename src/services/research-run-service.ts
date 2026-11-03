/**
 * Research runs (#298): the record of every investigation an administrator
 * delegates to the researcher, and the backstops around launching one.
 *
 * The rows are the durable side of a delegation: the brief, the model, the
 * ceiling, the spend, how the run ended, the report, and the notebook. The
 * judgment about whether to delegate, on which model, and with what budget
 * is the launching administrator's (Part VIII); what lives here is
 * bookkeeping and the mechanical bounds that guarantee a delegation halts:
 * a durable daily cap on researcher spend across every process, and an
 * operator pause flag polled each turn, both copied from the solver's
 * breaker (docs/mathematics.md 7.3).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { LlmBudgetExceededError } from "../llm/errors.js";
import { owlsToMicroUsd } from "./owl.js";

export const RESEARCHER_AGENT = "researcher";

export const RESEARCH_RUN_STATUSES = [
  "running",
  "completed",
  // The run ended on its own (end_turn, turn cap, max_tokens) without
  // calling report; its notebook is all there is.
  "no_report",
  "budget",
  "paused",
  "timeout",
  "refused",
  "failed",
] as const;
export type ResearchRunStatus = (typeof RESEARCH_RUN_STATUSES)[number];

export const RESEARCH_MODEL_TIERS = ["strong", "standard", "cheap"] as const;
export type ResearchModelTier = (typeof RESEARCH_MODEL_TIERS)[number];

/** The model each tier resolves to in this deployment. */
export function modelForTier(tier: ResearchModelTier): string {
  const config = loadConfig();
  switch (tier) {
    case "strong":
      return config.researcherStrongModel;
    case "standard":
      return config.researcherStandardModel;
    case "cheap":
      return config.researcherCheapModel;
  }
}

export interface ResearchRunRow {
  id: string;
  claim_id: string | null;
  grant_id: string | null;
  /** The request the run takes up or scopes (Part VIII); null for a delegated run. */
  request_id: string | null;
  requested_by: string;
  requester_run_id: string | null;
  run_id: string | null;
  job_id: string | null;
  task: string;
  model: string;
  model_tier: string;
  effort: string | null;
  include_constitution: boolean;
  status: ResearchRunStatus;
  tools: string[];
  ceiling_micro_usd: number;
  contribution_budget_micro_usd: number;
  spent_micro_usd: number;
  turns: number;
  served_models: string[] | null;
  report: Record<string, unknown> | null;
  notebook: Record<string, string>;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

const COLUMNS = `id, claim_id, grant_id, request_id, requested_by, requester_run_id, run_id, job_id, task,
  model, model_tier, effort, include_constitution, status, tools,
  ceiling_micro_usd::bigint AS ceiling_micro_usd, spent_micro_usd::bigint AS spent_micro_usd,
  contribution_budget_micro_usd::bigint AS contribution_budget_micro_usd,
  turns, served_models, report, notebook, started_at, finished_at, error`;

function normalize(row: ResearchRunRow): ResearchRunRow {
  return {
    ...row,
    ceiling_micro_usd: Number(row.ceiling_micro_usd),
    contribution_budget_micro_usd: Number(row.contribution_budget_micro_usd ?? 0),
    spent_micro_usd: Number(row.spent_micro_usd),
    turns: Number(row.turns),
    tools: Array.isArray(row.tools) ? row.tools : [],
    notebook: row.notebook && typeof row.notebook === "object" ? row.notebook : {},
  };
}

export async function openResearchRun(input: {
  claimId: string | null;
  grantId: string | null;
  requestedBy: string;
  requesterRunId: string | null;
  jobId: string | null;
  task: string;
  model: string;
  modelTier: ResearchModelTier;
  effort: string | null;
  includeConstitution: boolean;
  ceilingMicroUsd: number;
  /** The request the run takes up, when a mandate funded one (Part VIII). */
  requestId?: string | null;
  /** For a mandate's research: the delegated budget for reviewing its contributions. */
  contributionBudgetMicroUsd?: number;
  /** The notebook the run opens with: a request's earlier run's, for the next stage (#730). */
  notebook?: Record<string, string> | null;
}): Promise<ResearchRunRow> {
  const rows = await rawQuery<ResearchRunRow>(
    `INSERT INTO research_runs
       (claim_id, grant_id, requested_by, requester_run_id, job_id, task, model, model_tier,
        effort, include_constitution, ceiling_micro_usd, request_id, contribution_budget_micro_usd, notebook)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, COALESCE($14::jsonb, '{}'::jsonb))
     RETURNING ${COLUMNS}`,
    [
      input.claimId,
      input.grantId,
      input.requestedBy,
      input.requesterRunId,
      input.jobId,
      input.task,
      input.model,
      input.modelTier,
      input.effort,
      input.includeConstitution,
      Math.max(1, Math.round(input.ceilingMicroUsd)),
      input.requestId ?? null,
      Math.max(0, Math.round(input.contributionBudgetMicroUsd ?? 0)),
      input.notebook && Object.keys(input.notebook).length > 0 ? JSON.stringify(input.notebook) : null,
    ]
  );
  return normalize(rows[0]!);
}

/**
 * The latest finished run on a request, scoping or taking it up, for the
 * next run to open with (#730): a programme carried out in stages begins
 * each stage where the last stopped. Null when none has finished.
 */
export async function latestRequestRun(requestId: string): Promise<ResearchRunRow | null> {
  const rows = await rawQuery<ResearchRunRow>(
    `SELECT ${COLUMNS} FROM research_runs
      WHERE request_id = $1 AND status <> 'running'
      ORDER BY started_at DESC LIMIT 1`,
    [requestId]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

/**
 * The notebook a request's next run opens with (#730): the earlier run's
 * sections, and its report as a section of its own, since the report says
 * what the next stage would need. Section names say where they came from.
 */
export function carriedNotebook(prior: ResearchRunRow): Record<string, string> {
  const carried: Record<string, string> = {};
  for (const [section, content] of Object.entries(prior.notebook ?? {})) {
    carried[`from run ${prior.id.slice(0, 8)}: ${section}`.slice(0, 200)] = content;
  }
  if (prior.report) {
    const { harness: _harness, ...report } = prior.report as Record<string, unknown>;
    carried[`from run ${prior.id.slice(0, 8)}: its report`] = JSON.stringify(report, null, 2);
  }
  return carried;
}

/** Stamp the researcher's own agent_runs id and the tools it was offered, once known. */
export async function stampResearchRun(
  id: string,
  input: { runId: string | null; tools: string[] }
): Promise<void> {
  await rawQuery(`UPDATE research_runs SET run_id = $2, tools = $3::jsonb WHERE id = $1`, [
    id,
    input.runId,
    JSON.stringify(input.tools),
  ]);
}

/** Per-turn progress, so an operator can see a run's spend while it works. */
export async function updateResearchProgress(
  id: string,
  input: { turns: number; spentMicroUsd: number; servedModels: string[] }
): Promise<void> {
  await rawQuery(
    `UPDATE research_runs SET turns = $2, spent_micro_usd = $3, served_models = $4::jsonb WHERE id = $1`,
    [id, input.turns, Math.max(0, Math.round(input.spentMicroUsd)), JSON.stringify(input.servedModels)]
  );
}

export async function closeResearchRun(
  id: string,
  input: {
    status: ResearchRunStatus;
    report: Record<string, unknown> | null;
    spentMicroUsd: number;
    turns?: number;
    servedModels?: string[];
    error: string | null;
  }
): Promise<ResearchRunRow | null> {
  const rows = await rawQuery<ResearchRunRow>(
    `UPDATE research_runs
        SET status = $2, report = $3::jsonb, spent_micro_usd = $4,
            turns = COALESCE($5, turns), served_models = COALESCE($6::jsonb, served_models),
            error = $7, finished_at = now()
      WHERE id = $1
      RETURNING ${COLUMNS}`,
    [
      id,
      input.status,
      input.report === null ? null : JSON.stringify(input.report),
      Math.max(0, Math.round(input.spentMicroUsd)),
      input.turns ?? null,
      input.servedModels ? JSON.stringify(input.servedModels) : null,
      input.error,
    ]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

export async function getResearchRun(id: string): Promise<ResearchRunRow | null> {
  const rows = await rawQuery<ResearchRunRow>(
    `SELECT ${COLUMNS} FROM research_runs WHERE id = $1`,
    [id]
  );
  return rows[0] ? normalize(rows[0]) : null;
}

export type ResearchRunListing = Pick<
  ResearchRunRow,
  "id" | "requested_by" | "task" | "model" | "model_tier" | "status" | "spent_micro_usd" | "turns" | "started_at" | "finished_at"
>;

/**
 * The runs launched for one claim, newest first, without their reports and
 * notebooks: this serves the public claim page, which discloses neither.
 */
export async function listResearchRunsForClaim(claimId: string): Promise<ResearchRunListing[]> {
  const rows = await rawQuery<ResearchRunListing>(
    `SELECT id, requested_by, task, model, model_tier, status,
            spent_micro_usd::bigint AS spent_micro_usd, turns, started_at, finished_at
       FROM research_runs WHERE claim_id = $1 ORDER BY started_at DESC`,
    [claimId]
  );
  return rows.map((r) => ({ ...r, spent_micro_usd: Number(r.spent_micro_usd), turns: Number(r.turns) }));
}

export async function writeResearchNotebookSection(
  id: string,
  section: string,
  content: string
): Promise<void> {
  await rawQuery(
    `UPDATE research_runs
        SET notebook = jsonb_set(COALESCE(notebook, '{}'::jsonb), ARRAY[$2::text], to_jsonb($3::text), true)
      WHERE id = $1`,
    [id, section, content]
  );
}

// ---------------------------------------------------------------------------
// Backstops
// ---------------------------------------------------------------------------

/** Today's (UTC) metered researcher spend, in micro-USD, from the durable meter. */
export async function researcherSpentTodayMicroUsd(): Promise<number> {
  const [row] = await rawQuery<{ spent: number | string | null }>(
    `SELECT COALESCE(SUM(cost_micro_usd), 0)::bigint AS spent
       FROM llm_usage
      WHERE agent = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [RESEARCHER_AGENT]
  );
  return Number(row?.spent ?? 0);
}

/**
 * Throw LlmBudgetExceededError when today's researcher spend, plus the
 * ceiling of the run about to start, would exceed the daily cap. A cap of
 * zero admits nothing.
 */
export async function checkResearcherBudget(ceilingMicroUsd = 0): Promise<void> {
  const cap = owlsToMicroUsd(loadConfig().researcherDailyCapOwls);
  const spent = await researcherSpentTodayMicroUsd();
  if (spent + Math.max(0, ceilingMicroUsd) > cap) {
    throw new LlmBudgetExceededError("researcher_daily_cap_micro_usd", spent, cap);
  }
}

/** The operator's pause switch, a `researcher_paused` row in platform_flags. */
export async function readResearcherPaused(): Promise<boolean> {
  const [row] = await rawQuery<{ value: unknown }>(
    `SELECT value FROM platform_flags WHERE key = 'researcher_paused'`
  );
  if (!row) return false;
  const v = row.value;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return v === "true";
  if (v && typeof v === "object") return (v as { paused?: unknown }).paused === true;
  return false;
}

/**
 * Launchers whose research runs may record on the graph (provenance rows,
 * examinations). A Grantmaker serves its mandate as well as the graph, and
 * funding is kept apart from what the graph says (constitution §19), so the
 * runs it launches read and report and write nothing but their notebook. A
 * run taking up a request does record (#728): Part VIII has the Researcher
 * write its own sources and provenance, and its brief is the request as
 * filed, to which whoever funded it adds nothing. A scoping run does not do
 * the work, so it records nothing.
 */
const GRAPH_WRITING_LAUNCHERS = new Set(["claim_steward", "request"]);

export function launcherWritesGraph(requestedBy: string): boolean {
  return GRAPH_WRITING_LAUNCHERS.has(requestedBy);
}
