/**
 * Owl ledger service — the accounting core of the owl economy.
 *
 * Every earn and spend is an explicit signed row in owl_ledger (face-value
 * micro-USD); balance = SUM(amount_micro_usd). This replaced the derived
 * "usage beyond the monthly grant" model: llm_usage remains internal cost
 * observability, but the bill is the ledger. See src/services/owl.ts for the
 * unit itself and docs/accounts.md for the product shape.
 *
 * Charges are conditional inserts guarded by a balance subquery. Two racing
 * requests can each pass the guard — the same one-operation overshoot slack
 * the metered era accepted — but a drained balance can never be spent twice
 * beyond that, and every path that fails after charging refunds explicitly.
 */
import { eq, sql } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { owlLedger } from "../db/schema.js";
import { loadConfig } from "../config.js";
import { owlsToMicroUsd, type PricedOp } from "./owl.js";

export const OWL_REASONS = {
  purchase: "purchase",
  signupGrant: "signup_grant",
  monthlyGrant: "monthly_grant",
  contributionAward: "contribution_award",
  charge: "charge",
  refund: "refund",
  /** The unused fraction of a charged cap, returned after the meter ran. */
  meterSettlement: "meter_settlement",
  escrowHold: "escrow_hold",
  escrowRefund: "escrow_refund",
  adminAdjust: "admin_adjust",
} as const;

/** Spendable balance in face-value micro-USD. Can be 0, never negative in
 * normal operation (charges are balance-guarded). */
export async function getOwlBalanceMicroUsd(userId: string): Promise<number> {
  const db = getDb();
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${owlLedger.amountMicroUsd}), 0)::bigint`,
    })
    .from(owlLedger)
    .where(eq(owlLedger.userId, userId));
  return Number(row?.total ?? 0);
}

export interface OwlEntryInput {
  userId: string;
  /** Signed face-value micro-USD: positive credits, negative debits. */
  amountMicroUsd: number;
  reason: string;
  op?: PricedOp | null;
  claimId?: string | null;
  contributionId?: string | null;
  jobId?: string | null;
  /** Unique key making the write idempotent (grants, webhook retries). */
  idempotencyKey?: string | null;
  stripeEventId?: string | null;
}

/**
 * Append a ledger row. With an idempotencyKey, re-delivery is a no-op.
 * Returns true when a row was inserted, false on a duplicate key.
 */
export async function recordOwlEntry(input: OwlEntryInput): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(owlLedger)
    .values({
      userId: input.userId,
      amountMicroUsd: input.amountMicroUsd,
      reason: input.reason,
      op: input.op ?? null,
      claimId: input.claimId ?? null,
      contributionId: input.contributionId ?? null,
      jobId: input.jobId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      stripeEventId: input.stripeEventId ?? null,
    })
    .onConflictDoNothing({ target: owlLedger.idempotencyKey })
    .returning({ id: owlLedger.id });
  return inserted.length > 0;
}

/**
 * Charge an operation's cap: insert the debit only if the balance covers it.
 * Returns the ledger entry id when charged, null when the balance was
 * insufficient. The guard and insert are one statement, so concurrent
 * charges can overshoot by at most one operation each — never re-spend a
 * drained balance systematically. A zero cap returns "free" (no row).
 *
 * The cap is not the price: after the run, settleMeteredCharge returns
 * whatever the meter didn't use. Charging the full cap up front is what
 * makes the ceiling trustworthy — the balance can never go negative
 * mid-run, and the figure on the button is the worst case.
 */
export async function chargeOwls(input: {
  userId: string;
  priceOwls: number;
  op: PricedOp;
  claimId?: string | null;
  contributionId?: string | null;
}): Promise<{ charged: boolean; entryId: string | null }> {
  const priceMicro = owlsToMicroUsd(input.priceOwls);
  if (priceMicro <= 0) return { charged: true, entryId: null };
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger
       (user_id, amount_micro_usd, reason, op, claim_id, contribution_id)
     SELECT $1, $2, 'charge', $3, $4, $5
      WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
               FROM owl_ledger WHERE user_id = $1) >= $6
     RETURNING id`,
    [
      input.userId,
      -priceMicro,
      input.op,
      input.claimId ?? null,
      input.contributionId ?? null,
      priceMicro,
    ]
  );
  return { charged: rows.length > 0, entryId: rows[0]?.id ?? null };
}

/**
 * Attach a contribution to an already-written charge row. Used by proposal
 * flows where the charge is taken first (charge-at-start) and the
 * contribution row is minted right after — the link is what lets a later
 * intake rejection refund the exact charge.
 */
export async function attachChargeContribution(
  entryId: string,
  contributionId: string
): Promise<void> {
  await rawQuery(`UPDATE owl_ledger SET contribution_id = $1 WHERE id = $2`, [
    contributionId,
    entryId,
  ]);
}

/**
 * Refund the charge behind a rejected proposal, exactly once. Good-faith
 * contribution is free (#71): a claim/source proposal charge buys the
 * assessment work that follows acceptance, so a rejection returns it. The
 * idempotency key makes review + arbitration paths safely re-entrant.
 */
export async function refundChargeForContribution(
  contributionId: string
): Promise<boolean> {
  const rows = await rawQuery<{
    user_id: string;
    amount_micro_usd: number;
    op: string | null;
    claim_id: string | null;
  }>(
    `SELECT user_id, amount_micro_usd, op, claim_id
       FROM owl_ledger
      WHERE contribution_id = $1 AND reason = 'charge'
      ORDER BY created_at ASC`,
    [contributionId]
  );
  if (rows.length === 0) return false;
  let refunded = false;
  for (const [i, row] of rows.entries()) {
    const inserted = await recordOwlEntry({
      userId: row.user_id,
      amountMicroUsd: -Number(row.amount_micro_usd),
      reason: OWL_REASONS.refund,
      op: (row.op as PricedOp | null) ?? null,
      claimId: row.claim_id,
      contributionId,
      idempotencyKey: `refund:contribution:${contributionId}:${i}`,
    });
    refunded = refunded || inserted;
  }
  return refunded;
}

/**
 * Settle a cap charge against what the meter says the run really cost.
 * Credits back max(0, cap − metered): the user pays metered cost-plus, up
 * to the cap; overage past the cap is absorbed by the platform, never
 * charged. Idempotent per settleKey, so retried completion paths cannot
 * double-credit. A no-op when nothing is owed back (metered ≥ cap) or when
 * the meter saw no work at all (that is a refund case, not a settlement).
 */
export async function settleMeteredCharge(input: {
  userId: string;
  capMicroUsd: number;
  meteredMicroUsd: number;
  /** Unique key for this settlement, e.g. `settle:order:<id>` or the charge entry id. */
  settleKey: string;
  op: PricedOp;
  claimId?: string | null;
  contributionId?: string | null;
  jobId?: string | null;
}): Promise<{ settledMicroUsd: number }> {
  const unused = Math.max(
    0,
    Math.round(input.capMicroUsd) - Math.max(0, Math.round(input.meteredMicroUsd))
  );
  if (unused <= 0 || input.meteredMicroUsd <= 0) {
    return { settledMicroUsd: 0 };
  }
  const inserted = await recordOwlEntry({
    userId: input.userId,
    amountMicroUsd: unused,
    reason: OWL_REASONS.meterSettlement,
    op: input.op,
    claimId: input.claimId ?? null,
    contributionId: input.contributionId ?? null,
    jobId: input.jobId ?? null,
    idempotencyKey: `settle:${input.settleKey}`,
  });
  return { settledMicroUsd: inserted ? unused : 0 };
}

/** Compensate a charge whose operation failed after the debit was taken. */
export async function refundOwls(input: {
  userId: string;
  priceOwls: number;
  op: PricedOp;
  claimId?: string | null;
  contributionId?: string | null;
}): Promise<void> {
  await recordOwlEntry({
    userId: input.userId,
    amountMicroUsd: owlsToMicroUsd(input.priceOwls),
    reason: OWL_REASONS.refund,
    op: input.op,
    claimId: input.claimId ?? null,
    contributionId: input.contributionId ?? null,
  });
}

/**
 * Ensure the free-tier grants are on the ledger: the one-time signup grant
 * and this month's trickle. Idempotent via unique keys, so it's safe (and
 * cheap) to call from every entitlement read — which is what makes the
 * monthly grant "lazy": it lands the first time the user shows up in a month.
 */
export async function ensureFreeGrants(userId: string): Promise<void> {
  const config = loadConfig();
  if (config.signupGrantOwls > 0) {
    await recordOwlEntry({
      userId,
      amountMicroUsd: owlsToMicroUsd(config.signupGrantOwls),
      reason: OWL_REASONS.signupGrant,
      idempotencyKey: `signup:${userId}`,
    });
  }
  if (config.monthlyGrantOwls > 0) {
    const month = new Date().toISOString().slice(0, 7); // YYYY-MM (UTC)
    await recordOwlEntry({
      userId,
      amountMicroUsd: owlsToMicroUsd(config.monthlyGrantOwls),
      reason: OWL_REASONS.monthlyGrant,
      idempotencyKey: `monthly:${userId}:${month}`,
    });
  }
}

export interface OwlLedgerEntryView {
  id: string;
  amountMicroUsd: number;
  reason: string;
  op: string | null;
  claimId: string | null;
  contributionId: string | null;
  jobId: string | null;
  createdAt: Date;
}

/** The user's owl history, newest first — powers the account-page table. */
export async function listOwlLedger(
  userId: string,
  limit = 50
): Promise<OwlLedgerEntryView[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: owlLedger.id,
      amountMicroUsd: owlLedger.amountMicroUsd,
      reason: owlLedger.reason,
      op: owlLedger.op,
      claimId: owlLedger.claimId,
      contributionId: owlLedger.contributionId,
      jobId: owlLedger.jobId,
      createdAt: owlLedger.createdAt,
    })
    .from(owlLedger)
    .where(eq(owlLedger.userId, userId))
    .orderBy(sql`${owlLedger.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, amountMicroUsd: Number(r.amountMicroUsd) }));
}
