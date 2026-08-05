/**
 * Credit ledger service (#309) — the accounting half of paid billing.
 *
 * Grants (purchases, promos, adjustments) are rows in credits_ledger. Spend is
 * NOT duplicated into the ledger: llm_usage already prices every call in
 * micro-USD, so a user's paid consumption is derived — for each calendar
 * month, whatever their metered cost exceeded the free-tier grant. Balance is
 * therefore:
 *
 *   SUM(credits_ledger.amount_micro_usd)
 *     − Σ over months of max(0, month_usage − free_monthly_grant)
 *
 * exactly the "credit accounting is a SUM, not a re-architecture" shape the
 * billing seam promised. The free grant is read from config at query time, so
 * retroactively changing FREE_TIER_MONTHLY_USD re-prices history; that's
 * accepted for the same reason the grant itself is config, not data.
 */
import { eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { creditsLedger, llmUsage } from "../db/schema.js";
import { loadConfig } from "../config.js";

/** Total metered usage beyond the monthly free grant, summed over all months. */
async function getPaidUsageMicroUsd(userId: string): Promise<number> {
  const grant = Math.round(loadConfig().freeTierMonthlyUsd * 1_000_000);
  const db = getDb();
  const [row] = await db
    .select({
      overage: sql<number>`coalesce(sum(greatest(month_cost - ${grant}, 0)), 0)::bigint`,
    })
    .from(
      db
        .select({
          monthCost: sql`sum(${llmUsage.costMicroUsd})`.as("month_cost"),
        })
        .from(llmUsage)
        .where(eq(llmUsage.userId, userId))
        .groupBy(
          sql`date_trunc('month', ${llmUsage.createdAt} at time zone 'UTC')`
        )
        .as("monthly")
    );
  return Number(row?.overage ?? 0);
}

/** Purchased/granted credit remaining, in micro-USD. Never negative. */
export async function getCreditBalanceMicroUsd(
  userId: string
): Promise<number> {
  const db = getDb();
  const [granted] = await db
    .select({
      total: sql<number>`coalesce(sum(${creditsLedger.amountMicroUsd}), 0)::bigint`,
    })
    .from(creditsLedger)
    .where(eq(creditsLedger.userId, userId));
  const paidUsage = await getPaidUsageMicroUsd(userId);
  return Math.max(0, Number(granted?.total ?? 0) - paidUsage);
}

/**
 * Record a credit grant. Idempotent per Stripe Checkout session: Stripe
 * retries webhooks and a delayed-payment purchase emits two success events,
 * so the unique stripe_checkout_session_id makes re-delivery a no-op.
 * Returns true when a row was inserted, false when it was a duplicate.
 */
export async function grantCredits(input: {
  userId: string;
  amountMicroUsd: number;
  reason?: string;
  stripeEventId?: string;
  stripeCheckoutSessionId?: string;
}): Promise<boolean> {
  const db = getDb();
  const inserted = await db
    .insert(creditsLedger)
    .values({
      userId: input.userId,
      amountMicroUsd: input.amountMicroUsd,
      reason: input.reason ?? "purchase",
      stripeEventId: input.stripeEventId ?? null,
      stripeCheckoutSessionId: input.stripeCheckoutSessionId ?? null,
    })
    .onConflictDoNothing({ target: creditsLedger.stripeCheckoutSessionId })
    .returning({ id: creditsLedger.id });
  return inserted.length > 0;
}

export interface CreditLedgerEntryView {
  id: string;
  amountMicroUsd: number;
  reason: string;
  createdAt: Date;
}

/** The user's credit history, newest first — powers the dashboard table. */
export async function listCreditLedger(
  userId: string,
  limit = 50
): Promise<CreditLedgerEntryView[]> {
  const db = getDb();
  const rows = await db
    .select({
      id: creditsLedger.id,
      amountMicroUsd: creditsLedger.amountMicroUsd,
      reason: creditsLedger.reason,
      createdAt: creditsLedger.createdAt,
    })
    .from(creditsLedger)
    .where(eq(creditsLedger.userId, userId))
    .orderBy(sql`${creditsLedger.createdAt} desc`)
    .limit(limit);
  return rows.map((r) => ({ ...r, amountMicroUsd: Number(r.amountMicroUsd) }));
}
