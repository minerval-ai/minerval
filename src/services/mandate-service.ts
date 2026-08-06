/**
 * Public mandates — the outward face of grants.
 *
 * A mandate is managed by one user (or by the platform itself) but is a
 * PUBLIC thing: anyone can read its dashboard and put their own owls
 * behind it. The dashboard payload scales with what the mandate actually
 * does: every mandate reports budget, spend, contributors, and funded
 * assessments; mandates with ingestion additionally report their pipeline
 * (each source brought in, where its claims went, and importance and
 * contestation statistics per source), which is also exactly the data the
 * Grantmaker's analytics tools read when the manager asks questions.
 *
 * Discovery (/mandates) gives pride of place to the largest mandates and
 * to the platform's own (Mathematics, AI Economics to start).
 */
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import {
  contributeToBudgetJob,
  getJobContributions,
  getJobSpentMicroUsd,
} from "./budget-job-service.js";
import { grantAllocationExposureMicroUsd } from "./allocation-service.js";
import type { GrantMandate } from "../llm/agents/grantmaker.js";
import type { PlanItem } from "./grant-service.js";

export interface MandateSummary {
  id: string;
  title: string;
  objective: string | null;
  is_platform: boolean;
  status: string;
  manager: string;
  budget_owls: number;
  spent_owls: number;
  contributor_count: number;
  action_mix: Record<string, number>;
  created_at: string | null;
}

interface GrantRow {
  id: string;
  name: string;
  status: string;
  is_platform: boolean;
  scope_claim_id: string | null;
  scope_query: string | null;
  plan: { strategy?: string; items?: PlanItem[] } | null;
  plan_cursor: number;
  mandate: GrantMandate | null;
  budget_job_id: string;
  budget_micro_usd: number;
  job_status: string;
  funder_user_id: string;
  manager_name: string;
  created_at: Date | null;
}

const GRANT_SELECT = `
  SELECT g.id, g.name, g.status, g.is_platform, g.scope_claim_id,
         g.scope_query, g.plan, g.plan_cursor, g.mandate, g.budget_job_id,
         g.funder_user_id, g.created_at,
         j.budget_micro_usd, j.status AS job_status,
         COALESCE(c.display_name, 'a Minerval user') AS manager_name
    FROM grants g
    JOIN budget_jobs j ON j.id = g.budget_job_id
    LEFT JOIN contributors c ON c.id = g.funder_user_id`;

function actionMix(plan: GrantRow["plan"]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const item of plan?.items ?? []) {
    mix[item.action] = (mix[item.action] ?? 0) + 1;
  }
  return mix;
}

async function summarize(row: GrantRow): Promise<MandateSummary> {
  // A mandate's spend is what its runs metered directly to its job PLUS
  // its consumed shares of co-funded actions (the allocation engine).
  const [jobSpent, exposure, contributions] = await Promise.all([
    getJobSpentMicroUsd(row.budget_job_id),
    grantAllocationExposureMicroUsd(row.id),
    getJobContributions(row.budget_job_id),
  ]);
  const spent = jobSpent + exposure.spentMicroUsd;
  return {
    id: row.id,
    title: row.mandate?.title ?? row.name,
    objective: row.mandate?.objective ?? null,
    is_platform: row.is_platform,
    status: row.status,
    manager: row.is_platform ? "Minerval" : row.manager_name,
    budget_owls: microUsdToOwls(Number(row.budget_micro_usd)),
    spent_owls: microUsdToOwls(
      Math.min(spent, Number(row.budget_micro_usd))
    ),
    contributor_count: contributions.length,
    action_mix: actionMix(row.plan),
    created_at: row.created_at?.toISOString() ?? null,
  };
}

/**
 * The public listing: platform mandates first, then by total budget. Only
 * live mandates (active or budget-paused) are contributable; completed and
 * cancelled ones drop off.
 */
export async function listPublicMandates(limit = 50): Promise<MandateSummary[]> {
  const rows = await rawQuery<GrantRow>(
    `${GRANT_SELECT}
      WHERE g.status = 'active'
      ORDER BY g.is_platform DESC, j.budget_micro_usd DESC, g.created_at ASC
      LIMIT $1`,
    [limit]
  );
  return Promise.all(rows.map(summarize));
}

export interface SourcePipelineRow {
  source_id: string;
  url: string;
  title: string | null;
  ingested_at: string | null;
  extraction_status: string | null;
  claims_linked: number;
  claims_assessed: number;
  avg_importance: number | null;
  max_importance: number | null;
  contested_claims: number;
  importance_histogram: number[];
}

/**
 * The ingestion-pipeline view: one row per source the mandate brought in,
 * with where its claims went and what they look like. The histogram is
 * four importance buckets (0–.25, .25–.5, .5–.75, .75–1).
 */
export async function getMandatePipeline(
  grantId: string
): Promise<SourcePipelineRow[]> {
  const rows = await rawQuery<{
    source_id: string;
    url: string;
    title: string | null;
    ingested_at: Date | null;
    extraction_status: string | null;
    claims_linked: number;
    claims_assessed: number;
    avg_importance: number | null;
    max_importance: number | null;
    contested_claims: number;
    b1: number;
    b2: number;
    b3: number;
    b4: number;
  }>(
    `SELECT gs.source_id, gs.url, s.title, gs.created_at AS ingested_at,
            j.status AS extraction_status,
            COUNT(DISTINCT ci.claim_id)::int AS claims_linked,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE a.id IS NOT NULL)::int AS claims_assessed,
            AVG(cl.importance)::real AS avg_importance,
            MAX(cl.importance)::real AS max_importance,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.contestation >= 0.5)::int AS contested_claims,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.importance < 0.25)::int AS b1,
            COUNT(DISTINCT ci.claim_id) FILTER
              (WHERE cl.importance >= 0.25 AND cl.importance < 0.5)::int AS b2,
            COUNT(DISTINCT ci.claim_id) FILTER
              (WHERE cl.importance >= 0.5 AND cl.importance < 0.75)::int AS b3,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.importance >= 0.75)::int AS b4
       FROM grant_sources gs
       JOIN sources s ON s.id = gs.source_id
       LEFT JOIN jobs j ON j.id = gs.job_id
       LEFT JOIN claim_instances ci ON ci.source_id = gs.source_id
       LEFT JOIN claims cl ON cl.id = ci.claim_id AND cl.state = 'active'
       LEFT JOIN assessments a
         ON a.claim_id = ci.claim_id AND a.is_current = true
      WHERE gs.grant_id = $1
      GROUP BY gs.source_id, gs.url, s.title, gs.created_at, j.status
      ORDER BY gs.created_at ASC`,
    [grantId]
  );
  return rows.map((r) => ({
    source_id: r.source_id,
    url: r.url,
    title: r.title,
    ingested_at: r.ingested_at?.toISOString() ?? null,
    extraction_status: r.extraction_status,
    claims_linked: r.claims_linked,
    claims_assessed: r.claims_assessed,
    avg_importance:
      r.avg_importance != null
        ? Math.round(r.avg_importance * 100) / 100
        : null,
    max_importance:
      r.max_importance != null
        ? Math.round(r.max_importance * 100) / 100
        : null,
    contested_claims: r.contested_claims,
    importance_histogram: [r.b1, r.b2, r.b3, r.b4],
  }));
}

export interface MandateDetail extends MandateSummary {
  strategy: string | null;
  notes: string | null;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_status: string;
  plan_items: Array<PlanItem & { state: "done" | "current" | "queued" }>;
  contributors: Array<{ name: string; owls: number; is_manager: boolean }>;
  funded_assessments: Array<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: string | null;
  }>;
  /** Non-empty exactly when the mandate ingests: the pipeline view. */
  pipeline: SourcePipelineRow[];
  /** Set only for the manager: the conversation to keep talking in. */
  conversation_id?: string;
  is_manager?: boolean;
}

export async function getPublicMandate(
  grantId: string,
  viewerUserId?: string | null
): Promise<MandateDetail | null> {
  const [row] = await rawQuery<GrantRow>(
    `${GRANT_SELECT} WHERE g.id = $1`,
    [grantId]
  );
  if (!row) return null;
  // Pre-funding conversations are private; a mandate is public once live.
  if (!["active", "completed", "cancelled"].includes(row.status)) return null;

  const summary = await summarize(row);
  const contributions = await getJobContributions(row.budget_job_id);
  const contributorNames = await rawQuery<{ id: string; name: string }>(
    `SELECT id, display_name AS name FROM contributors
      WHERE id = ANY($1::uuid[])`,
    [contributions.map((c) => c.userId)]
  );
  const nameOf = new Map(contributorNames.map((c) => [c.id, c.name]));

  const funded = await rawQuery<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: Date | null;
  }>(
    `SELECT a.claim_id, c.text, a.status, a.assessed_at
       FROM assessments a JOIN claims c ON c.id = a.claim_id
      WHERE a.funded_by_job_id = $1
      ORDER BY a.assessed_at DESC
      LIMIT 100`,
    [row.budget_job_id]
  );

  const items = (row.plan?.items ?? []).map((item, i) => ({
    ...item,
    state: (i < row.plan_cursor
      ? "done"
      : i === row.plan_cursor
        ? "current"
        : "queued") as "done" | "current" | "queued",
  }));

  const hasIngest = items.some((i) => i.action === "ingest");
  const pipeline = hasIngest ? await getMandatePipeline(row.id) : [];

  const isManager = !!viewerUserId && viewerUserId === row.funder_user_id;
  let conversationId: string | undefined;
  if (isManager) {
    const [convo] = await rawQuery<{ id: string }>(
      `SELECT id FROM grant_conversations WHERE grant_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [row.id]
    );
    conversationId = convo?.id;
  }

  return {
    ...summary,
    strategy: row.plan?.strategy ?? row.mandate?.plan?.strategy ?? null,
    notes: row.mandate?.notes ?? null,
    scope_claim_id: row.scope_claim_id,
    scope_query: row.scope_query,
    budget_status: row.job_status,
    plan_items: items,
    contributors: contributions.map((c) => ({
      name:
        row.is_platform && c.userId === row.funder_user_id
          ? "Minerval"
          : (nameOf.get(c.userId) ?? "a Minerval user"),
      owls: microUsdToOwls(c.heldMicroUsd),
      is_manager: c.userId === row.funder_user_id,
    })),
    funded_assessments: funded.map((f) => ({
      claim_id: f.claim_id,
      text: f.text,
      status: f.status,
      assessed_at: f.assessed_at?.toISOString() ?? null,
    })),
    pipeline,
    ...(isManager
      ? { is_manager: true, ...(conversationId ? { conversation_id: conversationId } : {}) }
      : {}),
  };
}

export type ContributeResult =
  | { ok: true; mandate: MandateDetail }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_OPEN" | "INSUFFICIENT_OWLS";
      message: string;
    };

/** Put owls behind a public mandate. Any signed-in user; pro-rata refunds. */
export async function contributeToMandate(input: {
  grantId: string;
  userId: string;
  owls: number;
}): Promise<ContributeResult> {
  const [row] = await rawQuery<GrantRow>(
    `${GRANT_SELECT} WHERE g.id = $1`,
    [input.grantId]
  );
  if (!row || row.status !== "active") {
    return {
      ok: false,
      code: row ? "NOT_OPEN" : "NOT_FOUND",
      message: row
        ? `This mandate is ${row.status} and no longer taking contributions`
        : "Mandate not found",
    };
  }
  const result = await contributeToBudgetJob({
    jobId: row.budget_job_id,
    userId: input.userId,
    owls: input.owls,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code === "INSUFFICIENT_OWLS" ? "INSUFFICIENT_OWLS" : "NOT_OPEN",
      message: result.message,
    };
  }
  const mandate = await getPublicMandate(input.grantId, input.userId);
  return { ok: true, mandate: mandate! };
}
