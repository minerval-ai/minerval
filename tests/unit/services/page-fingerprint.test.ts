/**
 * The fingerprint of a shown page (src/services/page-fingerprint.ts): a
 * reader rebuilds the root from what they were shown, and every way of
 * showing them something other than what was recorded is caught.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  FINGERPRINT_FORMAT,
  leafHash,
  markOf,
  newSalt,
  pageRoot,
  partCommitment,
  verifyShownPage,
  type ShownPageForCheck,
  type ShownPartForCheck,
} from "../../../src/services/page-fingerprint.js";
import { applyRemovals } from "../../../src/services/page-parts.js";

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

/** A page of a verdict and `texts`, with the parts at `held` (1-based) held. */
function page(texts: string[], held: number[] = []): ShownPageForCheck {
  const verdictSalt = newSalt();
  const verdictText = '{"verdict":{"status":"supported","confidence":0.8}}';
  const verdict: ShownPartForCheck = { position: 0, descriptor: "verdict", commitment: partCommitment(verdictSalt, verdictText), text: verdictText, salt: verdictSalt, marks: [] };
  const full = texts.map((original, i) => {
    const salt = newSalt();
    const { text, marks } = original.includes("SECRET")
      ? applyRemovals(original, [{ start: original.indexOf("SECRET"), end: original.indexOf("SECRET") + 6, category: "commercial figures" }])
      : { text: original, marks: [] };
    return { position: i + 1, descriptor: i % 2 ? "argument:against" : "reasoning", commitment: partCommitment(salt, text, marks), text, salt, marks };
  });
  const root = pageRoot([verdict, ...full]);
  return {
    root,
    verdict,
    parts: full.map((p) => (held.includes(p.position) ? { position: p.position, descriptor: p.descriptor, commitment: p.commitment } : p)),
  };
}

describe("the construction", () => {
  it("can be redone with nothing but SHA-256", () => {
    const salt = "00".repeat(32);
    const commitment = partCommitment(salt, "A paragraph.", []);
    expect(commitment).toBe(sha(`part\n${salt}\n[]\nA paragraph.`));
    expect(partCommitment(salt, "x [redacted: personal data] y", [{ at: 2, category: "personal data" }])).toBe(
      sha(`part\n${salt}\n[[2,"personal data"]]\nx [redacted: personal data] y`)
    );
    const leaf = (n: number, d: string, c: string) => sha(`leaf\n${n}\n${d}\n${c}`);
    expect(leafHash(3, "argument:against", commitment)).toBe(leaf(3, "argument:against", commitment));
    const leaves = [0, 1, 2].map((n) => ({ position: n, descriptor: n ? "reasoning" : "verdict", commitment: sha(String(n)) }));
    const [a, b, c] = leaves.map((l) => leaf(l.position, l.descriptor, l.commitment));
    // Three leaves split two and one, as RFC 6962 splits them.
    expect(pageRoot(leaves)).toBe(sha(`root\n${FINGERPRINT_FORMAT}\n3\n${sha(`node\n${sha(`node\n${a}\n${b}`)}\n${c}`)}`));
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
    expect(verifyShownPage(page(texts))).toEqual({ ok: true, problems: [], checked: 6, held: 0 });
    expect(verifyShownPage(page(texts, [2, 4]))).toEqual({ ok: true, problems: [], checked: 4, held: 2 });
  });

  it("catches an altered part, whether or not its listed hash was altered to match", () => {
    const one = page(texts);
    (one.parts[0] as ShownPartForCheck).text = "First paragraph, improved.";
    expect(verifyShownPage(one).problems).toContain("Part 1 does not match its hash: its text, its marks or its salt is not what was recorded.");
    const two = page(texts);
    const part = two.parts[0] as ShownPartForCheck;
    part.text = "First paragraph, improved.";
    part.commitment = partCommitment(part.salt!, part.text, []);
    const result = verifyShownPage(two);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/do not rebuild the recorded root/);
  });

  it("catches a removal's mark taken out, moved, or given another category", () => {
    const unmarked = page(texts);
    (unmarked.parts[2] as ShownPartForCheck).text = "The figure is 12 here.";
    expect(verifyShownPage(unmarked).ok).toBe(false);
    const recategorized = page(texts);
    (recategorized.parts[2] as ShownPartForCheck).marks = [{ at: 14, category: "personal data" }];
    expect(verifyShownPage(recategorized).problems[0]).toMatch(/no such mark/);
  });

  it("catches two parts swapped, a part dropped, a part added, and the page reordered", () => {
    const swapped = page(texts);
    const parts = swapped.parts as ShownPartForCheck[];
    [parts[0], parts[3]] = [{ ...parts[3]!, position: 1 }, { ...parts[0]!, position: 4 }];
    expect(verifyShownPage(swapped).ok).toBe(false);

    const dropped = page(texts);
    (dropped.parts as ShownPartForCheck[]).splice(1, 1);
    expect(verifyShownPage(dropped).ok).toBe(false);
    const renumbered = page(texts);
    (renumbered as { parts: ShownPartForCheck[] }).parts = renumbered.parts.filter((_, i) => i !== 1).map((p, i) => ({ ...p, position: i + 1 }));
    expect(verifyShownPage(renumbered).ok).toBe(false);

    const added = page(texts);
    const salt = newSalt();
    (added.parts as ShownPartForCheck[]).push({ position: 6, descriptor: "reasoning", commitment: partCommitment(salt, "One more."), text: "One more.", salt, marks: [] });
    expect(verifyShownPage(added).ok).toBe(false);

    const reordered = page(texts);
    (reordered.parts as ShownPartForCheck[]).reverse();
    const result = verifyShownPage(reordered);
    expect(result.ok).toBe(false);
    expect(result.problems.some((p) => /out of order, or one is missing/.test(p))).toBe(true);
  });

  it("catches a held part described as another kind, and a held part whose hash was changed", () => {
    const renamed = page(texts, [2]);
    (renamed.parts[1] as ShownPartForCheck).descriptor = "argument:for";
    expect(verifyShownPage(renamed).ok).toBe(false);
    const rehashed = page(texts, [2]);
    (rehashed.parts[1] as ShownPartForCheck).commitment = sha("something else");
    expect(verifyShownPage(rehashed).ok).toBe(false);
  });

  it("catches a changed verdict, and a part shown without its salt", () => {
    const verdict = page(texts);
    verdict.verdict.text = verdict.verdict.text!.replace("supported", "verified");
    expect(verifyShownPage(verdict).problems[0]).toMatch(/^The verdict does not match its hash/);
    const saltless = page(texts);
    (saltless.parts[0] as ShownPartForCheck).salt = null;
    expect(verifyShownPage(saltless).problems[0]).toBe("Part 1 is shown without its salt, so it cannot be checked against its hash.");
  });

  it("does not accept one page's parts under another page's root", () => {
    const first = page(texts);
    const second = page(texts);
    expect(verifyShownPage({ ...first, root: second.root }).ok).toBe(false);
  });
});
