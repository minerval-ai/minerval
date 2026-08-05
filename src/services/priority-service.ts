/**
 * Composite queue priority — the allocation core's ordering key.
 *
 * The background drain used to order by `importance` alone. The essay's
 * mechanism ("Allocating Attention in Claimspace") orders instead by an
 * estimate of MARGINAL VALUE per assessment, which importance is only one
 * input to:
 *
 *   priority = importance                                (epistemic base)
 *            + wYield  × expected yield                  (marginal_yield;
 *                                                         unassessed = max)
 *            + wContest × contestation                   (live dispute)
 *            + wStake  × saturating(stake owls)          (user/grant demand)
 *            + wStale  × saturating(days since assessed) (evidence drift)
 *            + provenance boost for user-proposed claims (#284)
 *
 * Every weight is config (legible, tunable, printable) — the formula is an
 * INPUT TO JUDGMENT about ordering, not a black box that decides what is
 * true (Part VIII anti-formalism; #291). Two invariants hold by
 * construction: stakes and money touch only this column, never
 * `claims.importance` (§19 as amended); and the paid express lane doesn't
 * read it at all — this orders only the background/subsidized lane.
 *
 * Computed in one SQL statement so refreshes are cheap enough to run at
 * enqueue and in the allocation scheduler's periodic sweep.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";

/** The SQL expression computing the composite for one claims row `c`. */
function prioritySql(): { sql: string; params: number[] } {
  const c = loadConfig();
  const owl = c.owlPriceMicroUsd;
  // Parameters: $2 wYield, $3 wContest, $4 wStake, $5 stakeSaturationOwls,
  // $6 wStale, $7 staleSaturationDays, $8 provenanceBoost ($1 is the claim id
  // or reserved by the caller's WHERE clause).
  return {
    sql: `
      LEAST(10.0,
        c.importance
        + $2::real * COALESCE(
            (SELECT a.marginal_yield FROM assessments a
              WHERE a.claim_id = c.id AND a.is_current = true
              ORDER BY a.assessed_at DESC LIMIT 1),
            1.0)
        + $3::real * COALESCE(c.contestation, 0)
        + $4::real * LEAST(1.0,
            COALESCE((SELECT SUM(s.amount_micro_usd) FROM claim_stakes s
                       WHERE s.claim_id = c.id), 0)::real
            / (${owl}::real * NULLIF($5::real, 0)))
        + $6::real * LEAST(1.0,
            COALESCE(EXTRACT(EPOCH FROM (now() -
              (SELECT a.assessed_at FROM assessments a
                WHERE a.claim_id = c.id AND a.is_current = true
                ORDER BY a.assessed_at DESC LIMIT 1))) / 86400.0
              / NULLIF($7::real, 0), 0))
        + CASE WHEN c.created_by = 'user' THEN $8::real ELSE 0 END
      )`,
    params: [
      c.priorityYieldWeight,
      c.priorityContestationWeight,
      c.priorityStakeWeight,
      c.priorityStakeSaturationOwls,
      c.priorityStalenessWeight,
      c.priorityStalenessSaturationDays,
      c.priorityUserProvenanceBoost,
    ],
  };
}

/** Recompute one claim's queue priority. Returns the new value. */
export async function refreshQueuePriority(claimId: string): Promise<number> {
  const { sql, params } = prioritySql();
  const rows = await rawQuery<{ queue_priority: number }>(
    `UPDATE claims c SET queue_priority = ${sql}
      WHERE c.id = $1
      RETURNING c.queue_priority`,
    [claimId, ...params]
  );
  return rows[0]?.queue_priority ?? 0;
}

/**
 * Refresh every PENDING claim's priority (the live queue) — the allocation
 * scheduler's sweep, so staleness and new stakes reorder the queue without
 * per-event bookkeeping. Returns how many rows were touched.
 */
export async function refreshPendingQueuePriorities(): Promise<number> {
  const { sql, params } = prioritySql();
  const rows = await rawQuery<{ id: string }>(
    `UPDATE claims c SET queue_priority = ${sql}
      WHERE c.state = 'active' AND c.steward_state = 'pending' AND $1::int = 1
      RETURNING c.id`,
    [1, ...params]
  );
  return rows.length;
}

/**
 * The priority inputs for one claim, serialized for the transparency
 * surfaces (§15): the claim page's scheduling disclosure and GET /queue.
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
