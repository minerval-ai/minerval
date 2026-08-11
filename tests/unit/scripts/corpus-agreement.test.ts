import { describe, it, expect } from "vitest";
import {
  computeGraphAgreement,
  pairByNormalizedText,
  pairByEmbedding,
  normalizeClaimText,
  cosine,
  formatAgreement,
} from "../../../scripts/corpus/agreement.js";
import type { GraphSnapshot } from "../../../scripts/corpus/metrics.js";

type ClaimSpec = { id: string; text: string; createdBy?: string };
type EdgeSpec = { parent: string; child: string; rel?: string };
type AssessSpec = { claimId: string; status: string; confidence?: number };

function graph(
  claims: ClaimSpec[],
  edges: EdgeSpec[] = [],
  assessments: AssessSpec[] = []
): GraphSnapshot {
  return {
    claims: claims.map((c) => ({
      id: c.id,
      text: c.text,
      claimType: "empirical_derived",
      importance: 0.5,
      createdBy: c.createdBy ?? "extractor",
    })),
    edges: edges.map((e) => ({ parent: e.parent, child: e.child, rel: e.rel ?? "requires" })),
    assessments: assessments.map((a) => ({
      claimId: a.claimId,
      status: a.status,
      confidence: a.confidence ?? 0.7,
      reasoningTrace: "trace",
    })),
    instances: [],
    sourceWords: 1000,
  };
}

describe("normalizeClaimText", () => {
  it("ignores case, punctuation, curly quotes and spacing", () => {
    expect(normalizeClaimText("The LHC  is “safe”, probably.")).toBe(
      normalizeClaimText("the lhc is safe probably")
    );
  });
});

describe("cosine", () => {
  it("is 1 for parallel, 0 for orthogonal, and 0 for a zero vector", () => {
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("pairByNormalizedText", () => {
  it("pairs claims whose canonical text agrees up to punctuation", () => {
    const a = graph([{ id: "a1", text: "Micro black holes decay quickly" }]);
    const b = graph([{ id: "b1", text: "micro black holes decay quickly!" }]);
    expect(pairByNormalizedText(a, b).pairs).toEqual([{ a: "a1", b: "b1", score: 1 }]);
  });

  it("never uses a B-claim twice, and resolves ambiguity deterministically", () => {
    const a = graph([
      { id: "a2", text: "Same text" },
      { id: "a1", text: "Same text" },
    ]);
    const b = graph([
      { id: "b2", text: "same text" },
      { id: "b1", text: "same text" },
    ]);
    const first = pairByNormalizedText(a, b).pairs;
    // Sorted-id traversal on both sides: a1↔b1, a2↔b2 — and re-running with
    // the rows in a different order must not change that.
    expect(first).toEqual([
      { a: "a1", b: "b1", score: 1 },
      { a: "a2", b: "b2", score: 1 },
    ]);
    const reordered = pairByNormalizedText(
      graph([...a.claims].reverse().map((c) => ({ id: c.id, text: c.text }))),
      graph([...b.claims].reverse().map((c) => ({ id: c.id, text: c.text })))
    );
    expect(reordered.pairs).toEqual(first);
  });

  it("leaves genuinely different claims unpaired", () => {
    const a = graph([{ id: "a1", text: "Black holes evaporate" }]);
    const b = graph([{ id: "b1", text: "Eggs raise cholesterol" }]);
    expect(pairByNormalizedText(a, b).pairs).toEqual([]);
  });
});

describe("pairByEmbedding", () => {
  const vectors = new Map<string, number[]>([
    ["a1", [1, 0, 0]],
    ["a2", [0, 1, 0]],
    ["b1", [0.99, 0.1, 0]],
    ["b2", [0, 0.98, 0.05]],
  ]);

  it("greedily assigns best matches above the floor, each claim once", () => {
    const a = graph([
      { id: "a1", text: "one" },
      { id: "a2", text: "two" },
    ]);
    const b = graph([
      { id: "b1", text: "uno" },
      { id: "b2", text: "dos" },
    ]);
    const pairs = pairByEmbedding(a, b, vectors).pairs;
    // Emission order follows descending similarity, which is an artifact of
    // the greedy pass, not a contract — the ASSIGNMENT is what's asserted.
    expect(pairs.map((p) => [p.a, p.b]).sort()).toEqual([
      ["a1", "b1"],
      ["a2", "b2"],
    ]);
  });

  it("drops pairs below the similarity floor", () => {
    const a = graph([{ id: "a1", text: "one" }]);
    const b = graph([{ id: "b2", text: "dos" }]);
    // a1·b2 ≈ 0 — far under the 0.4 floor.
    expect(pairByEmbedding(a, b, vectors).pairs).toEqual([]);
  });

  it("skips claims with no vector rather than guessing", () => {
    const a = graph([{ id: "a1", text: "one" }]);
    const b = graph([{ id: "unknown", text: "uno" }]);
    expect(pairByEmbedding(a, b, vectors).pairs).toEqual([]);
  });
});

describe("computeGraphAgreement", () => {
  it("reports perfect agreement for a graph against itself", () => {
    const g = graph(
      [
        { id: "r", text: "Root claim" },
        { id: "c", text: "Child claim" },
      ],
      [{ parent: "r", child: "c" }],
      [
        { claimId: "r", status: "supported", confidence: 0.6 },
        { claimId: "c", status: "verified", confidence: 0.9 },
      ]
    );
    const x = computeGraphAgreement(g, g, pairByNormalizedText(g, g));
    expect(x.claimSet.f1).toBe(1);
    expect(x.structure.jaccard).toBe(1);
    expect(x.credence.statusAgreement).toBe(1);
    expect(x.credence.meanAbsConfidenceDelta).toBe(0);
    expect(x.composite).toBe(1);
    expect(x.attribution).toEqual({});
  });

  it("treats two empty graphs as agreeing, and empty-vs-populated as not", () => {
    const empty = graph([]);
    const one = graph([{ id: "a1", text: "Something" }]);
    expect(computeGraphAgreement(empty, empty, { pairs: [] }).composite).toBe(1);
    const x = computeGraphAgreement(empty, one, { pairs: [] });
    expect(x.claimSet.precision).toBe(0);
    expect(x.claimSet.recall).toBe(1); // nothing to recall
    expect(x.claimSet.f1).toBe(0);
  });

  it("splits a missed claim from an invented one across recall and precision", () => {
    const a = graph([
      { id: "a1", text: "Kept claim" },
      { id: "a2", text: "Dropped claim" },
    ]);
    const b = graph([
      { id: "b1", text: "Kept claim" },
      { id: "b2", text: "Invented claim" },
    ]);
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.claimSet.matched).toBe(1);
    expect(x.claimSet.recall).toBeCloseTo(0.5);
    expect(x.claimSet.precision).toBeCloseTo(0.5);
    expect(x.claimSet.onlyInA).toEqual(["a2"]);
    expect(x.claimSet.onlyInB).toEqual(["b2"]);
  });

  it("compares only edges whose endpoints both matched, so one divergence is charged once", () => {
    // B drops claim `c` entirely; the r→c edge must count as a CLAIM-set
    // difference, not additionally as a structural one.
    const a = graph(
      [
        { id: "r", text: "Root" },
        { id: "c", text: "Child" },
      ],
      [{ parent: "r", child: "c" }]
    );
    const b = graph([{ id: "r2", text: "Root" }]);
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.claimSet.onlyInA).toEqual(["c"]);
    expect(x.structure.comparableEdges).toEqual({ a: 0, b: 0 });
    expect(x.structure.jaccard).toBe(1); // nothing comparable ⇒ no structural penalty
  });

  it("detects a re-parented subclaim as a structural difference", () => {
    const a = graph(
      [
        { id: "r", text: "Root" },
        { id: "m", text: "Middle" },
        { id: "l", text: "Leaf" },
      ],
      [
        { parent: "r", child: "m" },
        { parent: "m", child: "l" },
      ]
    );
    // Same three claims, but the leaf hangs off the root directly.
    const b = graph(
      [
        { id: "R", text: "Root" },
        { id: "M", text: "Middle" },
        { id: "L", text: "Leaf" },
      ],
      [
        { parent: "R", child: "M" },
        { parent: "R", child: "L" },
      ]
    );
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.claimSet.f1).toBe(1); // claim sets agree completely
    expect(x.structure.shared).toBe(1);
    expect(x.structure.onlyInA).toBe(1);
    expect(x.structure.onlyInB).toBe(1);
    expect(x.structure.jaccard).toBeCloseTo(1 / 3);
  });

  it("flags a same-pair relation change without calling the edge missing", () => {
    const a = graph(
      [
        { id: "r", text: "Root" },
        { id: "c", text: "Child" },
      ],
      [{ parent: "r", child: "c", rel: "requires" }]
    );
    const b = graph(
      [
        { id: "R", text: "Root" },
        { id: "C", text: "Child" },
      ],
      [{ parent: "R", child: "C", rel: "supports" }]
    );
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.structure.shared).toBe(1);
    expect(x.structure.relationMismatches).toBe(1);
    expect(x.structure.jaccard).toBe(1);
  });

  it("scores credence disagreement and singles out polar flips", () => {
    const claims = [
      { id: "x", text: "Flipped claim" },
      { id: "y", text: "Softened claim" },
    ];
    const a = graph(claims, [], [
      { claimId: "x", status: "verified", confidence: 0.9 },
      { claimId: "y", status: "supported", confidence: 0.8 },
    ]);
    const b = graph(
      claims.map((c) => ({ ...c, id: c.id.toUpperCase() })),
      [],
      [
        { claimId: "X", status: "contradicted", confidence: 0.7 },
        { claimId: "Y", status: "contested", confidence: 0.5 },
      ]
    );
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.credence.comparable).toBe(2);
    expect(x.credence.statusAgreement).toBe(0);
    expect(x.credence.polarFlips).toBe(1); // verified→contradicted only
    expect(x.credence.meanAbsConfidenceDelta).toBeCloseTo(0.25);
    expect(x.credence.disagreements).toHaveLength(2);
  });

  it("ignores claims assessed on only one side", () => {
    const claims = [{ id: "p", text: "Pending on one side" }];
    const a = graph(claims, [], [{ claimId: "p", status: "supported" }]);
    const b = graph([{ id: "P", text: "Pending on one side" }], [], []);
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.credence.comparable).toBe(0);
    expect(x.credence.statusAgreement).toBe(1); // vacuous, not a penalty
  });

  it("buckets divergence by the agent that created the claim", () => {
    const a = graph(
      [
        { id: "e1", text: "Extractor claim", createdBy: "extractor" },
        { id: "s1", text: "Steward subclaim", createdBy: "claim_steward" },
        { id: "s2", text: "Assessed subclaim", createdBy: "claim_steward" },
      ],
      [],
      [{ claimId: "s2", status: "verified" }]
    );
    const b = graph(
      [
        { id: "E1", text: "Extractor claim", createdBy: "extractor" },
        { id: "S2", text: "Assessed subclaim", createdBy: "claim_steward" },
        { id: "N1", text: "Novel curator claim", createdBy: "curator" },
      ],
      [],
      [{ claimId: "S2", status: "contradicted" }]
    );
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.attribution.claim_steward).toEqual({
      unmatchedA: 1, // s1 vanished
      unmatchedB: 0,
      statusDisagreements: 1, // s2 flipped
    });
    expect(x.attribution.curator).toEqual({
      unmatchedA: 0,
      unmatchedB: 1, // N1 appeared
      statusDisagreements: 0,
    });
    expect(x.attribution.extractor).toBeUndefined(); // agreed completely
  });

  it("keeps a vacuous axis out of the composite", () => {
    // A ran the Steward (edges + assessments); B was drained with it parked.
    // B's credence axis has nothing to compare, and must not bank a free 1 —
    // this is the epoch-baseline-vs-parked-snapshot case, seen live.
    const a = graph(
      [
        { id: "r", text: "Root" },
        { id: "c", text: "Child", createdBy: "claim_steward" },
      ],
      [{ parent: "r", child: "c" }],
      [{ claimId: "r", status: "verified" }]
    );
    const b = graph([{ id: "R", text: "Root" }]);
    const x = computeGraphAgreement(a, b, pairByNormalizedText(a, b));
    expect(x.axesCompared).toEqual({ claimSet: true, structure: false, credence: false });
    // Only the claim-set axis is live, so the composite IS the F1 — not an
    // average dragged upward by two vacuous 1s.
    expect(x.composite).toBeCloseTo(x.claimSet.f1);
    expect(x.composite).toBeLessThan(1);
  });

  it("scores two empty graphs as agreeing with no live axes", () => {
    const x = computeGraphAgreement(graph([]), graph([]), { pairs: [] });
    expect(x.axesCompared).toEqual({ claimSet: false, structure: false, credence: false });
    expect(x.composite).toBe(1);
  });

  it("summarizes to one line", () => {
    const g = graph([{ id: "a", text: "Only claim" }]);
    expect(formatAgreement(computeGraphAgreement(g, g, pairByNormalizedText(g, g)))).toContain(
      "composite 1.000"
    );
  });
});
