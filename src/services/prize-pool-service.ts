/**
 * The prize fund (docs/mathematics.md §8.1): one `prize_pools` row per
 * domain, whose balance is the sum of `prize_pool_entries`.
 *
 * Three numbers, and only the first is stored. `balance` is the sum of the
 * entries. `reserved` is derived: the sum of `amount_micro_usd` over live
 * bounties (open, claim_pending, house_result_pending, rebinding).
 * `available` is balance minus reserved, and a bounty opens only when
 * `available` covers it. Nothing is posted when a bounty opens or closes.
 * The only debits are owl_prize (owls granted, at the cash amount),
 * withholding_remitted, defect_award, review_award, and — only once a cash
 * rail exists — payout; each consumes the bounty's reservation where one
 * exists. A dollar is promised once, in `reserved`, and spent once, in an
 * entry.
 *
 * Every writer takes an optional transaction runner so the payout path can
 * post its debits inside the same transaction that grants the owls.
 */
import { rawQuery, type TxQuery } from "../db/client.js";

export const PRIZE_DOMAIN_MATHEMATICS = "mathematics";

/** Bounty statuses whose amounts count as reserved. */
export const RESERVING_BOUNTY_STATUSES = [
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
] as const;

/** The fund's debit reasons: each consumes a bounty's reservation where one exists. */
export const FUND_DEBIT_REASONS = [
  "owl_prize",
  "withholding_remitted",
  "defect_award",
  "review_award",
  "payout",
] as const;
export type FundDebitReason = (typeof FUND_DEBIT_REASONS)[number];

/** A query runner: a transaction's, or the pool's autocommit one. */
export interface Runner {
  query<T>(queryText: string, params?: unknown[]): Promise<T[]>;
}

export const poolRunner: Runner = {
  query: <T>(q: string, p: unknown[] = []) => rawQuery<T>(q, p),
};

export function asRunner(tx?: TxQuery | Runner | null): Runner {
  return tx ?? poolRunner;
}

export interface PrizePoolRow {
  id: string;
  domain: string;
  currency: string;
}

export async function getPoolByDomain(
  domain: string,
  tx?: Runner
): Promise<PrizePoolRow | null> {
  const [row] = await asRunner(tx).query<PrizePoolRow>(
    `SELECT id, domain, currency FROM prize_pools WHERE domain = $1`,
    [domain]
  );
  return row ?? null;
}

/** The domain's fund, created on first use (one row per domain, UNIQUE). */
export async function getOrCreatePool(
  domain: string,
  tx?: Runner
): Promise<PrizePoolRow> {
  const r = asRunner(tx);
  const existing = await getPoolByDomain(domain, r);
  if (existing) return existing;
  await r.query(
    `INSERT INTO prize_pools (domain) VALUES ($1) ON CONFLICT (domain) DO NOTHING`,
    [domain]
  );
  const created = await getPoolByDomain(domain, r);
  if (!created) throw new Error(`prize pool for ${domain} could not be created`);
  return created;
}

/** balance = SUM(entries). */
export async function poolBalanceMicroUsd(
  poolId: string,
  tx?: Runner
): Promise<number> {
  const [row] = await asRunner(tx).query<{ total: string | number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
       FROM prize_pool_entries WHERE pool_id = $1`,
    [poolId]
  );
  return Number(row?.total ?? 0);
}

/** reserved = SUM(amount) over live bounties on the pool. Derived, never stored. */
export async function poolReservedMicroUsd(
  poolId: string,
  tx?: Runner
): Promise<number> {
  const [row] = await asRunner(tx).query<{ total: string | number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
       FROM bounties
      WHERE pool_id = $1 AND status = ANY($2)`,
    [poolId, [...RESERVING_BOUNTY_STATUSES]]
  );
  return Number(row?.total ?? 0);
}

export interface PoolNumbers {
  balance_micro_usd: number;
  reserved_micro_usd: number;
  available_micro_usd: number;
}

/** The pure arithmetic: available is what the balance does not already promise. */
export function computeAvailable(
  balanceMicroUsd: number,
  reservedMicroUsd: number
): number {
  return balanceMicroUsd - reservedMicroUsd;
}

export async function poolNumbers(poolId: string, tx?: Runner): Promise<PoolNumbers> {
  const r = asRunner(tx);
  const balance = await poolBalanceMicroUsd(poolId, r);
  const reserved = await poolReservedMicroUsd(poolId, r);
  return {
    balance_micro_usd: balance,
    reserved_micro_usd: reserved,
    available_micro_usd: computeAvailable(balance, reserved),
  };
}

export interface DepositInput {
  domain: string;
  amount_cents: number;
  bank_reference: string;
  batch_key: string;
}

export type DepositResult =
  | { ok: true; entry_id: string; duplicate: false; numbers: PoolNumbers }
  | { ok: true; entry_id: string; duplicate: true; numbers: PoolNumbers }
  | { ok: false; code: "BAD_AMOUNT" | "BAD_REFERENCE" | "BAD_BATCH_KEY"; message: string };

/** The idempotency key a deposit batch lands under. */
export function depositIdempotencyKey(domain: string, batchKey: string): string {
  return `deposit:${domain}:${batchKey}`;
}

/**
 * Record the founder's deposit (operator key, §8.11): a positive
 * platform_deposit entry carrying the bank reference as evidence of the
 * cash. Idempotent under the batch key: a retried call returns the entry
 * that already landed, and the balance rises once.
 */
export async function depositToPool(input: DepositInput): Promise<DepositResult> {
  const cents = Number(input.amount_cents);
  if (!Number.isInteger(cents) || cents <= 0) {
    return { ok: false, code: "BAD_AMOUNT", message: "amount_cents must be a positive integer" };
  }
  const reference = String(input.bank_reference ?? "").trim();
  if (!reference) {
    return { ok: false, code: "BAD_REFERENCE", message: "bank_reference is required" };
  }
  const batchKey = String(input.batch_key ?? "").trim();
  if (!batchKey) {
    return { ok: false, code: "BAD_BATCH_KEY", message: "batch_key is required" };
  }
  const pool = await getOrCreatePool(input.domain);
  const key = depositIdempotencyKey(input.domain, batchKey);
  const amountMicro = cents * 10_000;
  const inserted = await rawQuery<{ id: string }>(
    `INSERT INTO prize_pool_entries
       (pool_id, amount_micro_usd, reason, bank_reference, idempotency_key)
     VALUES ($1, $2, 'platform_deposit', $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [pool.id, amountMicro, reference, key]
  );
  const numbers = await poolNumbers(pool.id);
  if (inserted.length > 0) {
    return { ok: true, entry_id: inserted[0]!.id, duplicate: false, numbers };
  }
  const [existing] = await rawQuery<{ id: string }>(
    `SELECT id FROM prize_pool_entries WHERE idempotency_key = $1`,
    [key]
  );
  return { ok: true, entry_id: existing!.id, duplicate: true, numbers };
}

/** The sum already debited against one bounty (a negative sum, returned positive). */
export async function bountyDebitedMicroUsd(
  bountyId: string,
  tx?: Runner
): Promise<number> {
  const [row] = await asRunner(tx).query<{ total: string | number }>(
    `SELECT COALESCE(-SUM(amount_micro_usd), 0)::bigint AS total
       FROM prize_pool_entries
      WHERE bounty_id = $1 AND reason = ANY($2)`,
    [bountyId, [...FUND_DEBIT_REASONS]]
  );
  return Number(row?.total ?? 0);
}

export interface FundDebitInput {
  poolId: string;
  reason: FundDebitReason;
  /** Positive: how much leaves the fund. */
  amountMicroUsd: number;
  /** The reservation this debit consumes, when one exists. */
  bountyId?: string | null;
  prizeClaimId?: string | null;
  idempotencyKey: string;
}

/**
 * Post one debit. With a bounty, the debit consumes that bounty's
 * reservation, and the sum of debits against a bounty never exceeds its
 * amount: the invariant §8.1 states ("spent once, in an entry"), checked
 * under a row lock on the bounty so two concurrent debits cannot both
 * pass. Idempotent under the key; returns the entry id, or null when the
 * key had already landed.
 */
export async function postFundDebit(
  input: FundDebitInput,
  tx?: Runner
): Promise<string | null> {
  const r = asRunner(tx);
  const amount = Math.round(input.amountMicroUsd);
  if (!(amount > 0)) throw new Error("a fund debit must be positive");
  if (!FUND_DEBIT_REASONS.includes(input.reason)) {
    throw new Error(`${input.reason} is not a fund debit reason`);
  }
  if (input.bountyId) {
    const [bounty] = await r.query<{ amount_micro_usd: string | number }>(
      `SELECT amount_micro_usd FROM bounties WHERE id = $1 FOR UPDATE`,
      [input.bountyId]
    );
    if (!bounty) throw new Error(`bounty ${input.bountyId} not found`);
    const already = await bountyDebitedMicroUsd(input.bountyId, r);
    const [dup] = await r.query<{ id: string }>(
      `SELECT id FROM prize_pool_entries WHERE idempotency_key = $1`,
      [input.idempotencyKey]
    );
    if (dup) return null;
    if (already + amount > Number(bounty.amount_micro_usd)) {
      throw new Error(
        `debit of ${amount} against bounty ${input.bountyId} would exceed its ` +
          `reservation (${Number(bounty.amount_micro_usd)}; ${already} already spent)`
      );
    }
  }
  const rows = await r.query<{ id: string }>(
    `INSERT INTO prize_pool_entries
       (pool_id, amount_micro_usd, reason, bounty_id, prize_claim_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.poolId,
      -amount,
      input.reason,
      input.bountyId ?? null,
      input.prizeClaimId ?? null,
      input.idempotencyKey,
    ]
  );
  return rows[0]?.id ?? null;
}

/** owl_prize: owls granted, debited at the cash amount so every owl prize is fully funded. */
export function postOwlPrizeDebit(
  input: Omit<FundDebitInput, "reason">,
  tx?: Runner
): Promise<string | null> {
  return postFundDebit({ ...input, reason: "owl_prize" }, tx);
}

/** withholding_remitted: tax withheld from a prize, remitted from the fund. */
export function postWithholdingRemitted(
  input: Omit<FundDebitInput, "reason">,
  tx?: Runner
): Promise<string | null> {
  return postFundDebit({ ...input, reason: "withholding_remitted" }, tx);
}

/** defect_award: a claimant exposed a statement defect (§8.4). */
export function postDefectAward(
  input: Omit<FundDebitInput, "reason">,
  tx?: Runner
): Promise<string | null> {
  return postFundDebit({ ...input, reason: "defect_award" }, tx);
}

/** review_award: a challenger exposed a defect during the review period (§5.6). */
export function postReviewAward(
  input: Omit<FundDebitInput, "reason">,
  tx?: Runner
): Promise<string | null> {
  return postFundDebit({ ...input, reason: "review_award" }, tx);
}

export interface PoolPublicView {
  domain: string;
  currency: string;
  balance_micro_usd: number;
  reserved_micro_usd: number;
  available_micro_usd: number;
  entries_by_reason: Array<{ reason: string; count: number; total_micro_usd: number }>;
  open_bounties: number;
}

/** GET /prize-pools/:domain — balance and entries by reason, public. */
export async function getPoolPublicView(domain: string): Promise<PoolPublicView | null> {
  const pool = await getPoolByDomain(domain);
  if (!pool) return null;
  const numbers = await poolNumbers(pool.id);
  const byReason = await rawQuery<{ reason: string; count: string; total: string }>(
    `SELECT reason, COUNT(*)::int AS count,
            COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
       FROM prize_pool_entries WHERE pool_id = $1
      GROUP BY reason ORDER BY reason`,
    [pool.id]
  );
  const [open] = await rawQuery<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM bounties WHERE pool_id = $1 AND status = 'open'`,
    [pool.id]
  );
  return {
    domain: pool.domain,
    currency: pool.currency,
    ...numbers,
    entries_by_reason: byReason.map((r) => ({
      reason: r.reason,
      count: Number(r.count),
      total_micro_usd: Number(r.total),
    })),
    open_bounties: Number(open?.n ?? 0),
  };
}
