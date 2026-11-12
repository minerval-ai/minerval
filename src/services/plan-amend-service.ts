/**
 * Changing or withdrawing a standing order after it is written (#956).
 *
 * A plan item was append-only: `extend_plan` adds, and `adjust_plan`
 * replaces only what follows the plan's started prefix, in the funder's
 * conversation. So a Grantmaker whose review pass found an old item about
 * to commission a strong pass it would not have chosen could not re-tier
 * it, shrink it or drop it; it raised the daily rate for a few minutes and
 * bought throwaway standard passes on the same nodes so the items would be
 * met. This is the tool it lacked.
 *
 * The contract, stated to the agent in the same words (AMEND_PLAN_ITEMS):
 * an item's work has STARTED once its pass is running. Until then, whether
 * the order is waiting for room, blocked, or placed and waiting its turn in
 * the queue, and wherever the item sits in the plan, its Grantmaker may
 * change its tier or budget or withdraw it. A budget the order already
 * holds comes straight back to the escrow and the day's room, and an
 * amended order is asked for again on its new terms in the same call. A
 * pass that is running or has run is left exactly as it is: money being
 * spent is not taken from under a run. A deepen item is several passes, so
 * the rule applies to each: a change reaches every pass of the item that
 * has not started.
 *
 * No count bounds any of this. What an amended order may hold is bounded
 * where every order is: by the day's rate and the escrow.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  materializePlanItems,
  type MaterializablePlanItem,
  type PlanItemLedger,
  type PlanItemOutcome,
} from "./action-service.js";
import { microUsdToOwls } from "./owl.js";
import { orderTier, releaseStandingOrder } from "./standing-order-service.js";

export interface PlanItemChange {
  /** The item's position in the plan, as extend_plan's result and grant_overview give it. */
  index: number;
  /** The node the item is on: checked, so a plan rewritten since it was read is not changed by position. */
  claim_id?: string;
  variant?: string;
  /** A number of owls per pass, or null for the pass's estimate on the item's tier. */
  budget_owls?: number | null;
  withdraw?: boolean;
}

export type AmendResult =
  | {
      ok: true;
      items: Array<{
        index: number;
        action: string;
        claim_id?: string;
        change: string;
        variant?: string;
        budget_owls?: number | null;
        ledger: PlanItemLedger | null;
      }>;
      /** Budget the changed items held and no longer hold, before any re-placement. */
      returned_owls: number;
      note?: string;
    }
  | { ok: false; problem: string };

const STEWARDING = new Set(["assess", "reassess", "deepen"]);

const a = (action: string) => `${/^[aeiou]/.test(action) ? "an" : "a"} ${action}`;

/** Why a change to this item is refused, or null when it can be made. */
function refusal(item: MaterializablePlanItem | undefined, c: PlanItemChange, total: number): string | null {
  const at = `item ${c.index}`;
  if (!item) return `${at}: the plan has ${total} item${total === 1 ? "" : "s"}, numbered from 0; read grant_overview for each item's index`;
  if (!STEWARDING.has(item.action)) {
    return (
      `${at} is ${a(item.action)} item. amend_plan_items changes standing orders (assess, reassess, deepen): ` +
      `they are the items that name a tier and a budget and hold a commission. Other kinds are replaced ` +
      `with the unstarted remainder of the plan by adjust_plan, in the funder's conversation`
    );
  }
  if (item.claim_id && c.claim_id !== item.claim_id) {
    return (
      `${at} is ${a(item.action)} item on node ${item.claim_id}` +
      (c.claim_id ? `, not ${c.claim_id}` : `; give its claim_id with the index`) +
      `. The check is there so a plan rewritten since you read it is not changed by position: ` +
      `read grant_overview and name the item by both`
    );
  }
  if (item.withdrawn) return `${at} was already withdrawn on ${String(item.withdrawn.at).slice(0, 10)}`;
  const status = item.ledger?.status;
  if (status === "done") {
    return `${at} is done: its pass has run, so there is nothing left of it to change. Another pass on the node is another item`;
  }
  // A deepen item whose node's pass is running or has run still has its
  // children's passes to place, and those can change.
  if (status === "running" && item.action !== "deepen") {
    return (
      `${at}: its pass is running, so its work has started. A running pass works to the budget it was ` +
      `told and settles to what it spends; it cannot be re-tiered or withdrawn`
    );
  }
  if (c.withdraw) {
    if (c.variant !== undefined || c.budget_owls !== undefined) {
      return `${at}: give withdraw, or a new variant and/or budget_owls, not both`;
    }
    return null;
  }
  if (c.variant === undefined && c.budget_owls === undefined) {
    return `${at}: say what to change: variant, budget_owls, or withdraw: true`;
  }
  if (c.variant !== undefined && !orderTier(c.variant)) {
    return `${at}: variant is standard or strong (got: ${String(c.variant)})`;
  }
  if (
    c.budget_owls !== undefined && c.budget_owls !== null &&
    !(typeof c.budget_owls === "number" && Number.isFinite(c.budget_owls) && c.budget_owls > 0)
  ) {
    return `${at}: budget_owls is a number of owls above zero, or null for the pass's estimate on the item's tier (got: ${String(c.budget_owls)})`;
  }
  if (!orderTier(c.variant ?? item.variant)) {
    return `${at} names no variant yet: give one (standard or strong) with this change, since nothing is commissioned on a tier nobody chose`;
  }
  return null;
}

/**
 * Take back what an item placed and has not started, when its terms change:
 * the node's own order, and the orders on the children it placed. Returns
 * the money released and the item's ledger with those placements forgotten,
 * so the materializer asks for them again on the new terms. A child another
 * item of the plan ordered in its own right keeps that order.
 */
export async function releaseUnstartedOrders(
  grantId: string,
  index: number,
  items: readonly MaterializablePlanItem[]
): Promise<{ releasedMicroUsd: number; ledger: PlanItemLedger | undefined }> {
  const item = items[index]!;
  const prior = item.ledger;
  if (!prior || !item.claim_id) return { releasedMicroUsd: 0, ledger: prior };
  let released = 0;
  let ledger: PlanItemLedger = prior;
  if (prior.order && !prior.ran_at) {
    const back = await releaseStandingOrder(grantId, item.claim_id);
    if (back > 0) {
      released += back;
      // The order is gone: the item reads as not yet placed until the
      // materializer, called next, places it again.
      const { order: _o, action_id: _a, exclusion_group: _g, reason: _r, ...rest } = prior;
      ledger = { ...rest, status: "waiting", reason: "amended; its order is being placed on the new terms", checked_at: new Date().toISOString() };
    }
  }
  const kept: string[] = [];
  for (const child of prior.children ?? []) {
    const theirs = items.some(
      (other, j) => j !== index && other.claim_id === child && !other.withdrawn && other.ledger?.order
    );
    const back = theirs ? 0 : await releaseStandingOrder(grantId, child);
    released += back;
    // A child whose order was released is asked for again; the rest (its
    // pass running or run, or paid for by someone else) stay dealt with.
    if (back === 0) kept.push(child);
  }
  if ((prior.children?.length ?? 0) !== kept.length) {
    const { children: _c, ...rest } = ledger;
    ledger = { ...rest, ...(kept.length > 0 ? { children: kept } : {}) };
  }
  return { releasedMicroUsd: released, ledger };
}

/**
 * Change the tier or budget of standing orders that have not started, or
 * withdraw them. All of the changes are checked first and none is made if
 * one is refused, so the caller reads one answer. The plan is materialized
 * in the same call: an amended order is placed again on its new terms if
 * the room is there, and each item's standing comes back.
 */
export async function amendPlanItems(input: {
  grantId: string;
  changes: readonly PlanItemChange[];
  note: string;
}): Promise<AmendResult> {
  const note = String(input.note ?? "").trim();
  if (!note) return { ok: false, problem: "note required: one sentence on why, kept with each item changed" };
  const changes = input.changes;
  if (!Array.isArray(changes) || changes.length === 0) return { ok: false, problem: "no changes given" };
  const seen = new Set<number>();
  for (const c of changes) {
    if (!c || typeof c !== "object" || !Number.isInteger(c.index) || c.index < 0) {
      return { ok: false, problem: "each change needs an index: the item's position in the plan, from 0" };
    }
    if (seen.has(c.index)) return { ok: false, problem: `item ${c.index} is named twice: one change per item` };
    seen.add(c.index);
  }

  const [grant] = await rawQuery<{ status: string; plan: { items?: MaterializablePlanItem[] } | null }>(
    `SELECT status, plan FROM grants WHERE id = $1`,
    [input.grantId]
  );
  if (!grant) return { ok: false, problem: "the mandate could not be read" };
  if (grant.status !== "active") {
    return { ok: false, problem: `the mandate is ${grant.status}, not active; its plan can no longer be amended` };
  }
  const items = grant.plan?.items ?? [];
  const problems = changes
    .map((c) => refusal(items[c.index], c, items.length))
    .filter((p): p is string => Boolean(p));
  if (problems.length > 0) {
    return { ok: false, problem: `nothing was changed. ${problems.join(". ")}.` };
  }

  const at = new Date().toISOString();
  const owl = loadConfig().owlCostMicroUsd;
  let returned = 0;
  const said = new Map<number, string>();
  const raced: number[] = [];
  for (const c of changes) {
    const item = items[c.index]!;
    const patch: Record<string, unknown> = {};
    let drop: string[] = [];
    let change: string;
    if (c.withdraw) {
      patch.withdrawn = { at, note };
      change = "withdrawn";
    } else {
      const tier = orderTier(c.variant ?? item.variant)!;
      const budget = c.budget_owls === undefined ? item.budget_owls : c.budget_owls;
      patch.variant = tier;
      if (typeof budget === "number" && budget > 0) patch.budget_owls = budget;
      else drop = ["budget_owls"];
      patch.amended = { at, note };
      const same =
        tier === orderTier(item.variant) &&
        (Number(item.budget_owls) > 0 ? Number(item.budget_owls) : null) ===
          (typeof budget === "number" && budget > 0 ? budget : null);
      change = same
        ? "unchanged: it already has that tier and budget"
        : `now ${tier}, ` +
          (typeof budget === "number" && budget > 0 ? `${budget} owls a pass` : "at the pass's estimate");
      if (same) {
        said.set(c.index, change);
        continue;
      }
    }
    // The item at that position must still be the one that was checked: an
    // adjust_plan in the funder's conversation can replace the remainder.
    const written = await rawQuery<{ id: string }>(
      `UPDATE grants
          SET plan = jsonb_set(plan, $2::text[], ((plan->'items'->$3::int) - $6::text[]) || $7::jsonb),
              updated_at = now()
        WHERE id = $1 AND status = 'active'
          AND plan->'items'->$3::int->>'action' = $4
          AND COALESCE(plan->'items'->$3::int->>'claim_id', '') = $5
          AND plan->'items'->$3::int->'withdrawn' IS NULL
        RETURNING id`,
      [input.grantId, ["items", String(c.index)], c.index, item.action, item.claim_id ?? "", drop, JSON.stringify(patch)]
    );
    if (written.length === 0) {
      raced.push(c.index);
      continue;
    }
    said.set(c.index, change);
    // What the item placed and has not started comes back now. An amended
    // item reads as not yet placed, and the materializer below asks for its
    // order again on the new terms; a withdrawn item's standing is written
    // by the materializer, which is told what came back.
    const res = await releaseUnstartedOrders(input.grantId, c.index, items);
    returned += res.releasedMicroUsd;
    if (c.withdraw) {
      if (res.releasedMicroUsd > 0) {
        await rawQuery(
          `UPDATE grants SET plan = jsonb_set(plan, $2::text[], to_jsonb($3::numeric))
            WHERE id = $1 AND plan->'items'->$4::int->'withdrawn' IS NOT NULL`,
          [input.grantId, ["items", String(c.index), "withdrawn", "returned_owls"], res.releasedMicroUsd / owl, c.index]
        );
      }
    } else if (res.ledger && res.ledger !== item.ledger) {
      await rawQuery(
        `UPDATE grants SET plan = jsonb_set(plan, $2::text[], $3::jsonb)
          WHERE id = $1 AND plan->'items'->$4::int->>'action' = $5`,
        [input.grantId, ["items", String(c.index), "ledger"], JSON.stringify(res.ledger), c.index, item.action]
      );
    }
  }

  let outcomes: PlanItemOutcome[] = [];
  let materializeProblem: string | null = null;
  try {
    outcomes = await materializePlanItems(input.grantId, [...said.keys()]);
  } catch (err) {
    materializeProblem = err instanceof Error ? err.message : String(err);
  }
  const byIndex = new Map(outcomes.map((o) => [o.index, o]));
  const [after] = await rawQuery<{ plan: { items?: MaterializablePlanItem[] } | null }>(
    `SELECT plan FROM grants WHERE id = $1`,
    [input.grantId]
  );
  const now = after?.plan?.items ?? [];
  const notes: string[] = [];
  if (raced.length > 0) {
    notes.push(
      `item${raced.length === 1 ? "" : "s"} ${raced.join(", ")} changed under this call (the plan was ` +
        `rewritten or the item withdrawn meanwhile) and ${raced.length === 1 ? "was" : "were"} left alone: read grant_overview`
    );
  }
  if (materializeProblem) {
    notes.push(
      `changed, but not yet materialized onto the ledger: ${materializeProblem}. The sweep retries on its ` +
        `cadence; grant_overview shows each item's standing`
    );
  }
  return {
    ok: true,
    items: [...said.entries()].map(([index, change]) => {
      const item = now[index] ?? items[index]!;
      return {
        index,
        action: item.action,
        ...(item.claim_id ? { claim_id: item.claim_id } : {}),
        change,
        ...(item.withdrawn ? {} : { variant: item.variant, budget_owls: item.budget_owls ?? null }),
        ledger: byIndex.get(index)?.ledger ?? item.ledger ?? null,
      };
    }),
    returned_owls: microUsdToOwls(returned),
    ...(notes.length > 0 ? { note: notes.join(". ") + "." } : {}),
  };
}
