import { getDb } from "../db/client.js";
import { assessments } from "../db/schema.js";
import { eq, desc, and, gte, lte, count } from "drizzle-orm";

export async function getCurrentAssessment(claimId: string) {
  const db = getDb();
  const rows = await db
    .select()
    .from(assessments)
    .where(and(eq(assessments.claimId, claimId), eq(assessments.isCurrent, true)))
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
