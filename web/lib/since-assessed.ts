import type { JudgmentInputs, SinceAssessed } from "./types";
import { QUESTION_STANDING, isStanding, statusMeta } from "./ontology";

// What has changed under a node's judgment since it was written (#566). The
// API serves it beside the judgment as counts: premises judged again (and of
// those, the ones whose verdict moved), premises added or removed, sources
// added or removed, and notices (corrections, retractions) on its sources.
//
// The page says only what moved. A premise judged again to the verdict it
// had is the graph doing its work: under a busy node one is nearly always
// true, and a line that said so would sit under most assessments and mean
// nothing. Agents still read the count of versions (the Steward and the
// Grantmaker decide what is worth a reassessment); the page reads the count
// of verdicts. A judgment written before the record existed answers
// `recorded: false`: nothing is known either way, so the page says nothing
// rather than suggest the assessment is up to date.

function counted(n: number | undefined, one: string, many: string, what: string): string | null {
  return n && n > 0 ? `${n} ${n === 1 ? one : many} ${what}` : null;
}

/**
 * Whether anything a reader should hear of moved under the judgment: a
 * premise's verdict, a premise added or removed, a source added or removed,
 * a notice on a source. A premise judged again to the same verdict is not
 * one. An API that predates `premises_moved` gives no way to tell the two
 * apart, so a premise judged again is then left unsaid.
 */
export function sinceAssessedMoved(since: SinceAssessed | null | undefined): boolean {
  if (!since || since.recorded !== true || since.changed !== true) return false;
  return [
    since.premises_moved,
    since.premises_added,
    since.premises_removed,
    since.sources_added,
    since.sources_removed,
    since.source_events,
  ].some((n) => typeof n === "number" && n > 0);
}

/**
 * The line for the page, or null when there is nothing to say: no judgment,
 * no record, or nothing moved. `judgment` is the word the page uses for
 * the node's judgment ("assessment" for a claim, "estimate" for a quantity).
 */
export function sinceAssessedLine(
  since: SinceAssessed | null | undefined,
  judgment: "assessment" | "estimate" = "assessment",
): string | null {
  if (!since || !sinceAssessedMoved(since)) return null;
  const parts = [
    counted(since.premises_moved, "premise", "premises", "judged differently"),
    counted(since.premises_added, "premise", "premises", "added"),
    counted(since.premises_removed, "premise", "premises", "removed"),
    counted(since.sources_added, "source", "sources", "added"),
    counted(since.sources_removed, "source", "sources", "removed"),
    counted(since.source_events, "notice", "notices", "on its sources"),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? `Since this ${judgment}: ${parts.join(", ")}.` : null;
}

/** A verdict in the page's words: a claim's status or a question's standing. */
export function verdictWord(v: string | null | undefined): string | null {
  if (!v) return null;
  if (isStanding(v)) return QUESTION_STANDING[v].label;
  return statusMeta(v).label;
}

export interface MovedPremise {
  node_id: string;
  text: string | null;
  /** What happened, in words: "verified → doubtful", "judged for the first time", "added", "removed". */
  change: string;
}

/**
 * The premises the page names under the line: those judged to a different
 * verdict, then those added, then those removed. A premise judged again to
 * the verdict it had is left out, as the line leaves it out.
 */
export function movedPremises(inputs: JudgmentInputs | null | undefined): MovedPremise[] {
  if (!inputs || inputs.recorded !== true) return [];
  const out: MovedPremise[] = [];
  for (const p of inputs.premises) {
    if (p.state !== "rejudged" || p.moved !== true) continue;
    const then = verdictWord(p.verdict_then);
    const now = verdictWord(p.verdict_now);
    const change =
      then && now
        ? `${then} → ${now}`
        : !p.verdict_then && now
          ? `judged for the first time: ${now}`
          : then && !p.verdict_now
            ? `${then} → no judgment in force`
            : "estimate changed";
    out.push({ node_id: p.node_id, text: p.text ?? null, change });
  }
  for (const p of inputs.premises_added) {
    const now = verdictWord(p.verdict_now);
    out.push({ node_id: p.node_id, text: p.text ?? null, change: now ? `added (${now})` : "added" });
  }
  for (const p of inputs.premises) {
    if (p.state === "removed") out.push({ node_id: p.node_id, text: p.text ?? null, change: "removed" });
  }
  return out;
}
