/**
 * How a stated view stands beside the judgment in force on its node (§4).
 *
 * A stated view is one source's instance, in the speaker's own terms. The
 * graph's judgment is the Steward's. This module sets the two side by side
 * and says, where both are on a scale that can be read against the other,
 * whether they differ and in which direction. It is arithmetic on what each
 * recorded and nothing more: it does not read the statement's words, weigh
 * its reasons, or say which of the two is right. Where the two are not on
 * one scale it says so and gives the reason, and it never places a view on
 * a scale the speaker did not use.
 *
 * What is compared, by the node's kind:
 *
 *   claim     a stated probability with the assessment's credence, where
 *             both exist; otherwise the stance (affirms, denies, open) with
 *             the status. A view that qualifies the claim, or gives only a
 *             probability where the assessment states no credence, is not
 *             compared.
 *   quantity  a stated figure, range or bound with the range of the
 *             estimate. An estimate that is one figure with no range, or an
 *             order of magnitude, gives a single stated figure nothing to
 *             lie inside or outside, so those are not compared.
 *   question  whether each gives an answer or treats the question as open.
 *             Two answers are not compared: whether they are the same answer
 *             takes reading them.
 *
 * A node nobody has assessed is reported as that, never as agreement.
 */
import type { NodeKind, QuantityEstimate } from "../schemas/kinds.js";

/**
 * How far a stated probability must be from the assessment's credence to
 * count as differing. Both numbers are always shown, so the line only sorts
 * rows into lists; it decides nothing about either number.
 */
export const PROBABILITY_GAP = 0.2;

export const VIEW_RELATIONS = ["differs", "agrees", "not_assessed", "not_comparable"] as const;
export type ViewRelation = (typeof VIEW_RELATIONS)[number];

/** Which way a differing view lies from the judgment. */
export const VIEW_DIRECTIONS = [
  // The view affirms; the assessment is doubtful or contradicted.
  "view_affirms_assessment_against",
  // The view denies; the assessment is supported or verified.
  "view_denies_assessment_for",
  // The view takes a side, states a figure or gives an answer; the judgment finds the matter unsettled.
  "view_definite_assessment_unsettled",
  // The view treats the matter as open; the judgment takes a side, gives a figure or gives an answer.
  "view_open_assessment_definite",
  "view_probability_higher",
  "view_probability_lower",
  "view_figure_higher",
  "view_figure_lower",
  // The view answers a question the assessment finds rests on a false presupposition.
  "view_answers_assessment_ill_posed",
] as const;
export type ViewDirection = (typeof VIEW_DIRECTIONS)[number];

export type ComparisonBasis =
  | "probability_and_credence"
  | "stance_and_status"
  | "figure_and_estimate"
  | "stance_and_standing";

export interface ViewComparison {
  relation: ViewRelation;
  /** Set only when relation is "differs". */
  direction: ViewDirection | null;
  /** Which recorded terms were read against each other; null when none were. */
  basis: ComparisonBasis | null;
  /** One or two plain sentences saying what was compared and how it came out, or why nothing was. */
  summary: string;
}

/** The view, as its instance records it. */
export interface ViewPosition {
  kind: NodeKind;
  /** The instance's stance, or the stated view's own before it has an instance. */
  stance: string;
  probability: number | null;
  estimate: QuantityEstimate | null;
}

/** The judgment in force on the node; every field null when the node has not been assessed. */
export interface JudgmentInForce {
  status: string | null;
  credence: number | null;
  estimate: QuantityEstimate | null;
  standing: string | null;
}

const FOR = new Set(["verified", "supported"]);
const AGAINST = new Set(["doubtful", "contradicted"]);
const UNSETTLED = new Set(["inconclusive", "unknown"]);

/** "open" on any kind: the stated view's own word, or the instance stance it is recorded as. */
function treatsAsOpen(stance: string): boolean {
  return stance === "open" || stance === "poses" || stance === "asks";
}

const fixed = (n: number) => n.toFixed(2);
const num = (n: number) => String(Number(n.toPrecision(6)));

interface Range {
  low: number;
  high: number;
  /** The range in words, for the summary. */
  words: string;
}

/**
 * The range a figure in the estimate shape covers, or null where it has
 * none to speak of ("none", an order of magnitude). A single figure is the
 * range from itself to itself, flagged so that two single figures are never
 * called different for not being equal.
 */
export function rangeOfEstimate(e: QuantityEstimate | null): (Range & { single: boolean }) | null {
  if (!e) return null;
  switch (e.form) {
    case "interval":
      if (e.low == null || e.high == null) return null;
      return { low: e.low, high: e.high, words: `${num(e.low)} to ${num(e.high)}`, single: false };
    case "distribution": {
      const q = e.quantiles ?? [];
      if (q.length < 2) return null;
      const first = q[0]!;
      const last = q[q.length - 1]!;
      return {
        low: first.v,
        high: last.v,
        words:
          `${num(first.v)} to ${num(last.v)} ` +
          `(its ${Math.round(first.p * 100)}% and ${Math.round(last.p * 100)}% points)`,
        single: false,
      };
    }
    case "bound":
      if (!e.bound) return null;
      return e.bound.side === "above"
        ? { low: e.bound.value, high: Infinity, words: `above ${num(e.bound.value)}`, single: false }
        : { low: -Infinity, high: e.bound.value, words: `below ${num(e.bound.value)}`, single: false };
    case "point":
      if (e.central == null) return null;
      return { low: e.central, high: e.central, words: num(e.central), single: true };
    default:
      return null;
  }
}

function compareClaim(view: ViewPosition, judgment: JudgmentInForce): ViewComparison {
  const status = judgment.status;
  if (!status) return notAssessed("claim");

  if (view.probability != null && judgment.credence != null) {
    // To two places, the precision both are shown at: the columns are
    // single-precision, so 0.7 against 0.5 would otherwise fall just short
    // of a gap the reader sees as 0.20.
    const gap = Math.round((view.probability - judgment.credence) * 100) / 100;
    const both =
      `The view gives the claim a probability of ${fixed(view.probability)}. ` +
      `The assessment's credence is ${fixed(judgment.credence)}`;
    if (Math.abs(gap) < PROBABILITY_GAP) {
      return {
        relation: "agrees",
        direction: null,
        basis: "probability_and_credence",
        summary: `${both}, within ${fixed(PROBABILITY_GAP)} of it.`,
      };
    }
    return {
      relation: "differs",
      direction: gap > 0 ? "view_probability_higher" : "view_probability_lower",
      basis: "probability_and_credence",
      summary: `${both}: the view is ${fixed(Math.abs(gap))} ${gap > 0 ? "higher" : "lower"}.`,
    };
  }

  const side = view.stance === "affirms" ? "affirms" : view.stance === "denies" ? "denies" : null;
  if (side) {
    const said = `The view ${side} the claim. The assessment is ${status}.`;
    const agrees = side === "affirms" ? FOR.has(status) : AGAINST.has(status);
    if (agrees) return { relation: "agrees", direction: null, basis: "stance_and_status", summary: said };
    if (UNSETTLED.has(status)) {
      return {
        relation: "differs",
        direction: "view_definite_assessment_unsettled",
        basis: "stance_and_status",
        summary: `${said} The view takes a side where the assessment finds the evidence does not settle the claim.`,
      };
    }
    if (FOR.has(status) || AGAINST.has(status)) {
      return {
        relation: "differs",
        direction: side === "affirms" ? "view_affirms_assessment_against" : "view_denies_assessment_for",
        basis: "stance_and_status",
        summary: said,
      };
    }
    return notComparable(`${said} That status is not one this comparison reads.`);
  }

  if (treatsAsOpen(view.stance)) {
    const said = `The view treats the claim as open. The assessment is ${status}.`;
    if (UNSETTLED.has(status)) return { relation: "agrees", direction: null, basis: "stance_and_status", summary: said };
    if (FOR.has(status) || AGAINST.has(status)) {
      return {
        relation: "differs",
        direction: "view_open_assessment_definite",
        basis: "stance_and_status",
        summary: `${said} The assessment takes a side where the view does not.`,
      };
    }
    return notComparable(`${said} That status is not one this comparison reads.`);
  }

  if (view.stance === "qualifies") {
    return notComparable(
      `The view holds the claim only with a qualification, which a status of ${status} neither matches nor ` +
        `contradicts. Whether the two differ depends on the qualification, so they are shown side by side and not compared.`
    );
  }
  if (view.stance === "gives_probability" && view.probability != null) {
    return notComparable(
      `The view gives the claim a probability of ${fixed(view.probability)} and takes no side. The assessment is ` +
        `${status} and states no credence, so the two are not on one scale.`
    );
  }
  return notComparable(`The view's stance ("${view.stance}") is not one this comparison reads against a status.`);
}

function compareQuantity(view: ViewPosition, judgment: JudgmentInForce): ViewComparison {
  const estimate = judgment.estimate;
  if (!estimate) return notAssessed("quantity");
  const graph = rangeOfEstimate(estimate);
  const noFigure = estimate.form === "none";

  if (treatsAsOpen(view.stance)) {
    if (noFigure) {
      return {
        relation: "agrees",
        direction: null,
        basis: "figure_and_estimate",
        summary: "The view treats the value as open. The estimate gives no figure either.",
      };
    }
    return {
      relation: "differs",
      direction: "view_open_assessment_definite",
      basis: "figure_and_estimate",
      summary: "The view treats the value as open. The estimate gives a figure.",
    };
  }

  const stated = rangeOfEstimate(view.estimate);
  if (!stated) {
    return notComparable("The view states no figure in a form that can be placed on the estimate's range.");
  }
  if (noFigure) {
    return {
      relation: "differs",
      direction: "view_definite_assessment_unsettled",
      basis: "figure_and_estimate",
      summary: `The view states ${stated.words}. The estimate gives no figure.`,
    };
  }
  if (!graph) {
    return notComparable(
      `The view states ${stated.words}. The estimate is an order of magnitude, which gives the stated figure no range to lie inside or outside.`
    );
  }
  if (graph.single && stated.single) {
    if (graph.low === stated.low) {
      return {
        relation: "agrees",
        direction: null,
        basis: "figure_and_estimate",
        summary: `The view states ${stated.words}, the figure the estimate gives.`,
      };
    }
    return notComparable(
      `The view states ${stated.words}. The estimate is ${graph.words}, one figure with no range, so there is ` +
        `nothing for the stated figure to lie inside or outside.`
    );
  }
  const said = `The view states ${stated.words}. The estimate's range is ${graph.words}`;
  if (stated.low > graph.high) {
    return {
      relation: "differs",
      direction: "view_figure_higher",
      basis: "figure_and_estimate",
      summary: `${said}: the view lies above it.`,
    };
  }
  if (stated.high < graph.low) {
    return {
      relation: "differs",
      direction: "view_figure_lower",
      basis: "figure_and_estimate",
      summary: `${said}: the view lies below it.`,
    };
  }
  return {
    relation: "agrees",
    direction: null,
    basis: "figure_and_estimate",
    summary: `${said}, which the view lies within or overlaps.`,
  };
}

function compareQuestion(view: ViewPosition, judgment: JudgmentInForce): ViewComparison {
  const standing = judgment.standing;
  if (!standing) return notAssessed("question");
  const settled = standing === "answered" || standing === "leaning";
  const unsettled = standing === "open" || standing === "unknown";
  const standingWords = standing.replace(/_/g, "-");

  if (treatsAsOpen(view.stance)) {
    const said = `The view treats the question as open. The assessment finds it ${standingWords}.`;
    if (unsettled) return { relation: "agrees", direction: null, basis: "stance_and_standing", summary: said };
    if (settled) {
      return {
        relation: "differs",
        direction: "view_open_assessment_definite",
        basis: "stance_and_standing",
        summary: `${said} The assessment gives an answer where the view does not.`,
      };
    }
    return notComparable(`${said} A question that rests on a false presupposition is neither open nor answered.`);
  }
  if (view.stance === "answers") {
    const said = `The view gives an answer. The assessment finds the question ${standingWords}.`;
    if (unsettled) {
      return {
        relation: "differs",
        direction: "view_definite_assessment_unsettled",
        basis: "stance_and_standing",
        summary: said,
      };
    }
    if (standing === "ill_posed") {
      return {
        relation: "differs",
        direction: "view_answers_assessment_ill_posed",
        basis: "stance_and_standing",
        summary: `${said} The view answers a question the assessment finds rests on a false presupposition.`,
      };
    }
    return notComparable(
      `${said} Both give an answer, and whether it is the same answer takes reading them, so they are shown side by side and not compared.`
    );
  }
  return notComparable(`The view's stance ("${view.stance}") is not one this comparison reads against a question's standing.`);
}

function notAssessed(kind: NodeKind): ViewComparison {
  const what = kind === "quantity" ? "estimated" : "assessed";
  return {
    relation: "not_assessed",
    direction: null,
    basis: null,
    summary: `This ${kind} has not been ${what}, so there is nothing to set the view beside. That is not agreement.`,
  };
}

function notComparable(summary: string): ViewComparison {
  return { relation: "not_comparable", direction: null, basis: null, summary };
}

/** Set a stated view beside the judgment in force on its node. */
export function compareStatedView(view: ViewPosition, judgment: JudgmentInForce): ViewComparison {
  if (view.kind === "quantity") return compareQuantity(view, judgment);
  if (view.kind === "question") return compareQuestion(view, judgment);
  return compareClaim(view, judgment);
}

/** Each direction in a few words, for a count or a heading. Spelled the same in every English. */
export const VIEW_DIRECTION_WORDS: Record<ViewDirection, string> = {
  view_affirms_assessment_against: "the view affirms, the assessment is doubtful or contradicted",
  view_denies_assessment_for: "the view denies, the assessment is supported or verified",
  view_definite_assessment_unsettled: "the view is definite, the assessment finds the matter unsettled",
  view_open_assessment_definite: "the view treats it as open, the assessment is definite",
  view_probability_higher: "the stated probability is well above the credence",
  view_probability_lower: "the stated probability is well below the credence",
  view_figure_higher: "the stated figure is above the estimate's range",
  view_figure_lower: "the stated figure is below the estimate's range",
  view_answers_assessment_ill_posed: "the view answers, the assessment finds the question ill-posed",
};
