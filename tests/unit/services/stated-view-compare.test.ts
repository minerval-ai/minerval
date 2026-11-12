/**
 * How a stated view is set beside the judgment in force (§4): what counts as
 * differing and in which direction, what counts as agreeing, and the cases
 * that are reported as not assessed or not comparable instead of being
 * forced onto a scale.
 */
import { describe, it, expect } from "vitest";
import {
  PROBABILITY_GAP,
  VIEW_DIRECTIONS,
  VIEW_DIRECTION_WORDS,
  compareStatedView,
  rangeOfEstimate,
  type JudgmentInForce,
  type ViewPosition,
} from "../../../src/services/stated-view-compare.js";
import { parseStatedView } from "../../../src/services/stated-view-service.js";
import { instanceStanceForStatedView, STATED_VIEW_STANCES } from "../../../src/schemas/common.js";

const none: JudgmentInForce = { status: null, credence: null, estimate: null, standing: null };
const claim = (stance: string, probability: number | null = null): ViewPosition => ({
  kind: "claim",
  stance,
  probability,
  estimate: null,
});
const assessed = (status: string, credence: number | null = null): JudgmentInForce => ({ ...none, status, credence });

describe("a stated view on a claim", () => {
  it("is not compared with a claim nobody has assessed, and says that is not agreement", () => {
    const c = compareStatedView(claim("affirms"), none);
    expect(c.relation).toBe("not_assessed");
    expect(c.direction).toBeNull();
    expect(c.summary).toContain("That is not agreement.");
  });

  it("differs when it affirms and the assessment is doubtful or contradicted", () => {
    for (const status of ["doubtful", "contradicted"]) {
      const c = compareStatedView(claim("affirms"), assessed(status));
      expect(c).toMatchObject({ relation: "differs", direction: "view_affirms_assessment_against", basis: "stance_and_status" });
    }
  });

  it("differs when it denies and the assessment is supported or verified", () => {
    for (const status of ["supported", "verified"]) {
      const c = compareStatedView(claim("denies"), assessed(status));
      expect(c).toMatchObject({ relation: "differs", direction: "view_denies_assessment_for" });
    }
  });

  it("agrees when it takes the side the assessment takes", () => {
    expect(compareStatedView(claim("affirms"), assessed("verified")).relation).toBe("agrees");
    expect(compareStatedView(claim("denies"), assessed("contradicted")).relation).toBe("agrees");
  });

  it("differs when one takes a side and the other finds the matter unsettled, and says which", () => {
    expect(compareStatedView(claim("affirms"), assessed("inconclusive")).direction).toBe("view_definite_assessment_unsettled");
    expect(compareStatedView(claim("denies"), assessed("unknown")).direction).toBe("view_definite_assessment_unsettled");
    expect(compareStatedView(claim("open"), assessed("supported")).direction).toBe("view_open_assessment_definite");
    // The instance of a view that treats the claim as open is recorded as posing it.
    expect(compareStatedView(claim("poses"), assessed("contradicted")).direction).toBe("view_open_assessment_definite");
    expect(compareStatedView(claim("open"), assessed("inconclusive")).relation).toBe("agrees");
  });

  it("reads a stated probability against the credence, wherever both exist", () => {
    const far = compareStatedView(claim("affirms", 0.9), assessed("supported", 0.6));
    expect(far).toMatchObject({ relation: "differs", direction: "view_probability_higher", basis: "probability_and_credence" });
    expect(far.summary).toContain("0.90");
    expect(far.summary).toContain("0.60");
    expect(far.summary).toContain("0.30 higher");
    expect(compareStatedView(claim("gives_probability", 0.1), assessed("supported", 0.7)).direction).toBe("view_probability_lower");
    const near = compareStatedView(claim("gives_probability", 0.55), assessed("supported", 0.7));
    expect(near.relation).toBe("agrees");
    // The line itself: a gap of exactly the threshold differs, one just under does not.
    expect(compareStatedView(claim("affirms", 0.5 + PROBABILITY_GAP), assessed("inconclusive", 0.5)).relation).toBe("differs");
    expect(compareStatedView(claim("affirms", 0.5 + PROBABILITY_GAP - 0.01), assessed("inconclusive", 0.5)).relation).toBe("agrees");
  });

  it("falls back to the stance when the assessment states no credence", () => {
    const c = compareStatedView(claim("affirms", 0.95), assessed("contradicted"));
    expect(c).toMatchObject({ relation: "differs", direction: "view_affirms_assessment_against", basis: "stance_and_status" });
  });

  it("does not put a qualified view, or a bare probability with no credence beside it, on a scale", () => {
    const q = compareStatedView(claim("qualifies"), assessed("supported"));
    expect(q).toMatchObject({ relation: "not_comparable", direction: null, basis: null });
    const p = compareStatedView(claim("gives_probability", 0.3), assessed("doubtful"));
    expect(p.relation).toBe("not_comparable");
    expect(p.summary).toContain("not on one scale");
    // A qualified view that also gives a probability is compared on the numbers both gave.
    expect(compareStatedView(claim("qualifies", 0.2), assessed("supported", 0.8)).relation).toBe("differs");
  });
});

describe("a stated view on a quantity", () => {
  const states = (estimate: ViewPosition["estimate"]): ViewPosition => ({ kind: "quantity", stance: "states", probability: null, estimate });
  const estimated = (estimate: JudgmentInForce["estimate"]): JudgmentInForce => ({ ...none, estimate });
  const interval = (low: number, high: number) => ({ form: "interval" as const, low, high });
  const point = (central: number) => ({ form: "point" as const, central });

  it("is not compared with a quantity nobody has estimated", () => {
    expect(compareStatedView(states(point(4)), none).relation).toBe("not_assessed");
  });

  it("differs when the stated figure lies outside the estimate's range, and says on which side", () => {
    expect(compareStatedView(states(point(12)), estimated(interval(3, 8)))).toMatchObject({
      relation: "differs",
      direction: "view_figure_higher",
      basis: "figure_and_estimate",
    });
    expect(compareStatedView(states(point(1)), estimated(interval(3, 8))).direction).toBe("view_figure_lower");
    expect(compareStatedView(states(interval(9, 11)), estimated(interval(3, 8))).direction).toBe("view_figure_higher");
    expect(
      compareStatedView(states({ form: "bound", bound: { side: "above", value: 20 } }), estimated(interval(3, 8))).direction
    ).toBe("view_figure_higher");
  });

  it("agrees when the stated figure lies within or overlaps the range", () => {
    expect(compareStatedView(states(point(5)), estimated(interval(3, 8))).relation).toBe("agrees");
    expect(compareStatedView(states(interval(7, 20)), estimated(interval(3, 8))).relation).toBe("agrees");
    expect(compareStatedView(states({ form: "bound", bound: { side: "above", value: 2 } }), estimated(interval(3, 8))).relation).toBe("agrees");
  });

  it("uses a distribution's outermost points as its range", () => {
    const d = { form: "distribution" as const, quantiles: [{ p: 0.05, v: 10 }, { p: 0.5, v: 20 }, { p: 0.95, v: 40 }] };
    expect(rangeOfEstimate(d)).toMatchObject({ low: 10, high: 40 });
    expect(compareStatedView(states(point(50)), estimated(d)).direction).toBe("view_figure_higher");
    expect(compareStatedView(states(point(30)), estimated(d)).relation).toBe("agrees");
  });

  it("does not call two single figures different for not being equal, or compare with an order of magnitude", () => {
    const c = compareStatedView(states(point(5.1)), estimated(point(5)));
    expect(c.relation).toBe("not_comparable");
    expect(c.summary).toContain("no range");
    expect(compareStatedView(states(point(5)), estimated(point(5))).relation).toBe("agrees");
    expect(compareStatedView(states(point(5)), estimated({ form: "magnitude", magnitude: 6 })).relation).toBe("not_comparable");
    // A stated range can still be placed against one figure.
    expect(compareStatedView(states(interval(6, 9)), estimated(point(5))).direction).toBe("view_figure_higher");
  });

  it("reads a view that treats the value as open against whether the estimate gives a figure", () => {
    const open: ViewPosition = { kind: "quantity", stance: "poses", probability: null, estimate: null };
    expect(compareStatedView(open, estimated(interval(3, 8))).direction).toBe("view_open_assessment_definite");
    expect(compareStatedView(open, estimated({ form: "none", reason: "no basis for a figure" })).relation).toBe("agrees");
    expect(compareStatedView(states(point(4)), estimated({ form: "none", reason: "no basis for a figure" })).direction).toBe(
      "view_definite_assessment_unsettled"
    );
  });
});

describe("a stated view on a question", () => {
  const view = (stance: string): ViewPosition => ({ kind: "question", stance, probability: null, estimate: null });
  const standing = (s: string): JudgmentInForce => ({ ...none, standing: s });

  it("compares giving an answer with treating the question as open, and never two answers", () => {
    expect(compareStatedView(view("answers"), none).relation).toBe("not_assessed");
    expect(compareStatedView(view("answers"), standing("open")).direction).toBe("view_definite_assessment_unsettled");
    expect(compareStatedView(view("asks"), standing("answered")).direction).toBe("view_open_assessment_definite");
    expect(compareStatedView(view("open"), standing("unknown")).relation).toBe("agrees");
    const both = compareStatedView(view("answers"), standing("leaning"));
    expect(both.relation).toBe("not_comparable");
    expect(both.summary).toContain("takes reading them");
    expect(compareStatedView(view("answers"), standing("ill_posed")).direction).toBe("view_answers_assessment_ill_posed");
  });
});

describe("the vocabulary", () => {
  it("has words for every direction", () => {
    expect(Object.keys(VIEW_DIRECTION_WORDS).sort()).toEqual([...VIEW_DIRECTIONS].sort());
  });

  it("records a view that treats the matter as open as the stance each kind already has for that", () => {
    expect(instanceStanceForStatedView("claim", "open")).toBe("poses");
    expect(instanceStanceForStatedView("quantity", "open")).toBe("poses");
    expect(instanceStanceForStatedView("question", "open")).toBe("asks");
    expect(instanceStanceForStatedView("claim", "qualifies")).toBe("qualifies");
    expect(STATED_VIEW_STANCES.claim).toContain("gives_probability");
  });
});

describe("parseStatedView", () => {
  const ok = { statement: "We hold this to be so.", stance: "affirms", no_stake: true };

  it("takes a view with a declared stake, or a declaration that there is none, and never neither", () => {
    expect(parseStatedView("claim", ok)).toMatchObject({ ok: true, view: { stake: null, stance: "affirms", reasons: null } });
    const staked = parseStatedView("claim", { ...ok, no_stake: undefined, stake: " We sell the product. " });
    expect(staked).toMatchObject({ ok: true, view: { stake: "We sell the product." } });
    expect(parseStatedView("claim", { ...ok, no_stake: undefined })).toMatchObject({ ok: false, code: "STAKE" });
    expect(parseStatedView("claim", { ...ok, stake: "x" })).toMatchObject({ ok: false, code: "STAKE" });
  });

  it("holds the stance to the node's kind", () => {
    expect(parseStatedView("question", ok)).toMatchObject({ ok: false, code: "STANCE" });
    expect(parseStatedView("question", { ...ok, stance: "answers" }).ok).toBe(true);
    expect(parseStatedView("quantity", { ...ok, stance: "open" }).ok).toBe(true);
  });

  it("takes a probability on a claim only, and requires one of a view that only gives a probability", () => {
    expect(parseStatedView("claim", { ...ok, probability: 0.8 })).toMatchObject({ ok: true, view: { probability: 0.8 } });
    expect(parseStatedView("claim", { ...ok, probability: 1.2 })).toMatchObject({ ok: false, code: "PROBABILITY" });
    expect(parseStatedView("claim", { ...ok, stance: "gives_probability" })).toMatchObject({ ok: false, code: "PROBABILITY" });
    expect(parseStatedView("question", { ...ok, stance: "answers", probability: 0.5 })).toMatchObject({ ok: false, code: "PROBABILITY" });
  });

  it("takes a figure, a range or a bound for a quantity, and no other form", () => {
    const q = { ...ok, stance: "states" };
    expect(parseStatedView("quantity", q)).toMatchObject({ ok: false, code: "FIGURE" });
    expect(parseStatedView("quantity", { ...q, figure: { form: "point", central: 4 } })).toMatchObject({
      ok: true,
      view: { figure: { form: "point", central: 4 } },
    });
    expect(parseStatedView("quantity", { ...q, figure: { form: "interval", low: 5, high: 2 } })).toMatchObject({ ok: false, code: "FIGURE" });
    expect(parseStatedView("quantity", { ...q, figure: { form: "magnitude", magnitude: 3 } })).toMatchObject({ ok: false, code: "FIGURE" });
    expect(parseStatedView("claim", { ...ok, figure: { form: "point", central: 4 } })).toMatchObject({ ok: false, code: "FIGURE" });
  });

  it("refuses an empty statement and one longer than the limit", () => {
    expect(parseStatedView("claim", { ...ok, statement: "  " })).toMatchObject({ ok: false, code: "STATEMENT_REQUIRED" });
    expect(parseStatedView("claim", { ...ok, statement: "x".repeat(2001) })).toMatchObject({ ok: false, code: "STATEMENT_TOO_LONG" });
  });
});
