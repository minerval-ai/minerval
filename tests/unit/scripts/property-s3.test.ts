/**
 * The S3 property additions (#295): the new arms, the per-claim readings
 * (granularity, churn, inflation, first mover), corpus:run's new flag
 * parsers and orderings, and graph-agreement's per-claim block.
 */
import { describe, it, expect } from "vitest";
import {
  buildPropertyArms,
  churn,
  firstMover,
  granularityStability,
  inflation,
  isProperty,
  netStance,
  restoresArmA,
  summarizeProperty,
} from "../../../scripts/corpus/property-lib.js";
import { dupUrl, orderPosts, parseDupSuffixes, parseForeign, pickAdversarialFirst } from "../../../scripts/corpus/run.js";
import { buildMatching, graphAgreement, perClaimAgreement, type AgreementGraph, type AgreementReport, type PerClaimPair } from "../../../scripts/corpus/graph-agreement.js";

describe("buildPropertyArms (S3)", () => {
  it("knows the new properties and which restore arm A", () => {
    for (const p of ["adversarial-order", "dup-flood", "locality", "fixpoint"]) expect(isProperty(p)).toBe(true);
    expect(restoresArmA("dup-flood")).toBe(true);
    expect(restoresArmA("locality")).toBe(true);
    expect(restoresArmA("fixpoint")).toBe(true);
    expect(restoresArmA("adversarial-order")).toBe(false);
    expect(restoresArmA("idempotency")).toBe(false);
  });
  it("adversarial-order: the most partisan role first, or a named one", () => {
    expect(buildPropertyArms({ property: "adversarial-order", cluster: "blackholes" })[1]!.args).toEqual(["blackholes", "--order=adversarial"]);
    expect(buildPropertyArms({ property: "adversarial-order", cluster: "blackholes", role: "published-dissent", limit: 3 })[1]!.args).toEqual([
      "blackholes",
      "--limit=3",
      "--order=role:published-dissent",
    ]);
  });
  it("dup-flood: arm B re-submits on top of the restored graph", () => {
    const arms = buildPropertyArms({ property: "dup-flood", cluster: "eggs", profile: "production", dups: 2 });
    expect(arms[0]!.args).toEqual(["eggs", "--profile=production"]);
    expect(arms[1]!.args).toEqual(["eggs", "--profile=production", "--no-reset", "--dup-suffix=1..2"]);
    expect(buildPropertyArms({ property: "dup-flood", cluster: "eggs" })[1]!.args).toContain("--dup-suffix=1..3");
    expect(() => buildPropertyArms({ property: "dup-flood", cluster: "eggs", dups: 0 })).toThrow(/--dups/);
  });
  it("locality: one foreign post, without this cluster's selection", () => {
    const arms = buildPropertyArms({ property: "locality", cluster: "eggs", limit: 2, foreign: "blackholes:cern-safety" });
    expect(arms[0]!.args).toEqual(["eggs", "--limit=2"]);
    expect(arms[1]!.args).toEqual(["eggs", "--no-reset", "--foreign=blackholes:cern-safety"]);
    expect(() => buildPropertyArms({ property: "locality", cluster: "eggs" })).toThrow(/--foreign/);
  });
  it("fixpoint: a re-stewarding pass on the restored graph", () => {
    expect(buildPropertyArms({ property: "fixpoint", cluster: "eggs", posts: ["p1"] })[1]!.args).toEqual(["eggs", "--no-reset", "--reassess-all"]);
  });
});

describe("corpus:run flag parsers", () => {
  it("parses duplicate suffixes", () => {
    expect(parseDupSuffixes(undefined)).toEqual([]);
    expect(parseDupSuffixes("3")).toEqual(["3"]);
    expect(parseDupSuffixes("1..3")).toEqual(["1", "2", "3"]);
    expect(parseDupSuffixes("a,b")).toEqual(["a", "b"]);
    expect(() => parseDupSuffixes("3..1")).toThrow(/ascend/);
    expect(() => parseDupSuffixes("a b")).toThrow(/dup-suffix/);
  });
  it("builds distinct urls per suffix", () => {
    expect(dupUrl("https://x.org/p", "2")).toBe("https://x.org/p?dup=2");
    expect(dupUrl("https://x.org/p?v=1", "2")).toBe("https://x.org/p?v=1&dup=2");
  });
  it("parses --foreign", () => {
    expect(parseForeign(undefined)).toBeNull();
    expect(parseForeign("blackholes:a,b")).toEqual({ cluster: "blackholes", ids: ["a", "b"] });
    expect(() => parseForeign("blackholes")).toThrow(/--foreign/);
    expect(() => parseForeign("blackholes:")).toThrow(/--foreign/);
  });
});

describe("orderPosts (S3)", () => {
  const posts = [
    { id: "a", role: "institutional-reassurance" },
    { id: "b", role: "safety-derivation-foundational" },
    { id: "c", role: "overview-of-the-dispute" },
    { id: "d", role: "published-dissent" },
  ];
  it("puts a named role first, keeping the rest in order", () => {
    expect(orderPosts(posts, "role:published-dissent").map((p) => p.id)).toEqual(["d", "a", "b", "c"]);
    expect(() => orderPosts(posts, "role:nope")).toThrow(/no selected post carries that role/);
  });
  it("adversarial: the most partisan role by keyword, else the last post", () => {
    expect(orderPosts(posts, "adversarial").map((p) => p.id)).toEqual(["d", "a", "b", "c"]);
    const lableak = [{ id: "n", role: "neutral-overview" }, { id: "z", role: "zoonosis-case" }, { id: "l", role: "lab-leak-case" }];
    expect(orderPosts(lableak, "adversarial", (p) => p.role).map((p) => p.id)).toEqual(["l", "n", "z"]);
    const roleless = [{ id: "x" }, { id: "y" }];
    expect(pickAdversarialFirst(roleless, () => undefined)).toBe(1);
    expect(orderPosts(roleless, "adversarial").map((p) => p.id)).toEqual(["y", "x"]);
    expect(pickAdversarialFirst([], () => undefined)).toBe(-1);
  });
  it("still rejects unknown orders", () => {
    expect(() => orderPosts(posts, "random")).toThrow(/--order/);
  });
});

describe("per-claim readings", () => {
  const pair = (over: Partial<PerClaimPair>): PerClaimPair => ({
    a: "a",
    b: "b",
    similarity: 1,
    method: "exact",
    textA: "t",
    statusA: "supported",
    statusB: "supported",
    credenceA: 0.7,
    credenceB: 0.7,
    childrenA: 2,
    childrenB: 2,
    depthA: 1,
    depthB: 1,
    instancesA: [],
    instancesB: [],
    ...over,
  });

  it("netStance", () => {
    expect(netStance([{ stance: "affirms" }, { stance: "affirms" }, { stance: "denies" }])).toBe(1);
    expect(netStance([{ stance: "denies" }])).toBe(-1);
    expect(netStance([{ stance: "affirms" }, { stance: "denies" }])).toBe(0);
    expect(netStance([])).toBe(0);
  });

  it("granularity: child counts and depth agreement", () => {
    const g = granularityStability([pair({}), pair({ childrenB: 4, depthB: 2 }), pair({ childrenB: 1 })]);
    expect(g.n).toBe(3);
    expect(g.meanAbsChildrenDiff).toBe(1);
    expect(g.childrenEqualShare).toBe(0.333);
    expect(g.meanAbsDepthDiff).toBe(0.333);
    expect(g.depthEqualShare).toBe(0.667);
  });

  it("churn: status or credence ≥ 0.1", () => {
    const c = churn([pair({}), pair({ statusB: "contested" }), pair({ credenceB: 0.85 }), pair({ credenceB: 0.75 }), pair({ statusA: null, statusB: null, credenceA: null, credenceB: null })]);
    expect(c.n).toBe(4);
    expect(c.moved).toBe(2);
    expect(c.statusChanged).toBe(1);
    expect(c.credenceMoved).toBe(1);
    expect(c.share).toBe(0.5);
  });

  it("inflation: signed drift toward A's sources' stance, instances counted", () => {
    const aff = [{ sourceUrl: "u1", stance: "affirms" }];
    const den = [{ sourceUrl: "u1", stance: "denies" }];
    const i = inflation([
      pair({ instancesA: aff, instancesB: [...aff, ...aff, ...aff], credenceB: 0.85 }), // +0.15 toward
      pair({ instancesA: den, instancesB: [...den, ...den], credenceB: 0.55 }), // denies, credence fell: toward
      pair({ instancesA: aff, instancesB: [...aff, ...aff], credenceB: 0.7 }), // unchanged
      pair({ instancesA: [], instancesB: [], credenceB: 0.9 }), // no stance: skipped
    ]);
    expect(i.n).toBe(3);
    expect(i.towardStance).toBe(2);
    expect(i.againstStance).toBe(0);
    expect(i.meanSignedTowardStance).toBe(0.1);
    expect(i.instancesA).toBe(3);
    expect(i.instancesB).toBe(7);
  });

  it("first mover: drift toward the first source's stance in B", () => {
    const f = firstMover(
      [
        pair({ instancesB: [{ sourceUrl: "first", stance: "denies" }, { sourceUrl: "other", stance: "affirms" }], credenceB: 0.5 }), // −0.2 × −1 = +0.2 toward
        pair({ instancesB: [{ sourceUrl: "first", stance: "affirms" }], credenceB: 0.55 }), // −0.15 against
        pair({ instancesB: [{ sourceUrl: "other", stance: "affirms" }], credenceB: 0.9 }), // first has no stance
      ],
      "first"
    );
    expect(f.n).toBe(2);
    expect(f.towardFirst).toBe(1);
    expect(f.againstFirst).toBe(1);
    expect(f.meanSignedTowardFirst).toBe(0.025);
    expect(firstMover([pair({})], null).n).toBe(0);
  });
});

describe("summarizeProperty (S3)", () => {
  const arm = { cluster: "eggs", registryId: null, startedAt: "t", finishedAt: "t", postsIngested: 3, capped: false, costMicroUsd: 500_000, models: {} as never };
  const report = (perClaim: PerClaimPair[], over: Partial<AgreementReport> = {}): AgreementReport => ({
    a: "a",
    b: "b",
    claimSet: { sizeA: perClaim.length, sizeB: perClaim.length, matched: perClaim.length, precision: 1, recall: 1, f1: 1, byMethod: { exact: perClaim.length, embedding: 0, judge: 0 }, unmatchedA: [], unmatchedB: [], unmatchedByCreator: { a: {}, b: {} } },
    credence: { n: perClaim.length, meanAbsDiff: 0, rmsDiff: 0, within01: 1, statusN: perClaim.length, statusAgreement: 1, statusConfusion: {}, oneSided: 0 },
    structure: { edgesA: 4, edgesB: 4, sharedIgnoringRel: 4, sharedWithRel: 4, precision: 1, recall: 1, editDistance: 0, danglingA: 0, danglingB: 0 },
    perClaim,
    ...over,
  });
  const base = (over: Partial<PerClaimPair> = {}): PerClaimPair => ({
    a: "a", b: "b", similarity: 1, method: "exact", textA: "t", statusA: "supported", statusB: "supported", credenceA: 0.7, credenceB: 0.7,
    childrenA: 2, childrenB: 2, depthA: 1, depthB: 1, instancesA: [{ sourceUrl: "u", stance: "affirms" }], instancesB: [{ sourceUrl: "u", stance: "affirms" }], ...over,
  });

  it("fixpoint: an unchanged graph is a fixpoint", () => {
    const s = summarizeProperty({ property: "fixpoint", cluster: "eggs", armA: arm, armB: arm, agreement: report([base(), base(), base()]) });
    expect(s.reading).toMatch(/Stewardship settles/);
    expect(s.churn).toEqual({ n: 3, moved: 0, share: 0, statusChanged: 0, credenceMoved: 0 });
    expect(s.granularity!.childrenEqualShare).toBe(1);
    expect(s.reading).toMatch(/Granularity: 100% of 3/);
  });

  it("fixpoint: moves are reported against the noise floor", () => {
    const s = summarizeProperty({ property: "fixpoint", cluster: "eggs", armA: arm, armB: arm, agreement: report([base(), base({ credenceB: 0.4 })]) });
    expect(s.reading).toMatch(/does not settle yet: re-stewarding moved 1 of 2/);
  });

  it("locality: churn share over A's claims", () => {
    const quiet = summarizeProperty({ property: "locality", cluster: "eggs", armA: arm, armB: arm, agreement: report([base(), base()], { claimSet: { sizeA: 2, sizeB: 5, matched: 2, precision: 0.4, recall: 1, f1: 0.571, byMethod: { exact: 2, embedding: 0, judge: 0 }, unmatchedA: [], unmatchedB: ["x", "y", "z"], unmatchedByCreator: { a: {}, b: { extractor: 3 } } } }) });
    expect(quiet.reading).toMatch(/left A's claims alone: 0 of 2/);
    expect(quiet.reading).toMatch(/3 new claim\(s\)/);
    const churned = summarizeProperty({ property: "locality", cluster: "eggs", armA: arm, armB: arm, agreement: report([base(), base({ statusB: "contested" })]) });
    expect(churned.reading).toMatch(/churned 1 of 2 matched claims \(50%/);
  });

  it("dup-flood: inflation toward the sources' stance", () => {
    const three = (i: PerClaimPair["instancesA"]) => [...i, ...i, ...i];
    const clean = summarizeProperty({ property: "dup-flood", cluster: "eggs", armA: arm, armB: arm, dups: 2, agreement: report([base({ instancesB: three(base().instancesA) }), base({ instancesB: three(base().instancesA) })]) });
    expect(clean.reading).toMatch(/No inflation: after 2× copies/);
    expect(clean.inflation!.instancesB).toBe(6);
    expect(clean.reading).toMatch(/does not re-trigger the Steward/);
    const inflated = summarizeProperty({ property: "dup-flood", cluster: "eggs", armA: arm, armB: arm, agreement: report([base({ credenceB: 0.9 }), base({ credenceB: 0.85 })]) });
    expect(inflated.reading).toMatch(/inflated credence/);
    expect(inflated.inflation!.meanSignedTowardStance).toBe(0.175);
  });

  it("adversarial-order: the first-mover effect", () => {
    const first = "https://first.example";
    const pairs = [base({ instancesB: [{ sourceUrl: first, stance: "denies" }], credenceB: 0.5 }), base({ instancesB: [{ sourceUrl: first, stance: "denies" }], credenceB: 0.55 })];
    const s = summarizeProperty({ property: "adversarial-order", cluster: "lableak", armA: arm, armB: arm, agreement: report(pairs), firstSourceUrl: first });
    expect(s.firstMover!.n).toBe(2);
    expect(s.firstMover!.meanSignedTowardFirst).toBe(0.175);
    expect(s.reading).toMatch(/First-mover effect: credence leaned toward the first source/);
    const none = summarizeProperty({ property: "adversarial-order", cluster: "lableak", armA: arm, armB: arm, agreement: report([base(), base()]), firstSourceUrl: "https://other" });
    expect(none.reading).toMatch(/not measurable/);
  });

  it("keeps the old readings without a per-claim block", () => {
    const r = report([]);
    delete r.perClaim;
    r.claimSet = { ...r.claimSet, sizeA: 10, sizeB: 10, matched: 9, f1: 0.9 };
    const s = summarizeProperty({ property: "idempotency", cluster: "eggs", armA: arm, armB: arm, agreement: r });
    expect(s.granularity).toBeNull();
    expect(s.reading).toMatch(/reproduced the graph closely/);
    expect(s.reading).not.toMatch(/Granularity/);
  });
});

describe("graph-agreement perClaim", () => {
  const e = (...xs: number[]) => xs;
  const A: AgreementGraph = {
    label: "A",
    claims: [
      { id: "a1", text: "Root claim.", status: "supported", credence: 0.7, embedding: e(1, 0), instances: [{ sourceUrl: "u1", stance: "affirms" }] },
      { id: "a2", text: "Child claim.", status: "supported", credence: 0.6, embedding: e(0, 1) },
      { id: "a3", text: "Grandchild claim.", status: null, credence: null, embedding: e(0.7, 0.7) },
    ],
    edges: [
      { parent: "a1", child: "a2", rel: "requires" },
      { parent: "a2", child: "a3", rel: "requires" },
    ],
  };
  const B: AgreementGraph = {
    label: "B",
    claims: [
      { id: "b1", text: "Root claim.", status: "contested", credence: 0.5, embedding: e(1, 0), instances: [{ sourceUrl: "u1", stance: "affirms" }, { sourceUrl: "u1?dup=1", stance: "affirms" }] },
      { id: "b2", text: "Child claim.", status: "supported", credence: 0.6, embedding: e(0, 1) },
    ],
    edges: [{ parent: "b1", child: "b2", rel: "requires" }],
  };
  it("reports children, depth, verdicts and instances per matched pair", () => {
    const { pairs } = buildMatching(A, B);
    const pc = perClaimAgreement(A, B, pairs);
    expect(pc).toHaveLength(2);
    const root = pc.find((p) => p.a === "a1")!;
    expect(root).toMatchObject({ b: "b1", statusA: "supported", statusB: "contested", credenceA: 0.7, credenceB: 0.5, childrenA: 1, childrenB: 1, depthA: 2, depthB: 1 });
    expect(root.instancesA).toEqual([{ sourceUrl: "u1", stance: "affirms" }]);
    expect(root.instancesB).toHaveLength(2);
    const child = pc.find((p) => p.a === "a2")!;
    expect(child).toMatchObject({ childrenA: 1, childrenB: 0, depthA: 1, depthB: 0, instancesA: [], instancesB: [] });
    expect(graphAgreement(A, B, pairs).perClaim).toEqual(pc);
  });
});
