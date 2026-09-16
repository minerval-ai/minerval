import { describe, it, expect } from "vitest";
import {
  planItemState,
  describePlanItems,
  countPlanItems,
  describePlanCounts,
} from "../../../src/services/plan-state.js";
import type { PlanItemLedger } from "../../../src/services/action-service.js";

// Plan item state is read from the item's ledger standing first and from
// its position against the cursor only when no standing exists (#416,
// #427): the cursor passing an item never makes unexecuted work "done",
// and a done row behind or ahead of the cursor reads done either way.

const at = "2026-09-12T00:00:00.000Z";
const ledger = (status: PlanItemLedger["status"], extra: Partial<PlanItemLedger> = {}): PlanItemLedger => ({
  status,
  checked_at: at,
  ...extra,
});

describe("planItemState", () => {
  it("reads the ledger standing whatever the cursor says", () => {
    // An ingest item the direct lane's cursor jump passed while its row
    // was still open: queued, not done.
    expect(planItemState({ action: "ingest", ledger: ledger("open") }, 0, 3)).toBe("queued");
    expect(planItemState({ action: "ingest", ledger: ledger("running") }, 0, 3)).toBe("current");
    expect(planItemState({ action: "ingest", ledger: ledger("cancelled") }, 0, 3)).toBe("cancelled");
    // A done assess row far ahead of the cursor: done.
    expect(planItemState({ action: "assess", ledger: ledger("done") }, 9, 0)).toBe("done");
    expect(planItemState({ action: "assess", ledger: ledger("waiting", { reason: "r" }) }, 9, 0)).toBe("waiting");
    expect(planItemState({ action: "formalize", ledger: ledger("blocked", { reason: "r" }) }, 9, 0)).toBe("blocked");
  });

  it("falls back to position only for an item with no standing yet", () => {
    expect(planItemState({ action: "assess" }, 0, 2)).toBe("done");
    expect(planItemState({ action: "ingest" }, 2, 2)).toBe("current");
    expect(planItemState({ action: "assess" }, 2, 2)).toBe("queued");
    expect(planItemState({ action: "ingest" }, 5, 2)).toBe("queued");
  });
});

describe("countPlanItems", () => {
  const items = [
    { action: "ingest", ledger: ledger("done") },
    { action: "ingest", ledger: ledger("open") },
    { action: "assess", ledger: ledger("done") },
    { action: "assess", ledger: ledger("running") },
    { action: "reassess", ledger: ledger("cancelled") },
    { action: "formalize", ledger: ledger("blocked", { reason: "no tool" }) },
    { action: "attempt_proof", ledger: ledger("waiting", { reason: "no statement" }) },
    { action: "assess" }, // appended after the last sweep
  ];

  it("counts done as the items whose work ran, not the cursor", () => {
    const counts = countPlanItems(items, 5);
    expect(counts.total).toBe(8);
    expect(counts.done).toBe(2);
    expect(counts.current).toBe(1);
    expect(counts.queued).toBe(2);
    expect(counts.cancelled).toBe(1);
    expect(counts.blocked).toBe(1);
    expect(counts.waiting).toBe(1);
    expect(describePlanItems(items, 5).map((i) => i.state)).toEqual([
      "done", "queued", "done", "current", "cancelled", "blocked", "waiting", "queued",
    ]);
  });

  it("describes the counts in one line, skipping empty states", () => {
    expect(describePlanCounts(countPlanItems(items, 5))).toBe(
      "8 items: 2 done, 1 in progress, 2 queued, 1 waiting, 1 blocked, 1 cancelled"
    );
    expect(describePlanCounts(countPlanItems([], 0))).toBe("0 items");
    expect(describePlanCounts(countPlanItems([{ action: "assess" }], 0))).toBe("1 item: 1 queued");
  });
});
