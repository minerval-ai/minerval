/**
 * The scope survey: one page of the graph's allocation signals over a
 * subtree and/or a keyword slice, most valuable first. The mandate agents
 * (Grantmaker chat, planning pass, review pass, lookouts) all read the
 * same query, so the numbers they reason from cannot drift between them.
 */
import { rawQuery } from "../db/client.js";

/** One row of the survey the agent sees per claim in scope. */
export interface SurveyRow {
  id: string;
  text: string;
  importance: number;
  contestation: number | null;
  queue_priority: number;
  steward_state: string;
  assessment_status: string | null;
  days_since_assessed: number | null;
  marginal_yield: number | null;
  deferred_subclaims: number;
}

export async function surveyScope(input: {
  scopeClaimId: string | null;
  scopeQuery: string | null;
  filterQuery?: string;
  offset: number;
  limit: number;
}): Promise<SurveyRow[]> {
  const query = input.filterQuery?.trim() || input.scopeQuery?.trim() || null;
  return rawQuery<SurveyRow>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $1
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
     ),
     scope AS (
       SELECT c.id FROM claims c
        WHERE c.state = 'active'
          AND (($1::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
               OR ($2::text IS NOT NULL
                   AND c.text_search @@ websearch_to_tsquery('english', $2)))
     )
     SELECT c.id, c.text, c.importance, c.contestation, c.queue_priority,
            c.steward_state,
            a.status AS assessment_status,
            CASE WHEN a.assessed_at IS NULL THEN NULL
                 ELSE FLOOR(EXTRACT(EPOCH FROM (now() - a.assessed_at)) / 86400)::int
            END AS days_since_assessed,
            a.marginal_yield,
            (SELECT COUNT(*)::int FROM claim_relationships cr
              JOIN claims sub ON sub.id = cr.child_claim_id
             WHERE cr.parent_claim_id = c.id
               AND sub.steward_state = 'deferred') AS deferred_subclaims
       FROM claims c
       JOIN scope ON scope.id = c.id
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
      ORDER BY c.queue_priority DESC
      OFFSET $3 LIMIT $4`,
    [input.scopeClaimId, query, input.offset, input.limit]
  );
}
