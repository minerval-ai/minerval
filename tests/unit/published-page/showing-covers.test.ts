/**
 * What a showing covers, in words (src/published-page/shape.ts,
 * showingCovers): every scope a showing can have has its own words, used
 * by the deployment's record of a showing (release-gate-service.ts,
 * shownShowing), by what this graph says of a page published from another
 * (published-page-service.ts, sourceTextOf) and by the web app's copy.
 */
import { describe, it, expect } from "vitest";
import { showingCovers } from "../../../src/published-page/shape.js";
import { SHOWING_SCOPES } from "../../../src/services/showing-service.js";

describe("what a showing covers, in words", () => {
  it("words each scope, naming nothing where nothing is given", () => {
    expect(showingCovers("node")).toBe("the node alone");
    expect(showingCovers("under")).toBe("the node with what sits under it");
    expect(showingCovers("mandate")).toBe("every node one mandate's work assessed");
    expect(showingCovers("boundary")).toBe("every node assessed at the label its pages are written at");
    expect(showingCovers("item")).toBe("one item that is not a node's page");
  });

  it("names the mandate, the label and what an item is where it is given them", () => {
    expect(showingCovers("mandate", { mandate: "Supplier audits" })).toBe('every node the work of the mandate "Supplier audits" assessed');
    expect(showingCovers("boundary", { from: "finance" })).toBe('every node assessed at "finance"');
    expect(showingCovers("item", { item: "an answer to a request" })).toBe("one item: an answer to a request");
    // A name given for another scope is not used: a node's showing says nothing of a label or a mandate.
    expect(showingCovers("node", { mandate: "Supplier audits", from: "finance" })).toBe("the node alone");
    expect(showingCovers("under", { from: "finance" })).toBe("the node with what sits under it");
  });

  it("gives every scope words of its own, and none is said as the node alone but the node's own", () => {
    const words = SHOWING_SCOPES.map((s) => showingCovers(s));
    expect(new Set(words).size).toBe(SHOWING_SCOPES.length);
    expect(SHOWING_SCOPES.filter((s) => showingCovers(s) === "the node alone")).toEqual(["node"]);
    expect(words.some((w) => w.includes("has no words for"))).toBe(false);
  });

  it("says plainly where it does not know the scope, rather than calling it the node alone", () => {
    expect(showingCovers("galaxy")).toBe('a scope this check has no words for ("galaxy")');
    expect(showingCovers(null)).toBe("a scope not recorded");
  });
});

describe("the web app's sentence for a published page's showing", () => {
  it("says what a showing of a mandate's work or a whole boundary covers, not that it is the node alone", async () => {
    const { showingWords } = await import("../../../web/lib/published.js");
    const base = { form: "standing", asked_at: "2026-09-08T00:00:00.000Z", showing_began: "after the node was first assessed", ended: null };
    expect(showingWords({ ...base, scope: "node" })).toContain("; covering the node alone.");
    expect(showingWords({ ...base, scope: "under" })).toContain("; covering the node with what sits under it.");
    expect(showingWords({ ...base, scope: "mandate" })).toContain("; covering every node one mandate's work assessed.");
    expect(showingWords({ ...base, scope: "boundary" })).toContain("; covering every node assessed at the label its pages are written at.");
  });
});
