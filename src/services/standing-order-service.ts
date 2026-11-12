/**
 * Standing orders: how a mandate's plan pays for the Steward passes it names.
 *
 * An assess, reassess or deepen plan item used to open its node's rows on
 * the ledger and stop there. Nothing placed money on them, so the item read
 * "open" for weeks and ran only if someone else happened to commission the
 * node (#849). A plan item is now what its Grantmaker was told it is: an
 * order the mandate commissions (commission-service.ts), whole, at the
 * budget the item names or the row's estimate, on the tier the item names.
 *
 * What makes it a standing order is what happens when the money is not
 * there. A commission through the `commission` tool is now-or-refused: the
 * caller is in a turn and reads the refusal. A plan item has no turn to
 * come back in, so the materializer keeps asking: an order the day's rate
 * cannot cover yet reads `waiting` with the figures and is placed by the
 * first sweep that finds the room; one that could never fit (a budget above
 * the whole daily rate, or above what the escrow could hold even with every
 * running budget returned) reads `blocked` with the figures, because only
 * its author can change that. Every limit is money the Grantmaker can see
 * (the rate, the escrow) and is given back to it in the item's reason.
 */
import { rawQuery } from "../db/client.js";
import { ASSESS_GROUP, ensureAssessActions } from "./action-service.js";
import { commissionNodePass, liveNodeCommission, type CommissionTier } from "./commission-service.js";
import { grantEscrowBreakdown } from "./regrant-service.js";
import { enqueueSteward } from "./queue-service.js";
import { microUsdToOwls } from "./owl.js";
import { runAtMandateLabelOutsideAnyRun } from "./label-service.js";

/** Who placed it, on the allocation and in the mandate's commission list. */
export const PLAN_ORDER_COMMISSIONER = "plan";

/**
 * How often the scheduler ticks, and so looks again at standing orders that
 * are waiting (allocation-scheduler.ts), in minutes. A cadence, not a limit
 * on anyone: it is how long room that has opened can sit unused.
 */
export const STANDING_ORDER_RETRY_MINUTES = 15;

/** The tier an item's `variant` names. Strong when it names none: a plan
 * item has always bought the strong model, as a paid order does. */
export function orderTier(variant: unknown): CommissionTier {
  return variant === "standard" ? "standard" : "strong";
}

export type OrderStanding =
  /** Commissioned just now. */
  | { state: "placed"; actionId: string; budgetMicroUsd: number; tier: CommissionTier }
  /** The node's pass is already paid for or running, by this mandate or anyone. */
  | { state: "live"; actionId: string }
  /** Not placed yet; the next sweep asks again. `rate` when today's rate is what it waits on. */
  | { state: "waiting"; reason: string; rate: boolean }
  /** Cannot be placed until the plan's author changes something. */
  | { state: "blocked"; reason: string };

const RETRY =
  `It is a standing order: the scheduler asks again every ${STANDING_ORDER_RETRY_MINUTES} minutes ` +
  `and at the start of each review pass, and places it as soon as the room is there`;

/** The budget a pass on the node is estimated at, on the tier asked for (or standard, where no strong row exists). */
async function estimateMicroUsd(claimId: string, tier: CommissionTier): Promise<number> {
  await ensureAssessActions(claimId);
  const [row] = await rawQuery<{ cost: string }>(
    `SELECT cost_est_micro_usd AS cost FROM actions
      WHERE exclusion_group = $1 AND variant IN ('standard', 'strong')
      ORDER BY (variant = $2) DESC, (variant = 'standard') DESC
      LIMIT 1`,
    [ASSESS_GROUP(claimId), tier]
  );
  return Number(row?.cost ?? 0);
}

/**
 * Place (or find) the order for one node's pass, paid by the mandate. Safe
 * to call on every sweep: an order already placed, or a pass anyone else
 * already paid for, is found and left alone, and nothing is posted to the
 * node's inbox for it a second time.
 */
export async function placeStandingOrder(input: StandingOrderInput): Promise<OrderStanding> {
  // An order is placed by the scheduler's sweeps as well as from inside a
  // Grantmaker's run. It is the mandate's work, so from a sweep the pass is
  // ordered at the mandate's label (runAtMandateLabel in label-service.ts),
  // whatever the claim's is. From inside a run the order is that run's work
  // and keeps its label.
  return runAtMandateLabelOutsideAnyRun(input.grantId, () => placeOrder(input));
}

interface StandingOrderInput {
  grantId: string;
  claimId: string;
  tier: CommissionTier;
  /** The item's budget_owls, when it names one; else the row's estimate. */
  budgetMicroUsd?: number | null;
  /** What the Steward reads. Never the mandate or its reasons (§19). */
  brief: string;
}

async function placeOrder(input: StandingOrderInput): Promise<OrderStanding> {
  const owls = (micro: number) => microUsdToOwls(micro);
  const live = await liveNodeCommission(input.claimId);
  if (live) {
    // A commission can outlive the queue slot it was placed for (the
    // executor retires a group whose node is not queued and leaves the money
    // on it). Queue the node, once, so the money that is there runs.
    const [claim] = await rawQuery<{ steward_state: string }>(
      `SELECT steward_state FROM claims WHERE id = $1 AND state = 'active'`,
      [input.claimId]
    );
    if (claim && claim.steward_state !== "pending" && claim.steward_state !== "running") {
      await enqueueSteward({ claimId: input.claimId, trigger: "mandate_plan", context: input.brief, paid: true });
    }
    return { state: "live", actionId: live.action_id };
  }

  const [grant] = await rawQuery<{ daily: string; escrow: string; budget_job_id: string }>(
    `SELECT g.daily_budget_micro_usd AS daily, j.budget_micro_usd AS escrow, g.budget_job_id
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
    [input.grantId]
  );
  if (!grant) return { state: "blocked", reason: "the mandate could not be read" };
  const named = Math.round(Number(input.budgetMicroUsd ?? 0));
  const budget = named > 0 ? named : await estimateMicroUsd(input.claimId, input.tier);
  if (!(budget > 0)) return { state: "blocked", reason: "no pass on this node could be priced" };
  const what = named > 0 ? `the item's budget of ${owls(budget)} owls` : `the pass's estimate of ${owls(budget)} owls`;

  // A budget above the whole daily rate never fits, on any day.
  const daily = Number(grant.daily);
  if (daily > 0 && budget > daily) {
    return {
      state: "blocked",
      reason:
        `${what} is more than the mandate's whole daily rate (${owls(daily)} owls), so no day can ` +
        `cover it. Raise the rate (set_daily_rate) or give the item a smaller budget_owls` +
        (input.tier === "strong" ? ", or the standard variant" : ""),
    };
  }

  const res = await commissionNodePass({
    payer: { kind: "grant", grantId: input.grantId },
    claimId: input.claimId,
    budgetMicroUsd: budget,
    tier: input.tier,
    brief: input.brief,
    reason: "A plan item of the mandate.",
    commissionedBy: PLAN_ORDER_COMMISSIONER,
    ifLive: "leave",
  });
  if (res.ok) {
    return res.status === "commissioned"
      ? { state: "placed", actionId: res.actionId, budgetMicroUsd: res.budgetMicroUsd, tier: res.tier }
      : { state: "live", actionId: res.actionId };
  }
  if (res.code === "OVER_DAILY_RATE") {
    return { state: "waiting", rate: true, reason: `${res.message} ${RETRY}.` };
  }
  if (res.code === "OVER_ESCROW") {
    // Money held by running work comes back as it settles; what is spent,
    // regranted or held for prizes does not. Only the second is a block.
    const money = await grantEscrowBreakdown({ id: input.grantId, budgetJobId: grant.budget_job_id });
    const escrow = Number(grant.escrow);
    const free = Math.max(0, escrow - money.committed);
    const couldFree = Math.max(0, escrow - (money.committed - money.held));
    if (budget > couldFree) {
      return {
        state: "blocked",
        reason:
          `${what} is more than the escrow could cover even with every running budget returned ` +
          `(${owls(couldFree)} of ${owls(escrow)} owls are not spent, regranted or held for prizes). ` +
          `Give the item a smaller budget_owls` +
          (input.tier === "strong" ? " or the standard variant" : "") +
          `, or the mandate needs a top-up`,
      };
    }
    return {
      state: "waiting",
      rate: false,
      reason:
        `${what} is more than the escrow holds uncommitted now (${owls(free)} owls), with ` +
        `${owls(money.held)} owls held by work that is waiting or running, which returns what it ` +
        `does not spend. ${RETRY}.`,
    };
  }
  if (res.code === "PAYER_INACTIVE") {
    return {
      state: "waiting",
      rate: false,
      reason: "the mandate's escrow is not running (paused or closing), so it commissions nothing; the order is placed once it is",
    };
  }
  return { state: "blocked", reason: res.message };
}

/**
 * Take a standing order's money back off a node whose pass will not run on
 * it: the Steward parked the node, or the pass the item asked for ran on
 * another lane. Only the plan's own placement, only while unspent, and never
 * under a running row. Returns what was released, in micro-USD.
 */
export async function releaseStandingOrder(grantId: string, claimId: string): Promise<number> {
  const rows = await rawQuery<{ amount: string }>(
    `UPDATE action_allocations al SET released_at = now()
      WHERE al.grant_id = $1 AND al.exclusion_group = $2
        AND al.commissioned_by = $3
        AND al.released_at IS NULL AND al.spent_micro_usd = 0
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.exclusion_group = al.exclusion_group AND a.status = 'running')
      RETURNING al.amount_micro_usd AS amount`,
    [grantId, ASSESS_GROUP(claimId), PLAN_ORDER_COMMISSIONER]
  );
  return rows.reduce((s, r) => s + Number(r.amount), 0);
}

/** Shared across one plan's items in a sweep: once today's rate has turned an order away, later ones wait their turn. */
export interface OrderQueue {
  rateHeld: boolean;
}

export const HELD_BEHIND_EARLIER =
  "an earlier item of this plan is waiting for today's rate; standing orders are placed in plan " +
  "order, so this one is asked for once that one is placed";

/**
 * A deepen item's other half: a pass on each of the node's direct children
 * that is waiting for one (the stubs the item released, and any already
 * queued), most important first. One level, as the item says; how much
 * deeper to go is the Grantmaker's judgment on later passes. `already` is
 * the children this item has dealt with on earlier sweeps, so a child is
 * ordered once per item however often it is queued again.
 */
export async function orderChildPasses(input: {
  grantId: string;
  parentId: string;
  tier: CommissionTier;
  budgetMicroUsd?: number | null;
  already: readonly string[];
  queue: OrderQueue;
}): Promise<{ children: string[]; waiting: string | null; blocked: string | null }> {
  const children = [...input.already];
  const candidates = await rawQuery<{ id: string }>(
    `SELECT c.id FROM claims c
      WHERE c.state = 'active' AND c.steward_state = 'pending'
        AND c.id IN (SELECT child_claim_id FROM claim_relationships WHERE parent_claim_id = $1)
        AND NOT (c.id = ANY($2::uuid[]))
      ORDER BY c.importance DESC NULLS LAST, c.created_at ASC`,
    [input.parentId, children]
  );
  let left = candidates.length;
  for (const child of candidates) {
    if (input.queue.rateHeld) {
      return { children, waiting: `${left} of its children wait for today's rate. ${RETRY}.`, blocked: null };
    }
    const res = await placeStandingOrder({
      grantId: input.grantId,
      claimId: child.id,
      tier: input.tier,
      budgetMicroUsd: input.budgetMicroUsd,
      brief: "A funded mandate scheduled a pass on this claim.",
    });
    if (res.state === "waiting") {
      if (res.rate) input.queue.rateHeld = true;
      return { children, waiting: `${left} of its children are not commissioned yet: ${res.reason}`, blocked: null };
    }
    if (res.state === "blocked") {
      return { children, waiting: null, blocked: `${left} of its children cannot be commissioned: ${res.reason}` };
    }
    children.push(child.id);
    left--;
  }
  return { children, waiting: null, blocked: null };
}
