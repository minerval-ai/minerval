import { describe, it, expect } from "vitest";
import { mandatesHref, mandatesView, rowAction, rowState, stateFilters } from "../../../web/lib/mandates-list";
import type { MandateListRow } from "../../../web/lib/account-api";

// What the Mandates list works out from its address, and how a row reads.

const row = (over: Partial<MandateListRow>): MandateListRow =>
  ({ id: "m-1", status: "active", budget_status: "running", ...over }) as MandateListRow;

describe("which list an address asks for", () => {
  it("opens everyone's to a reader with no mandates, and their own to one who has some", () => {
    expect(mandatesView({}, false).scope).toBe("all");
    expect(mandatesView({}, true, 0).scope).toBe("all");
    expect(mandatesView({}, true, 3).scope).toBe("mine");
    expect(mandatesView({ show: "all" }, true, 3).scope).toBe("all");
  });

  it("gives no one else's reader the manager's list or its narrowing", () => {
    const v = mandatesView({ show: "mine", state: "needs_you", order: "needs_you" }, false);
    expect(v).toMatchObject({ scope: "all", state: "any", order: null });
    expect(mandatesView({ show: "mine", state: "needs_you" }, true)).toMatchObject({ scope: "mine", state: "needs_you" });
  });

  it("ignores a state, an order and a page it does not know", () => {
    expect(mandatesView({ state: "secret", order: "luck", page: "0" }, false)).toMatchObject({
      state: "any", order: null, page: 1,
    });
  });
});

describe("the list's links", () => {
  const view = mandatesView({ show: "all", state: "finished", q: "oversight", page: "3" }, true);

  it("name the scope always, and start again from the first page when the list changes", () => {
    expect(mandatesHref(view, { page: 4 })).toBe("/mandates?show=all&state=finished&q=oversight&page=4");
    expect(mandatesHref(view, { order: "newest" })).toBe("/mandates?show=all&state=finished&q=oversight&order=newest");
  });

  it("drop the narrowing when whose mandates changes, and keep the words", () => {
    expect(mandatesHref(view, { scope: "mine" })).toBe("/mandates?show=mine&q=oversight");
  });

  it("offer the manager what needs them, and everyone else what is paused", () => {
    expect(stateFilters("mine").map(([s]) => s)).toContain("needs_you");
    expect(stateFilters("all").map(([s]) => s)).toEqual(["any", "active", "paused", "finished"]);
  });
});

describe("a row", () => {
  it("says a spent budget is a pause, and a cancelled mandate was withdrawn", () => {
    expect(rowState(row({ budget_status: "paused_budget" })).label).toBe("paused: budget spent");
    expect(rowState(row({ status: "cancelled" })).label).toBe("withdrawn");
    expect(rowState(row({ status: "pending_approval" })).label).toBe("plan to approve");
  });

  it("leads the manager to what waits on them, and anyone else to backing it", () => {
    expect(rowAction(row({ status: "pending_approval" }), true)).toMatchObject({ label: "Read and approve →", urgent: true });
    expect(rowAction(row({ budget_status: "paused_budget" }), true)).toMatchObject({ label: "Top up →", urgent: true });
    expect(rowAction(row({}), true)).toMatchObject({ href: "/mandates/m-1#grantmaker", urgent: false });
    expect(rowAction(row({}), false)).toMatchObject({ href: "/mandates/m-1#spending", label: "Back it →" });
    expect(rowAction(row({ status: "completed" }), false).label).toBe("Open →");
  });
});
