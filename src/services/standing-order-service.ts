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
 * come back in, so the materializer keeps asking: an order the pace (its
 * window, or the Grantmaker's reserve) cannot cover yet reads `waiting` with
 * the figures and is placed by the first sweep that finds the room; one that
 * could never fit (a budget above a steady pace's whole window, or above
 * what the escrow could hold even with every running budget returned) reads
 * `blocked` with the figures, because only its author can change that. Every
 * limit is money the Grantmaker can see (the pace, the reserve, the escrow)
 * and is given back to it in the item's reason.
 *
 * What the first day of this showed (#956, #961), and what follows from it:
 *
 *  - An order names its tier. An item written before items had to carried
 *    none and was commissioned on the strong tier, at several times the
 *    standard estimate, by a rule its Grantmaker had not chosen. An item
 *    written now is stored with its tier (standard when its author names
 *    none); a stored item that still names none commissions nothing until
 *    its Grantmaker gives it one (amend_plan_items), and says so.
 *  - An order the pace cannot cover does not hold the ones after it. Each
 *    look goes through the plan in order and places every order the room
 *    covers, so plan order is first claim on the room, never a queue with
 *    one head. A 5.9-owl order used to keep twenty-nine 0.8-owl ones
 *    waiting beside 1.2 owls of unused room.
 *  - A deepen item orders first assessments: the node's direct children
 *    that carry no judgment. A child that has one and is merely queued for
 *    a fresh look is left alone; a reassess item on it is that ask.
 *  - Until an order's pass is running, its Grantmaker can change its tier
 *    or budget or withdraw it (plan-amend-service.ts), and the budget it
 *    held comes back.
 */
import { rawQuery } from "../db/client.js";
import { ASSESS_GROUP, ensureAssessActions } from "./action-service.js";
import { slotColumnSql } from "./steward-lease.js";
import { commissionNodePass, liveNodeCommission, type CommissionTier } from "./commission-service.js";
import { stewardTierCostEstimates } from "./cost-estimate-service.js";
import { grantEscrowBreakdown } from "./regrant-service.js";
import { enqueueSteward } from "./queue-service.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { describePace, paceRoom, parsePace } from "./pace-service.js";
import { runAtMandateLabelOutsideAnyRun } from "./label-service.js";
import { importanceSql } from "./overlay-service.js";

/** Who placed it, on the allocation and in the mandate's commission list. */
export const PLAN_ORDER_COMMISSIONER = "plan";

/**
 * How often the scheduler ticks, and so looks again at standing orders that
 * are waiting (allocation-scheduler.ts), in minutes. A cadence, not a limit
 * on anyone: it is how long room that has opened can sit unused.
 */
export const STANDING_ORDER_RETRY_MINUTES = 15;

/** The tier an item written without a variant is stored with (normalizePlanItems). */
export const DEFAULT_ORDER_TIER: CommissionTier = "standard";

/**
 * The tier an item's `variant` names, or null when it names none. Every
 * item written now is stored with one, so null is an item from before
 * that: it is not commissioned on a tier nobody chose.
 */
export function orderTier(variant: unknown): CommissionTier | null {
  return variant === "standard" || variant === "strong" ? variant : null;
}

export type OrderStanding =
  /** Commissioned just now. */
  | { state: "placed"; actionId: string; budgetMicroUsd: number; tier: CommissionTier }
  /** The node's pass is already paid for or running, by this mandate or anyone. */
  | { state: "live"; actionId: string }
  /** Not placed yet; the next sweep asks again. `rate` when the pace is what it waits on. */
  | { state: "waiting"; reason: string; rate: boolean }
  /** Cannot be placed until the plan's author changes something. */
  | { state: "blocked"; reason: string };

const RETRY =
  `It is a standing order: the scheduler asks again every ${STANDING_ORDER_RETRY_MINUTES} minutes ` +
  `and at the start of each review pass, and places it as soon as the room is there`;

/** What a Grantmaker can do about an order that is not running yet, said on each one that waits. */
export const AMEND_HINT = "amend_plan_items changes this item's tier or budget, or withdraws it";

/**
 * Said on an order the pace cannot cover: it does not hold the plan.
 * A large order can be passed over, look after look, while smaller ones
 * after it take the room, so the reason says that too, and what moves it.
 */
const PASSED_OVER =
  "It does not hold the items after it: each look goes through the plan in order and places " +
  "every order the pace's room covers, so smaller orders after this one can be placed first, and " +
  "this one is placed by the first look that finds room for it whole";

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
 * Why an item that names no tier commissions nothing, with what each tier
 * would cost now, so the choice can be made from the item's own reason.
 * `passes` is the subject and verb: "its pass is", "their passes are".
 */
export async function unnamedTierReason(passes: string): Promise<string> {
  const est = await stewardTierCostEstimates();
  return (
    `this item names no variant, so ${passes} not commissioned. Items written before plan items ` +
    `stated their tier could leave it out and were commissioned on the strong tier; an order is ` +
    `now placed only on a tier its Grantmaker chose. Give it one with amend_plan_items: standard ` +
    `(a pass is estimated at ${microUsdToOwls(est.standardMicroUsd)} owls now) or strong ` +
    `(${microUsdToOwls(est.strongMicroUsd)} owls), with a budget_owls of your own if you want ` +
    `one, or withdraw it`
  );
}

/**
 * Shared across one plan's orders in one look. Once the pace has turned
 * an order away, the room it reported is kept here and counted down as
 * later orders are placed, so an order that plainly does not fit is told so
 * without another trip to the ledger, and one that does fit is still placed.
 */
export interface OrderQueue {
  /** What the pace has left for the plan, in micro-USD; null until an order has been turned away for it. */
  rateRoomMicroUsd: number | null;
}

export const newOrderQueue = (): OrderQueue => ({ rateRoomMicroUsd: null });

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
  /** The item's tier; null for an item that names none, which is found if live and otherwise not placed. */
  tier: CommissionTier | null;
  /** The item's budget_owls, when it names one; else the row's estimate. */
  budgetMicroUsd?: number | null;
  /** What the Steward reads. Never the mandate or its reasons (§19). */
  brief: string;
  /** The look this order is part of, when it is one of several. */
  queue?: OrderQueue;
}

async function placeOrder(input: StandingOrderInput): Promise<OrderStanding> {
  const owls = (micro: number) => microUsdToOwls(micro);
  const live = await liveNodeCommission(input.claimId);
  if (live) {
    // A commission can outlive the queue slot it was placed for (the
    // executor retires a group whose node is not queued and leaves the money
    // on it). Queue the node, once, so the money that is there runs.
    const [claim] = await rawQuery<{ steward_state: string }>(
      `SELECT ${slotColumnSql("steward_state", "c")} AS steward_state FROM claims c WHERE c.id = $1 AND c.state = 'active'`,
      [input.claimId]
    );
    if (claim && claim.steward_state !== "pending" && claim.steward_state !== "running") {
      await enqueueSteward({ claimId: input.claimId, trigger: "mandate_plan", context: input.brief, paid: true });
    }
    return { state: "live", actionId: live.action_id };
  }
  const tier = input.tier;
  if (!tier) return { state: "blocked", reason: await unnamedTierReason("its pass is") };

  const [grant] = await rawQuery<{ pace: unknown; escrow: string; budget_job_id: string }>(
    `SELECT g.pace, j.budget_micro_usd AS escrow, g.budget_job_id
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
    [input.grantId]
  );
  if (!grant) return { state: "blocked", reason: "the mandate could not be read" };
  const named = Math.round(Number(input.budgetMicroUsd ?? 0));
  const budget = named > 0 ? named : await estimateMicroUsd(input.claimId, tier);
  if (!(budget > 0)) return { state: "blocked", reason: "no pass on this node could be priced" };
  // The tier is in every reason: it is most of what the figure is.
  const what =
    named > 0
      ? `the item's budget of ${owls(budget)} owls (${tier} tier)`
      : `the ${tier} pass's estimate of ${owls(budget)} owls`;

  // A budget above a steady pace's whole window never fits, in any window.
  const pace = parsePace(grant.pace);
  if (pace.kind === "steady" && budget > owlsToMicroUsd(pace.owls)) {
    return {
      state: "blocked",
      reason:
        `${what} is more than the mandate's whole pace window (${pace.owls} owls per ${pace.period_hours} hours), ` +
        `so no window can cover it. Give the item a smaller budget_owls` +
        (tier === "strong" ? " or the standard variant" : "") +
        ` (amend_plan_items); the pace is the funder's to change`,
    };
  }
  // Under an as-needed pace only the Grantmaker's reserve can turn an
  // order away for the pace; under a steady one, the window or the reserve.
  const overRate = (roomMicroUsd: number): OrderStanding => ({
    state: "waiting",
    rate: true,
    reason:
      `${what} is more than the pace leaves for the plan now (` +
      (pace.kind === "steady"
        ? `${owls(roomMicroUsd)} of ${pace.owls} owls per ${pace.period_hours} hours, outside any reserve`
        : `${owls(roomMicroUsd)} owls outside the Grantmaker's reserve`) +
      `). Room returns as running work settles${pace.kind === "steady" ? " and as commitments age out of the window" : ""}, ` +
      `or when the Grantmaker lowers its reserve. ${RETRY}. ${PASSED_OVER}. ${AMEND_HINT}.`,
  });
  // The pace's room is known from an order turned away earlier in this look:
  // one that does not fit in it is not asked for again, one that does is.
  const queue = input.queue;
  if (queue && queue.rateRoomMicroUsd !== null && budget > queue.rateRoomMicroUsd) {
    return overRate(queue.rateRoomMicroUsd);
  }

  const res = await commissionNodePass({
    payer: { kind: "grant", grantId: input.grantId },
    claimId: input.claimId,
    budgetMicroUsd: budget,
    tier,
    brief: input.brief,
    reason: "A plan item of the mandate.",
    commissionedBy: PLAN_ORDER_COMMISSIONER,
    ifLive: "leave",
  });
  if (res.ok) {
    if (res.status !== "commissioned") return { state: "live", actionId: res.actionId };
    if (queue && queue.rateRoomMicroUsd !== null) {
      queue.rateRoomMicroUsd = Math.max(0, queue.rateRoomMicroUsd - res.budgetMicroUsd);
    }
    return { state: "placed", actionId: res.actionId, budgetMicroUsd: res.budgetMicroUsd, tier: res.tier };
  }
  if (res.code === "OVER_PACE") {
    // The window or the Grantmaker's reserve: either frees, the reserve when
    // the Grantmaker lowers it or commissions the order itself.
    const room = Math.max(0, Number(res.roomMicroUsd ?? 0));
    if (queue) queue.rateRoomMicroUsd = room;
    return overRate(room);
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
          (tier === "strong" ? " or the standard variant" : "") +
          ` (amend_plan_items), or the mandate needs a top-up`,
      };
    }
    return {
      state: "waiting",
      rate: false,
      reason:
        `${what} is more than the escrow holds uncommitted now (${owls(free)} owls), with ` +
        `${owls(money.held)} owls held by work that is waiting or running, which returns what it ` +
        `does not spend. ${RETRY}; items after it that the escrow does cover are placed without ` +
        `waiting for it. ${AMEND_HINT}.`,
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
 * it: the Steward parked the node, the pass the item asked for ran on
 * another lane, or the Grantmaker withdrew or re-tiered the item before its
 * pass began. Only the plan's own placement, only while unspent, and never
 * under a running row. Returns what was released, in micro-USD.
 */
export async function releaseStandingOrder(grantId: string, claimId: string): Promise<number> {
  const rows = await rawQuery<{ amount: string }>(
    `UPDATE minerval_whole.allocation_money al SET released_at = now()
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

/**
 * Whether a node carries a judgment of its kind: a claim's verdict, a
 * quantity's estimate, a question's standing. `c` is the claims alias.
 */
const ASSESSED_SQL = `(
     EXISTS (SELECT 1 FROM assessments_in_force x WHERE x.claim_id = c.id)
  OR EXISTS (SELECT 1 FROM quantity_estimates_in_force q WHERE q.claim_id = c.id)
  OR EXISTS (SELECT 1 FROM question_assessments_in_force qa WHERE qa.claim_id = c.id))`;

export interface DeepenChildren {
  /** No judgment yet, and queued or deferred (the item releases the deferred): the ones the item orders. */
  toOrder: string[];
  /** Judged already and queued for a fresh look: left alone. */
  assessedQueued: number;
}

/**
 * Which of a node's direct children a deepen item orders, read without
 * ordering anything: most important first. `already` leaves out the ones
 * the item has dealt with.
 */
export async function deepenChildren(parentId: string, already: readonly string[] = []): Promise<DeepenChildren> {
  const rows = await rawQuery<{ id: string; assessed: boolean }>(
    `SELECT c.id, ${ASSESSED_SQL} AS assessed FROM claims c
      WHERE c.state = 'active' AND ${slotColumnSql("steward_state", "c")} IN ('pending', 'deferred')
        AND c.id IN (SELECT child_claim_id FROM claim_relationships WHERE parent_claim_id = $1)
        AND NOT (c.id = ANY($2::uuid[]))
      ORDER BY ${importanceSql("c")} DESC NULLS LAST, c.created_at ASC`,
    [parentId, [...already]]
  );
  return {
    toOrder: rows.filter((r) => !r.assessed).map((r) => r.id),
    assessedQueued: rows.filter((r) => r.assessed).length,
  };
}

export const leftAssessedNote = (n: number): string =>
  `${n} of its children already carr${n === 1 ? "ies" : "y"} an assessment and ` +
  `${n === 1 ? "is" : "are"} queued for a fresh look; a deepen item orders first assessments only, ` +
  `so ${n === 1 ? "it was" : "they were"} left as ${n === 1 ? "it is" : "they are"} (a reassess ` +
  `item on a child is the ask for a fresh pass on it)`;

const nameIds = (ids: readonly string[]) =>
  ids.length <= 8 ? ids.join(", ") : `${ids.slice(0, 8).join(", ")} and ${ids.length - 8} more`;

/**
 * A deepen item's other half: a first assessment for each of the node's
 * direct children that has none and is queued for a pass (the stubs the
 * item released, and any already queued), most important first, on the
 * item's tier and budget. A child that already carries an assessment is
 * not ordered a fresh one because something queued it (#961: week-old
 * verdicts with an open reassess row were bought strong re-passes); that
 * is what a reassess item is for. One level, as the item says; how much
 * deeper to go is the Grantmaker's judgment on later passes. `already` is
 * the children this item has dealt with on earlier sweeps, so a child is
 * ordered once per item. A child the day or the escrow cannot cover does
 * not hold its siblings: every child is asked for, and the ones not
 * commissioned are named.
 */
export async function orderChildPasses(input: {
  grantId: string;
  parentId: string;
  tier: CommissionTier | null;
  budgetMicroUsd?: number | null;
  already: readonly string[];
  queue: OrderQueue;
}): Promise<{
  /** Dealt with: ordered by this item, or found already paid for. */
  children: string[];
  /** Unassessed children not commissioned yet, in the order they are asked for. */
  notOrdered: string[];
  waiting: string | null;
  blocked: string | null;
  /** Said whenever assessed children were left alone, whatever else is true. */
  note: string | null;
}> {
  const children = [...input.already];
  const found = await deepenChildren(input.parentId, children);
  const note = found.assessedQueued > 0 ? leftAssessedNote(found.assessedQueued) : null;
  const waitingIds: string[] = [];
  const blockedIds: string[] = [];
  let waitingWhy = "";
  let blockedWhy = "";
  for (const id of found.toOrder) {
    const res = await placeStandingOrder({
      grantId: input.grantId,
      claimId: id,
      tier: input.tier,
      budgetMicroUsd: input.budgetMicroUsd,
      brief: "A funded mandate scheduled a pass on this claim.",
      queue: input.queue,
    });
    if (res.state === "waiting") {
      waitingIds.push(id);
      waitingWhy ||= res.reason;
    } else if (res.state === "blocked") {
      blockedIds.push(id);
      // An item that names no tier says so once, for all its children.
      blockedWhy ||= input.tier ? res.reason : await unnamedTierReason("their passes are");
    } else {
      children.push(id);
    }
  }
  const count = (ids: string[]) =>
    `${ids.length} of its unassessed children ${ids.length === 1 ? "is" : "are"}`;
  return {
    children,
    notOrdered: [...waitingIds, ...blockedIds],
    waiting:
      waitingIds.length > 0
        ? `${count(waitingIds)} not commissioned yet (${nameIds(waitingIds)}): ${waitingWhy}`
        : null,
    blocked:
      blockedIds.length > 0
        ? `${count(blockedIds)} not commissioned (${nameIds(blockedIds)}): ${blockedWhy}`
        : null,
    note,
  };
}

/** One stewarding item, as a preview reads it. */
export interface PreviewItem {
  action: string;
  claim_id?: string;
  claim_ref?: string;
  variant?: string;
  budget_owls?: number;
}

export interface OrderPreview {
  action: string;
  claim_id?: string;
  tier?: CommissionTier;
  /** The budget of each pass the item would commission, and where the figure comes from. */
  budget_owls_per_pass?: number;
  budget_from?: "budget_owls" | "estimate";
  /** What would happen to the node's own pass. */
  node: string;
  /** deepen only. */
  children?: { would_order: string[]; assessed_left_alone: number; note: string };
  /** What the item would hold against the pace and the escrow if all of it were placed now. */
  would_hold_owls: number;
}

/**
 * What a list of items would commission, before any of it is written to
 * the plan: each stewarding item's tier and budget per pass, whether the
 * node's pass would be bought or is already met, and for a deepen item the
 * children it would order by id, with the total against the pace's room and
 * the escrow. Reads only; nothing is placed, released or queued.
 */
export async function previewPlanOrders(
  grantId: string,
  items: readonly PreviewItem[]
): Promise<{
  items: OrderPreview[];
  total_would_hold_owls: number;
  pace: { pace: string; room_owls: number | null };
  escrow_uncommitted_owls: number;
  note: string;
}> {
  const est = await stewardTierCostEstimates();
  const [grant] = await rawQuery<{ pace: unknown; escrow: string; budget_job_id: string }>(
    `SELECT g.pace, j.budget_micro_usd AS escrow, g.budget_job_id
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id WHERE g.id = $1`,
    [grantId]
  );
  // What the plan's orders may commit now: they are not the Grantmaker's
  // own, so the reserve is not theirs (pace-service.ts).
  const room = grant ? await paceRoom(grantId, "delegated") : null;
  const money = grant
    ? await grantEscrowBreakdown({ id: grantId, budgetJobId: grant.budget_job_id })
    : { committed: 0 };
  const out: OrderPreview[] = [];
  let total = 0;
  for (const it of items) {
    if (it.action !== "assess" && it.action !== "reassess" && it.action !== "deepen") continue;
    const tier = orderTier(it.variant) ?? DEFAULT_ORDER_TIER;
    const named = Number(it.budget_owls) > 0;
    const perPass = named
      ? Math.round(Number(it.budget_owls) * 1_000_000) / 1_000_000
      : microUsdToOwls(tier === "strong" ? est.strongMicroUsd : est.standardMicroUsd);
    const base = {
      action: it.action,
      tier,
      budget_owls_per_pass: perPass,
      budget_from: named ? ("budget_owls" as const) : ("estimate" as const),
    };
    if (!it.claim_id) {
      out.push({
        ...base,
        node: `not a node yet (claim_ref ${it.claim_ref ?? "?"}): commissioned once the proposal is accepted`,
        would_hold_owls: perPass,
      });
      total += perPass;
      continue;
    }
    const [claim] = await rawQuery<{ state: string; assessed: boolean }>(
      `SELECT c.state, ${ASSESSED_SQL} AS assessed FROM claims c WHERE c.id = $1`,
      [it.claim_id]
    );
    if (!claim || claim.state !== "active") {
      out.push({
        ...base,
        claim_id: it.claim_id,
        node: claim ? `the node is ${claim.state}, not active: the item would read blocked` : "no node has that id: the item would read blocked",
        would_hold_owls: 0,
      });
      continue;
    }
    let passes = 1;
    let node = `one ${tier} pass would be commissioned at ${perPass} owls`;
    if (it.action === "assess" && claim.assessed) {
      passes = 0;
      node = "the node already carries an assessment: an assess item reads done and commissions nothing (reassess is the ask for a fresh pass)";
    } else if (await liveNodeCommission(it.claim_id)) {
      passes = 0;
      node = "a pass on this node is already paid for or running: the item is met when it finishes, at no cost";
    }
    let children: OrderPreview["children"];
    if (it.action === "deepen") {
      const kids = await deepenChildren(it.claim_id);
      passes += kids.toOrder.length;
      children = {
        would_order: kids.toOrder,
        assessed_left_alone: kids.assessedQueued,
        note:
          `One ${tier} pass at ${perPass} owls on each child listed (its direct children that carry no ` +
          `assessment and are queued or deferred), and on any such child the node's own pass mints. ` +
          (kids.assessedQueued > 0 ? `${leftAssessedNote(kids.assessedQueued)}.` : "No assessed child is ordered a fresh pass."),
      };
    }
    const hold = Math.round(passes * perPass * 1_000_000) / 1_000_000;
    total += hold;
    out.push({ ...base, claim_id: it.claim_id, node, ...(children ? { children } : {}), would_hold_owls: hold });
  }
  return {
    items: out,
    total_would_hold_owls: Math.round(total * 1_000_000) / 1_000_000,
    pace: {
      pace: describePace(parsePace(grant?.pace)),
      room_owls: room ? microUsdToOwls(room.availableMicroUsd) : null,
    },
    escrow_uncommitted_owls: microUsdToOwls(Math.max(0, Number(grant?.escrow ?? 0) - money.committed)),
    note:
      "A preview: nothing was added to the plan or commissioned. Each order is placed whole when " +
      "the pace's room (outside the reserve) and the escrow cover it, earlier items of the plan first; one that does not " +
      "fit waits without holding the ones after it. Budgets are ceilings: a pass returns what it " +
      "does not spend. Estimates are the ledger's current figures and move.",
  };
}
