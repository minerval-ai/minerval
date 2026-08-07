/**
 * Mandate valuations — the judgment layer of the allocation engine.
 *
 * Each mandate decides for itself what the open actions are WORTH, and
 * records those judgments in `mandate_valuations`: sparse rows, one per
 * (mandate, action) the mandate knows and cares about. The mechanical
 * layer (action-service.ts) never reads them — actions run on allocations
 * alone — but every mandate's allocator spends against its own valuations.
 *
 * WHO writes them differs by mandate, deliberately:
 *
 *  - The General assessment mandate's scope genuinely is the whole graph,
 *    and its published value formula IS its allocation policy — so its
 *    valuations are a bulk formula refresh (below), with the formula's
 *    knobs amendable by its Grantmaker in conversation.
 *
 *  - Every other mandate's scope is defined in WORDS — its mandate text —
 *    and which actions fall under it is a judgment call. Its Grantmaker
 *    runs periodic VALUATION passes (kind 'valuation' actions on the
 *    ledger, self-funded, executed by the engine executor) with real
 *    affordances: search the graph, browse the open ledger, and write
 *    valuations with rationale (setMandateValuations below). No keyword
 *    filter is ever treated as the scope: agents are trusted with the
 *    same discretion a person holding the mandate would have.
 *
 * Money appears NOWHERE in a valuation: allocations reduce what remains
 * to be covered on the cost side, never how valuable an action is, and
 * nothing here touches claims.importance or a verdict.
 */
import { rawQuery } from "../db/client.js";
import {
  getGeneralMandate,
  getEffectiveAllocationPolicy,
} from "./allocation-policy-service.js";

/** The General formula for one claims row `c` and actions row `a`:
 * importance × contested-factor × expected-quality-gain + provenance
 * boost, strong variants multiplied by the policy's gain knob.
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
            / NULLIF($2::real, 0), 0)))
    + CASE WHEN c.created_by = 'user' THEN $3::real ELSE 0 END
  ) * CASE WHEN a.variant = 'strong' THEN $4::real ELSE 1.0 END`;

/**
 * Refresh the General mandate's valuations over every open assess/reassess
 * action, and mirror its standard-variant values into claims.queue_priority
 * (a display cache for claim pages; the authoritative store is the
 * valuations table). Returns the valuation count; 0 when no General
 * mandate is seeded (dev and tests run without one).
 */
export async function refreshGeneralValuations(): Promise<number> {
  const general = await getGeneralMandate();
  if (!general) return 0;
  const policy = await getEffectiveAllocationPolicy();
  const rows = await rawQuery<{ action_id: string }>(
    `INSERT INTO mandate_valuations (grant_id, action_id, value_est, updated_at)
     SELECT $5, a.id, ${GENERAL_VALUE_SQL}, now()
       FROM actions a
       JOIN claims c ON c.id = a.claim_id
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND c.state = 'active'
     ON CONFLICT (grant_id, action_id) DO UPDATE
        SET value_est = EXCLUDED.value_est, updated_at = now()
     RETURNING action_id`,
    [
      policy.contestation_floor,
      policy.staleness_saturation_days,
      policy.user_provenance_boost,
      policy.strong_gain_multiplier,
      general.grantId,
    ]
  );
  await pruneClosedValuations(general.grantId);
  await rawQuery(
    `UPDATE claims c SET queue_priority = mv.value_est
       FROM mandate_valuations mv
       JOIN actions a ON a.id = mv.action_id
      WHERE mv.grant_id = $1 AND a.claim_id = c.id
        AND a.variant = 'standard' AND a.status = 'open'`,
    [general.grantId]
  );
  return rows.length;
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
): Promise<{ written: number; unknownActionIds: string[] }> {
  const unknown: string[] = [];
  let written = 0;
  for (const entry of entries) {
    const value = Math.min(10, Math.max(0, Number(entry.value)));
    if (!Number.isFinite(value)) continue;
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
  return { written, unknownActionIds: unknown };
}
