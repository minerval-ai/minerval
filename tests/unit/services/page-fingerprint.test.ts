/**
 * The fingerprint of a released page (src/services/page-fingerprint.ts): a
 * reader rebuilds the root from what they were given, and every way of
 * giving them something other than what was recorded is caught, under the
 * construction the page's record names.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_FORMAT,
  FINGERPRINT_FORMAT_1,
  FINGERPRINT_FORMAT_2,
  type FingerprintFormat,
  leafHash,
  markOf,
  newSalt,
  pageRoot,
  partCommitment,
  verifyReleasedPage,
  type ReleasedPageForCheck,
  type ReleasedPartForCheck,
} from "../../../src/services/page-fingerprint.js";
import { applyRemovals } from "../../../src/services/page-parts.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const PUBLIC_NODE = "618187c4-1053-48ab-8d7e-32394ab18eea";
const OTHER_NODE = "20014d26-9bcb-472b-81f0-2339335d5ec2";

/**
 * A page of a verdict and `texts`, with the parts at `held` (1-based) held,
 * recorded under `format`. Under the current construction the second part
 * cites a node the public graph holds.
 */
function page(texts: string[], held: number[] = [], format: FingerprintFormat = FINGERPRINT_FORMAT): ReleasedPageForCheck {
  const verdictSalt = newSalt();
  const verdictText = '{"verdict":{"status":"supported","confidence":0.8}}';
  const verdict: ReleasedPartForCheck = {
    position: 0, descriptor: "verdict", commitment: partCommitment(verdictSalt, verdictText, [], [], format), text: verdictText, salt: verdictSalt, marks: [],
  };
  const full = texts.map((original, i) => {
    const salt = newSalt();
    const { text, marks } = original.includes("SECRET")
      ? applyRemovals(original, [{ start: original.indexOf("SECRET"), end: original.indexOf("SECRET") + 6, category: "commercial figures" }])
      : { text: original, marks: [] };
    const refs = format === FINGERPRINT_FORMAT && i === 1 ? [PUBLIC_NODE] : [];
    return { position: i + 1, descriptor: i % 2 ? "argument:against" : "reasoning", commitment: partCommitment(salt, text, marks, refs, format), text, salt, marks, refs };
  });
  const root = pageRoot([verdict, ...full], format);
  return {
    root,
    format,
    verdict,
    parts: full.map((p) => (held.includes(p.position) ? { position: p.position, descriptor: p.descriptor, commitment: p.commitment } : p)),
  };
}

describe("the construction", () => {
  it("can be redone with nothing but SHA-256", () => {
    const salt = "00".repeat(32);
    const commitment = partCommitment(salt, "A paragraph.", []);
    expect(commitment).toBe(sha(`part\n${salt}\n[]\n[]\nA paragraph.`));
    expect(partCommitment(salt, "x [redacted: personal data] y", [{ at: 2, category: "personal data" }])).toBe(
      sha(`part\n${salt}\n[[2,"personal data"]]\n[]\nx [redacted: personal data] y`)
    );
    // The nodes a part cites are in its commitment, in order (#1157).
    expect(partCommitment(salt, "Subclaim (supports)", [], [PUBLIC_NODE, OTHER_NODE])).toBe(
      sha(`part\n${salt}\n[]\n["${PUBLIC_NODE}","${OTHER_NODE}"]\nSubclaim (supports)`)
    );
    // Before /3 there is no refs line, and a part recorded then cites nothing.
    expect(partCommitment(salt, "A paragraph.", [], [], FINGERPRINT_FORMAT_2)).toBe(sha(`part\n${salt}\n[]\nA paragraph.`));
    expect(partCommitment(salt, "A paragraph.", [], [], FINGERPRINT_FORMAT_1)).toBe(sha(`part\n${salt}\n[]\nA paragraph.`));
    expect(() => partCommitment(salt, "A paragraph.", [], [PUBLIC_NODE], FINGERPRINT_FORMAT_2)).toThrow(/carries no refs/);
    const leaf = (n: number, d: string, c: string) => sha(`leaf\n${n}\n${d}\n${c}`);
    expect(leafHash(3, "argument:against", commitment)).toBe(leaf(3, "argument:against", commitment));
    const leaves = [0, 1, 2].map((n) => ({ position: n, descriptor: n ? "reasoning" : "verdict", commitment: sha(String(n)) }));
    const [a, b, c] = leaves.map((l) => leaf(l.position, l.descriptor, l.commitment));
    // Three leaves split two and one, as RFC 6962 splits them.
    const top = sha(`node\n${sha(`node\n${a}\n${b}`)}\n${c}`);
    expect(FINGERPRINT_FORMAT).toBe("minerval-released-page/3");
    expect(pageRoot(leaves, FINGERPRINT_FORMAT)).toBe(sha(`root\nminerval-released-page/3\n3\n${top}`));
    expect(pageRoot(leaves, FINGERPRINT_FORMAT_2)).toBe(sha(`root\nminerval-released-page/2\n3\n${top}`));
    // A page recorded before the construction was renamed keeps its root under the name it was made with.
    expect(pageRoot(leaves, FINGERPRINT_FORMAT_1)).toBe(sha(`root\nminerval-shown-page/1\n3\n${top}`));
    expect(() => pageRoot(leaves, "minerval-page/9" as FingerprintFormat)).toThrow(/No fingerprint is made under/);
    expect(markOf("personal data")).toBe("[redacted: personal data]");
  });

  it("hashes text as written: spacing, markup and line ends are part of it", () => {
    const salt = newSalt();
    const written = "The bound is $\\frac{1}{2}n^2$,\r\n  with  two spaces.";
    for (const changed of [written.replace("\r\n", "\n"), written.replace("  two", " two"), written.normalize("NFD") + "́", written.trimEnd() + " "]) {
      expect(partCommitment(salt, changed)).not.toBe(partCommitment(salt, written));
    }
  });

  it("gives two pages with the same text different hashes, so a held part cannot be guessed from its hash", () => {
    expect(partCommitment(newSalt(), "supported")).not.toBe(partCommitment(newSalt(), "supported"));
  });
});

describe("checking a shown page", () => {
  const texts = ["First paragraph.", "An argument against.", "The figure is SECRET here.", "A fourth.", "A fifth part."];

  it("passes the page as recorded, with every part released or with some held", () => {
    expect(verifyReleasedPage(page(texts))).toEqual({ ok: true, problems: [], checked: 6, held: 0 });
    expect(verifyReleasedPage(page(texts, [2, 4]))).toEqual({ ok: true, problems: [], checked: 4, held: 2 });
  });

  it("catches an altered part, whether or not its listed hash was altered to match", () => {
    const one = page(texts);
    (one.parts[0] as ReleasedPartForCheck).text = "First paragraph, improved.";
    expect(verifyReleasedPage(one).problems).toContain("Part 1 does not match its hash: its text, its marks, the nodes it cites or its salt is not what was recorded.");
    const two = page(texts);
    const part = two.parts[0] as ReleasedPartForCheck;
    part.text = "First paragraph, improved.";
    part.commitment = partCommitment(part.salt!, part.text, []);
    const result = verifyReleasedPage(two);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/do not rebuild the recorded root/);
  });

  it("catches a removal's mark taken out, moved, or given another category", () => {
    const unmarked = page(texts);
    (unmarked.parts[2] as ReleasedPartForCheck).text = "The figure is 12 here.";
    expect(verifyReleasedPage(unmarked).ok).toBe(false);
    const recategorized = page(texts);
    (recategorized.parts[2] as ReleasedPartForCheck).marks = [{ at: 14, category: "personal data" }];
    expect(verifyReleasedPage(recategorized).problems[0]).toMatch(/no such mark/);
  });

  it("catches two parts swapped, a part dropped, a part added, and the page reordered", () => {
    const swapped = page(texts);
    const parts = swapped.parts as ReleasedPartForCheck[];
    [parts[0], parts[3]] = [{ ...parts[3]!, position: 1 }, { ...parts[0]!, position: 4 }];
    expect(verifyReleasedPage(swapped).ok).toBe(false);

    const dropped = page(texts);
    (dropped.parts as ReleasedPartForCheck[]).splice(1, 1);
    expect(verifyReleasedPage(dropped).ok).toBe(false);
    const renumbered = page(texts);
    (renumbered as { parts: ReleasedPartForCheck[] }).parts = renumbered.parts.filter((_, i) => i !== 1).map((p, i) => ({ ...p, position: i + 1 }));
    expect(verifyReleasedPage(renumbered).ok).toBe(false);

    const added = page(texts);
    const salt = newSalt();
    (added.parts as ReleasedPartForCheck[]).push({ position: 6, descriptor: "reasoning", commitment: partCommitment(salt, "One more."), text: "One more.", salt, marks: [] });
    expect(verifyReleasedPage(added).ok).toBe(false);

    const reordered = page(texts);
    (reordered.parts as ReleasedPartForCheck[]).reverse();
    const result = verifyReleasedPage(reordered);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /out of order, or one is missing/.test(p))).toBe(true);
  });

  it("catches a held part described as another kind, and a held part whose hash was changed", () => {
    const renamed = page(texts, [2]);
    (renamed.parts[1] as ReleasedPartForCheck).descriptor = "argument:for";
    expect(verifyReleasedPage(renamed).ok).toBe(false);
    const rehashed = page(texts, [2]);
    (rehashed.parts[1] as ReleasedPartForCheck).commitment = sha("something else");
    expect(verifyReleasedPage(rehashed).ok).toBe(false);
  });

  it("catches a changed verdict, and a part shown without its salt", () => {
    const verdict = page(texts);
    verdict.verdict.text = verdict.verdict.text!.replace("supported", "verified");
    expect(verifyReleasedPage(verdict).problems[0]).toMatch(/^The verdict does not match its hash/);
    const saltless = page(texts);
    (saltless.parts[0] as ReleasedPartForCheck).salt = null;
    expect(verifyReleasedPage(saltless).problems[0]).toBe("Part 1 is shown without its salt, so it cannot be checked against its hash.");
  });

  it("catches a part made to cite another node, or to cite nothing, and keeps a held part's citations to itself", () => {
    const pointed = page(texts);
    (pointed.parts[1] as ReleasedPartForCheck).refs = [OTHER_NODE];
    expect(verifyReleasedPage(pointed).problems).toContain(
      "Part 2 does not match its hash: its text, its marks, the nodes it cites or its salt is not what was recorded."
    );
    const dropped = page(texts);
    (dropped.parts[1] as ReleasedPartForCheck).refs = [];
    expect(verifyReleasedPage(dropped).ok).toBe(false);
    // Held, the part is taken by its hash: nothing says what it cites, and the page still checks.
    const held = page(texts, [2]);
    expect(held.parts[1]).not.toHaveProperty("refs");
    expect(verifyReleasedPage(held)).toEqual({ ok: true, problems: [], checked: 5, held: 1 });
  });

  it("checks a page recorded under an earlier construction by that construction, and by no other", () => {
    for (const earlier of [FINGERPRINT_FORMAT_2, FINGERPRINT_FORMAT_1]) {
      const old = page(texts, [2], earlier);
      expect(verifyReleasedPage(old)).toEqual({ ok: true, problems: [], checked: 5, held: 1 });
      // The record names the construction: the same parts under another name do not check.
      expect(verifyReleasedPage({ ...old, format: FINGERPRINT_FORMAT }).ok).toBe(false);
      expect(verifyReleasedPage({ ...page(texts), format: earlier }).ok).toBe(false);
      // A part recorded under an earlier construction cites nothing.
      const citing = page(texts, [], earlier);
      (citing.parts[0] as ReleasedPartForCheck).refs = [PUBLIC_NODE];
      expect(verifyReleasedPage(citing).problems).toContain(`Part 1 cites nodes, which a page recorded under "${earlier}" cannot.`);
    }
    const old = page(texts, [2], FINGERPRINT_FORMAT_1);
    expect(verifyReleasedPage({ ...old, format: FINGERPRINT_FORMAT_2 }).ok).toBe(false);
    expect(verifyReleasedPage({ ...old, format: "minerval-page/9" }).problems).toEqual([
      'The page\'s fingerprint is recorded under "minerval-page/9", a construction this check does not know.',
    ]);
  });

  it("does not accept one page's parts under another page's root", () => {
    const first = page(texts);
    const second = page(texts);
    expect(verifyReleasedPage({ ...first, root: second.root }).ok).toBe(false);
  });
});
