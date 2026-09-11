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

export const NOTEBOOK_MAX_SECTION_CHARS = 40_000;
export const NOTEBOOK_MAX_SECTIONS = 100;

export interface ResearchRunRow {
  id: string;
  claim_id: string | null;
  grant_id: string | null;
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
  spent_micro_usd: number;
  turns: number;
  served_models: string[] | null;
  report: Record<string, unknown> | null;
  notebook: Record<string, string>;
  started_at: Date;
  finished_at: Date | null;
  error: string | null;
}

const COLUMNS = `id, claim_id, grant_id, requested_by, requester_run_id, run_id, job_id, task,
  model, model_tier, effort, include_constitution, status, tools,
  ceiling_micro_usd::bigint AS ceiling_micro_usd, spent_micro_usd::bigint AS spent_micro_usd,
  turns, served_models, report, notebook, started_at, finished_at, error`;

function normalize(row: ResearchRunRow): ResearchRunRow {
  return {
    ...row,
    ceiling_micro_usd: Number(row.ceiling_micro_usd),
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
}): Promise<ResearchRunRow> {
  const rows = await rawQuery<ResearchRunRow>(
    `INSERT INTO research_runs
       (claim_id, grant_id, requested_by, requester_run_id, job_id, task, model, model_tier,
        effort, include_constitution, ceiling_micro_usd)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
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
    ]
  );
  return normalize(rows[0]!);
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

/** The runs launched for one claim, newest first. */
export async function listResearchRunsForClaim(claimId: string): Promise<ResearchRunRow[]> {
  const rows = await rawQuery<ResearchRunRow>(
    `SELECT ${COLUMNS} FROM research_runs WHERE claim_id = $1 ORDER BY started_at DESC`,
    [claimId]
  );
  return rows.map(normalize);
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
