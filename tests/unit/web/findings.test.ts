import { describe, it, expect } from "vitest";

// The findings pages' logic (web/lib/findings.ts): what the index's URL
// says, how a filter changes it, which agents are one role, and how an
// account's links are numbered for the margin.
import {
  agentsOfRole,
  findingsHref,
  firstParagraph,
  hasFilters,
  numberAccount,
  orderInForce,
  parseFindingsView,
  rolesOf,
} from "../../../web/lib/findings";

describe("the index's view", () => {
  it("reads the filters from the URL and drops what it cannot use", () => {
    const view = parseFindingsView({
      q: "  abstainer bias ", tag: "cardiology", min: "6", by: "claim-steward",
      stands: "doubtful", days: "30", order: "importance", page: "3",
    });
    expect(view).toEqual({
      q: "abstainer bias", tag: "cardiology", min: 6, by: "claim-steward",
      stands: "doubtful", days: 30, order: "importance", page: 3,
    });
    const bad = parseFindingsView({ min: "11", days: "5", order: "sideways", page: "0", q: " " });
    expect(bad).toEqual({
      q: null, tag: null, min: null, by: null, stands: null, days: null, order: null, page: 1,
    });
    expect(hasFilters(bad)).toBe(false);
  });

  it("orders a search closest first and everything else newest first, unless asked", () => {
    expect(orderInForce(parseFindingsView({}))).toBe("recent");
    expect(orderInForce(parseFindingsView({ q: "sodium" }))).toBe("relevance");
    expect(orderInForce(parseFindingsView({ q: "sodium", order: "recent" }))).toBe("recent");
    // Closest-first means nothing without a search.
    expect(orderInForce(parseFindingsView({ order: "relevance" }))).toBe("recent");
  });

  it("builds the link for a changed filter, back on the first page, defaults left out", () => {
    const view = parseFindingsView({ tag: "cardiology", page: "2" });
    expect(findingsHref(view)).toBe("/findings?tag=cardiology");
    expect(findingsHref(view, { page: 2 })).toBe("/findings?tag=cardiology&page=2");
    expect(findingsHref(view, { min: 7 })).toBe("/findings?tag=cardiology&min=7");
    expect(findingsHref(view, { tag: null })).toBe("/findings");
    expect(findingsHref(view, { order: "recent" })).toBe("/findings?tag=cardiology");
    expect(findingsHref(view, { order: "importance" })).toBe("/findings?tag=cardiology&order=importance");
    const searching = parseFindingsView({ q: "sodium" });
    expect(findingsHref(searching, { order: "relevance" })).toBe("/findings?q=sodium");
    expect(findingsHref(searching, { order: "recent" })).toBe("/findings?q=sodium&order=recent");
  });
});

describe("roles", () => {
  it("gathers the names a role has had into one choice", () => {
    const roles = rolesOf([
      { agent: "steward", count: 4 },
      { agent: "grantmaker", count: 6 },
      { agent: "claim_steward", count: 3 },
      { agent: "solver", count: 1 },
    ]);
    expect(roles.map((r) => [r.slug, r.label, r.count])).toEqual([
      ["claim-steward", "Claim Steward", 7],
      ["grantmaker", "Grantmaker", 6],
      ["solver", "solver", 1],
    ]);
    expect(roles[0]!.agents).toEqual(["steward", "claim_steward"]);
  });

  it("names every agent of a role for the API, and an unknown one as itself", () => {
    expect(agentsOfRole("claim-steward")).toEqual(["steward", "claim_steward"]);
    expect(agentsOfRole("grantmaker")).toEqual(["grantmaker", "mandate_review"]);
    expect(agentsOfRole("question-steward")).toEqual(["question_steward"]);
  });
});

describe("an account", () => {
  const C1 = "11111111-1111-4111-8111-111111111111";
  const C2 = "22222222-2222-4222-8222-222222222222";
  const S1 = "33333333-3333-4333-8333-333333333333";

  it("gives the index its first paragraph", () => {
    expect(firstParagraph("One.\n\nTwo.")).toBe("One.");
    expect(firstParagraph("")).toBe("");
  });

  it("numbers what it links to in order of first mention, one card each", () => {
    const { paragraphs, targets } = numberAccount(
      `The record on [[claim:${C1}|the first claim]] cites [[source:${S1}|a paper]].\n\n` +
        `Again [[claim:${C1}|that claim]], and [[claim:${C2}]]; see https://example.com/x.`
    );
    expect(targets).toEqual([
      { kind: "claim", id: C1 },
      { kind: "source", id: S1 },
      { kind: "claim", id: C2 },
    ]);
    expect(paragraphs.map((p) => p.notes)).toEqual([[1, 2], [3]]);
    const second = paragraphs[1]!.segments;
    expect(second[1]).toEqual({
      kind: "ref", n: 1, target: { kind: "claim", id: C1 }, href: `/claims/${C1}`, display: "that claim",
    });
    expect(second.find((s) => s.kind === "url")).toEqual({ kind: "url", href: "https://example.com/x" });
    expect(paragraphs[0]!.segments[3]).toMatchObject({ kind: "ref", n: 2, href: `/sources/${S1}` });
  });

  it("leaves an account with no links as its paragraphs, with nothing in the margin", () => {
    const { paragraphs, targets } = numberAccount("Plain prose.\n\nMore of it.");
    expect(targets).toEqual([]);
    expect(paragraphs.every((p) => p.notes.length === 0)).toBe(true);
    expect(paragraphs).toHaveLength(2);
  });
});
