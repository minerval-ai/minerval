/**
 * Mandate valuations — the judgment layer of the allocation engine.
 *
 * Each mandate decides for itself what the open actions are WORTH, and
 * records those judgments in `mandate_valuations`: sparse rows, one per
 * (mandate, action) the mandate knows and cares about. The mechanical
 * layer (action-service.ts) never reads them — actions run on allocations
 * alone — but every mandate's allocator spends against its own valuations.
 *
 * WHO writes them differs by the mandate's POLICY, not by which mandate it
 * is:
 *
 *  - A FORMULA mandate (policy 'general') values in bulk from its own
 *    allocation policy — the refresh below, run over its scope with its
 *    own knobs, amendable by its Grantmaker in conversation. The
 *    platform's General assessment mandate is the one we seed, but it is
 *    an instance of the kind and not a special case in the code: a second
 *    formula mandate values its own scope from its own knobs, which is
 *    what makes the machinery replicable rather than platform-only.
 *
 *  - A JUDGMENT mandate's scope is defined in WORDS — its mandate text —
 *    and which actions fall under it is a judgment call. Its Grantmaker
 *    runs periodic VALUATION passes (kind 'valuation' actions on the
 *    ledger, self-funded, executed by the engine executor) with real
 *    affordances: search the graph, browse the open ledger, and write
 *    valuations with rationale (setMandateValuations below). No keyword
 *    filter is ever treated as the scope: agents are trusted with the
 *    same discretion a person holding the mandate would have. The formula
 *    never runs for these — it would clobber the agent's judgments, which
 *    share the same (grant, action) rows.
 *
 * Money appears NOWHERE in a valuation: allocations reduce what remains
 * to be covered on the cost side, never how valuable an action is, and
 * nothing here touches claims.importance or a verdict.
 */
import { rawQuery } from "../db/client.js";
import {
  getGeneralMandate,
  getGovernanceMandateIds,
  getMandateAllocationPolicy,
} from "./allocation-policy-service.js";

/** The General formula for one claims row `c` and actions row `a`:
 * importance × contested-factor × expected-quality-gain + provenance
 * boost, strong variants multiplied by the policy's gain knob.
 *
 * Expected quality gain is the best of three estimates: the Steward's own
 * marginal yield from its last pass (1.0 when unassessed), staleness, and
 * an open consistency flag's expected_gain (#330): the Consistency
 * Checker's estimate, made after reading the claim against its neighbors,
 * that a fresh pass would change something. A flag counts while the assess
 * group it was raised on is still open and no newer assessment has landed
 * on the claim (the pass it asked for has not run), and only raises the
 * estimate;
 * importance and contestation weigh it like any other.
 *
 * Parameters: $1 contestation floor, $2 staleness saturation days,
 * $3 provenance boost, $4 strong gain multiplier. */
const GENERAL_VALUE_SQL = `
  LEAST(10.0,
    c.importance
    * ($1::real + (1.0 - $1::real) * COALESCE(c.contestation, 0))
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
            / NULLIF($2::real, 0), 0)),
        COALESCE(
          (SELECT MAX(f.expected_gain) FROM consistency_flags f
             JOIN actions fx ON fx.id = f.action_id
            WHERE f.primary_claim_id = c.id
              AND fx.exclusion_group = a.exclusion_group
              AND fx.status IN ('open', 'running')
              -- The pass the flag asked for has not landed yet: the assess
              -- row is reused when a claim is wanted again, so the row's
              -- status alone would revive an old flag.
              AND f.assessment_id_at_flag = (
                SELECT x.id FROM assessments x
                 WHERE x.claim_id = c.id AND x.is_current = true
                 ORDER BY x.assessed_at DESC LIMIT 1)),
          0))
    + CASE WHEN c.created_by = 'user' THEN $3::real ELSE 0 END
  ) * CASE WHEN a.variant = 'strong' THEN $4::real ELSE 1.0 END`;

/**
 * Refresh ONE formula mandate's valuations over the open assess/reassess
 * actions inside its scope, using that mandate's own policy knobs. A
 * mandate with no scope (the platform's General assessment) values the
 * whole graph; a scoped one values its subtree and/or keyword scope, the
 * same scope resolution the Grantmaker's survey uses.
 *
 * Returns the valuation count.
 */
export async function refreshFormulaValuations(
  grantId: string,
  scope: { scopeClaimId: string | null; scopeQuery: string | null }
): Promise<number> {
  const policy = await getMandateAllocationPolicy(grantId);
  const rows = await rawQuery<{ action_id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $6
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
     )
     INSERT INTO mandate_valuations (grant_id, action_id, value_est, updated_at)
     SELECT $5, a.id, ${GENERAL_VALUE_SQL}, now()
       FROM actions a
       JOIN claims c ON c.id = a.claim_id
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND c.state = 'active'
        -- An unscoped formula mandate values the whole graph. A scoped one
        -- values what its scope covers, subtree OR keyword: the same
        -- disjunction surveyScope resolves, so what the Grantmaker is shown
        -- as its territory is what its formula actually values.
        AND (($6::uuid IS NULL AND $7::text IS NULL)
             OR ($6::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
             OR ($7::text IS NOT NULL
                 AND c.text_search @@ websearch_to_tsquery('english', $7)))
     ON CONFLICT (grant_id, action_id) DO UPDATE
        SET value_est = EXCLUDED.value_est, updated_at = now()
     RETURNING action_id`,
    [
      policy.contestation_floor,
      policy.staleness_saturation_days,
      policy.user_provenance_boost,
      policy.strong_gain_multiplier,
      grantId,
      scope.scopeClaimId,
      scope.scopeQuery,
    ]
  );
  const curated = await refreshCurateValuations(grantId, scope);
  await pruneClosedValuations(grantId);
  return rows.length + curated;
}

/**
 * The formula for one open `curate` row `a` on anchor claim `c` (#363):
 *
 *   importance × request weight × freshness
 *
 * where the request weight is the strongest live request on the anchor (a
 * Steward's escalation or an operator's request 1.0; a reconcile candidate
 * its policy weight × its similarity score) and freshness is 0 for an
 * anchor the Matcher admitted as novel within `curate_matcher_quiet_days`
 * that no agent has asked about since: the check that would find its
 * duplicate just ran. That term is the first live epoch's lesson written as
 * policy: 122 unconditional sweeps of just-matched claims wrote nothing.
 * Parameters: $1 candidate weight, $2 quiet days. */
const CURATE_VALUE_SQL = `
  LEAST(10.0,
    c.importance
    * COALESCE((SELECT MAX(CASE WHEN r.source = 'reconcile_candidate'
                                THEN $1::real * COALESCE(r.signal, 0)
                                ELSE 1.0 END)
                  FROM curation_requests r
                 WHERE r.anchor_claim_id = c.id AND r.consumed_at IS NULL), 0)
    * CASE WHEN c.created_at > now() - make_interval(days => $2::int)
                AND NOT EXISTS (SELECT 1 FROM curation_requests r
                                 WHERE r.anchor_claim_id = c.id
                                   AND r.consumed_at IS NULL
                                   AND r.source <> 'reconcile_candidate')
           THEN 0.0 ELSE 1.0 END)`;

/**
 * Refresh one formula mandate's valuations over the open `curate` rows in
 * its scope (or just one row, when a fresh request wants it priced now).
 * Returns the valuation count.
 */
export async function refreshCurateValuations(
  grantId: string,
  scope: { scopeClaimId: string | null; scopeQuery: string | null },
  actionId: string | null = null
): Promise<number> {
  const policy = await getMandateAllocationPolicy(grantId);
  const rows = await rawQuery<{ action_id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT id FROM claims WHERE id = $4
       UNION
       SELECT cr.child_claim_id
         FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
     )
     INSERT INTO mandate_valuations (grant_id, action_id, value_est, updated_at)
     SELECT $3, a.id, ${CURATE_VALUE_SQL}, now()
       FROM actions a
       JOIN claims c ON c.id = a.claim_id
      WHERE a.status = 'open' AND a.kind = 'curate'
        AND c.state = 'active'
        AND ($6::uuid IS NULL OR a.id = $6)
        AND (($4::uuid IS NULL AND $5::text IS NULL)
             OR ($4::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
             OR ($5::text IS NOT NULL
                 AND c.text_search @@ websearch_to_tsquery('english', $5)))
     ON CONFLICT (grant_id, action_id) DO UPDATE
        SET value_est = EXCLUDED.value_est, updated_at = now()
     RETURNING action_id`,
    [
      policy.curate_candidate_weight,
      Math.round(policy.curate_matcher_quiet_days),
      grantId,
      scope.scopeClaimId,
      scope.scopeQuery,
      actionId,
    ]
  );
  return rows.length;
}

/** An audit's trigger class, as the audit_runs row records its cause. */
const AUDIT_CLASS_WEIGHT_SQL = `
  CASE
    WHEN ar.triggered_by IN ('bounty_posted', 'prize_acceptance', 'prize_check_error') THEN $1::real
    WHEN ar.triggered_by = 'bad_faith_flag' THEN $2::real
    WHEN ar.triggered_by = 'arbitration_overturn' THEN $3::real
    WHEN ar.triggered_by IN ('monitor_signal', 'manual') THEN $4::real
    WHEN ar.triggered_by = 'suspension_review' THEN $5::real
    ELSE $6::real
  END`;

/**
 * Refresh the audit valuations (#363): every active Governance mandate
 * values the open `audit` rows by its policy's class weights, an audit's
 * value rising to twice its class weight as it waits a week; and the
 * General mandate values exactly the audits whose subject is a Governance
 * mandate, the one kind Governance may not value. No mandate ever values an
 * audit of itself (recusal). A prize audit is its bounty reserve's to fund,
 * so the formulas value one only when the reserve could not cover it (its
 * room ran short): then the valuer co-funds the remainder rather than let
 * the audit wait forever. `actionId` narrows the refresh to one fresh row.
 * Returns the valuation count.
 */
export async function refreshAuditValuations(actionId: string | null = null): Promise<number> {
  const governance = await getGovernanceMandateIds();
  const general = await getGeneralMandate();
  let count = 0;
  const valuers: Array<{ grantId: string; ofGovernanceOnly: boolean }> = [
    ...governance.map((grantId) => ({ grantId, ofGovernanceOnly: false })),
    ...(general && governance.length > 0
      ? [{ grantId: general.grantId, ofGovernanceOnly: true }]
      : []),
  ];
  for (const v of valuers) {
    const policy = await getMandateAllocationPolicy(v.grantId);
    const rows = await rawQuery<{ action_id: string }>(
      `INSERT INTO mandate_valuations (grant_id, action_id, value_est, updated_at)
       SELECT $7, a.id,
              LEAST(10.0, (${AUDIT_CLASS_WEIGHT_SQL})
                * (1.0 + LEAST(1.0, EXTRACT(EPOCH FROM (now() - ar.requested_at)) / 604800.0))),
              now()
         FROM actions a
         JOIN audit_runs ar ON ar.action_id = a.id
        WHERE a.status = 'open' AND a.kind = 'audit'
          AND ar.completed_at IS NULL
          AND (ar.bounty_id IS NULL
               OR COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                              FROM action_allocations al
                             WHERE al.exclusion_group = a.exclusion_group
                               AND al.released_at IS NULL), 0) < a.cost_est_micro_usd)
          AND ar.subject_grant_id IS DISTINCT FROM $7
          AND ($8::boolean IS NOT TRUE OR ar.subject_grant_id = ANY($9::uuid[]))
          AND ($10::uuid IS NULL OR a.id = $10)
       ON CONFLICT (grant_id, action_id) DO UPDATE
          SET value_est = EXCLUDED.value_est, updated_at = now()
       RETURNING action_id`,
      [
        policy.audit_value_prize,
        policy.audit_value_bad_faith,
        policy.audit_value_overturn,
        policy.audit_value_anomaly,
        policy.audit_value_suspension,
        policy.audit_value_sweep,
        v.grantId,
        v.ofGovernanceOnly,
        governance,
        actionId,
      ]
    );
    count += rows.length;
    if (actionId === null) await pruneClosedValuations(v.grantId);
  }
  return count;
}

/**
 * The platform lane's refresh: the General mandate's own formula pass, plus
 * the mirror of its standard-variant values into claims.queue_priority (a
 * display cache for claim pages; the authoritative store is the valuations
 * table). Returns the valuation count; 0 when no General mandate is seeded
 * (dev and tests run without one).
 */
export async function refreshGeneralValuations(): Promise<number> {
  const general = await getGeneralMandate();
  if (!general) return 0;
  const count = await refreshFormulaValuations(general.grantId, {
    scopeClaimId: null,
    scopeQuery: null,
  });
  await refreshQueuePriorityCache();
  return count;
}

/**
 * Recompute the claims table's display cache from every mandate's
 * valuations: a claim's shown priority is the HIGHEST value any funder puts
 * on its standard open assess/reassess action. Only assessment: a curate
 * or audit row on the same claim is maintenance about it, not a reason to
 * assess it sooner (the cache paces reassessment).
 *
 * This used to be one mandate assigning its own values into the column,
 * which made the displayed priority whichever mandate's refresh ran last —
 * so a narrow mandate valuing a claim low visibly demoted a claim the
 * platform lane valued highly. The max is over mandates, not over history:
 * a full recompute, so a value that falls is shown falling.
 */
export async function refreshQueuePriorityCache(): Promise<void> {
  await rawQuery(
    `UPDATE claims c
        SET queue_priority = COALESCE(
              (SELECT MAX(mv.value_est)
                 FROM mandate_valuations mv
                 JOIN actions a ON a.id = mv.action_id
                WHERE a.claim_id = c.id
                  AND a.kind IN ('assess', 'reassess')
                  AND a.variant = 'standard'
                  AND a.status = 'open'), 0)
      WHERE EXISTS (SELECT 1 FROM actions a2
                     WHERE a2.claim_id = c.id
                       AND a2.kind IN ('assess', 'reassess')
                       AND a2.variant = 'standard'
                       AND a2.status = 'open')
        AND c.queue_priority IS DISTINCT FROM COALESCE(
              (SELECT MAX(mv.value_est)
                 FROM mandate_valuations mv
                 JOIN actions a ON a.id = mv.action_id
                WHERE a.claim_id = c.id
                  AND a.kind IN ('assess', 'reassess')
                  AND a.variant = 'standard'
                  AND a.status = 'open'), 0)`
  );
}

/** Drop judgments about actions no longer open: the table stays a live
 * opinion, not a history. */
async function pruneClosedValuations(grantId: string): Promise<void> {
  await rawQuery(
    `DELETE FROM mandate_valuations mv
      USING actions a
      WHERE mv.grant_id = $1 AND a.id = mv.action_id
        AND a.status <> 'open'`,
    [grantId]
  );
}

// ---------------------------------------------------------------------------
// Affordances for agent valuers — what a Grantmaker's valuation pass uses.
// ---------------------------------------------------------------------------

export interface OpenActionRow {
  action_id: string;
  kind: string;
  variant: string;
  claim_id: string | null;
  label: string;
  cost_est_micro_usd: number;
  backing_micro_usd: number;
  my_value_est: number | null;
  importance: number | null;
  contestation: number | null;
  assessment_status: string | null;
  days_since_assessed: number | null;
}

/**
 * Browse the open ledger from one mandate's point of view: every open
 * action (optionally text-filtered against labels/claims — a search aid,
 * never a scope), with the shared signals and this mandate's current
 * valuation if it holds one.
 */
export async function listOpenActions(input: {
  grantId: string;
  query?: string | null;
  kind?: string | null;
  valuedOnly?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{ total: number; actions: OpenActionRow[] }> {
  const limit = Math.min(50, Math.max(1, input.limit ?? 25));
  const offset = Math.max(0, input.offset ?? 0);
  const rows = await rawQuery<OpenActionRow & { total: number }>(
    `SELECT a.id AS action_id, a.kind, a.variant, a.claim_id, a.label,
            a.cost_est_micro_usd,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND (al.action_id IS NULL OR al.action_id = a.id)),
                     0)::bigint AS backing_micro_usd,
            mv.value_est AS my_value_est,
            c.importance, c.contestation,
            x.status AS assessment_status,
            CASE WHEN x.assessed_at IS NULL THEN NULL
                 ELSE FLOOR(EXTRACT(EPOCH FROM (now() - x.assessed_at))
                            / 86400)::int END AS days_since_assessed,
            COUNT(*) OVER ()::int AS total
       FROM actions a
       LEFT JOIN mandate_valuations mv
         ON mv.action_id = a.id AND mv.grant_id = $1
       LEFT JOIN claims c ON c.id = a.claim_id
       LEFT JOIN assessments x
         ON x.claim_id = a.claim_id AND x.is_current = true
      WHERE a.status = 'open'
        AND ($2::text IS NULL OR a.kind = $2)
        AND ($3::text IS NULL
             OR a.label ILIKE '%' || $3 || '%'
             OR (c.id IS NOT NULL
                 AND c.text_search @@ websearch_to_tsquery('english', $3)))
        AND ($4::boolean IS NOT TRUE OR mv.value_est IS NOT NULL)
      ORDER BY COALESCE(mv.value_est, 0) DESC, c.importance DESC NULLS LAST
      LIMIT $5 OFFSET $6`,
    [
      input.grantId,
      input.kind ?? null,
      input.query?.trim() || null,
      input.valuedOnly ?? null,
      limit,
      offset,
    ]
  );
  return {
    total: Number(rows[0]?.total ?? 0),
    actions: rows.map(({ total: _total, ...r }) => r),
  };
}

export interface ValuationEntry {
  action_id: string;
  /** 0..10; 0 means "I judge this worthless to my mandate" (kept as a
   * recorded opinion, distinct from having no opinion). */
  value: number;
  rationale?: string;
}

/**
 * Write one mandate's valuations — the agent valuer's pen. Values are
 * clamped to [0, 10]; unknown action ids are reported back, not silently
 * dropped. Also prunes judgments about closed actions.
 */
export async function setMandateValuations(
  grantId: string,
  entries: ValuationEntry[]
): Promise<{ written: number; unknownActionIds: string[]; recusedActionIds: string[] }> {
  const unknown: string[] = [];
  const recused: string[] = [];
  let written = 0;
  for (const entry of entries) {
    const value = Math.min(10, Math.max(0, Number(entry.value)));
    if (!Number.isFinite(value)) continue;
    // Recusal (#363): an audit of this mandate is not this mandate's to
    // value, in either direction. The allocator enforces the same line.
    const [ownAudit] = await rawQuery<{ id: string }>(
      `SELECT ar.id FROM audit_runs ar
        WHERE ar.action_id = $1::uuid AND ar.subject_grant_id = $2`,
      [entry.action_id, grantId]
    ).catch(() => []);
    if (ownAudit) {
      recused.push(entry.action_id);
      continue;
    }
    const rows = await rawQuery<{ action_id: string }>(
      `INSERT INTO mandate_valuations
         (grant_id, action_id, value_est, rationale, updated_at)
       SELECT $1, a.id, $3, $4, now()
         FROM actions a WHERE a.id = $2
       ON CONFLICT (grant_id, action_id) DO UPDATE
          SET value_est = EXCLUDED.value_est,
              rationale = EXCLUDED.rationale,
              updated_at = now()
       RETURNING action_id`,
      [grantId, entry.action_id, value, entry.rationale ?? null]
    );
    if (rows.length === 0) unknown.push(entry.action_id);
    else written++;
  }
  await pruneClosedValuations(grantId);
  // A judgment mandate's values belong in the display cache too: the shown
  // priority is the best any funder puts on a claim, not the platform
  // lane's opinion alone.
  if (written > 0) await refreshQueuePriorityCache();
  return { written, unknownActionIds: unknown, recusedActionIds: recused };
}
