import type { SinceAssessed } from "./types";

// What has changed under a node's judgment since it was written (#566). The
// API serves it beside the judgment as counts: premises judged again, added
// or removed, sources added or removed, and notices (corrections,
// retractions) on its sources. The page says it in one quiet line, and only
// when something did change. A judgment written before the record existed
// answers `recorded: false`: nothing is known either way, so the page says
// nothing rather than suggest the assessment is up to date.

function counted(n: number | undefined, one: string, many: string, what: string): string | null {
  return n && n > 0 ? `${n} ${n === 1 ? one : many} ${what}` : null;
}

/**
 * The line for the page, or null when there is nothing to say: no judgment,
 * no record, or nothing changed. `judgment` is the word the page uses for
 * the node's judgment ("assessment" for a claim, "estimate" for a quantity).
 */
export function sinceAssessedLine(
  since: SinceAssessed | null | undefined,
  judgment: "assessment" | "estimate" = "assessment",
): string | null {
  if (!since || since.recorded !== true || since.changed !== true) return null;
  const parts = [
    counted(since.premises_rejudged, "premise", "premises", "judged again"),
    counted(since.premises_added, "premise", "premises", "added"),
    counted(since.premises_removed, "premise", "premises", "removed"),
    counted(since.sources_added, "source", "sources", "added"),
    counted(since.sources_removed, "source", "sources", "removed"),
    counted(since.source_events, "notice", "notices", "on its sources"),
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? `Since this ${judgment}: ${parts.join(", ")}.` : null;
}
