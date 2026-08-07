/**
 * Assessment orders — the demand side of the owl economy.
 *
 * An order is a user's purchase of one Steward assessment of one claim.
 * Orders run on the EXPRESS lane (src/workers/order-pipeline.ts): a purchase
 * doesn't queue behind the background importance-ordered drain. The charge is
 * taken by the dispatcher when the Steward run starts, never here — so a
 * pending order cancels free (docs/accounts.md, "charge-at-start").
 *
 * A proposal-funded order (contributionId set) is created when an accepted
 * claim proposal materializes: the claim_proposal charge already paid for the
 * assessment, so the order carries that charge entry and is never charged
 * again — this is what guarantees a paid proposal's claim doesn't sit in the
 * background queue (#284).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { getDb, rawQuery } from "../db/client.js";
import { assessmentOrders, claims, type AssessmentOrder } from "../db/schema.js";
import { capMicroUsd, microUsdToOwls } from "./owl.js";
import { recordOwlEntry, OWL_REASONS } from "./owl-ledger-service.js";

export type OrderCreateResult =
  | { ok: true; order: AssessmentOrder }
  | {
      ok: false;
      code: "CLAIM_NOT_FOUND" | "CLAIM_NOT_ACTIVE" | "ORDER_ALREADY_OPEN";
      message: string;
      existingOrderId?: string;
    };

/**
 * Create a pending order for a claim. One open (pending/running) order per
 * user per claim — a second click joins the first order instead of paying
 * twice. Ordering an already-assessed claim is a reassessment.
 */
export async function createOrder(input: {
  userId: string;
  claimId: string;
  contributionId?: string | null;
  /** Pre-paid orders (accepted proposals) carry the charge that funded them. */
  chargeEntryId?: string | null;
}): Promise<OrderCreateResult> {
  const db = getDb();
  const [claim] = await db
    .select({ id: claims.id, state: claims.state })
    .from(claims)
    .where(eq(claims.id, input.claimId))
    .limit(1);
  if (!claim) {
    return { ok: false, code: "CLAIM_NOT_FOUND", message: "Claim not found" };
  }
  if (claim.state !== "active") {
    return {
      ok: false,
      code: "CLAIM_NOT_ACTIVE",
      message: `Claim is ${claim.state}; only active claims can be assessed`,
    };
  }

  const [open] = await db
    .select({ id: assessmentOrders.id })
    .from(assessmentOrders)
    .where(
      and(
        eq(assessmentOrders.userId, input.userId),
        eq(assessmentOrders.claimId, input.claimId),
        inArray(assessmentOrders.status, ["pending", "running"])
      )
    )
    .limit(1);
  if (open) {
    return {
      ok: false,
      code: "ORDER_ALREADY_OPEN",
      message: "You already have an open order for this claim",
      existingOrderId: open.id,
    };
  }

  // The partial unique index (uq_orders_open_per_claim) is the real guard:
  // two racing creates cannot both insert an open order. The select above
  // is just the friendly-message fast path.
  const [order] = await db
    .insert(assessmentOrders)
    .values({
      userId: input.userId,
      claimId: input.claimId,
      contributionId: input.contributionId ?? null,
      chargeEntryId: input.chargeEntryId ?? null,
      // The row's price_micro_usd is the CAP quoted at order time: the most
      // this assessment can cost. The dispatcher charges it at run start and
      // settles the unused fraction back once the meter has the real cost.
      priceMicroUsd: capMicroUsd("assessment"),
    })
    .onConflictDoNothing()
    .returning();
  if (!order) {
    const existing = await getOpenOrderForClaim(input.userId, input.claimId);
    return {
      ok: false,
      code: "ORDER_ALREADY_OPEN",
      message: "You already have an open order for this claim",
      existingOrderId: existing?.id,
    };
  }
  return { ok: true, order };
}

export type OrderCancelResult =
  | { ok: true; refunded: boolean }
  | { ok: false; code: "NOT_FOUND" | "NOT_CANCELLABLE"; message: string };

/**
 * Cancel a pending order. Free when it was never charged (the normal case —
 * the charge lands only as the run starts); a charged-but-requeued order
 * (transient retry) refunds. Running/finished orders can't be cancelled.
 */
export async function cancelOrder(input: {
  orderId: string;
  userId: string;
}): Promise<OrderCancelResult> {
  const rows = await rawQuery<{
    id: string;
    charge_entry_id: string | null;
    price_micro_usd: number;
    claim_id: string;
  }>(
    `UPDATE assessment_orders
        SET status = 'cancelled', completed_at = now()
      WHERE id = $1 AND user_id = $2 AND status = 'pending'
      RETURNING id, charge_entry_id, price_micro_usd, claim_id`,
    [input.orderId, input.userId]
  );
  if (rows.length === 0) {
    const [existing] = await rawQuery<{ status: string }>(
      `SELECT status FROM assessment_orders WHERE id = $1 AND user_id = $2`,
      [input.orderId, input.userId]
    );
    if (!existing) {
      return { ok: false, code: "NOT_FOUND", message: "Order not found" };
    }
    return {
      ok: false,
      code: "NOT_CANCELLABLE",
      message: `Order is ${existing.status}; only pending orders can be cancelled`,
    };
  }
  const row = rows[0]!;
  let refunded = false;
  if (row.charge_entry_id) {
    refunded = await recordOwlEntry({
      userId: input.userId,
      amountMicroUsd: Number(row.price_micro_usd),
      reason: OWL_REASONS.refund,
      op: "assessment",
      claimId: row.claim_id,
      idempotencyKey: `refund:order:${row.id}`,
    });
  }
  return { ok: true, refunded };
}

export async function listOrders(
  userId: string,
  limit = 50
): Promise<AssessmentOrder[]> {
  const db = getDb();
  return db
    .select()
    .from(assessmentOrders)
    .where(eq(assessmentOrders.userId, userId))
    .orderBy(desc(assessmentOrders.createdAt))
    .limit(limit);
}

/** The user's open (pending/running) order for one claim, if any. */
export async function getOpenOrderForClaim(
  userId: string,
  claimId: string
): Promise<AssessmentOrder | null> {
  const db = getDb();
  const [order] = await db
    .select()
    .from(assessmentOrders)
    .where(
      and(
        eq(assessmentOrders.userId, userId),
        eq(assessmentOrders.claimId, claimId),
        inArray(assessmentOrders.status, ["pending", "running"])
      )
    )
    .limit(1);
  return order ?? null;
}

export function serializeOrder(o: AssessmentOrder) {
  return {
    id: o.id,
    claim_id: o.claimId,
    contribution_id: o.contributionId,
    status: o.status,
    // The quoted cap, not a fixed price — the settled charge can be less.
    price_cap_owls: microUsdToOwls(Number(o.priceMicroUsd)),
    charged: o.chargeEntryId !== null,
    error: o.error,
    created_at: o.createdAt?.toISOString(),
    started_at: o.startedAt?.toISOString() ?? null,
    completed_at: o.completedAt?.toISOString() ?? null,
  };
}
