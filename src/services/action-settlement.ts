/**
 * The money side of a ledger row's close (#1045).
 *
 * A commission pays for one run. When the run ends, however it ends, what
 * it metered is recorded against the commissions that paid for it and the
 * rest goes back to whoever paid: a mandate's escrow simply stops counting
 * it, a person's owls return to their balance, a lookout's fund gets its
 * money back. When a row closes without running (cancelled, retired,
 * superseded), what was placed on it goes back whole.
 *
 * Before this the release was written out at each place a row closed, and
 * three of them (a failed extraction, an extraction given up on, a row
 * whose subject was gone) did not write it: a mandate held 4.37 owls on
 * four cancelled ingests, money nothing could ever spend. So a row is
 * closed here or in completeAction, both of which settle, and a test
 * (tests/unit/services/action-settlement.test.ts) refuses a statement
 * elsewhere that closes a row. A sweep (settleDeadGroups) settles anything
 * left over all the same, and says so as a fault.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { labelInContext } from "../llm/usage-context.js";
import { returnUnspentToFund } from "./lookout-fund.js";
import { microUsdToOwls } from "./owl.js";

interface LiveAllocation {
  id: string;
  grant_id: string | null;
  user_id: string | null;
  claim_id: string | null;
  action_id: string | null;
  commissioned_by: string | null;
  created_at: Date;
  amount: number;
  unspent: number;
}

/**
 * Settle the money on `group` once rows of it have closed, inside the
 * caller's transaction:
 *
 * - `ranId`, the row that ran (if one did): what it metered is consumed
 *   pro rata from the allocations covering it (pinned to it, or placed on
 *   the group as a whole), a mandate's overage is recorded as an
 *   allocation already spent, and the covering allocations then release
 *   what they still hold;
 * - every allocation pinned to a row in `closedIds` releases whole;
 * - when `groupClosed` (no row of the group is open or running any more),
 *   so does money placed on the group as a whole: nothing is left for it to
 *   pay for. A group's next piece of work is commissioned afresh.
 *
 * An allocation released here includes one fully spent: it holds nothing,
 * but left unreleased it reads as live work to every report of the payer's
 * money. Returns what was consumed (overage included) and what went back.
 */
export async function settleGroupMoney(
  tx: TxQuery,
  input: {
    group: string;
    ranId: string | null;
    meteredMicroUsd: number;
    closedIds: string[];
    groupClosed: boolean;
  }
): Promise<{ consumed: number; released: number }> {
  const { group, ranId } = input;
  let released = 0;
  const metered = Math.max(0, Math.round(input.meteredMicroUsd));
  // Lock every live allocation on the group for the duration of the close
  // (plain FOR UPDATE: wait, don't skip, or a skipped row would be silently
  // exempted from consumption).
  const allocations = await tx.query<LiveAllocation>(
    `SELECT id, grant_id, user_id, claim_id, action_id, commissioned_by, created_at,
            amount_micro_usd::bigint AS amount,
            GREATEST(0, amount_micro_usd - spent_micro_usd)::bigint AS unspent
       FROM minerval_whole.allocation_money
      WHERE exclusion_group = $1 AND released_at IS NULL
      ORDER BY created_at ASC
      FOR UPDATE`,
    [group]
  );
  for (const a of allocations) {
    a.amount = Number(a.amount);
    a.unspent = Number(a.unspent);
  }

  const release = async (r: LiveAllocation, key: string) => {
    await tx.query(`UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`, [r.id]);
    if (r.unspent <= 0) return;
    released += r.unspent;
    // Money a Steward's lookout's fund put on its run goes back to the fund.
    if (await returnUnspentToFund(tx, { ...r, exclusion_group: group })) return;
    if (r.user_id) {
      await tx.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
         VALUES ($1, $2, 'refund', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [r.user_id, r.unspent, r.claim_id, `${key}:${r.id}`]
      );
    }
    // A mandate's placement simply stops counting against its escrow.
  };

  const closed = new Set(input.closedIds);
  // Pinned to a row that closed and did not run: returned, not spent.
  for (const r of allocations) {
    if (r.action_id === null || r.action_id === ranId) continue;
    if (input.groupClosed || closed.has(r.action_id)) await release(r, "release");
  }

  const covering = allocations.filter((a) => a.action_id === null || (ranId !== null && a.action_id === ranId));
  let consumed = 0;
  if (ranId !== null) {
    if (metered > 0) {
      const totalUnspent = covering.reduce((s, r) => s + r.unspent, 0);
      const toConsume = Math.min(metered, totalUnspent);
      for (const [i, row] of covering.entries()) {
        if (totalUnspent <= 0) break;
        const share =
          i === covering.length - 1 ? toConsume - consumed : Math.floor((toConsume * row.unspent) / totalUnspent);
        const take = Math.min(row.unspent, Math.max(0, share));
        if (take <= 0) continue;
        await tx.query(
          `UPDATE minerval_whole.allocation_money SET spent_micro_usd = spent_micro_usd + $2 WHERE id = $1`,
          [row.id, take]
        );
        consumed += take;
        row.unspent -= take;
      }
    }

    // OVERAGE: the run cost more than its funders had promised. The money is
    // already gone (the calls happened and are metered against the funder's
    // job), so the only question is whether the ledger admits it. A
    // MANDATE's overage is recorded as what it is: an allocation, already
    // spent, so the escrow's committed total includes it and the pace's
    // window counts it. Consumption above is clamped at what was unspent, so
    // without this the rest would be in no term of the escrow at all (23.57
    // owls of the General mandate's first epoch once were).
    //
    // A USER's overage stays absorbed by the platform: their cap is a
    // promise, and a buyer is never billed past the number on the button.
    // Where a group has no mandate allocation, the shortfall stays off the
    // ledger, where the escrow's outside-ledger term counts it.
    const shortfall = metered - consumed;
    if (shortfall > 0) {
      const byGrant = new Map<string, number>();
      for (const r of covering) {
        if (!r.grant_id) continue;
        byGrant.set(r.grant_id, (byGrant.get(r.grant_id) ?? 0) + r.amount);
      }
      const totalWeight = [...byGrant.values()].reduce((s, n) => s + n, 0);
      if (totalWeight > 0) {
        // Pro rata by what each mandate had promised.
        const entries = [...byGrant.entries()];
        let assigned = 0;
        for (const [i, [grantId, weight]] of entries.entries()) {
          const share = i === entries.length - 1 ? shortfall - assigned : Math.floor((shortfall * weight) / totalWeight);
          if (share <= 0) continue;
          const claimId = covering.find((r) => r.grant_id === grantId)?.claim_id ?? null;
          await tx.query(
            // The record of a shortfall met, at the label of the row that ran.
            `INSERT INTO action_allocations
               (exclusion_group, action_id, claim_id, grant_id,
                amount_micro_usd, spent_micro_usd, released_at, sensitivity_label)
             VALUES ($1, $2, $3, $4, $5, $5, now(), COALESCE($6, (SELECT sensitivity_label FROM actions WHERE id = $2)))`,
            [group, ranId, claimId, grantId, share, labelInContext()]
          );
          assigned += share;
          consumed += share;
        }
      }
    }
  }

  // SETTLEMENT: what the covering allocations still hold returns to its
  // funders. The ceiling was theirs to rely on; the meter is what they pay.
  // Money on the group as a whole stays only while a row of the group is
  // still open or running and none ran here.
  if (ranId !== null || input.groupClosed) {
    for (const r of covering) await release(r, "settle");
  }
  return { consumed, released };
}

/**
 * Close rows of one group that will not finish, and settle their money
 * (settleGroupMoney). The rows closed are the group's open rows, and its
 * running ones too with `includeRunning` (the run that is failing closes
 * itself this way); `ids` narrows them to those rows. `ranId`, with
 * `meteredMicroUsd`, is a row that ran and stopped: what it spent is
 * recorded against what paid for it, as for a finished run, and the rest
 * comes back.
 *
 * `reason` is the platform's own sentence for why, stored on each row
 * closed (actions.end_reason) where the payer reads it beside the money it
 * got back. Never a provider's or a site's text.
 *
 * Settles even when no row is left to close: a group whose rows another
 * statement already closed gets its money back here too. Returns the rows
 * closed and what was released.
 */
export async function cancelActions(input: {
  group: string;
  reason: string;
  ids?: string[];
  includeRunning?: boolean;
  /** 'superseded' where another variant of the group has taken the row's place; 'cancelled' by default. */
  status?: "cancelled" | "superseded";
  ranId?: string | null;
  meteredMicroUsd?: number;
  meteredJobId?: string | null;
  /** Run inside the caller's transaction instead of a fresh one. */
  tx?: TxQuery;
}): Promise<{ cancelled: string[]; releasedMicroUsd: number }> {
  const run = async (tx: TxQuery) => {
    const rows = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM actions WHERE exclusion_group = $1 ORDER BY id FOR UPDATE`,
      [input.group]
    );
    const closable = new Set(input.includeRunning ? ["open", "running"] : ["open"]);
    const targets = rows
      .filter((r) => closable.has(r.status) && (!input.ids || input.ids.includes(r.id)))
      .map((r) => r.id);
    const ranId = input.ranId && targets.includes(input.ranId) ? input.ranId : null;
    const metered = ranId ? Math.max(0, Math.round(input.meteredMicroUsd ?? 0)) : 0;
    if (targets.length > 0) {
      await tx.query(
        `UPDATE actions
            SET status = $6, end_reason = $2, updated_at = now(),
                metered_cost_micro_usd = CASE WHEN id = $3 THEN $4 ELSE metered_cost_micro_usd END,
                metered_job_id = CASE WHEN id = $3 THEN $5 ELSE metered_job_id END
          WHERE id = ANY($1::uuid[])`,
        [targets, input.reason, ranId, metered, input.meteredJobId ?? null, input.status ?? "cancelled"]
      );
    }
    const stillLive = rows.some((r) => (r.status === "open" || r.status === "running") && !targets.includes(r.id));
    const { released: releasedMicroUsd } = await settleGroupMoney(tx, {
      group: input.group,
      ranId,
      meteredMicroUsd: metered,
      closedIds: targets,
      groupClosed: !stillLive,
    });
    if (ranId) await recordRunEnded(tx, ranId, metered, input.reason, releasedMicroUsd);
    return { cancelled: targets, releasedMicroUsd };
  };
  return input.tx ? run(input.tx) : withTransaction(run);
}

/**
 * Close one row by id (a placement that failed, a lookout run its fund
 * cannot pay for, an extraction given up on): cancelActions on its group,
 * narrowed to it. Only an open row unless `includeRunning`.
 */
export async function cancelAction(
  actionId: string,
  reason: string,
  opts: { includeRunning?: boolean; tx?: TxQuery } = {}
): Promise<boolean> {
  const { tx } = opts;
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const [row] = await q<{ exclusion_group: string }>(`SELECT exclusion_group FROM actions WHERE id = $1`, [actionId]);
  if (!row) return false;
  const res = await cancelActions({
    group: row.exclusion_group,
    ids: [actionId],
    reason,
    includeRunning: opts.includeRunning,
    tx,
  });
  return res.cancelled.length > 0;
}

/**
 * Close every row a statement picks (`selectSql`, returning `id` and
 * `exclusion_group`, run as given) with `reason`, group by group, each
 * group settled in its own transaction: the reconcile sweep's bulk
 * retirements. A row that moved on between the pick and its group's lock
 * (started running, say) is left alone, since only open rows close here.
 * Returns how many rows closed.
 */
export async function cancelActionsWhere(
  selectSql: string,
  params: unknown[],
  reason: string,
  status: "cancelled" | "superseded" = "cancelled"
): Promise<number> {
  const picked = await rawQuery<{ id: string; exclusion_group: string }>(selectSql, params);
  const byGroup = new Map<string, string[]>();
  for (const p of picked) byGroup.set(p.exclusion_group, [...(byGroup.get(p.exclusion_group) ?? []), p.id]);
  let n = 0;
  for (const [group, ids] of byGroup) {
    try {
      n += (await cancelActions({ group, ids, reason, status })).cancelled.length;
    } catch (err) {
      console.error(`[actions] closing ${group} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return n;
}

/** How long a group sits closed before the sweep settles its money: past any commission's own two steps. */
export const DEAD_GROUP_GRACE_MINUTES = 15;

/**
 * The backstop: money still held for a row that is closed, or placed on a
 * group as a whole whose rows are all closed, for longer than
 * DEAD_GROUP_GRACE_MINUTES on both sides (the money placed and the row's
 * close), is returned as cancelActions would have returned it. Every path that closes a row settles its own
 * money, so anything found here is a path that did not, and it is reported
 * as a fault with the groups and the amount. Money placed on a group with no
 * rows at all is a fund (a lookout's), not a commission, and is left alone.
 * Also the back-fill for commissions stranded before #1045.
 */
export async function settleDeadGroups(limit = 200): Promise<{ groups: number; releasedMicroUsd: number }> {
  // Two kinds of leftover, both past the grace on both sides: money pinned
  // to a row that is closed, and money placed on a group as a whole whose
  // rows are all closed.
  const dead = await rawQuery<{ exclusion_group: string; pinned: string[] | null }>(
    `SELECT al.exclusion_group,
            array_agg(DISTINCT al.action_id::text) FILTER (WHERE a.id IS NOT NULL) AS pinned
       FROM minerval_whole.allocation_money al
       LEFT JOIN actions a ON a.id = al.action_id
                          AND a.status NOT IN ('open', 'running')
                          AND a.updated_at < now() - make_interval(mins => ${DEAD_GROUP_GRACE_MINUTES})
      WHERE al.released_at IS NULL
        AND al.created_at < now() - make_interval(mins => ${DEAD_GROUP_GRACE_MINUTES})
        AND (a.id IS NOT NULL
             OR (al.action_id IS NULL
                 AND EXISTS (SELECT 1 FROM actions g WHERE g.exclusion_group = al.exclusion_group)
                 AND NOT EXISTS (SELECT 1 FROM actions g
                                  WHERE g.exclusion_group = al.exclusion_group
                                    AND (g.status IN ('open', 'running')
                                         OR g.updated_at >= now() - make_interval(mins => ${DEAD_GROUP_GRACE_MINUTES})))))
      GROUP BY al.exclusion_group
      ORDER BY al.exclusion_group
      LIMIT $1`,
    [limit]
  );
  let releasedMicroUsd = 0;
  let groups = 0;
  for (const d of dead) {
    try {
      const released = await withTransaction(async (tx) => {
        const rows = await tx.query<{ id: string; status: string }>(
          `SELECT id, status FROM actions WHERE exclusion_group = $1 ORDER BY id FOR UPDATE`,
          [d.exclusion_group]
        );
        // Read again behind the lock: a row reopened since the pick keeps
        // what is pinned to it.
        const closedIds = rows.filter((r) => r.status !== "open" && r.status !== "running").map((r) => r.id);
        const pinned = (d.pinned ?? []).filter((id) => closedIds.includes(id));
        const groupClosed = rows.length > 0 && closedIds.length === rows.length;
        if (pinned.length === 0 && !groupClosed) return 0;
        const res = await settleGroupMoney(tx, {
          group: d.exclusion_group,
          ranId: null,
          meteredMicroUsd: 0,
          closedIds: pinned,
          groupClosed,
        });
        return res.released;
      });
      releasedMicroUsd += released;
      groups++;
    } catch (err) {
      console.error(
        `[actions] settling dead group ${d.exclusion_group} failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  if (groups > 0) {
    console.error(
      `[actions] settled money left on ${groups} closed group(s), ${microUsdToOwls(releasedMicroUsd)} owls ` +
        `(a path closed rows without settling them): ${dead.map((d) => d.exclusion_group).slice(0, 10).join(", ")}`
    );
  }
  return { groups, releasedMicroUsd };
}

/** The settlement event for a run that stopped short, as completeAction records one for a run that finished. */
async function recordRunEnded(
  tx: TxQuery,
  actionId: string,
  meteredMicroUsd: number,
  reason: string,
  releasedMicroUsd: number
): Promise<void> {
  const [row] = await tx.query<{ kind: string; claim_id: string | null; target_ref: string | null; label: string; grants: string[] }>(
    `SELECT a.kind, a.claim_id, a.target_ref, a.label,
            ARRAY(SELECT DISTINCT al.grant_id::text FROM minerval_whole.allocation_money al
                   WHERE al.action_id = a.id AND al.grant_id IS NOT NULL) AS grants
       FROM actions a WHERE a.id = $1`,
    [actionId]
  );
  if (!row) return;
  const { recordEvent } = await import("./event-service.js");
  await recordEvent(
    {
      kind: "run_settled",
      actionId,
      nodeId: row.claim_id,
      grantId: row.grants[0] ?? null,
      refs: { work_kind: row.kind, target_ref: row.target_ref, grants: row.grants, ended: "stopped" },
      summary:
        `${row.label} stopped without finishing (${reason}), spending ${microUsdToOwls(meteredMicroUsd)} owls; ` +
        `${microUsdToOwls(releasedMicroUsd)} owls went back to whoever paid.`,
      payload: { spent_micro_usd: meteredMicroUsd, returned_micro_usd: releasedMicroUsd, end_reason: reason },
    },
    tx
  );
}
