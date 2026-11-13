import { describe, it, expect } from "vitest";
import {
  mandateHref,
  mandatePageView,
  orderTerms,
  paceWords,
  paragraphs,
  planRows,
  planTabOf,
  standingOf,
  workKindTabs,
} from "../../../web/lib/mandate-page";
import type { MandateDetailView } from "../../../web/lib/account-api";

// What the mandate page works out from what the API serves: which part of
// its lists an address asks for, how a plan's actions group and fold, and
// how a standing order's state reads.

type Item = MandateDetailView["plan_items"][number];
const item = (over: Partial<Item>): Item => ({ action: "assess", rationale: "r", state: "queued", ledger: null, ...over });
const ID = "m-1";

describe("the page's address", () => {
  it("reads the plain page as assessments, newest first, the open plan", () => {
    expect(mandatePageView({})).toEqual({
      work: "assessments", node: null, order: "recent", full: false, page: 1, plan: "open", planAll: false,
    });
  });

  it("ignores what it does not know", () => {
    const v = mandatePageView({ work: "everything", node: "argument", order: "oldest", wp: "-3", plan: "soon" });
    expect(v).toMatchObject({ work: "assessments", node: null, order: "recent", page: 1, plan: "open" });
  });

  it("opens the list to full pages on a later page", () => {
    expect(mandatePageView({ wp: "3" })).toMatchObject({ full: true, page: 3 });
    expect(mandatePageView({ all: "1" })).toMatchObject({ full: true, page: 1 });
  });

  it("leaves defaults out of an address and anchors it", () => {
    const v = mandatePageView({});
    expect(mandateHref(ID, v, {}, "completed")).toBe("/mandates/m-1#completed");
    expect(mandateHref(ID, v, { order: "importance" }, "completed")).toBe("/mandates/m-1?order=importance#completed");
  });

  it("starts a list again when what it lists changes, and keeps the other section's choice", () => {
    const v = mandatePageView({ wp: "3", node: "question", plan: "done" });
    expect(mandateHref(ID, v, { order: "importance" }, "completed")).toBe(
      "/mandates/m-1?node=question&order=importance&all=1&plan=done#completed"
    );
    expect(mandateHref(ID, v, { work: "sources" }, "completed")).toBe("/mandates/m-1?work=sources&plan=done#completed");
    expect(mandateHref(ID, v, { plan: "cancelled" }, "plan")).toBe("/mandates/m-1?node=question&wp=3&plan=cancelled#plan");
  });
});

describe("the kinds of completed work", () => {
  it("offers assessments always and another kind only where there is some", () => {
    const tabs = workKindTabs(
      { assessments: { nodes: 0, claims: 0, questions: 0, quantities: 0, passes: 0 }, sources: 4, requests: 0, research: 0, proposals: 2, findings: 9 },
      1
    );
    expect(tabs.map((t) => [t.key, t.count])).toEqual([["assessments", 0], ["sources", 4], ["proposals", 2], ["regrants", 1]]);
    expect(workKindTabs(null, 0).map((t) => t.key)).toEqual(["assessments"]);
  });
});

describe("the plan", () => {
  it("puts an action under waiting or running until it is done or cancelled", () => {
    expect(planTabOf(item({ state: "current" }))).toBe("open");
    expect(planTabOf(item({ state: "blocked" }))).toBe("open");
    expect(planTabOf(item({ state: "done" }))).toBe("done");
    expect(planTabOf(item({ state: "cancelled" }))).toBe("cancelled");
  });

  it("says how an unfinished action stands, and tells a platform fault from waiting on the pace", () => {
    expect(standingOf(item({ state: "current" }))).toBe("running");
    expect(standingOf(item({ state: "queued" }))).toBe("planned");
    expect(standingOf(item({ state: "blocked" }))).toBe("blocked");
    const ledger = (reason: string) => ({ status: "waiting" as const, reason, checked_at: "" });
    expect(standingOf(item({ state: "waiting", ledger: ledger("Waiting for room in the pace.") }))).toBe("waiting");
    expect(standingOf(item({ state: "waiting", ledger: ledger("Waiting on a platform fault: a provider is refusing calls.") }))).toBe("fault");
    expect(standingOf(item({ state: "done" }))).toBeNull();
  });

  it("gives a standing order's terms from the commission it placed, else from the plan", () => {
    expect(orderTerms(item({ variant: "strong", budget_owls: 14 }))).toBe("strong · up to 14 owls");
    expect(
      orderTerms(item({ variant: "standard", budget_owls: 4, ledger: { status: "running", checked_at: "", order: { tier: "strong", budget_owls: 6.5, placed_at: "" } } }))
    ).toBe("strong · up to 6.5 owls");
    expect(orderTerms(item({ action: "deepen", state: "blocked" }))).toBe("no tier named");
    expect(orderTerms(item({ action: "ingest", url: "u" }))).toBeNull();
  });

  it("folds identical sweeps and reads into one row with a count, and never folds passes on nodes", () => {
    const rows = planRows(
      [
        ...Array.from({ length: 27 }, () => item({ action: "sweep", partition: "t", rationale: "Never read by the Checker." })),
        item({ action: "sweep", partition: "t", rationale: "After the fresh passes." }),
        item({ action: "assess", claim_id: "a" }),
        item({ action: "assess", claim_id: "b" }),
        item({ action: "sweep", partition: "t", rationale: "Never read by the Checker.", state: "done" }),
      ],
      "open"
    );
    expect(rows.map((r) => [r.item.action, r.count])).toEqual([["sweep", 27], ["sweep", 1], ["assess", 1], ["assess", 1]]);
  });
});

describe("words", () => {
  it("splits prose at blank lines and names a pace", () => {
    expect(paragraphs("one\n\n  two \n\n\n")).toEqual(["one", "two"]);
    expect(paragraphs(null)).toEqual([]);
    expect(paceWords(60, 24)).toBe("60 owls a day");
    expect(paceWords(200, 168)).toBe("200 owls a week");
    expect(paceWords(40, 36)).toBe("40 owls every 36 hours");
  });
});
