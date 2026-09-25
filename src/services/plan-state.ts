/**
 * How a mandate's plan items read to people and agents: one state per item,
 * derived from the item's ledger standing (written by the plan-to-ledger
 * materializer, action-service.ts) rather than from its position against
 * the plan cursor. Position alone said "queued" for every non-ingest item
 * forever, whether or not any work existed for it (#416), and "done" for
 * every item the cursor had passed, whether or not its work ran (#427).
 * The cursor still drives ingest items, which execute in order from the
 * mandate's escrow; it only speaks for an item that has no ledger
 * standing yet.
 *
 * States, in the dashboard's words:
 *  - done: the work ran (or a sibling won, or the claim already had what the
 *    item asked for, or the pass ran on another lane);
 *  - current: the work is running now;
 *  - queued: a priced ledger row exists and awaits backing;
 *  - waiting: a precondition the platform satisfies on its own (a statement
 *    still to publish, an earlier attempt still live, a cooldown);
 *  - blocked: something the plan's author must change (the ledger reason
 *    says what);
 *  - cancelled: the row was retired (a claim left the graph, a statement was
 *    unpublished) without its work running.
 */
import type { PlanItemLedger } from "./action-service.js";

export type PlanItemState =
  | "done"
  | "current"
  | "queued"
  | "waiting"
  | "blocked"
  | "cancelled";

export const PLAN_ITEM_STATES: readonly PlanItemState[] = [
  "done",
  "current",
  "queued",
  "waiting",
  "blocked",
  "cancelled",
];

export interface PlanItemLike {
  action: string;
  ledger?: PlanItemLedger;
}

const FROM_LEDGER: Record<PlanItemLedger["status"], PlanItemState> = {
  open: "queued",
  running: "current",
  done: "done",
  cancelled: "cancelled",
  waiting: "waiting",
  blocked: "blocked",
};

export function planItemState(
  item: PlanItemLike,
  index: number,
  cursor: number
): PlanItemState {
  // The ledger is the record of what ran: an ingest item the cursor passed
  // before its row closed (the direct steward lane moves the cursor past a
  // claim item and takes any ingest item before it along) still reads from
  // its row, so "done" means the work ran and nothing else.
  if (item.ledger) return FROM_LEDGER[item.ledger.status] ?? "queued";
  // Not yet materialized (a fresh append before its first sweep, or an item
  // executed before the ledger recorded plan work): the positional reading.
  if (index < cursor) return "done";
  return item.action === "ingest" && index === cursor ? "current" : "queued";
}

/** Every item with its state and its ledger standing (null before the first sweep). */
export function describePlanItems<T extends PlanItemLike>(
  items: readonly T[],
  cursor: number
): Array<T & { state: PlanItemState; ledger: PlanItemLedger | null }> {
  return items.map((item, i) => ({
    ...item,
    state: planItemState(item, i, cursor),
    ledger: item.ledger ?? null,
  }));
}

/** How many items sit in each state; `done` is the plan's executed count. */
export type PlanItemCounts = Record<PlanItemState, number> & { total: number };

export function countPlanItems(
  items: readonly PlanItemLike[],
  cursor: number
): PlanItemCounts {
  const counts = { total: items.length } as PlanItemCounts;
  for (const s of PLAN_ITEM_STATES) counts[s] = 0;
  items.forEach((item, i) => {
    counts[planItemState(item, i, cursor)]++;
  });
  return counts;
}

/** The counts as one line for a briefing: "31 items: 12 done, 3 in progress, …". */
export function describePlanCounts(counts: PlanItemCounts): string {
  const words: Record<PlanItemState, string> = {
    done: "done",
    current: "in progress",
    queued: "queued",
    waiting: "waiting",
    blocked: "blocked",
    cancelled: "cancelled",
  };
  const parts = PLAN_ITEM_STATES.filter((s) => counts[s] > 0).map(
    (s) => `${counts[s]} ${words[s]}`
  );
  return `${counts.total} item${counts.total === 1 ? "" : "s"}` +
    (parts.length > 0 ? `: ${parts.join(", ")}` : "");
}
