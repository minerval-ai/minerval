/**
 * The check of a published page (src/published-page/verify.ts) and the page
 * shape read from a package (shape.ts), with no database: a package is made
 * here from the page fingerprint's own functions and signed.
 *
 * tests/db/published-pages.test.ts runs the same check on packages a
 * deployment built and on each tampering of one.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { sign as cryptoSign } from "node:crypto";
import { VERDICT_DESCRIPTOR, newSalt, pageRoot, partCommitment } from "../../../src/services/page-fingerprint.js";
import { applyRemovals, heldWords, kindWords } from "../../../src/services/page-parts.js";
import { hashPolicy } from "../../../src/services/redaction-policy.js";
import { generateSigningKey, keyIdOf, parseSigningKey } from "../../../src/services/mirror-batch.js";
import { canonicalContent } from "../../../src/services/run-log.js";
import { kindInWords, publishedPageAsText, shapeOfPublishedPage } from "../../../src/published-page/shape.js";
import {
  PUBLISHED_PAGE_FORMAT,
  keyIdOfPublicKey,
  packageHash,
  verifyPublishedPage,
  type PackagePart,
  type PublishedPagePackage,
} from "../../../src/published-page/verify.js";

const key = generateSigningKey();

async function sign(body: Omit<PublishedPagePackage, "hash" | "signature">, pem = key.privateKeyPem): Promise<PublishedPagePackage> {
  const hash = await packageHash(body as unknown as Record<string, unknown>);
  return { ...body, hash, signature: cryptoSign(null, Buffer.from(hash, "hex"), parseSigningKey(pem)).toString("base64") };
}

/** A page with a marked removal, an argument each way and one part held. */
async function example(opts: { shown?: boolean } = {}): Promise<PublishedPagePackage> {
  const shown = opts.shown !== false;
  const policy = "# Redaction policy, version 1\n\n## Categories\n\n### commercial figures\n";
  const reasoning = applyRemovals("The meters show 4711 units against a target of 4500.", [{ start: 16, end: 26, category: "commercial figures" }]);
  const written: Array<{ kind: string; descriptor: string; text: string; marks: { at: number; category: string }[]; held?: boolean }> = [
    { kind: "summary", descriptor: "summary", text: "The target was met.", marks: [] },
    { kind: "reasoning", descriptor: "reasoning", text: reasoning.text, marks: reasoning.marks },
    { kind: "argument", descriptor: "argument:for", text: "Argument (for): From the meters\n\nThe meters record more than the target.\n\nEvaluation: likely if the premises hold; decisive\n\nThe meters are direct evidence.", marks: [] },
    { kind: "argument", descriptor: "argument:against", text: "Argument (against): From the logs\n\nUnread logs could hide a shortfall.", marks: [], held: true },
    { kind: "reading", descriptor: "reading", text: "Reading of a source (affirms)\n\nPassage: Output was above target.\n\nIt was so in every month.\n\nContext: The annual report.\n\nHow it was read: supports. A direct statement.", marks: [] },
    { kind: "subclaim", descriptor: "subclaim", text: "Subclaim (supports): The meters were calibrated\n\nCalibrated meters make the count reliable.", marks: [] },
  ];
  const header = JSON.stringify({
    format: "minerval-shown-page/1",
    node_kind: "claim",
    verdict: { status: "supported", confidence: 0.8, credence: 0.85 },
    judged_at: "2026-10-12T00:00:00.000Z",
    coverage: { examined: true, on: ["evidence_this_reader_cannot_read"] },
    sources: [{ source: 1, kind: "dataset", fingerprint: "aaaa", supplied_by: "an_outside_party", interest_recorded: true }],
    gaps: { requests: [], names_what_remains_open: false },
    made: { assessed_by_model: "a-model", prompt_set: "ab".repeat(32), policy: { version: 1, hash: hashPolicy(policy) }, redacted_by_model: "r-model", role_additions: [] },
    removals: { "commercial figures": 1 },
    parts: written.length,
  });
  const headerSalt = newSalt();
  const parts: PackagePart[] = written.map((w, i) => {
    const salt = newSalt();
    const hash = partCommitment(salt, w.text, w.marks);
    return shown && !w.held
      ? { part: i + 1, kind: w.kind, descriptor: w.descriptor, hash, text: w.text, marks: w.marks, salt }
      : { part: i + 1, kind: w.kind, descriptor: w.descriptor, hash, held: { by: ["Acme"], reasons: w.held ? ["confidential to the party"] : [], since: w.held ? "2026-10-13T00:00:00.000Z" : null } };
  });
  const headerHash = partCommitment(headerSalt, header, []);
  const fingerprint = pageRoot([{ position: 0, descriptor: VERDICT_DESCRIPTOR, commitment: headerHash }, ...parts.map((p) => ({ position: p.part, descriptor: p.descriptor, commitment: p.hash }))]);
  const state = shown ? "released_in_part" : "held";
  return sign({
    format: PUBLISHED_PAGE_FORMAT,
    publisher: { key_id: key.keyId, public_key: key.publicKey },
    deployment: { hosting: "own_machines", attested_by: "nothing" },
    showing: { id: "11111111-1111-4111-8111-111111111111", form: "standing", scope: "node", asked_at: "2026-09-08T00:00:00.000Z", send: "by_a_person_each_time", ended: null },
    node: { public_id: "22222222-2222-4222-8222-222222222222", covered_from: "2026-09-08T00:00:00.000Z", first_assessed_at: "2026-10-12T00:00:00.000Z", showing_began: "before the node was first assessed", left: null },
    sequence: 1,
    previous_hash: null,
    state,
    page: {
      id: "33333333-3333-4333-8333-333333333333",
      version_of: "2026-10-12T00:00:00.000Z",
      state,
      held: shown ? null : { because: "waiting on Acme", since: "2026-10-12T01:00:00.000Z" },
      shown_at: shown ? "2026-10-14T00:00:00.000Z" : null,
      redaction_round: 1,
      fingerprint,
      earlier_fingerprints: [],
      always_shown: shown ? { text: header, salt: headerSalt } : null,
      always_shown_hash: headerHash,
      parts,
      audit: shown ? "The reasoning shown supports the verdict in part." : null,
    },
    policy: shown ? { version: 1, hash: hashPolicy(policy), text: policy } : null,
    record: {
      made: shown ? { prompt_set: "ab".repeat(32), assessed_by_model: "a-model", redacted_by_model: "r-model", role_additions: [], run_log: { sealed: true, seal: "cd".repeat(32), steps: 12, chain_verifies: true }, paid_for: { by: "a mandate", stake: "its funder declared no stake in the subject" } } : null,
      acts: [{ at: "2026-09-08T00:00:00.000Z", what: "asked for the showing", by: "person 1", holding: ["direct"] }],
      versions: [{ page_id: "33333333-3333-4333-8333-333333333333", version_of: "2026-10-12T00:00:00.000Z", state, fingerprint }],
    },
    built_at: "2026-10-14T00:00:01.000Z",
  });
}

describe("the check of a published page", () => {
  it("confirms a package that is what its publisher signed, and says what it cannot show", async () => {
    const pkg = await example();
    const check = await verifyPublishedPage(pkg, { publisherKey: key.publicKey });
    expect(check.failed).toEqual([]);
    expect(check.ok).toBe(true);
    expect(check.released_parts).toBe(5);
    expect(check.held_parts).toBe(1);
    expect(check.confirmed[0]).toBe("The package's contents match its hash: nothing in it was changed after it was signed.");
    expect(check.confirmed.some((c) => c.startsWith("The page rebuilds its fingerprint: 5 released parts are word for word what was recorded"))).toBe(true);
    // It never reads as complete: what cannot be shown is said every time.
    expect(check.cannot_show[0]).toContain("That the assessment in the log was the only one made.");
    expect(check.cannot_show[0]).toContain("so its publisher could have assessed more than once and kept one");
    expect(check.cannot_show.join(" ")).toContain("What the held parts say.");
    // Taken as text, as a file is.
    expect((await verifyPublishedPage(JSON.stringify(pkg))).ok).toBe(true);
  });

  it("without the publisher's key from elsewhere, says the signature is good and not whose key it is", async () => {
    const check = await verifyPublishedPage(await example());
    expect(check.ok).toBe(true);
    expect(check.cannot_show.some((c) => c.startsWith("Whose key that is."))).toBe(true);
  });

  it("checks a held page by its kinds and hashes alone", async () => {
    const pkg = await example({ shown: false });
    const check = await verifyPublishedPage(pkg, { publisherKey: key.publicKey });
    expect(check.failed).toEqual([]);
    expect(check.confirmed.some((c) => c.startsWith("The page is held, and its 6 parts by kind and hash rebuild the fingerprint"))).toBe(true);
    // No part's words are in a held page. The check is on phrases with a
    // space in them: a bare run of digits such as the figure itself can
    // turn up by chance in a hash or a signature, which carry none.
    for (const words of ["The meters show", "a target of 4500", "The target was met", "From the meters"]) {
      expect(JSON.stringify(pkg)).not.toContain(words);
    }
  });

  it("checks a package whose record carries a field this check does not read, and says nothing of it", async () => {
    // For a short time a record could carry `made.given_source_text`. The
    // field is gone and the format's name did not change, so a package
    // built with it is checked as any other: what it says there is signed
    // with the rest and is otherwise not read.
    const { hash: _h, signature: _s, ...body } = await example();
    const made = { ...body.record.made!, given_source_text: "none" };
    const pkg = await sign({ ...body, record: { ...body.record, made } });
    const check = await verifyPublishedPage(pkg, { publisherKey: key.publicKey });
    expect(check.failed).toEqual([]);
    expect(check.ok).toBe(true);
    expect([...check.confirmed, ...check.cannot_show].join("\n")).not.toMatch(/given the text|wording/);
  });

  it("uses the same hash and key id as the code that signs", async () => {
    const pkg = await example();
    const { hash: _h, signature: _s, ...body } = pkg;
    const { createHash } = await import("node:crypto");
    expect(pkg.hash).toBe(createHash("sha256").update(`${PUBLISHED_PAGE_FORMAT}\n${canonicalContent(JSON.parse(JSON.stringify(body)))}`).digest("hex"));
    expect(await keyIdOfPublicKey(key.publicKey)).toBe(keyIdOf(key.publicKey));
  });

  it("fails on what is not a package, on another's key, and on a changed, moved, dropped or re-kinded part", async () => {
    expect((await verifyPublishedPage("not json")).failed[0]).toBe("This is not a published page's package: it is not JSON.");
    expect((await verifyPublishedPage({ format: "something-else" })).ok).toBe(false);
    const other = generateSigningKey();
    expect((await verifyPublishedPage(await example(), { publisherKey: other.publicKey })).failed[0]).toContain("that is not the key given to this check as the publisher's");

    const base = await example();
    const again = (change: (p: PublishedPagePackage) => void) => {
      const copy = JSON.parse(JSON.stringify(base)) as PublishedPagePackage;
      change(copy);
      const { hash: _h, signature: _s, ...body } = copy;
      return sign(body);
    };
    const cases: Array<[string, (p: PublishedPagePackage) => void, RegExp]> = [
      ["a changed part", (p) => void (p.page!.parts[0]!.text = "The target was missed."), /Part 1 does not match its hash/],
      ["swapped parts", (p) => void ([p.page!.parts[0], p.page!.parts[1]] = [p.page!.parts[1]!, p.page!.parts[0]!]), /out of order/],
      ["a dropped part", (p) => void p.page!.parts.pop(), /The page was recorded with 6 parts and the package carries 5|do not rebuild/],
      ["a held part of another kind", (p) => void (p.page!.parts[3]!.descriptor = "argument:for"), /do not rebuild the page's fingerprint/],
      ["a mark moved", (p) => void (p.page!.parts[1]!.marks = [{ at: 3, category: "commercial figures" }]), /no such mark/],
      ["text added to a held part", (p) => void (p.page!.parts[3]!.text = "It was fine."), /shown without its salt/],
      ["a state the parts do not show", (p) => void (p.page!.state = "released_whole"), /its parts show "released_in_part"/],
    ];
    for (const [what, change, why] of cases) {
      const check = await verifyPublishedPage(await again(change), { publisherKey: key.publicKey });
      expect(check.ok, what).toBe(false);
      expect(check.failed.join(" "), what).toMatch(why);
    }
    // Changed and not signed again.
    const edited = JSON.parse(JSON.stringify(base)) as PublishedPagePackage;
    edited.record.acts[0]!.holding = ["direct", "release for Acme"];
    expect((await verifyPublishedPage(edited)).failed[0]).toContain("do not match its hash");
  });
});

describe("a published page in the shape of a node's page", () => {
  it("reads each part back as what it is, text untouched, with marks and holds in place", async () => {
    const shape = shapeOfPublishedPage(await example())!;
    expect(shape.verdict).toEqual({ status: "supported", confidence: 0.8, credence: 0.85 });
    expect(shape.summary).toEqual([{ part: 1, text: "The target was met.", marks: [] }]);
    expect(shape.reasoning[0]).toEqual({ part: 2, text: "The meters show [redacted: commercial figures] against a target of 4500.", marks: [{ at: 16, category: "commercial figures" }] });
    expect(shape.arguments[0]).toEqual({ part: 3, stance: "for", name: "From the meters", content: "The meters record more than the target.", rating: "likely if the premises hold", decisive: true, evaluation: "The meters are direct evidence." });
    expect(shape.arguments[1]).toMatchObject({ part: 4, stance: "against", content: null, held: { what: "An argument against", by: ["Acme"], reasons: ["confidential to the party"] } });
    // A passage that itself holds a blank line stays whole.
    expect(shape.readings[0]).toMatchObject({ stance: "affirms", passage: "Output was above target.\n\nIt was so in every month.", context: "The annual report.", how_read: "supports. A direct statement." });
    expect(shape.subclaims[0]).toEqual({ part: 6, relation: "supports", wording: "The meters were calibrated", reasoning: "Calibrated meters make the count reliable." });
    expect([shape.parts, shape.held_parts, shape.held_kinds]).toEqual([6, 1, "an argument against"]);
    expect(shapeOfPublishedPage(await example({ shown: false }))).toBeNull();
  });

  it("names kinds of part in the words the deployment's own pages use", () => {
    for (const d of ["wording", "summary", "reasoning", "gap", "argument", "argument:for", "argument:against", "argument:neutral", "reading", "supplier", "stated_view", "subclaim"]) {
      expect(kindInWords(d)).toBe(kindWords(d));
      expect(kindInWords(d, 3)).toBe(kindWords(d, 3));
    }
  });

  it("gives the page as one text with held parts named where they stood", async () => {
    const text = publishedPageAsText(await example());
    expect(text).toContain("The meters show [redacted: commercial figures] against a target of 4500.");
    expect(text).toContain("[An argument against, held by Acme. Reason given: confidential to the party]");
    expect(heldWords("argument:against", ["Acme"])).toBe("[An argument against, held by Acme]");
  });
});

describe("the web app's copy of the check", () => {
  it("is the file the public graph runs, word for word", () => {
    for (const name of ["verify.ts", "shape.ts"]) {
      const here = readFileSync(`src/published-page/${name}`, "utf8");
      const there = readFileSync(`web/lib/published-page/${name}`, "utf8");
      expect(there, `web/lib/published-page/${name} is out of date: run npx tsx scripts/sync-frontend-content.ts`).toBe(here.replace('from "./verify.js"', 'from "./verify"'));
    }
  });
});
