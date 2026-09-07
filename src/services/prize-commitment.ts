/**
 * The prize term in a mandate's committed money (docs/mathematics.md §8.1,
 * §8.6). A bounty is posted by a mandate's Grantmaker and held against that
 * mandate's escrow: from the moment it opens until it resolves, its amount
 * is a term in the mandate's committed money beside allocation shares,
 * non-ledger metered spend, and regrants out. When the prize is paid the
 * hold becomes consumption, and the payout row is the record. Nothing is
 * posted when a bounty opens or closes; the term is derived.
 *
 * For each bounty of the grant:
 *
 *   live ? GREATEST(amount, paid) : paid
 *
 * where live means a holding status (confirm_pending, open, claim_pending,
 * house_result_pending, rebinding; a `requested` bounty holds nothing) and
 * paid is the gross sum of `prize_payouts` on the bounty's prize claims,
 * every kind, status <> 'reversed'. Plus the prize-review reserve (§8.6):
 * each reserve job's budget while it is running, and once released the
 * amount actually placed on `prize_review` actions for that bounty (the
 * join releasePrizeReviewReserve uses).
 *
 * One SQL fragment, exported here and used verbatim by every statement that
 * computes committed money (grantCommittedMicroUsd, refundUnspentBudget's
 * settlement statement, fundGrantSelfActions' inline headroom), so the
 * readings cannot drift.
 */
import { rawQuery, type TxQuery } from "../db/client.js";

/** Bounty statuses whose amounts hold against the posting mandate's escrow. */
export const HOLDING_BOUNTY_STATUSES = [
  "confirm_pending",
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
] as const;

export function isHoldingBountyStatus(status: string): boolean {
  return (HOLDING_BOUNTY_STATUSES as readonly string[]).includes(status);
}

/** The platform-owned budget job that reserves review money per bounty (§8.6). */
export const PRIZE_RESERVE_JOB_KIND = "prize_review_reserve";

const HOLDING_LIST = HOLDING_BOUNTY_STATUSES.map((s) => `'${s}'`).join(", ");

/**
 * The FROM clause every reading shares: the grant's bounties, each joined
 * laterally to its gross payouts and to its review reserve. `grantIdExpr`
 * is a SQL expression for the grant id: a parameter placeholder (`$1`) or a
 * correlated column (`g.id`).
 */
function bountyTermsFromSql(grantIdExpr: string): string {
  return `FROM bounties b
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(pp.amount_micro_usd), 0)::bigint AS total
           FROM prize_claims pc
           JOIN prize_payouts pp ON pp.prize_claim_id = pc.id
          WHERE pc.bounty_id = b.id AND pp.status <> 'reversed'
       ) paid
       CROSS JOIN LATERAL (
         SELECT COALESCE(SUM(CASE WHEN j.status = 'running' THEN j.budget_micro_usd
                                  ELSE (SELECT COALESCE(SUM(al.amount_micro_usd), 0)
                                          FROM action_allocations al
                                          JOIN actions a ON a.id = al.action_id
                                          JOIN prize_claims pc ON pc.id::text = a.target_ref
                                         WHERE a.kind = 'prize_review'
                                           AND pc.bounty_id = b.id
                                           AND al.user_id = j.user_id)
                             END), 0)::bigint AS total
           FROM budget_jobs j
          WHERE j.kind = '${PRIZE_RESERVE_JOB_KIND}'
            AND j.checkpoint->>'bounty_id' = b.id::text
       ) reserve
      WHERE b.posted_by_grant_id = ${grantIdExpr}`;
}

/** One bounty's term: its hold or its consumption, plus its review reserve. */
const PER_BOUNTY_TERM_SQL =
  `(CASE WHEN b.status IN (${HOLDING_LIST}) THEN GREATEST(b.amount_micro_usd, paid.total) ` +
  `ELSE paid.total END + reserve.total)`;

/**
 * The prize term as one scalar expression in micro-USD (`::bigint`), for
 * use as a column in a committed-money statement.
 */
export function prizeCommitmentSql(grantIdExpr: string): string {
  return `COALESCE((SELECT SUM(${PER_BOUNTY_TERM_SQL}) ${bountyTermsFromSql(grantIdExpr)}), 0)::bigint`;
}

export interface PrizeCommitmentBreakdown {
  /** Amounts of the mandate's bounties in a holding status. */
  held_micro_usd: number;
  /** Gross payouts on the mandate's bounties, every kind, not reversed. */
  paid_micro_usd: number;
  /** The review reserve: running budgets, and placed spend once released. */
  review_reserve_micro_usd: number;
  /** The prize term itself, as grantCommittedMicroUsd counts it. */
  total_micro_usd: number;
}

/**
 * The mandate's prize numbers (§8.1), all derived from the same FROM clause
 * as the term, so the page's tiles and the escrow's arithmetic agree.
 */
export async function prizeCommitmentBreakdown(
  grantId: string,
  tx?: TxQuery | null
): Promise<PrizeCommitmentBreakdown> {
  const query = <T,>(text: string, params?: unknown[]) =>
    tx ? tx.query<T>(text, params) : rawQuery<T>(text, params);
  const [row] = await query<{
    held: string | number;
    paid: string | number;
    reserve: string | number;
    total: string | number;
  }>(
    `SELECT COALESCE(SUM(CASE WHEN b.status IN (${HOLDING_LIST}) THEN b.amount_micro_usd ELSE 0 END), 0)::bigint AS held,
            COALESCE(SUM(paid.total), 0)::bigint AS paid,
            COALESCE(SUM(reserve.total), 0)::bigint AS reserve,
            COALESCE(SUM(${PER_BOUNTY_TERM_SQL}), 0)::bigint AS total
       ${bountyTermsFromSql("$1")}`,
    [grantId]
  );
  return {
    held_micro_usd: Number(row?.held ?? 0),
    paid_micro_usd: Number(row?.paid ?? 0),
    review_reserve_micro_usd: Number(row?.reserve ?? 0),
    total_micro_usd: Number(row?.total ?? 0),
  };
}
