/**
 * Expected marginal value of assessing a claim — the EV in the allocation
 * core's value/cost standard.
 *
 * The background lane's decision rule is the essay's: take the actions with
 * the highest expected marginal value per unit of expected marginal cost,
 * up to the day's budget. This module estimates the VALUE side for one
 * action type — a Steward assessment pass — with the multiplicative
 * heuristic:
 *
 *   value = importance                         (consequence-if-wrong, §19)
 *         × (floor + (1 − floor)×contestation) (live disagreement sharpens
 *                                               what a verdict is worth)
 *         × expected quality gain              (the last pass's
 *                                               marginal_yield, 1.0 when
 *                                               unassessed, revived by
 *                                               staleness as evidence
 *                                               drifts)
 *         + stake boost                        (paid demand, saturating)
 *         + provenance boost                   (a human proposed it, #284)
 *
 * The result is stored on claims.queue_priority. Cost lives elsewhere
 * (cost-estimate-service.ts); the drain divides the two at selection time.
 * Every knob is config — legible, tunable, printable. The formula is an
 * INPUT TO JUDGMENT about ordering, not a black box that decides what is
 * true (Part VIII): heuristics start as guesses and get revised as the
 * eval engine grows. Two invariants hold by construction: stakes and money
 * touch only this column, never `claims.importance` (§19 as amended); and
 * the paid express lane doesn't read it at all.
 *
 * Computed in one SQL statement so refreshes are cheap enough to run at
 * enqueue and in the allocation scheduler's periodic sweep.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

/** The SQL expression computing the expected value for one claims row `c`. */
function valueSql(): { sql: string; params: number[] } {
  const c = loadConfig();
  const owl = c.owlPriceMicroUsd;
  // Parameters: $2 contestation floor, $3 wStake, $4 stakeSaturationOwls,
  // $5 staleSaturationDays, $6 provenanceBoost ($1 is the claim id or
  // reserved by the caller's WHERE clause).
  return {
    sql: `
      LEAST(10.0,
        c.importance
        * ($2::real + (1.0 - $2::real) * COALESCE(c.contestation, 0))
        * GREATEST(
            COALESCE(
              (SELECT a.marginal_yield FROM assessments a
                WHERE a.claim_id = c.id AND a.is_current = true
                ORDER BY a.assessed_at DESC LIMIT 1),
              1.0),
            LEAST(1.0,
              COALESCE(EXTRACT(EPOCH FROM (now() -
                (SELECT a.assessed_at FROM assessments a
                  WHERE a.claim_id = c.id AND a.is_current = true
                  ORDER BY a.assessed_at DESC LIMIT 1))) / 86400.0
                / NULLIF($5::real, 0), 0)))
        + $3::real * LEAST(1.0,
            COALESCE((SELECT SUM(s.amount_micro_usd) FROM claim_stakes s
                       WHERE s.claim_id = c.id), 0)::real
            / (${owl}::real * NULLIF($4::real, 0)))
        + CASE WHEN c.created_by = 'user' THEN $6::real ELSE 0 END
      )`,
    params: [
      c.valueContestationFloor,
      c.priorityStakeWeight,
      c.priorityStakeSaturationOwls,
      c.priorityStalenessSaturationDays,
      c.priorityUserProvenanceBoost,
    ],
  };
}

/** Recompute one claim's expected value. Returns the new value. */
export async function refreshQueuePriority(claimId: string): Promise<number> {
  const { sql, params } = valueSql();
  const rows = await rawQuery<{ queue_priority: number }>(
    `UPDATE claims c SET queue_priority = ${sql}
      WHERE c.id = $1
      RETURNING c.queue_priority`,
    [claimId, ...params]
  );
  return rows[0]?.queue_priority ?? 0;
}

/**
 * Refresh every PENDING claim's expected value (the live candidate set) —
 * the allocation scheduler's sweep, so staleness and new stakes reorder the
 * lane without per-event bookkeeping. Returns how many rows were touched.
 */
export async function refreshPendingQueuePriorities(): Promise<number> {
  const { sql, params } = valueSql();
  const rows = await rawQuery<{ id: string }>(
    `UPDATE claims c SET queue_priority = ${sql}
      WHERE c.state = 'active' AND c.steward_state = 'pending' AND $1::int = 1
      RETURNING c.id`,
    [1, ...params]
  );
  return rows.length;
}

/**
 * The value inputs for one claim, serialized for the transparency surfaces
 * (§15): the claim page's scheduling disclosure and GET /queue.
 */
export async function getPriorityBreakdown(claimId: string): Promise<{
  queue_priority: number;
  importance: number;
  contestation: number | null;
  marginal_yield: number | null;
  stake_owls: number;
  days_since_assessed: number | null;
  user_proposed: boolean;
} | null> {
  const c = loadConfig();
  const rows = await rawQuery<{
    queue_priority: number;
    importance: number;
    contestation: number | null;
    marginal_yield: number | null;
    stake_micro: number;
    assessed_at: Date | null;
    created_by: string;
  }>(
    `SELECT c.queue_priority, c.importance, c.contestation, c.created_by,
            (SELECT a.marginal_yield FROM assessments a
              WHERE a.claim_id = c.id AND a.is_current = true
              ORDER BY a.assessed_at DESC LIMIT 1) AS marginal_yield,
            (SELECT a.assessed_at FROM assessments a
              WHERE a.claim_id = c.id AND a.is_current = true
              ORDER BY a.assessed_at DESC LIMIT 1) AS assessed_at,
            COALESCE((SELECT SUM(s.amount_micro_usd) FROM claim_stakes s
                       WHERE s.claim_id = c.id), 0) AS stake_micro
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
    stake_owls:
      Math.round((Number(row.stake_micro) / c.owlPriceMicroUsd) * 1000) / 1000,
    days_since_assessed: row.assessed_at
      ? Math.floor((Date.now() - new Date(row.assessed_at).getTime()) / 86_400_000)
      : null,
    user_proposed: row.created_by === "user",
  };
}
