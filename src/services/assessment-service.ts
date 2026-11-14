import { getDb, rawQuery } from "../db/client.js";
import { assessments, assessmentsInForce } from "../db/schema.js";
import { eq, desc, and, gte, lte, count } from "drizzle-orm";

export async function getCurrentAssessment(claimId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(assessmentsInForce)
    .where(eq(assessmentsInForce.claimId, claimId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getAssessmentHistory(
  claimId: string,
  options: { limit?: number; offset?: number; since?: Date; until?: Date } = {}
) {
  const db = getDb();
  const { limit = 20, offset = 0, since, until } = options;

  const conditions = [eq(assessments.claimId, claimId)];
  if (since) conditions.push(gte(assessments.assessedAt, since));
  if (until) conditions.push(lte(assessments.assessedAt, until));

  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(assessments)
      .where(and(...conditions))
      .orderBy(desc(assessments.assessedAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ count: count() })
      .from(assessments)
      .where(and(...conditions)),
  ]);

  return { assessments: rows, total: totalRows[0]?.count ?? 0 };
}

/**
 * Every judgment of a quantity or a question, newest first: the estimates a
 * quantity's Stewards recorded, or a question's assessments of its standing.
 * The same paging and dates as getAssessmentHistory, and each row carries
 * the run that wrote it, so a caller can open it on the run log as it would
 * a claim's verdict. A claim's history is getAssessmentHistory's.
 */
export async function getKindJudgmentHistory(
  claimId: string,
  kind: "quantity" | "question",
  options: { limit?: number; offset?: number; since?: Date; until?: Date } = {}
): Promise<{ rows: Array<Record<string, unknown>>; total: number }> {
  const { limit = 20, offset = 0, since, until } = options;
  const table = kind === "quantity" ? "quantity_estimates" : "question_assessments";
  const where = `claim_id = $1 AND ($2::timestamptz IS NULL OR assessed_at >= $2)
                 AND ($3::timestamptz IS NULL OR assessed_at <= $3)`;
  const columns =
    kind === "quantity"
      ? `id, claim_id, estimate, summary, work AS reasoning_trace, marginal_yield, model, run_id,
         is_current, trigger, trigger_context, assessed_at`
      : `id, claim_id, standing, confidence, favored_claim_ids::text[] AS favored_claim_ids, incomplete,
         summary, reasoning_trace, marginal_yield, model, run_id, is_current, trigger,
         trigger_context, assessed_at`;
  const params = [claimId, since ?? null, until ?? null];
  const [rows, total] = await Promise.all([
    rawQuery<Record<string, unknown> & { assessed_at: Date }>(
      `SELECT ${columns} FROM ${table} WHERE ${where}
        ORDER BY assessed_at DESC, id LIMIT $4 OFFSET $5`,
      [...params, limit, offset]
    ),
    rawQuery<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`, params),
  ]);
  return {
    rows: rows.map((r) => ({
      ...r,
      kind,
      assessed_at: new Date(r.assessed_at).toISOString(),
      run_id: r.run_id ?? null,
    })),
    total: Number(total[0]?.n ?? 0),
  };
}

/**
 * One assessment history row as the API and MCP serve it (and the Audit
 * reads it), so every surface shows the same fields under the same names.
 */
export function formatAssessmentHistoryRow(a: {
  id: string;
  claimId: string;
  status: string;
  confidence: number;
  claimCredence: number | null;
  summary: string | null;
  reasoningTrace: string;
  isCurrent: boolean;
  subclaimSummary: unknown;
  trigger: string | null;
  triggerContext: string | null;
  assessedAt: Date;
  model?: string | null;
  runId?: string | null;
}) {
  return {
    id: a.id,
    claim_id: a.claimId,
    status: a.status,
    confidence: a.confidence,
    claim_credence: a.claimCredence ?? null,
    summary: a.summary ?? a.reasoningTrace,
    reasoning_trace: a.reasoningTrace,
    is_current: a.isCurrent,
    subclaim_summary: a.subclaimSummary ?? {},
    trigger: a.trigger,
    trigger_context: a.triggerContext,
    assessed_at: a.assessedAt.toISOString(),
    model: a.model ?? null,
    // The run that wrote this verdict (GET /runs/:id); null when written
    // outside a traced run or before runs were linked.
    run_id: a.runId ?? null,
  };
}

export async function getAssessmentTrajectory(claimId: string) {
  const db = getDb();
  const rows = await db
    .select({
      status: assessments.status,
      confidence: assessments.confidence,
      assessedAt: assessments.assessedAt,
      isCurrent: assessments.isCurrent,
      trigger: assessments.trigger,
    })
    .from(assessments)
    .where(eq(assessments.claimId, claimId))
    .orderBy(desc(assessments.assessedAt));

  const transitions = rows.length > 1
    ? rows.slice(0, -1).filter((r, i) => r.status !== rows[i + 1]!.status).length
    : 0;

  return {
    current: rows.find(r => r.isCurrent) ?? rows[0] ?? null,
    history: rows,
    totalAssessments: rows.length,
    statusTransitions: transitions,
  };
}
