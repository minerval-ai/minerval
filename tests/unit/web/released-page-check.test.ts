import { describe, it, expect } from "vitest";
import { checkReleasedPage, type PageToCheck } from "../../../web/lib/released-page-check.js";
import {
  FINGERPRINT_FORMAT,
  FINGERPRINT_FORMAT_1,
  FINGERPRINT_FORMAT_2,
  leafHash,
  pageRoot,
  partCommitment,
  verifyReleasedPage,
  type FingerprintFormat,
} from "../../../src/services/page-fingerprint.js";

// "Check this page" for a page released inside a deployment runs in the
// reader's browser, from a second writing of the fingerprint's construction
// (web/lib/released-page-check.ts). It must agree with the one the deployment
// records the fingerprint with (src/services/page-fingerprint.ts) on a page
// that is whole, and catch what that one catches on a page that is not.

const CITED = "618187c4-1053-48ab-8d7e-32394ab18eea";

function page(format: FingerprintFormat = FINGERPRINT_FORMAT): PageToCheck {
  const header = { text: JSON.stringify({ verdict: { status: "supported", confidence: 0.8 } }), salt: "aa".repeat(32) };
  const parts = [
    { part: 1, descriptor: "summary", text: "The target was met.", marks: [] as Array<{ at: number; category: string }>, salt: "01".repeat(32) },
    { part: 2, descriptor: "reasoning", text: "The meters show [redacted: commercial figures] against a target of 4500.", marks: [{ at: 16, category: "commercial figures" }], salt: "02".repeat(32) },
    { part: 3, descriptor: "argument:against", text: "Argument (against): From the missing logs", marks: [], salt: "03".repeat(32) },
    { part: 4, descriptor: "reading", text: "Reading of a source (affirms)\n\nPassage: with  two spaces\r\nand a line end kept", marks: [], salt: "04".repeat(32) },
    { part: 5, descriptor: "subclaim", text: "Subclaim (supports)\n\nWhy it bears.", marks: [], salt: "05".repeat(32) },
  ];
  // Under the current construction the subclaim cites a node the public graph holds (#1157).
  const refsOf = (p: { part: number }) => (format === FINGERPRINT_FORMAT && p.part === 5 ? [CITED] : []);
  const headerHash = partCommitment(header.salt, header.text, [], [], format);
  const hashes = parts.map((p) => partCommitment(p.salt, p.text, p.marks, refsOf(p), format));
  const root = pageRoot([
    { position: 0, descriptor: "verdict", commitment: headerHash },
    ...parts.map((p, i) => ({ position: p.part, descriptor: p.descriptor, commitment: hashes[i]! })),
  ], format);
  return {
    fingerprint: root,
    fingerprint_format: format,
    always_released_as_hashed: { ...header, hash: headerHash },
    parts: parts.map((p, i) =>
      // Part 3 is held: its hash and kind are given, and none of its text.
      p.part === 3
        ? { part: p.part, descriptor: p.descriptor, hash: hashes[i]! }
        : { part: p.part, descriptor: p.descriptor, hash: hashes[i]!, text: p.text, removals_marked: p.marks, salt: p.salt, ...(refsOf(p).length ? { refs: refsOf(p) } : {}) }
    ),
  };
}

describe("the check of a released page, in the browser", () => {
  it("confirms a page that is whole, counting released and held parts, as the deployment's own check does", async () => {
    const shown = page();
    const check = await checkReleasedPage(shown);
    expect(check).toEqual({ ok: true, released: 4, held: 1, problems: [] });
    const theirs = verifyReleasedPage({
      root: shown.fingerprint!,
      format: shown.fingerprint_format!,
      verdict: { position: 0, descriptor: "verdict", commitment: shown.always_released_as_hashed!.hash, text: shown.always_released_as_hashed!.text, salt: shown.always_released_as_hashed!.salt, marks: [] },
      parts: shown.parts!.map((p) => ({ position: p.part, descriptor: p.descriptor, commitment: p.hash, text: p.text, marks: p.removals_marked, salt: p.salt, refs: p.refs })),
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
    ["the verdict changed", (p) => { p.always_released_as_hashed!.text = p.always_released_as_hashed!.text.replace("supported", "verified"); }, /What is always shown with the page|always released/],
    ["another fingerprint", (p) => { p.fingerprint = "0".repeat(64); }, /do not rebuild the recorded fingerprint/],
  ];
  for (const [what, change, says] of broken) {
    it(`fails on ${what}`, async () => {
      const shown = page();
      change(shown);
      const check = await checkReleasedPage(shown);
      expect(check.ok).toBe(false);
      expect(check.problems.join(" ")).toMatch(says);
    });
  }

  it("says there is nothing to check for a page that has not been released", async () => {
    const check = await checkReleasedPage({ fingerprint: null });
    expect(check.ok).toBe(false);
    expect(check.problems).toEqual(["This page has not been released, so there is nothing to check yet."]);
  });

  it("catches a part made to cite another node, as the deployment's check does", async () => {
    const pointed = page();
    pointed.parts![4]!.refs = ["20014d26-9bcb-472b-81f0-2339335d5ec2"];
    expect((await checkReleasedPage(pointed)).problems).toContain(
      "Part 5 does not match its hash: its text, its marks, the nodes it cites or its salt is not what was recorded."
    );
    const stripped = page();
    delete stripped.parts![4]!.refs;
    expect((await checkReleasedPage(stripped)).ok).toBe(false);
  });

  it("checks a page recorded before parts carried refs by the construction its record names", async () => {
    const before = page(FINGERPRINT_FORMAT_2);
    expect(await checkReleasedPage(before)).toEqual({ ok: true, released: 4, held: 1, problems: [] });
    expect((await checkReleasedPage({ ...before, fingerprint_format: FINGERPRINT_FORMAT })).ok).toBe(false);
    const citing = page(FINGERPRINT_FORMAT_2);
    citing.parts![0]!.refs = ["20014d26-9bcb-472b-81f0-2339335d5ec2"];
    expect((await checkReleasedPage(citing)).problems).toContain(`Part 1 cites nodes, which a page fingerprinted under "${FINGERPRINT_FORMAT_2}" cannot.`);
  });

  it("checks a page recorded under the old construction by the construction its record names", async () => {
    const old = page(FINGERPRINT_FORMAT_1);
    expect(await checkReleasedPage(old)).toEqual({ ok: true, released: 4, held: 1, problems: [] });
    // Under the other name the same parts do not rebuild its root: the check does not try both.
    expect((await checkReleasedPage({ ...old, fingerprint_format: FINGERPRINT_FORMAT })).problems.join(" ")).toMatch(/do not rebuild the recorded fingerprint/);
    expect((await checkReleasedPage({ ...page(), fingerprint_format: FINGERPRINT_FORMAT_1 })).ok).toBe(false);
    expect((await checkReleasedPage({ ...old, fingerprint_format: undefined })).problems).toEqual([
      'The fingerprint is recorded under "", a construction this check does not know.',
    ]);
  });
});
