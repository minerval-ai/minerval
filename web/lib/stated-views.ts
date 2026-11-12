import type { QuantityEstimate, StatedView, StatedViewChallenge, StatedViewRelation } from "./types";

// Wording for views stated to the graph directly (constitution §4). A stated
// view is its speaker's; everything this file writes is the page's own
// description of what the speaker recorded, kept short so the speaker's
// words stay the larger part of what a reader sees.

type Kind = StatedView["node"]["kind"];

const KIND_WORD: Record<Kind, string> = { claim: "claim", quantity: "quantity", question: "question" };

export function kindWord(kind: Kind): string {
  return KIND_WORD[kind] ?? "claim";
}

/** A stated figure without its unit, which the node's own page gives. */
export function figureWords(e: QuantityEstimate | null | undefined): string | null {
  if (!e) return null;
  if (e.form === "point" && e.central != null) return String(e.central);
  if (e.form === "interval" && e.low != null && e.high != null) return `${e.low} to ${e.high}`;
  if (e.form === "bound" && e.bound) return `${e.bound.side === "above" ? "above" : "below"} ${e.bound.value}`;
  return null;
}

/** How the speaker stands toward the node, as one phrase. */
export function stanceWords(stance: string, kind: Kind): string {
  const node = kindWord(kind);
  switch (stance) {
    case "affirms":
      return `affirms the ${node}`;
    case "denies":
      return `denies the ${node}`;
    case "qualifies":
      return `holds the ${node} with a qualification`;
    case "gives_probability":
      return `gives the ${node} a probability and takes no side`;
    case "states":
      return "states a figure";
    case "answers":
      return "gives an answer";
    case "open":
      return kind === "quantity" ? "treats the value as open" : `treats the ${node} as open`;
    default:
      return stance.replace(/_/g, " ");
  }
}

/** The stance with the number the speaker gave beside it, where it gave one. */
export function standsLine(v: Pick<StatedView, "stance" | "probability" | "figure" | "node">): string {
  const words = stanceWords(v.stance, v.node.kind);
  const figure = figureWords(v.figure);
  if (v.stance === "states" && figure) return `states ${figure}`;
  if (v.probability != null) return `${words}, probability ${v.probability.toFixed(2)}`;
  return words;
}

/** What became of the reasons, in the page's words. The answer itself is on the record, not here. */
export function challengeLine(challenge: StatedViewChallenge | null, gaveReasons: boolean, fmtDate: (iso: string) => string): string {
  if (!gaveReasons) return "No reasons given.";
  if (!challenge) return "Gave reasons.";
  if (challenge.state === "waiting") {
    return `Gave reasons, put to the Steward as a challenge on ${fmtDate(challenge.sent_at)}. They have not been weighed yet: they wait for the next assessment pass.`;
  }
  const outcome =
    challenge.outcome === "changed"
      ? "the page changed"
      : challenge.outcome === "disagree"
        ? "the Steward disagreed and said why"
        : "the Steward weighed them and changed nothing";
  return `Gave reasons, heard as a challenge and answered on ${fmtDate(challenge.answered_at ?? challenge.sent_at)}: ${outcome}.`;
}

/** The judgment in force on a node, in a few words, for a row that sets a view beside it. */
export function judgmentWords(v: Pick<StatedView, "judgment" | "node">): string {
  const j = v.judgment;
  if (!j) return v.node.kind === "quantity" ? "not yet estimated" : "not yet assessed";
  if (v.node.kind === "quantity") {
    const e = j.estimate;
    if (!e) return "not yet estimated";
    if (e.form === "none") return "no figure given";
    if (e.form === "magnitude" && e.magnitude != null) return `around 10^${e.magnitude}`;
    if (e.form === "distribution" && e.quantiles && e.quantiles.length > 1) {
      return `${e.quantiles[0]!.v} to ${e.quantiles[e.quantiles.length - 1]!.v}`;
    }
    return figureWords(e) ?? "estimated";
  }
  if (v.node.kind === "question") return (j.standing ?? "assessed").replace(/_/g, "-");
  return j.credence != null ? `${j.status}, credence ${j.credence.toFixed(2)}` : (j.status ?? "assessed");
}

export const RELATION_HEADING: Record<StatedViewRelation, string> = {
  differs: "Where the view and the assessment differ",
  not_assessed: "Stated on a page nobody has assessed",
  not_comparable: "Shown side by side, not compared",
  agrees: "In line with the assessment",
};

export const RELATION_NOTE: Record<StatedViewRelation, string> = {
  differs:
    "The speaker's recorded stance, probability or figure lies on one side of the graph's judgment, and each row says which.",
  not_assessed:
    "No assessment exists to set these beside. That is not agreement: the graph has not examined the question.",
  not_comparable:
    "The view and the judgment are not on one scale, so nothing is counted either way. Each row says why.",
  agrees: "The recorded stance, probability or figure lies with the graph's judgment.",
};

/** Each direction a differing view can lie in, for the counts at the head of the list. */
export const DIRECTION_WORDS: Record<string, string> = {
  view_affirms_assessment_against: "affirmed where the assessment is doubtful or contradicted",
  view_denies_assessment_for: "denied where the assessment is supported or verified",
  view_definite_assessment_unsettled: "definite where the assessment finds the matter unsettled",
  view_open_assessment_definite: "treated as open where the assessment is definite",
  view_probability_higher: "given a probability well above the credence",
  view_probability_lower: "given a probability well below the credence",
  view_figure_higher: "given a figure above the estimate's range",
  view_figure_lower: "given a figure below the estimate's range",
  view_answers_assessment_ill_posed: "answered where the assessment finds the question ill-posed",
};
