/**
 * Express lane — the assessment-order dispatcher.
 *
 * A paid order is a purchase, not a request: it never waits behind the
 * background importance-ordered drain. The runner checks this lane FIRST on
 * every tick (local-runner.ts), so an order's dispatch latency is one tick,
 * not a queue position. Background work uses whatever capacity is left.
 *
 * Charge-at-start, settle-at-finish: the order's CAP is debited HERE,
 * immediately before the Steward run begins — a pending order was never
 * charged and cancels free — and after the run the metered cost settles
 * against the cap, crediting back the unused fraction. The stake (the
 * demand signal the allocation core reads) is recorded with the charge.
 * A transient failure requeues the order WITH its charge intact (the retry
 * must not double-charge); a genuine failure refunds and fails the order.
 *
 * The run itself is a normal Steward run with the ordering user attributed
 * (usage context: userId + jobId=order id, so per-order cost is queryable
 * from llm_usage), and the claim's queue slot is claimed/released with the
 * same guarded transitions as the background drain — the two lanes can never
 * run one claim twice concurrently.
 */
import { rawQuery } from "../db/client.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { runWithUsageContext, withCostMeter } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import {
  chargeOwls,
  recordOwlEntry,
  settleMeteredCharge,
  OWL_REASONS,
} from "../services/owl-ledger-service.js";
import { microUsdToOwls } from "../services/owl.js";
import { refreshQueuePriority } from "../services/priority-service.js";

interface OrderRow {
  id: string;
  user_id: string;
  claim_id: string;
  contribution_id: string | null;
  price_micro_usd: number;
  charge_entry_id: string | null;
}

export type OrderDrainStatus =
  | "processed"
  | "empty"
  | "budget"
  | "transient"
  /** The claim is mid-run on the other lane; the order stays pending. */
  | "busy";

export interface OrderProcessResult {
  status: OrderDrainStatus;
  orderId?: string;
  claimId?: string;
  ok?: boolean;
  error?: string;
}

/** Return an order to the pending lane (keeping any charge for the retry). */
async function requeueOrder(orderId: string): Promise<void> {
  await rawQuery(
    `UPDATE assessment_orders
        SET status = 'pending', started_at = NULL
      WHERE id = $1 AND status = 'running'`,
    [orderId]
  );
}

/**
 * Release a claim slot this dispatcher claimed. Guarded on the slot still
 * being 'running': a message that re-pended the claim mid-run must keep its
 * pending slot (#182), same as the background drain's success path.
 */
async function releaseClaim(claimId: string, state: string): Promise<void> {
  await rawQuery(
    `UPDATE claims
        SET steward_state = CASE
              WHEN steward_state = 'running' THEN $2
              ELSE steward_state
            END,
            updated_at = now()
      WHERE id = $1`,
    [claimId, state]
  );
}

/**
 * Dispatch the oldest pending order: charge, stake, run the Steward, settle.
 * Returns 'empty' when the lane is clear and 'busy' when the order's claim is
 * currently running on the background lane (retry next tick).
 */
export async function processNextOrderTask(
  opts: { model?: string } = {}
): Promise<OrderProcessResult> {
  const config = loadConfig();
  // A paid order always gets the strong model when one is configured — the
  // buyer is paying for the real thing. Caller override (harness) wins.
  const model =
    opts.model ?? (config.stewardStrongModel || config.stewardModel);

  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }

  const orders = await rawQuery<OrderRow>(
    `UPDATE assessment_orders
        SET status = 'running', started_at = now()
      WHERE id = (
        SELECT id FROM assessment_orders
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT 1
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, user_id, claim_id, contribution_id, price_micro_usd,
                charge_entry_id`
  );
  if (orders.length === 0) return { status: "empty" };
  const order = orders[0]!;

  // Claim the claim's queue slot so the background lane can't double-run it.
  // (A slot stuck 'running' >15m is a crashed worker, reclaimable like the
  // background drain does.) The prior state rides along so paths that never
  // run the Steward can put the slot back exactly as found.
  const claimed = await rawQuery<{
    id: string;
    prior_state: string;
    decomposition_status: string;
  }>(
    `UPDATE claims c
        SET steward_state = 'running', stewarded_at = now()
       FROM (SELECT id, steward_state AS prior_state FROM claims WHERE id = $1) prior
      WHERE c.id = prior.id AND c.state = 'active'
        AND (c.steward_state <> 'running'
             OR c.stewarded_at < now() - interval '15 minutes')
      RETURNING c.id, prior.prior_state, c.decomposition_status`,
    [order.claim_id]
  );
  if (claimed.length === 0) {
    // Mid-run on the other lane (or no longer active). Requeue and let the
    // next tick see the fresh state; if the claim got assessed meanwhile,
    // the order still runs as a reassessment with that context.
    await requeueOrder(order.id);
    return { status: "busy", orderId: order.id, claimId: order.claim_id };
  }
  const priorState = claimed[0]!.prior_state;

  // Charge at the moment the work starts — unless this order was pre-paid
  // (an accepted claim proposal's charge funded it) or already charged by a
  // previous transiently-failed attempt.
  if (!order.charge_entry_id) {
    const priceOwls = microUsdToOwls(Number(order.price_micro_usd));
    const { charged, entryId } = await chargeOwls({
      userId: order.user_id,
      priceOwls,
      op: "assessment",
      claimId: order.claim_id,
    });
    if (!charged) {
      // Balance drained between order creation and dispatch. Fail the order
      // (never charged) and put the claim slot back exactly as found.
      await releaseClaim(order.claim_id, priorState);
      await rawQuery(
        `UPDATE assessment_orders
            SET status = 'failed', completed_at = now(),
                error = 'Owl balance no longer covers the assessment price'
          WHERE id = $1`,
        [order.id]
      );
      return {
        status: "processed",
        orderId: order.id,
        claimId: order.claim_id,
        ok: false,
        error: "insufficient owls",
      };
    }
    await rawQuery(
      `UPDATE assessment_orders SET charge_entry_id = $2 WHERE id = $1`,
      [order.id, entryId]
    );
    order.charge_entry_id = entryId;
  }

  // The stake: the demand signal background priority reads. Idempotent per
  // order so a transient retry doesn't double-stake, and the composite
  // priority refreshes so the signal lands immediately (best-effort — the
  // scheduler's sweep catches any miss).
  await rawQuery(
    `INSERT INTO claim_stakes (claim_id, user_id, amount_micro_usd, source, order_id)
     SELECT $1, $2, $3, 'order', $4
      WHERE NOT EXISTS (SELECT 1 FROM claim_stakes WHERE order_id = $4)`,
    [order.claim_id, order.user_id, order.price_micro_usd, order.id]
  );
  await refreshQueuePriority(order.claim_id).catch(() => {});

  // A claim that was never stewarded needs its first full pass, not a
  // re-assessment — the order may arrive before the background lane ever
  // touched it (that's the point).
  const virgin = claimed[0]!.decomposition_status === "pending";
  const trigger = virgin ? "structure_and_assess" : "user_order";
  const context = virgin
    ? "A user ordered an assessment of this claim (paid). This is its first " +
      "Steward pass: structure and assess it."
    : "A user ordered a (re)assessment of this claim (paid). Re-examine the " +
      "evidence with fresh eyes and record a current assessment.";

  try {
    const { billedMicroUsd } = await runWithUsageContext(
      { userId: order.user_id, jobId: order.id },
      () =>
        withCostMeter(() =>
          runClaimSteward({ trigger, claimId: order.claim_id, context, model })
        )
    );

    // The quoted figure was a cap, not a price: return whatever the metered
    // cost-plus run didn't use. Ran over the cap? The overage is ours — the
    // buyer's ceiling holds. Idempotent per order, so a crash between here
    // and the status write can't double-credit on retry.
    await settleMeteredCharge({
      userId: order.user_id,
      capMicroUsd: Number(order.price_micro_usd),
      meteredMicroUsd: billedMicroUsd,
      settleKey: `order:${order.id}`,
      op: "assessment",
      claimId: order.claim_id,
    }).catch(() => {
      // A missed settlement favours the platform and must not fail the run.
    });

    await releaseClaim(order.claim_id, "done");
    await rawQuery(
      `UPDATE claims SET steward_error = NULL, steward_attempts = 0 WHERE id = $1`,
      [order.claim_id]
    );
    await rawQuery(
      `UPDATE assessment_orders
          SET status = 'done', completed_at = now(), error = NULL
        WHERE id = $1`,
      [order.id]
    );
    return { status: "processed", orderId: order.id, claimId: order.claim_id, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    if (err instanceof LlmBudgetExceededError || isTransientApiError(err)) {
      // Not the order's fault: requeue with the charge intact for the retry.
      await releaseClaim(order.claim_id, "pending");
      await requeueOrder(order.id);
      return {
        status: err instanceof LlmBudgetExceededError ? "budget" : "transient",
        orderId: order.id,
        claimId: order.claim_id,
        ok: false,
        error: msg,
      };
    }

    // Genuine failure: the user must not pay for it. Refund (idempotent per
    // order) and fail the order; the claim returns to the background queue.
    await releaseClaim(order.claim_id, "pending");
    await recordOwlEntry({
      userId: order.user_id,
      amountMicroUsd: Number(order.price_micro_usd),
      reason: OWL_REASONS.refund,
      op: "assessment",
      claimId: order.claim_id,
      idempotencyKey: `refund:order:${order.id}`,
    });
    await rawQuery(
      `UPDATE assessment_orders
          SET status = 'failed', completed_at = now(), error = $2
        WHERE id = $1`,
      [order.id, msg]
    );
    return {
      status: "processed",
      orderId: order.id,
      claimId: order.claim_id,
      ok: false,
      error: msg,
    };
  }
}

/** How many orders are waiting on the express lane. */
export async function pendingOrderCount(): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM assessment_orders WHERE status = 'pending'`
  );
  return row?.n ?? 0;
}
