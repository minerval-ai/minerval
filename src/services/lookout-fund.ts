/**
 * A Steward's lookout and the money it runs on (docs/allocation.md, "A
 * Steward's own lookout").
 *
 * A mandate's lookout runs from its mandate's escrow, run by run, within the
 * mandate's pace (fundGrantSelfActions). A Steward holds no escrow: it holds
 * the budget of the pass it is running. So a Steward that posts a lookout
 * puts up a FUND for it from that budget, which leaves the pass at once, and
 * the lookout lives on the fund: each run is paid from it at the run's
 * estimate, and so is anything the lookout commissions within the limit its
 * Steward set. The money keeps its payer the whole way (the fund's rows are
 * the funders of the pass that posted it, a mandate's or a person's, moved
 * as a commission from a run moves them), so a mandate's escrow and pace and
 * a person's balance read it as they read any commission of theirs.
 *
 *  - The fund is allocations on LOOKOUT_FUND_GROUP(id), with no ledger row,
 *    so nothing runs on it and nothing counts it as cover.
 *  - A due run is paid from it whole at its estimate (fundStewardLookoutRuns).
 *    A fund that cannot pay for a run pauses the lookout and says so in its
 *    node's inbox; a top-up resumes it.
 *  - What a run does not spend goes back to the fund, not to its funders
 *    (returnUnspentToFund, from the settlement in completeAction), so the
 *    fund drains by what the watch costs and not by its estimates.
 *  - Retiring the lookout returns what is left to its funders
 *    (releaseLookoutFund), and so does its node leaving the graph (merged
 *    or retired), which retires it.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { LOOKOUT_FUND_GROUP } from "./lookout-fund-group.js";
import { placeCommission, commissionAction, type CommissionPayer } from "./commission-service.js";
import { postMessage } from "./inbox-service.js";
import { capMicroUsd, microUsdToOwls } from "./owl.js";

export { LOOKOUT_FUND_GROUP };

/** The commissioned_by of the money a fund moves onto a run, which settlement returns to the fund. */
export const FUND_RUN_COMMISSIONER = "lookout_fund";

/** The commissioned_by of a fund's own rows. */
export const FUND_COMMISSIONER = "steward";

/** What a Steward's lookout has left to spend, in micro-USD. A closed mandate's share is not counted. */
export async function lookoutFundLeftMicroUsd(lookoutId: string, q: Pick<TxQuery, "query"> | null = null): Promise<number> {
  const sql = `SELECT COALESCE(SUM(al.amount_micro_usd - al.spent_micro_usd), 0)::bigint AS left
                 FROM minerval_whole.allocation_money al
                WHERE al.exclusion_group = $1 AND al.action_id IS NULL
                  AND al.released_at IS NULL
                  AND (al.grant_id IS NULL
                       OR EXISTS (SELECT 1 FROM grants g WHERE g.id = al.grant_id AND g.status = 'active'))`;
  const rows = q
    ? await q.query<{ left: number }>(sql, [LOOKOUT_FUND_GROUP(lookoutId)])
    : await rawQuery<{ left: number }>(sql, [LOOKOUT_FUND_GROUP(lookoutId)]);
  return Number(rows[0]?.left ?? 0);
}

/** What one run of a lookout is paid at: the run's cap (CAP_LOOKOUT_RUN_OWLS). */
export function lookoutRunCostMicroUsd(): number {
  return capMicroUsd("lookout_run");
}

/**
 * Put money into a Steward's lookout's fund from the pass that pays for it
 * (the run's own allocations, or a mandate paying straight from its
 * escrow). The caller lowers the pass's ceiling by what it moved
 * (debitRunBudget), as for any commission.
 */
export async function addToLookoutFund(input: {
  lookoutId: string;
  nodeId: string;
  payer: CommissionPayer;
  budgetMicroUsd: number;
  reason: string;
}): Promise<{ ok: true; leftMicroUsd: number } | { ok: false; code: string; message: string }> {
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) return { ok: false, code: "BAD_AMOUNT", message: "A fund needs an amount above zero." };
  if (input.payer.kind === "fund") {
    return { ok: false, code: "PAYER", message: "A lookout's fund is not paid from another fund." };
  }
  const placed = await placeCommission({
    group: LOOKOUT_FUND_GROUP(input.lookoutId),
    actionId: null,
    claimId: input.nodeId,
    payer: input.payer,
    budget,
    commissionedBy: FUND_COMMISSIONER,
    brief: null,
    reason: input.reason,
  });
  if (!placed.ok) return { ok: false, code: placed.code, message: placed.message };
  // Topped up after it paused for want of money: it runs again, now.
  await rawQuery(
    `UPDATE lookouts SET status = 'active', paused_for_fund = false, next_due_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'paused' AND paused_for_fund`,
    [input.lookoutId]
  );
  return { ok: true, leftMicroUsd: await lookoutFundLeftMicroUsd(input.lookoutId) };
}

/**
 * Pay for the due runs of Steward lookouts from their funds, on the
 * executor's tick beside fundGrantSelfActions. A run is paid whole at its
 * estimate or not at all: a fund that cannot pay for one pauses its
 * lookout, retires the row, and tells the node's Steward in its inbox.
 */
export async function fundStewardLookoutRuns(): Promise<number> {
  // A lookout whose node is no longer active (merged, retired) has no
  // Steward to answer to: it is retired and what its fund holds goes back.
  const orphaned = await rawQuery<{ id: string }>(
    `UPDATE lookouts l SET status = 'retired', paused_for_fund = false, updated_at = now()
       FROM claims n
      WHERE n.id = l.node_id AND n.state <> 'active' AND l.status <> 'retired'
      RETURNING l.id`
  );
  for (const o of orphaned) await releaseLookoutFund(o.id);

  const rows = await rawQuery<{
    action_id: string;
    lookout_id: string;
    node_id: string;
    title: string;
    cost_est: number;
    covered: number;
  }>(
    `SELECT a.id AS action_id, l.id AS lookout_id, l.node_id, l.title,
            a.cost_est_micro_usd::bigint AS cost_est,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM minerval_whole.allocation_money al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND (al.action_id IS NULL OR al.action_id = a.id)), 0)::bigint AS covered
       FROM actions a
       JOIN lookouts l ON a.exclusion_group = 'lookout:' || l.id::text
      WHERE a.kind = 'lookout_run' AND a.status = 'open'
        AND l.node_id IS NOT NULL AND l.status = 'active'
      LIMIT 100`
  );
  let placed = 0;
  for (const row of rows) {
    if (Number(row.covered) > 0) continue;
    const cost = Number(row.cost_est);
    const left = await lookoutFundLeftMicroUsd(row.lookout_id);
    if (left < cost) {
      await pauseForFund(row, left, cost);
      continue;
    }
    const res = await commissionAction({
      payer: { kind: "fund", lookoutId: row.lookout_id },
      actionId: row.action_id,
      budgetMicroUsd: cost,
      reason: `A run of the lookout "${row.title}", from its fund.`,
      commissionedBy: FUND_RUN_COMMISSIONER,
    });
    if (res.ok && res.status === "commissioned") placed++;
  }
  return placed;
}

async function pauseForFund(
  row: { action_id: string; lookout_id: string; node_id: string; title: string },
  leftMicroUsd: number,
  costMicroUsd: number
): Promise<void> {
  const [paused] = await rawQuery<{ id: string }>(
    `UPDATE lookouts SET status = 'paused', paused_for_fund = true, updated_at = now()
      WHERE id = $1 AND status = 'active' RETURNING id`,
    [row.lookout_id]
  );
  await rawQuery(
    `UPDATE actions SET status = 'cancelled', updated_at = now() WHERE id = $1 AND status = 'open'`,
    [row.action_id]
  );
  if (!paused) return;
  await postMessage({
    nodeId: row.node_id,
    trigger: "lookout_flag",
    sender: { kind: "lookout", ref: row.lookout_id },
    body:
      `Your lookout "${row.title}" (${row.lookout_id}) has paused: its fund holds ` +
      `${microUsdToOwls(leftMicroUsd)} owls and a run costs ${microUsdToOwls(costMicroUsd)}. ` +
      `amend_lookout with add_budget_owls resumes it; retiring it returns what is left to whoever put it up.`,
  });
}

/**
 * Inside the settlement of a run (completeAction): money a fund moved onto
 * a Steward lookout's run that the run did not spend goes back to the fund,
 * at the time it was first placed, unless the lookout has been retired. The
 * row it came from is released by the caller. True when it went back, so
 * the caller does not also refund it.
 */
export async function returnUnspentToFund(
  tx: TxQuery,
  r: {
    exclusion_group: string;
    commissioned_by: string | null;
    grant_id: string | null;
    user_id: string | null;
    claim_id: string | null;
    unspent: number;
    created_at: Date;
  }
): Promise<boolean> {
  if (r.commissioned_by !== FUND_RUN_COMMISSIONER || !r.exclusion_group.startsWith("lookout:")) return false;
  const lookoutId = r.exclusion_group.slice("lookout:".length);
  const [lookout] = await tx.query<{ id: string; sensitivity_label: string }>(
    `SELECT id, sensitivity_label FROM lookouts WHERE id = $1 AND node_id IS NOT NULL AND status <> 'retired'`,
    [lookoutId]
  );
  if (!lookout) return false;
  if (r.grant_id) {
    const [active] = await tx.query(`SELECT 1 FROM grants WHERE id = $1 AND status = 'active'`, [r.grant_id]);
    if (!active) return false;
  }
  await tx.query(
    `INSERT INTO action_allocations
       (exclusion_group, action_id, claim_id, grant_id, user_id, amount_micro_usd,
        commissioned_by, reason, sensitivity_label, created_at)
     VALUES ($1, NULL, $2, $3, $4, $5, $6, 'Unspent by a run of the lookout, back in its fund.', $7, $8)
     ON CONFLICT (grant_id, exclusion_group, (COALESCE(action_id::text, '')))
       WHERE released_at IS NULL AND grant_id IS NOT NULL AND spent_micro_usd < amount_micro_usd
     DO UPDATE SET amount_micro_usd = action_allocations.amount_micro_usd + EXCLUDED.amount_micro_usd`,
    [LOOKOUT_FUND_GROUP(lookoutId), r.claim_id, r.grant_id, r.user_id, Number(r.unspent),
     FUND_COMMISSIONER, lookout.sensitivity_label, r.created_at]
  );
  return true;
}

/**
 * Return what is left of a lookout's fund to the funders who put it up: a
 * mandate's headroom comes back, a person's owls go back to their balance.
 * Called when the lookout is retired. Returns what was returned.
 */
export async function releaseLookoutFund(lookoutId: string): Promise<number> {
  return withTransaction(async (tx) => {
    const rows = await tx.query<{ id: string; user_id: string | null; claim_id: string | null; unspent: number }>(
      `SELECT id, user_id, claim_id, (amount_micro_usd - spent_micro_usd)::bigint AS unspent
         FROM minerval_whole.allocation_money
        WHERE exclusion_group = $1 AND action_id IS NULL AND released_at IS NULL
        FOR UPDATE`,
      [LOOKOUT_FUND_GROUP(lookoutId)]
    );
    let returned = 0;
    for (const r of rows) {
      await tx.query(`UPDATE minerval_whole.allocation_money SET released_at = now() WHERE id = $1`, [r.id]);
      const unspent = Number(r.unspent);
      if (unspent <= 0) continue;
      returned += unspent;
      if (r.user_id) {
        await tx.query(
          `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
           VALUES ($1, $2, 'refund', $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [r.user_id, unspent, r.claim_id, `lookout-fund:${r.id}`]
        );
      }
    }
    return returned;
  });
}
