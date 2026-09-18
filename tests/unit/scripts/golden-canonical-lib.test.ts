import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  buildCanonicalJudgePrompt,
  CANONICAL_CATEGORIES,
  CANONICAL_JUDGE_SCHEMA,
  cosine,
  gradeCanonicalCase,
  loadCanonicalFixture,
  pickClosest,
  summarizeCanonical,
  validateCanonicalFixture,
  type CanonicalCase,
} from "../../../scripts/corpus/golden-canonical-lib.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, "../../../corpus/golden/canonical-forms.json");

const aCase: CanonicalCase = {
  id: "dir-x",
  category: "direction",
  sourceTitle: "t",
  excerpt: "one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen.",
  expected: "Eating eggs raises heart disease risk in healthy adults.",
  note: "n",
};

describe("the committed canonical-form fixture", () => {
  const fixture = loadCanonicalFixture(FIXTURE);

  it("is well-formed and covers every category", () => {
    expect(validateCanonicalFixture(fixture)).toEqual([]);
    const seen = new Set(fixture.cases.map((c) => c.category));
    for (const cat of CANONICAL_CATEGORIES) expect(seen.has(cat), `category ${cat}`).toBe(true);
    expect(fixture.cases.length).toBeGreaterThanOrEqual(20);
  });

  it("keeps expected forms in §3's length band", () => {
    for (const c of fixture.cases) {
      expect(c.expected.trim().split(/\s+/).length, c.id).toBeLessThanOrEqual(25);
    }
  });
});

describe("validateCanonicalFixture", () => {
  it("names the problems", () => {
    const bad = {
      version: 1,
      description: "",
      cases: [
        { ...aCase, id: "" },
        { ...aCase, id: "a", category: "nope" as never },
        { ...aCase, id: "a", expected: "Inflation above [threshold] is harmful." },
        { ...aCase, id: "b", excerpt: "too short" },
      ],
    };
    const problems = validateCanonicalFixture(bad);
    expect(problems.some((p) => /missing an id/.test(p))).toBe(true);
    expect(problems.some((p) => /unknown category/.test(p))).toBe(true);
    expect(problems.some((p) => /duplicate id "a"/.test(p))).toBe(true);
    expect(problems.some((p) => /placeholder/.test(p))).toBe(true);
    expect(problems.some((p) => /too short/.test(p))).toBe(true);
    expect(problems.some((p) => /wants ≥15/.test(p))).toBe(true);
  });
});

describe("pickClosest", () => {
  it("returns the proposal with the highest cosine to the expected form", () => {
    const best = pickClosest(
      [1, 0, 0],
      [
        { text: "far", embedding: [0, 1, 0] },
        { text: "near", embedding: [0.9, 0.1, 0] },
        { text: "mid", embedding: [0.5, 0.5, 0] },
      ]
    );
    expect(best?.text).toBe("near");
    expect(best?.index).toBe(1);
    expect(cosine([1, 0], [1, 0])).toBeCloseTo(1, 10);
    expect(pickClosest([1, 0], [])).toBeNull();
  });
});

describe("gradeCanonicalCase", () => {
  const yes = { same_proposition: true, same_direction: true, neutral_no_invented_specificity: true, note: "equivalent" };

  it("passes only when a proposal exists and all three answers are yes", () => {
    const pass = gradeCanonicalCase(aCase, ["p"], { text: "p", similarity: 0.9 }, yes);
    expect(pass.pass).toBe(true);
    expect(pass.failures).toEqual([]);

    const flipped = gradeCanonicalCase(aCase, ["p"], { text: "p", similarity: 0.9 }, { ...yes, same_direction: false });
    expect(flipped.pass).toBe(false);
    expect(flipped.failures).toEqual(["direction flipped"]);

    const sharpened = gradeCanonicalCase(aCase, ["p"], { text: "p", similarity: 0.9 }, { ...yes, neutral_no_invented_specificity: false });
    expect(sharpened.failures).toEqual(["not neutral or added specificity"]);
  });

  it("fails an excerpt that yielded nothing, and a missing verdict", () => {
    expect(gradeCanonicalCase(aCase, [], null, null).failures).toEqual(["extractor proposed no claim for the excerpt"]);
    expect(gradeCanonicalCase(aCase, ["p"], { text: "p", similarity: 0.5 }, null).failures).toEqual(["judge returned no verdict"]);
  });
});

describe("summarizeCanonical", () => {
  const yes = { same_proposition: true, same_direction: true, neutral_no_invented_specificity: true, note: "" };
  it("aggregates by category and names the misses in the reading", () => {
    const results = [
      gradeCanonicalCase({ ...aCase, id: "1", category: "survive" }, ["p"], { text: "p", similarity: 1 }, yes),
      gradeCanonicalCase({ ...aCase, id: "2", category: "survive" }, ["p"], { text: "p", similarity: 1 }, { ...yes, same_proposition: false }),
      gradeCanonicalCase({ ...aCase, id: "3", category: "direction" }, ["p"], { text: "p", similarity: 1 }, { ...yes, same_direction: false }),
      gradeCanonicalCase({ ...aCase, id: "4", category: "hedging" }, [], null, null),
    ];
    const s = summarizeCanonical(results);
    expect(s.total).toBe(4);
    expect(s.passed).toBe(1);
    expect(s.passRate).toBe(0.25);
    expect(s.byCategory.survive).toEqual({ total: 2, passed: 1 });
    expect(s.misses).toEqual({ noProposal: 1, proposition: 1, direction: 1, neutrality: 0 });
    expect(s.reading).toMatch(/wrong direction/);
    expect(s.reading).toMatch(/already-correct forms were rewritten/);
    expect(s.reading).toMatch(/yielded no claim/);
  });
});

describe("the pair-judge prompt and schema", () => {
  it("pins the §3 standard and the three questions, with the case's fields in place", () => {
    const prompt = buildCanonicalJudgePrompt({ excerpt: "EXCERPT", expected: "EXPECTED", proposed: "PROPOSED" });
    expect(prompt).toContain("constitution §3");
    expect(prompt).toContain("## Source excerpt\nEXCERPT");
    expect(prompt).toContain("## Expected canonical form\nEXPECTED");
    expect(prompt).toContain("## Proposed canonical form\nPROPOSED");
    expect(prompt).toMatch(/same proposition\? same direction\? neutral and no invented specificity\?/);
    expect(CANONICAL_JUDGE_SCHEMA.required).toEqual(["same_proposition", "same_direction", "neutral_no_invented_specificity", "note"]);
    expect(CANONICAL_JUDGE_SCHEMA.additionalProperties).toBe(false);
  });
});
