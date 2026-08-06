/**
 * Mandate valuers — the judgment layer of the allocation engine.
 *
 * Each mandate decides for itself what the open actions are WORTH, by its
 * own definition of importance, and records those judgments in
 * `mandate_valuations`: one sparse table per the whole graph, one row per
 * (mandate, action) the mandate knows and cares about. The AI-Math mandate
 * holds no opinion on a politics claim; it simply writes no row. The
 * mechanical layer (action-service.ts) never reads valuations — actions
 * run on allocations alone — but every mandate's ALLOCATOR
 * (allocation-service.ts) reads its own valuations to decide where its
 * owls go.
 *
 * Today's valuers are formulas (the policy heuristic below, bulk SQL so a
 * refresh is one statement); a mandate's Grantmaker amends the formula's
 * knobs in conversation, and hand-set per-action valuations are the
 * natural next write to give it. The General assessment mandate is merely
 * the first valuer — scoped mandates run the same machinery restricted to
 * their scope.
 *
 * The formula, per open assess/reassess action:
 *
 *   value = importance                         (as the mandate defines it)
 *         × (floor + (1 − floor)×contestation) (live disagreement sharpens
 *                                               what a verdict is worth)
 *         × expected quality gain              (marginal_yield; 1.0 when
 *                                               unassessed; revived by
 *                                               staleness as evidence
 *                                               drifts)
 *         + provenance boost                   (a human proposed it, #284)
 *
 *   value(strong variant) = value(standard) × strong_gain_multiplier
 *
 * Money appears NOWHERE here: allocations reduce what remains to be
 * covered on the cost side, never how valuable an action is, and nothing
 * in this table ever touches claims.importance or a verdict.
 */
import { rawQuery } from "../db/client.js";
import {
  getMandateAllocationPolicy,
  getGeneralMandate,
  type AllocationPolicy,
} from "./allocation-policy-service.js";

/** The value expression for one claims row `c` and actions row `a`.
 * Parameter offsets are fixed: $3 contestation floor, $4 staleness
 * saturation days, $5 provenance boost, $6 strong gain multiplier
 * ($1/$2 are reserved for the caller's scope parameters). */
const VALUE_SQL = `
  LEAST(10.0,
    c.importance
    * ($3::real + (1.0 - $3::real) * COALESCE(c.contestation, 0))
    * GREATEST(
        COALESCE(
          (SELECT x.marginal_yield FROM assessments x
            WHERE x.claim_id = c.id AND x.is_current = true
            ORDER BY x.assessed_at DESC LIMIT 1),
          1.0),
        LEAST(1.0,
          COALESCE(EXTRACT(EPOCH FROM (now() -
            (SELECT x.assessed_at FROM assessments x
              WHERE x.claim_id = c.id AND x.is_current = true
              ORDER BY x.assessed_at DESC LIMIT 1))) / 86400.0
            / NULLIF($4::real, 0), 0)))
    + CASE WHEN c.created_by = 'user' THEN $5::real ELSE 0 END
  ) * CASE WHEN a.variant = 'strong' THEN $6::real ELSE 1.0 END`;

/** The scope CTE (same shape as grant-pipeline's): subtree and/or text. */
const SCOPE_SQL = `
  WITH RECURSIVE subtree AS (
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
  )`;

export interface ValuerMandateRow {
  id: string;
  policy: string;
  scope_claim_id: string | null;
  scope_query: string | null;
}

/**
 * Refresh one mandate's valuations over the open assess/reassess actions
 * it cares about. The General mandate (policy 'general') values the whole
 * graph; a scoped mandate values only its scope — a mandate with no scope
 * and no 'general' policy values nothing (its judgments would have no
 * basis). One bulk upsert; rows for actions that left the candidate set
 * are pruned. Returns how many valuations now stand.
 */
export async function refreshMandateValuations(
  mandate: ValuerMandateRow,
  policyOverride?: AllocationPolicy
): Promise<number> {
  const general = mandate.policy === "general";
  if (!general && !mandate.scope_claim_id && !mandate.scope_query) return 0;
  const policy =
    policyOverride ?? (await getMandateAllocationPolicy(mandate.id));

  const params: unknown[] = [
    mandate.scope_claim_id,
    mandate.scope_query,
    policy.contestation_floor,
    policy.staleness_saturation_days,
    policy.user_provenance_boost,
    policy.strong_gain_multiplier,
    mandate.id,
  ];
  const scopeFilter = general
    ? ""
    : "AND c.id IN (SELECT id FROM scope)";
  const rows = await rawQuery<{ action_id: string }>(
    `${SCOPE_SQL}
     INSERT INTO mandate_valuations (grant_id, action_id, value_est, updated_at)
     SELECT $7, a.id, ${VALUE_SQL}, now()
       FROM actions a
       JOIN claims c ON c.id = a.claim_id
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND c.state = 'active'
        ${scopeFilter}
     ON CONFLICT (grant_id, action_id) DO UPDATE
        SET value_est = EXCLUDED.value_est, updated_at = now()
     RETURNING action_id`,
    params
  );

  // Prune judgments about actions no longer open (done, superseded,
  // cancelled): the table stays a live opinion, not a history.
  await rawQuery(
    `DELETE FROM mandate_valuations mv
      USING actions a
      WHERE mv.grant_id = $1 AND a.id = mv.action_id
        AND a.status <> 'open'`,
    [mandate.id]
  );
  return rows.length;
}

/**
 * Refresh the General mandate's valuations and mirror its standard-variant
 * assess values into claims.queue_priority — a display cache for claim
 * pages, no longer the authoritative store. Returns the valuation count
 * (0 when no General mandate is seeded; dev and tests run without one).
 */
export async function refreshGeneralValuations(): Promise<number> {
  const general = await getGeneralMandate();
  if (!general) return 0;
  const count = await refreshMandateValuations({
    id: general.grantId,
    policy: "general",
    scope_claim_id: null,
    scope_query: null,
  });
  await rawQuery(
    `UPDATE claims c SET queue_priority = mv.value_est
       FROM mandate_valuations mv
       JOIN actions a ON a.id = mv.action_id
      WHERE mv.grant_id = $1 AND a.claim_id = c.id
        AND a.variant = 'standard' AND a.status = 'open'`,
    [general.grantId]
  );
  return count;
}

/**
 * Refresh every active mandate's valuations — the scheduler's sweep. The
 * General mandate first (it also refreshes the queue_priority cache),
 * then each scoped mandate over its scope.
 */
export async function refreshAllValuations(): Promise<{
  mandates: number;
  valuations: number;
}> {
  let mandates = 0;
  let valuations = 0;

  const generalCount = await refreshGeneralValuations();
  if (generalCount > 0) {
    mandates++;
    valuations += generalCount;
  }

  const scoped = await rawQuery<ValuerMandateRow>(
    `SELECT id, policy, scope_claim_id, scope_query FROM grants
      WHERE status = 'active' AND policy <> 'general'
        AND (scope_claim_id IS NOT NULL OR scope_query IS NOT NULL)`
  );
  for (const mandate of scoped) {
    const n = await refreshMandateValuations(mandate);
    if (n > 0) {
      mandates++;
      valuations += n;
    }
  }
  return { mandates, valuations };
}
