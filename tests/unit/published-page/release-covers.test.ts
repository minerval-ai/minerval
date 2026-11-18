/**
 * What a release covers, in words (src/published-page/shape.ts,
 * releaseCovers): every scope a release can have has its own words, used
 * by the deployment's record of a release (release-gate-service.ts,
 * shownRelease), by what this graph says of a page published from another
 * (published-page-service.ts, sourceTextOf) and by the web app's copy.
 */
import { describe, it, expect } from "vitest";
import { releaseCovers } from "../../../src/published-page/shape.js";
import { RELEASE_SCOPES } from "../../../src/services/release-service.js";

describe("what a release covers, in words", () => {
  it("words each scope, naming nothing where nothing is given", () => {
    expect(releaseCovers("node")).toBe("the node alone");
    expect(releaseCovers("under")).toBe("the node with what sits under it");
    expect(releaseCovers("mandate")).toBe("every node one mandate's work assessed");
    expect(releaseCovers("boundary")).toBe("every node assessed at the label its pages are written at");
    expect(releaseCovers("item")).toBe("one item that is not a node's page");
  });

  it("names the mandate, the label and what an item is where it is given them", () => {
    expect(releaseCovers("mandate", { mandate: "Supplier audits" })).toBe('every node the work of the mandate "Supplier audits" assessed');
    expect(releaseCovers("boundary", { from: "finance" })).toBe('every node assessed at "finance"');
    expect(releaseCovers("item", { item: "an answer to a request" })).toBe("one item: an answer to a request");
    // A name given for another scope is not used: a node's release says nothing of a label or a mandate.
    expect(releaseCovers("node", { mandate: "Supplier audits", from: "finance" })).toBe("the node alone");
    expect(releaseCovers("under", { from: "finance" })).toBe("the node with what sits under it");
  });

  it("gives every scope words of its own, and none is said as the node alone but the node's own", () => {
    const words = RELEASE_SCOPES.map((s) => releaseCovers(s));
    expect(new Set(words).size).toBe(RELEASE_SCOPES.length);
    expect(RELEASE_SCOPES.filter((s) => releaseCovers(s) === "the node alone")).toEqual(["node"]);
    expect(words.some((w) => w.includes("has no words for"))).toBe(false);
  });

  it("says plainly where it does not know the scope, rather than calling it the node alone", () => {
    expect(releaseCovers("galaxy")).toBe('a scope this check has no words for ("galaxy")');
    expect(releaseCovers(null)).toBe("a scope not recorded");
  });
});

describe("the web app's sentence for a published page's release", () => {
  it("says what a release of a mandate's work or a whole boundary covers, not that it is the node alone", async () => {
    const { releaseWords } = await import("../../../web/lib/published.js");
    const base = { form: "standing", asked_at: "2026-09-08T00:00:00.000Z", release_began: "after the node was first assessed", ended: null };
    expect(releaseWords({ ...base, scope: "node" })).toContain("; covering the node alone.");
    expect(releaseWords({ ...base, scope: "under" })).toContain("; covering the node with what sits under it.");
    expect(releaseWords({ ...base, scope: "mandate" })).toContain("; covering every node one mandate's work assessed.");
    expect(releaseWords({ ...base, scope: "boundary" })).toContain("; covering every node assessed at the label its pages are written at.");
  });
});
