// A node's judgments by label, for the node's page inside a private
// deployment (lib/inside-node.ts reads them; this file decides, with no
// reading of its own, which the page opens on and how one judgment is put
// where the ordinary page reads its judgment from).
import type { Assessment, ClaimDetail, LeftStanding, NodeVersion } from "./types";

/** Which of a node's judgments the page opens on. */
export type Opened =
  | { kind: "version"; version: NodeVersion }
  // Two or more are in force for this reader, at labels that do not read
  // each other. Nothing picks between them: not recency, and not this file.
  | { kind: "several"; versions: NodeVersion[] }
  | { kind: "none" };

/**
 * The judgment the reader asked for by its label, where there is one; else
 * the one in force; else, where several are in force, all of them, in the
 * order of their labels' names.
 */
export function whichToOpen(versions: readonly NodeVersion[], at?: string | null): Opened {
  const wanted = at ? versions.find((v) => v.label === at) : undefined;
  if (wanted) return { kind: "version", version: wanted };
  const inForce = versions.filter((v) => v.in_force).sort(byLabelName);
  if (inForce.length > 1) return { kind: "several", versions: inForce };
  if (inForce.length === 1) return { kind: "version", version: inForce[0]! };
  return { kind: "none" };
}

/** Labels in the order a reader meets them where nothing else orders them: by name, with `public` last. */
export function byLabelName(a: { label: string }, b: { label: string }): number {
  if (a.label === b.label) return 0;
  if (a.label === "public") return 1;
  if (b.label === "public") return -1;
  return a.label < b.label ? -1 : 1;
}

/** A version of a claim's judgment as the claim page's own assessment. */
export function assessmentOf(version: NodeVersion, served: Assessment | null): Assessment | null {
  if (typeof version.status !== "string") return null;
  // What the API serves beside the one judgment it names (who paid, the
  // developer disclosure) belongs to that judgment and no other.
  const same = served && served.id === version.id ? served : null;
  return {
    ...(same ?? {}),
    id: version.id,
    status: version.status,
    confidence: version.confidence ?? 0,
    claim_credence: version.claim_credence ?? null,
    summary: version.summary ?? version.reasoning_trace ?? "",
    reasoning_trace: version.reasoning_trace ?? "",
    subclaim_summary: {},
    assessed_at: version.assessed_at,
    model: version.model ?? null,
    run_id: version.run_id ?? null,
  } as Assessment;
}

/** The node's detail carrying one version's judgment in the place the page reads its judgment from. */
export function detailAt(detail: ClaimDetail, version: NodeVersion): ClaimDetail {
  const served = detail.assessment;
  const isServed = served?.id === version.id || detail.quantity?.assessed?.assessed_at === version.assessed_at;
  const out: ClaimDetail = {
    ...detail,
    assessment: assessmentOf(version, served),
    // What it was made on and what has changed beneath it are said of each
    // judgment by the API, so each tab shows its own.
    coverage: version.coverage ?? (isServed ? detail.coverage : undefined),
    since_assessed: version.since_assessed ?? (isServed ? detail.since_assessed : undefined),
  };
  if (detail.claim.kind === "quantity" && detail.quantity && !isServed) {
    out.quantity = {
      ...detail.quantity,
      estimate: (version.estimate ?? null) as typeof detail.quantity.estimate,
      assessed: {
        ...(detail.quantity.assessed ?? {}),
        estimate: version.estimate,
        summary: version.summary ?? "",
        work: version.work ?? "",
        assessed_at: version.assessed_at,
        model: version.model ?? null,
      } as NonNullable<typeof detail.quantity.assessed>,
    };
  }
  return out;
}

/** The node's detail with no judgment in the place the page reads one from: the versions stand above it instead. */
export function detailWithoutJudgment(detail: ClaimDetail): ClaimDetail {
  return { ...detail, assessment: null, coverage: undefined, since_assessed: undefined, seed: null };
}


/** An assessment named in the middle of a sentence. */
export function versionRef(label: string): string {
  return label === "public" ? "the public assessment" : `the assessment at ${label}`;
}

function listOf(names: string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * What the page says where a label the reader reads examined the node and
 * left another label's assessment standing: that it did and when, and then
 * whether that assessment still stands. Two sentences, so that the page can
 * put a link to the run between them. `on` is the date as the page writes
 * dates.
 */
export function leftStandingLines(e: LeftStanding, on: string): { examined: string; since: string } {
  const one = e.judgments.length === 1;
  const stood = listOf(e.judgments.map((j) => versionRef(j.label)));
  return {
    examined: `This node was examined at ${e.label} on ${on}, and ${stood} ${one ? "was" : "were"} left standing: its Steward at ${e.label} made no separate assessment.`,
    since: e.open_again
      ? `${one ? "That assessment has" : "One of those assessments has"} been replaced since, so the newer one has not been looked at from ${e.label}. The deployment opens a fresh look at ${e.label} when that happens, and it runs when someone pays for it.`
      : `${one ? "That assessment" : "Each of those assessments"} still stands.`,
  };
}

/** What the page says of the labels a reader holds at which nobody has looked at the node. Null where there are none. */
export function notExaminedLine(labels: readonly string[]): string | null {
  if (labels.length === 0) return null;
  return (
    `This node has not been examined at ${listOf([...labels])}: no assessment has been made there, and no Steward there has looked and left another standing. ` +
    `That is not a finding that nothing filed at ${labels.length === 1 ? "that label" : "those labels"} bears on it.`
  );
}
