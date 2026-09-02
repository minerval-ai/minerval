import { describe, it, expect } from "vitest";
import {
  buildMatching,
  claimSetAgreement,
  cosine,
  credenceAgreement,
  graphAgreement,
  normalizeText,
  renderAgreement,
  structuralAgreement,
  type AgreementGraph,
} from "../../../scripts/corpus/graph-agreement.js";

// Embeddings as tiny unit-ish vectors so cosine is legible.
const e = (...xs: number[]) => xs;

const A: AgreementGraph = {
  label: "A",
  claims: [
    { id: "a1", text: "Advanced AI poses a non-negligible risk of human extinction.", createdBy: "extractor", status: "contested", credence: 0.4, embedding: e(1, 0, 0) },
    { id: "a2", text: "Current alignment techniques do not scale to superhuman systems.", createdBy: "claim_steward", status: "supported", credence: 0.7, embedding: e(0, 1, 0) },
    { id: "a3", text: "Interpretability tools can detect deceptive cognition.", createdBy: "claim_steward", status: "unsupported", credence: 0.3, embedding: e(0, 0, 1) },
    { id: "a4", text: "A claim only A has.", createdBy: "claim_steward", status: "supported", credence: 0.6, embedding: e(0.7, 0.7, 0) },
  ],
  edges: [
    { parent: "a1", child: "a2", rel: "requires" },
    { parent: "a1", child: "a3", rel: "contradicts" },
    { parent: "a2", child: "a4", rel: "requires" },
  ],
};

const B: AgreementGraph = {
  label: "B",
  claims: [
    { id: "b1", text: "Advanced AI poses a non-negligible risk of human extinction", createdBy: "extractor", status: "contested", credence: 0.45, embedding: e(1, 0, 0) },
    { id: "b2", text: "Today's alignment methods fail to scale to superhuman AI.", createdBy: "claim_steward", status: "contested", credence: 0.55, embedding: e(0.05, 0.99, 0) },
    { id: "b3", text: "Interpretability can catch deception.", createdBy: "claim_steward", status: "unsupported", credence: null, embedding: e(0, 0.1, 0.99) },
    { id: "b5", text: "A claim only B has.", createdBy: "curator", status: null, credence: null, embedding: e(0, 0.7, 0.7) },
  ],
  edges: [
    { parent: "b1", child: "b2", rel: "requires" },
    { parent: "b1", child: "b3", rel: "supports" },
    { parent: "b2", child: "b5", rel: "requires" },
  ],
};

describe("helpers", () => {
  it("cosine and text normalization", () => {
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0, 10);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(normalizeText("  Hello, World!  ")).toBe("hello world");
  });
});

describe("buildMatching", () => {
  it("matches exact text first, then embeddings greedily one-to-one, flagging the ambiguous band", () => {
    const { pairs, ambiguous } = buildMatching(A, B, { threshold: 0.85, sure: 0.995 });
    const byA = Object.fromEntries(pairs.map((p) => [p.a, p]));
    expect(byA.a1).toMatchObject({ b: "b1", method: "exact", similarity: 1 });
    expect(byA.a2).toMatchObject({ b: "b2", method: "embedding" });
    expect(byA.a3).toMatchObject({ b: "b3", method: "embedding" });
    expect(byA.a4).toBeUndefined();
    expect(pairs).toHaveLength(3);
    // a2↔b2 (~0.999) is sure; a3↔b3 (~0.995) sits in the ambiguous band under this `sure`.
    expect(ambiguous.map((p) => p.a)).toContain("a3");
    expect(ambiguous.map((p) => p.a)).not.toContain("a1");
  });

  it("never reuses a claim on either side", () => {
    const dup: AgreementGraph = {
      label: "D",
      claims: [
        { id: "d1", text: "x", embedding: e(1, 0, 0) },
        { id: "d2", text: "y", embedding: e(0.99, 0.01, 0) },
      ],
      edges: [],
    };
    const one: AgreementGraph = { label: "O", claims: [{ id: "o1", text: "z", embedding: e(1, 0, 0) }], edges: [] };
    const { pairs } = buildMatching(dup, one, { threshold: 0.9 });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]!.a).toBe("d1");
  });
});

describe("the three axes", () => {
  const { pairs } = buildMatching(A, B, { threshold: 0.85 });

  it("claim-set agreement: precision, recall, F1 and attribution of the unmatched", () => {
    const cs = claimSetAgreement(A, B, pairs);
    expect(cs.matched).toBe(3);
    expect(cs.precision).toBeCloseTo(0.75, 3);
    expect(cs.recall).toBeCloseTo(0.75, 3);
    expect(cs.f1).toBeCloseTo(0.75, 3);
    expect(cs.unmatchedA).toEqual(["a4"]);
    expect(cs.unmatchedB).toEqual(["b5"]);
    expect(cs.unmatchedByCreator).toEqual({ a: { claim_steward: 1 }, b: { curator: 1 } });
  });

  it("credence agreement over pairs that both state one, status agreement and confusion", () => {
    const cr = credenceAgreement(A, B, pairs);
    expect(cr.n).toBe(2); // a1/b1 and a2/b2; b3 states none
    expect(cr.meanAbsDiff).toBeCloseTo(0.1, 3);
    expect(cr.within01).toBeCloseTo(0.5, 3);
    expect(cr.oneSided).toBe(1);
    expect(cr.statusN).toBe(3);
    expect(cr.statusAgreement).toBeCloseTo(2 / 3, 3);
    expect(cr.statusConfusion).toEqual({ supported: { contested: 1 } });
  });

  it("structural agreement maps A's edges into B's ids and compares edge sets", () => {
    const st = structuralAgreement(A, B, pairs);
    // A: a1→a2, a1→a3 among matched (a2→a4 dangles); B: b1→b2, b1→b3 (b2→b5 dangles).
    expect(st.edgesA).toBe(2);
    expect(st.edgesB).toBe(2);
    expect(st.sharedIgnoringRel).toBe(2);
    expect(st.sharedWithRel).toBe(1); // contradicts vs supports on a1→a3
    expect(st.precision).toBe(1);
    expect(st.recall).toBe(1);
    expect(st.editDistance).toBe(0);
    expect(st.danglingA).toBe(1);
    expect(st.danglingB).toBe(1);
  });

  it("a graph agrees with itself perfectly", () => {
    const { pairs: self } = buildMatching(A, A);
    const r = graphAgreement(A, A, self);
    expect(r.claimSet.f1).toBe(1);
    expect(r.credence.meanAbsDiff).toBe(0);
    expect(r.credence.statusAgreement).toBe(1);
    expect(r.structure.editDistance).toBe(0);
    expect(r.structure.sharedWithRel).toBe(3);
    expect(renderAgreement(r)).toMatch(/F1 1.000/);
  });

  it("handles empty graphs without dividing by zero", () => {
    const empty: AgreementGraph = { label: "E", claims: [], edges: [] };
    const r = graphAgreement(empty, empty, []);
    expect(r.claimSet.precision).toBeNull();
    expect(r.credence.meanAbsDiff).toBeNull();
    expect(r.structure.precision).toBeNull();
  });
});
