import { describe, it, expect } from "vitest";
import { checkShownPage, type PageToCheck } from "../../../web/lib/shown-page-check.js";
import { leafHash, pageRoot, partCommitment, verifyShownPage } from "../../../src/services/page-fingerprint.js";

// "Check this page" for a page shown inside a deployment runs in the
// reader's browser, from a second writing of the fingerprint's construction
// (web/lib/shown-page-check.ts). It must agree with the one the deployment
// records the fingerprint with (src/services/page-fingerprint.ts) on a page
// that is whole, and catch what that one catches on a page that is not.

function page(): PageToCheck {
  const header = { text: JSON.stringify({ verdict: { status: "supported", confidence: 0.8 } }), salt: "aa".repeat(32) };
  const parts = [
    { part: 1, descriptor: "summary", text: "The target was met.", marks: [] as Array<{ at: number; category: string }>, salt: "01".repeat(32) },
    { part: 2, descriptor: "reasoning", text: "The meters show [redacted: commercial figures] against a target of 4500.", marks: [{ at: 16, category: "commercial figures" }], salt: "02".repeat(32) },
    { part: 3, descriptor: "argument:against", text: "Argument (against): From the missing logs", marks: [], salt: "03".repeat(32) },
    { part: 4, descriptor: "reading", text: "Reading of a source (affirms)\n\nPassage: with  two spaces\r\nand a line end kept", marks: [], salt: "04".repeat(32) },
    { part: 5, descriptor: "subclaim", text: "Subclaim (supports): x", marks: [], salt: "05".repeat(32) },
  ];
  const headerHash = partCommitment(header.salt, header.text, []);
  const hashes = parts.map((p) => partCommitment(p.salt, p.text, p.marks));
  const root = pageRoot([
    { position: 0, descriptor: "verdict", commitment: headerHash },
    ...parts.map((p, i) => ({ position: p.part, descriptor: p.descriptor, commitment: hashes[i]! })),
  ]);
  return {
    fingerprint: root,
    always_shown_as_hashed: { ...header, hash: headerHash },
    parts: parts.map((p, i) =>
      // Part 3 is held: its hash and kind are given, and none of its text.
      p.part === 3
        ? { part: p.part, descriptor: p.descriptor, hash: hashes[i]! }
        : { part: p.part, descriptor: p.descriptor, hash: hashes[i]!, text: p.text, removals_marked: p.marks, salt: p.salt }
    ),
  };
}

describe("the check of a shown page, in the browser", () => {
  it("confirms a page that is whole, counting released and held parts, as the deployment's own check does", async () => {
    const shown = page();
    const check = await checkShownPage(shown);
    expect(check).toEqual({ ok: true, released: 4, held: 1, problems: [] });
    const theirs = verifyShownPage({
      root: shown.fingerprint!,
      verdict: { position: 0, descriptor: "verdict", commitment: shown.always_shown_as_hashed!.hash, text: shown.always_shown_as_hashed!.text, salt: shown.always_shown_as_hashed!.salt, marks: [] },
      parts: shown.parts!.map((p) => ({ position: p.part, descriptor: p.descriptor, commitment: p.hash, text: p.text, marks: p.removals_marked, salt: p.salt })),
    });
    expect(theirs.ok).toBe(true);
    // The verdict counts among the parts the deployment's check checked; here it is said apart.
    expect(theirs.checked - 1).toBe(check.released);
    expect(theirs.held).toBe(check.held);
    expect(leafHash(1, "summary", shown.parts![0]!.hash)).toMatch(/^[0-9a-f]{64}$/);
  });

  const broken: Array<[string, (p: PageToCheck) => void, RegExp]> = [
    ["a word changed in a released part", (p) => { p.parts![0]!.text = "The target was not met."; }, /Part 1 does not match its hash/],
    ["spacing normalised in a released part", (p) => { p.parts![3]!.text = p.parts![3]!.text!.replace("  ", " "); }, /Part 4 does not match its hash/],
    ["a mark's category changed", (p) => { p.parts![1]!.removals_marked = [{ at: 16, category: "personal data" }]; }, /Part 2 lists a removal marked "personal data" at a place where the text has no such mark/],
    ["a mark left out of the list", (p) => { p.parts![1]!.removals_marked = []; }, /Part 2 does not match its hash/],
    ["a held part said to be of another kind", (p) => { p.parts![2]!.descriptor = "argument:for"; }, /do not rebuild the recorded fingerprint/],
    ["a part dropped", (p) => { p.parts!.splice(4, 1); }, /do not rebuild the recorded fingerprint/],
    ["two parts swapped", (p) => { [p.parts![0], p.parts![1]] = [p.parts![1]!, p.parts![0]!]; }, /out of order/],
    ["the verdict changed", (p) => { p.always_shown_as_hashed!.text = p.always_shown_as_hashed!.text.replace("supported", "verified"); }, /What is always shown with the page/],
    ["another fingerprint", (p) => { p.fingerprint = "0".repeat(64); }, /do not rebuild the recorded fingerprint/],
  ];
  for (const [what, change, says] of broken) {
    it(`fails on ${what}`, async () => {
      const shown = page();
      change(shown);
      const check = await checkShownPage(shown);
      expect(check.ok).toBe(false);
      expect(check.problems.join(" ")).toMatch(says);
    });
  }

  it("says there is nothing to check for a page that has not been shown", async () => {
    const check = await checkShownPage({ fingerprint: null });
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(["This page has not been shown, so there is nothing to check yet."]);
  });
});
