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
import { mergedAliasRefusal } from "./claim-alias-service.js";
import { currentLabel } from "../llm/usage-context.js";
import { oneLabelOnly } from "./judgment-version-service.js";

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
    // A merged node names its survivor (#884).
    const merged = await mergedAliasRefusal(input.claimId);
    return {
      ok: false,
      code: "CLAIM_NOT_ACTIVE",
      message: merged?.message ?? `Claim is ${claim.state}; only active claims can be assessed`,
    };
  }

  // One open order per person, node and label: an order is for a pass at
  // its label, so an order at one label does not stand in for one at
  // another. Where `public` is the only label this is the check it was.
  const atThisLabel = oneLabelOnly() ? [] : [eq(assessmentOrders.sensitivityLabel, currentLabel())];
  const [open] = await db
    .select({ id: assessmentOrders.id })
    .from(assessmentOrders)
    .where(
      and(
        eq(assessmentOrders.userId, input.userId),
        eq(assessmentOrders.claimId, input.claimId),
        inArray(assessmentOrders.status, ["pending", "running"]),
        ...atThisLabel
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

  // A pre-paid order's cap is what its charge actually took, so the
  // settlement after the run returns the unused part of that charge and no
  // more. Read from the ledger rather than today's cap: the proposal was
  // charged at the claim_proposal cap in force when it was submitted, and a
  // cap changed since (or a proposal cap below the assessment cap) must not
  // settle back owls the buyer never paid.
  let priceMicroUsd = capMicroUsd("assessment");
  if (input.chargeEntryId) {
    const [charge] = await rawQuery<{ amount: string }>(
      `SELECT amount_micro_usd::bigint AS amount FROM owl_ledger WHERE id = $1`,
      [input.chargeEntryId]
    );
    if (charge) priceMicroUsd = Math.abs(Number(charge.amount));
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
      priceMicroUsd,
      // The pass the order buys runs at this (src/labels.ts).
      sensitivityLabel: currentLabel(),
    })
    .onConflictDoNothing()
    .returning();
  if (!order) {
    const existing = await getOpenOrderForClaim(input.userId, input.claimId, oneLabelOnly() ? undefined : currentLabel());
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
  claimId: string,
  /** Only an order at this label; left out, any the reader may read. */
  label?: string
): Promise<AssessmentOrder | null> {
  const db = getDb();
  const [order] = await db
    .select()
    .from(assessmentOrders)
    .where(
      and(
        eq(assessmentOrders.userId, userId),
        eq(assessmentOrders.claimId, claimId),
        inArray(assessmentOrders.status, ["pending", "running"]),
        ...(label === undefined ? [] : [eq(assessmentOrders.sensitivityLabel, label)])
      )
    )
    .limit(1);
  return order ?? null;
}

/**
 * What each finished order cost in the end: its ceiling, less the unused
 * part the meter settlement returned (and any refund). Only orders that are
 * done and were charged have a cost; the rest are absent from the map. The
 * settlement and the refund are found by the idempotency keys the order
 * pipeline and cancelOrder write them under.
 */
export async function orderCostsMicroUsd(
  orders: AssessmentOrder[]
): Promise<Map<string, number>> {
  const settled = orders.filter((o) => o.status === "done" && o.chargeEntryId !== null);
  const costs = new Map<string, number>();
  if (settled.length === 0) return costs;
  const keys = settled.flatMap((o) => [`settle:order:${o.id}`, `refund:order:${o.id}`]);
  const rows = await rawQuery<{ idempotency_key: string; amount_micro_usd: number }>(
    `SELECT idempotency_key, amount_micro_usd
       FROM owl_ledger
      WHERE idempotency_key = ANY($1::text[])`,
    [keys]
  );
  const returned = new Map<string, number>();
  for (const r of rows) {
    const orderId = r.idempotency_key.slice(r.idempotency_key.lastIndexOf(":") + 1);
    returned.set(orderId, (returned.get(orderId) ?? 0) + Number(r.amount_micro_usd));
  }
  for (const o of settled) {
    costs.set(o.id, Math.max(0, Number(o.priceMicroUsd) - (returned.get(o.id) ?? 0)));
  }
  return costs;
}

/** Orders as the API lists them, each finished one with what it cost. */
export async function serializeOrders(orders: AssessmentOrder[]) {
  const costs = await orderCostsMicroUsd(orders);
  return orders.map((o) => serializeOrder(o, costs.get(o.id)));
}

export function serializeOrder(o: AssessmentOrder, costMicroUsd?: number) {

  return {
    id: o.id,
    claim_id: o.claimId,
    contribution_id: o.contributionId,
    status: o.status,
    // The quoted cap, not a fixed price — the settled charge can be less.
    price_cap_owls: microUsdToOwls(Number(o.priceMicroUsd)),
    charged: o.chargeEntryId !== null,
    // What a finished order cost once its unused part was returned; null
    // while it is open, and where the cost was not looked up.
    cost_owls: costMicroUsd === undefined ? null : microUsdToOwls(costMicroUsd),
    error: o.error,
    created_at: o.createdAt?.toISOString(),
    started_at: o.startedAt?.toISOString() ?? null,
    completed_at: o.completedAt?.toISOString() ?? null,
  };
}
