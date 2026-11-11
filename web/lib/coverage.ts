import type { Coverage, CoverageRow } from "./types";

// What examination a node has had (#543). The API serves it as `coverage`
// beside the judgment: `examined` says whether a judgment of the node is in
// force, and `on` what that judgment was made on. A status says what the
// evidence shows; this says what evidence was looked at. The page needs two
// things from it. Where there is no judgment, the place a verdict would
// stand is empty, and an empty place is easy to read as nothing being wrong,
// so the page says in words that no verdict exists and that this is not a
// finding. Where the judgment was made in part on a source that reports a
// result from evidence it has not published, the page says so in one quiet
// line under the verdict.

/** What the page calls each kind's judgment and the node itself. */
const KIND_WORDS = {
  claim: { lead: "Not yet assessed", carries: "no verdict", about: "for or against the claim" },
  quantity: { lead: "Not yet estimated", carries: "no estimate from the graph", about: "about the value" },
  question: { lead: "Not yet assessed", carries: "no answer from the graph", about: "about the answer" },
} as const;

export type CoverageKind = keyof typeof KIND_WORDS;

/**
 * The words for a node with no judgment in force, in place of a verdict.
 * They are the same whatever else the node carries (a seed, sources,
 * readings): none of those is a judgment. `afterLead` is for a place that
 * has just said "Not yet estimated" itself (a quantity's head), where the
 * line would otherwise say it twice.
 */
export function notExaminedLine(kind: CoverageKind, opts: { afterLead?: boolean } = {}): string {
  const w = KIND_WORDS[kind];
  const first = opts.afterLead ? "This page carries" : `${w.lead}, so this page carries`;
  return `${first} ${w.carries}. That is not a finding ${w.about}.`;
}

/**
 * Whether the node has been examined, for a node of a tree or a whole read.
 * `coverage` decides when the API serves it; `judged` is what the caller can
 * tell from the judgment fields it holds, for an API that predates the field.
 */
export function isExamined(coverage: CoverageRow | null | undefined, judged: boolean): boolean {
  return coverage ? coverage.examined : judged;
}

/**
 * The line under a verdict that was made in part on evidence not shown, or
 * null when there is nothing to say: no judgment, or none of its sources
 * read that way. `judgment` is the word the page uses for the node's
 * judgment ("assessment" for a claim, "estimate" for a quantity).
 */
export function evidenceNotShownLine(
  coverage: Coverage | null | undefined,
  judgment: "assessment" | "estimate" = "assessment",
): string | null {
  if (!coverage || !coverage.examined || !coverage.on.includes("evidence_not_shown")) return null;
  return (
    `This ${judgment} rests in part on evidence not shown: ` +
    "at least one of its sources reports a result from data it has not published."
  );
}
