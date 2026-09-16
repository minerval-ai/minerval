/**
 * How a mandate's plan items read to people and agents: one state per item,
 * derived from the item's ledger standing (written by the plan-to-ledger
 * materializer, action-service.ts) rather than from its position against
 * the plan cursor. Position alone said "queued" for every non-ingest item
 * forever, whether or not any work existed for it (#416); the cursor still
 * drives ingest items, which execute in order from the mandate's escrow.
 *
 * States, in the dashboard's words:
 *  - done: the work ran (or a sibling won, or the claim already had what the
 *    item asked for);
 *  - current: the work is running now;
 *  - queued: a priced ledger row exists and awaits backing;
 *  - waiting: a precondition the platform satisfies on its own (a statement
 *    still to publish, an earlier attempt still live, a cooldown);
 *  - blocked: something the plan's author must change (the ledger reason
 *    says what);
 *  - cancelled: the row was retired (a claim left the graph, a statement was
 *    unpublished).
 */
import type { PlanItemLedger } from "./action-service.js";

export type PlanItemState =
  | "done"
  | "current"
  | "queued"
  | "waiting"
  | "blocked"
  | "cancelled";

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
  if (index < cursor) return "done";
  if (item.ledger) return FROM_LEDGER[item.ledger.status] ?? "queued";
  // Not yet materialized (a fresh append before its first sweep): the
  // positional reading, as before.
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
