import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  gradeDecision,
  loadGoldenFixture,
  summarize,
  validateGoldenFixture,
  type GoldenPair,
} from "../../../scripts/corpus/golden-lib.js";
import type { MatchDecision } from "../../../src/llm/agents/matcher.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../../corpus/golden/matcher-pairs.json");

const decision = (over: Partial<MatchDecision>): MatchDecision => ({
  is_match: false,
  matched_claim_id: null,
  new_canonical_form: null,
  instance_stance: "affirms",
  confidence: 0.9,
  reasoning: "r",
  alternative_matches: [],
  relationship_notes: null,
  ...over,
});

const matchPair: GoldenPair = {
  id: "p1",
  category: "paraphrase",
  existing: ["A", "B"],
  candidate: { extractedText: "x", proposedCanonical: "y" },
  expect: { isMatch: true, matchedIndex: 0, stance: "affirms" },
  note: "n",
};

const noMatchPair: GoldenPair = {
  ...matchPair,
  id: "p2",
  category: "specification",
  expect: { isMatch: false },
};

describe("the committed fixture set", () => {
  it("is well-formed, with every category represented", () => {
    const fixture = loadGoldenFixture(FIXTURE);
    expect(validateGoldenFixture(fixture)).toEqual([]);
    const categories = new Set(fixture.pairs.map((p) => p.category));
    for (const c of ["paraphrase", "negation", "specification", "similar_but_different", "hard"]) {
      expect(categories).toContain(c);
    }
    // Both stances and both polarities of expectation are exercised.
    expect(fixture.pairs.some((p) => p.expect.isMatch && p.expect.stance === "denies")).toBe(true);
    expect(fixture.pairs.some((p) => !p.expect.isMatch)).toBe(true);
  });
});

describe("gradeDecision", () => {
  const seeded = ["id-a", "id-b"];

  it("passes a correct match with correct stance", () => {
    const r = gradeDecision(
      matchPair,
      decision({ is_match: true, matched_claim_id: "id-a", instance_stance: "affirms" }),
      seeded
    );
    expect(r.pass).toBe(true);
  });

  it("fails a missed match, a wrong-claim match, and a wrong stance", () => {
    expect(gradeDecision(matchPair, decision({ is_match: false }), seeded).pass).toBe(false);
    expect(
      gradeDecision(
        matchPair,
        decision({ is_match: true, matched_claim_id: "id-b", instance_stance: "affirms" }),
        seeded
      ).failures[0]
    ).toMatch(/wrong claim/);
    expect(
      gradeDecision(
        matchPair,
        decision({ is_match: true, matched_claim_id: "id-a", instance_stance: "denies" }),
        seeded
      ).failures[0]
    ).toMatch(/wrong stance/);
  });

  it("fails an over-merge on a no-match pair, passes a clean no-match", () => {
    expect(
      gradeDecision(
        noMatchPair,
        decision({ is_match: true, matched_claim_id: "id-a" }),
        seeded
      ).failures[0]
    ).toMatch(/expected no match/);
    expect(gradeDecision(noMatchPair, decision({ is_match: false }), seeded).pass).toBe(true);
  });
});

describe("summarize", () => {
  it("aggregates by category", () => {
    const results = [
      gradeDecision(matchPair, decision({ is_match: true, matched_claim_id: "id-a" }), ["id-a"]),
      gradeDecision(noMatchPair, decision({ is_match: false }), ["id-a"]),
      gradeDecision(noMatchPair, decision({ is_match: true, matched_claim_id: "id-a" }), ["id-a"]),
    ];
    const s = summarize(results);
    expect(s.total).toBe(3);
    expect(s.passed).toBe(2);
    expect(s.byCategory["specification"]).toEqual({ total: 2, passed: 1 });
  });
});
