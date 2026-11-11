/**
 * claims.queue_priority: the order pending claims are shown in, and the
 * order the fallback lane (a deployment with no mandate) drains them.
 *
 * It decides nothing about funding. Mandates decide what to fund through
 * their agents and their written operating policies (program-officer.ts),
 * not through a formula; this column only orders a list, by the claim's
 * importance, which its Steward judges (§19). Money never touches it.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

/** The ordering for one claims row `c` (SQL fragment). */
const ORDER_SQL = `COALESCE(c.importance, 0)`;

/** Restamp one claim's place in the list. Returns it. */
export async function refreshQueuePriority(claimId: string): Promise<number> {
  const rows = await rawQuery<{ queue_priority: number }>(
    `UPDATE claims c SET queue_priority = ${ORDER_SQL} WHERE c.id = $1 RETURNING c.queue_priority`,
    [claimId]
  );
  return rows[0]?.queue_priority ?? 0;
}

/**
 * Restamp every pending claim's place in the list. Returns how many rows
 * were touched.
 */
export async function refreshPendingQueuePriorities(): Promise<number> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE claims c SET queue_priority = ${ORDER_SQL}
      WHERE c.state = 'active' AND c.steward_state = 'pending'
      RETURNING c.id`
  );
  return rows.length;
}

/**
 * The value inputs for one claim, serialized for the transparency surfaces
 * (§15): the claim page's scheduling disclosure and GET /queue. Includes
 * the claim's unspent reader contributions (the cost-side input).
 */
export async function getPriorityBreakdown(claimId: string): Promise<{
  queue_priority: number;
  importance: number;
  contestation: number | null;
  marginal_yield: number | null;
  backing_owls: number;
  days_since_assessed: number | null;
  user_proposed: boolean;
} | null> {
  const c = loadConfig();
  const rows = await rawQuery<{
    queue_priority: number;
    importance: number;
    contestation: number | null;
    marginal_yield: number | null;
    backing_micro: number;
    assessed_at: Date | null;
    created_by: string;
  }>(
    `SELECT c.queue_priority, c.importance, c.contestation, c.created_by,
            (SELECT a.marginal_yield FROM assessments_in_force a
              WHERE a.claim_id = c.id
              ORDER BY a.assessed_at DESC LIMIT 1) AS marginal_yield,
            (SELECT a.assessed_at FROM assessments_in_force a
              WHERE a.claim_id = c.id
              ORDER BY a.assessed_at DESC LIMIT 1) AS assessed_at,
            COALESCE((SELECT SUM(a.amount_micro_usd - a.spent_micro_usd)
                        FROM action_allocations a
                       WHERE a.exclusion_group = 'assess:' || c.id::text
                         AND a.released_at IS NULL), 0)
              AS backing_micro
       FROM claims c WHERE c.id = $1`,
    [claimId]
  );
  const row = rows[0];
  if (!row) return null;
  return {
    queue_priority: row.queue_priority,
    importance: row.importance,
    contestation: row.contestation,
    marginal_yield: row.marginal_yield,
    backing_owls:
      Math.round((Number(row.backing_micro) / c.owlCostMicroUsd) * 1000) /
      1000,
    days_since_assessed: row.assessed_at
      ? Math.floor((Date.now() - new Date(row.assessed_at).getTime()) / 86_400_000)
      : null,
    user_proposed: row.created_by === "user",
  };
}
