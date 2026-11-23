// What the two screens of the gate share: Review (app/gate), where
// a person decides on what waits on them, and a page as released
// (app/releases/[id]/pages/[pageId]), where the people it was released to read
// it. Both read the same header, the facts always shown with a page
// (docs/the-gate.md), and say them the same way.

import { CASE_FIDELITY_DEF, CASE_VERDICT, LIST_FIDELITY, STATUS, isCaseVerdict, isFidelity } from "./ontology";
import { estimateAsRecorded } from "./quantity";
import type { AssessmentStatus } from "./types";

export type Tone = "ok" | "warn" | "bad" | "info" | "neu";

/** The header a page is shown with whatever is removed or held, as the API records it. */
export interface AlwaysReleased {
  node_kind?: string;
  verdict?: Record<string, unknown>;
  judged_at?: string;
  coverage?: { examined?: boolean; on?: string[] };
  sources?: Array<{ source: number; kind: string; fingerprint: string | null; supplied_by: string; interest_recorded: boolean }>;
  gaps?: { requests?: Array<{ state: string; addressed_to_someone: boolean; filed: string }>; names_what_remains_open?: boolean };
  made?: Record<string, unknown>;
  removals?: Record<string, number>;
}

export function headerOf(raw: Record<string, unknown> | undefined): AlwaysReleased {
  return (raw ?? {}) as AlwaysReleased;
}

/**
 * An artifact's judgment as a released page's header carries it
 * (`{ fidelity, case_verdict, confidence }`): how far the list or the case can
 * be relied on, and for a safety case whether it establishes its conclusion
 * to its standard. Neither is a claim's status, so neither is read as one.
 * Null for a header that is not an artifact's.
 */
export function artifactVerdict(
  v: Record<string, unknown> | null | undefined,
  nodeKind?: string | null,
): { fidelity: { key: string; label: string; def: string } | null; isCase: boolean; caseVerdict: string | null } | null {
  if (!v || !("fidelity" in v || nodeKind === "artifact") || "status" in v) return null;
  const isCase = isCaseVerdict(v.case_verdict);
  const f = isFidelity(v.fidelity) ? v.fidelity : null;
  return {
    fidelity: f ? { key: f, label: LIST_FIDELITY[f].label, def: isCase ? CASE_FIDELITY_DEF[f] : LIST_FIDELITY[f].def } : null,
    isCase,
    caseVerdict: isCaseVerdict(v.case_verdict) ? `${CASE_VERDICT[v.case_verdict]}.` : null,
  };
}

/** The verdict as a pill: its word and its tone. Null where the item carries no verdict. */
export function verdictPill(v: Record<string, unknown> | undefined): { text: string; tone: Tone; title?: string } | null {
  if (!v) return null;
  if ("status" in v) {
    const s = STATUS[String(v.status) as AssessmentStatus];
    const status = String(v.status);
    const tone: Tone =
      status === "verified" || status === "supported" ? "ok" : status === "inconclusive" ? "warn" : status === "doubtful" || status === "contradicted" ? "bad" : "neu";
    return { text: s?.label ?? status.replace(/_/g, " "), tone, title: s?.def };
  }
  // An artifact's fidelity, named as that: it is in ink, and is never a status of the claim a case argues for.
  const artifact = artifactVerdict(v);
  if (artifact) return artifact.fidelity ? { text: `Fidelity: ${artifact.fidelity.label.toLowerCase()}`, tone: "neu", title: artifact.fidelity.def } : null;
  if ("estimate" in v) return { text: "Estimate", tone: "info", title: estimateAsRecorded(v.estimate) };
  if ("standing" in v) return { text: String(v.standing).replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()), tone: "neu" };
  return null;
}

/** A number as a fact: two decimals at most, or null where it was not given. */
export function figure(n: unknown): string | null {
  if (n === null || n === undefined || n === "") return null;
  const x = Number(n);
  return Number.isFinite(x) ? String(Number(x.toFixed(2))) : String(n);
}

export function totalRemovals(removals: Record<string, number> | undefined): number {
  return Object.values(removals ?? {}).reduce((n, c) => n + c, 0);
}

/** What the page was made on, short, with the API's longer sentence for a tip. */
export function coverageWords(c: AlwaysReleased["coverage"], releasedTo = "the people it is released to"): { short: string; long: string } {
  const on = c?.on ?? [];
  const can = on.includes("evidence_this_reader_can_read");
  const cannot = on.includes("evidence_this_reader_cannot_read");
  const [short, base] =
    can && cannot
      ? [`Partly readable by ${releasedTo}`, "Made partly on evidence the people it is released to can read and partly on evidence they cannot."]
      : cannot
        ? [`Not readable by ${releasedTo}`, "Made on evidence the people it is released to cannot read."]
        : can
          ? [`Readable by ${releasedTo}`, "Made on evidence the people it is released to can read."]
          : ["Not recorded", "What it was made on is not recorded."];
  return on.includes("evidence_not_shown")
    ? { short: `${short}; some unpublished`, long: `${base} At least one of its sources reports a result from data it has not published.` }
    : { short, long: base };
}

/** Audit's answer as a pill: its tone from the fixed answer it starts with, the API's sentence in full as its title. */
export function auditPill(audit: string | null | undefined): { text: string; tone: Tone; title: string } {
  if (!audit) return { text: "Audit: not recorded", tone: "neu", title: "Audit's check of the redaction is not recorded." };
  const tone: Tone = audit.startsWith("The reasoning shown supports the verdict in part")
    ? "warn"
    : audit.startsWith("The reasoning shown supports the verdict")
      ? "ok"
      : audit.startsWith("The reasoning shown does not show why")
        ? "bad"
        : "neu";
  const first = audit.split(/(?<=\.)\s/)[0]!.replace(/^The reasoning shown /, "").replace(/\.$/, "");
  return { text: `Audit: ${first}`, tone, title: audit };
}

/**
 * A label as a boundary names it, from where a release goes: the bare label
 * (as GET /releases lists it), `readers at "<label>"` (as one release says
 * it), or the outside, which is "outside".
 */
export function labelOf(releasedTo: string | null | undefined): string {
  if (!releasedTo || releasedTo === "outside this deployment") return "outside";
  return /^readers at "(.+)"$/.exec(releasedTo)?.[1] ?? releasedTo;
}

/** A gate's setting for one party, in a few words. */
export const SETTING_WORDS: Record<string, string> = {
  person: "A person decides",
  redactor: "The Redactor decides",
  open: "Open",
};

/** The kinds of thing at a gate, as a filter names them. */
export const KIND_PLURALS: Record<string, string> = {
  page: "Pages",
  answer: "Answers",
  taken_up: "Taken up",
  funding: "Funding",
  mandate: "Mandates",
  message: "Messages",
  petition: "Petitions",
  statement: "Statements",
  report: "Reports",
  proposal: "Proposals",
};

export const KIND_ONE: Record<string, string> = {
  page: "Page",
  answer: "Answer",
  taken_up: "Taken up",
  funding: "Funding",
  mandate: "Mandate",
  message: "Message",
  petition: "Petition",
  statement: "Statement",
  report: "Report",
  proposal: "Proposal",
};

/**
 * A text with each removal's mark set apart: "[redacted: <category>]". Only
 * the categories named are taken for marks, so an author's square brackets
 * stay prose. Returns the runs in order.
 */
export function splitMarks(text: string, categories: readonly string[]): Array<{ text: string; mark?: string }> {
  const marks = [...new Set(categories)].map((c) => `[redacted: ${c}]`);
  const out: Array<{ text: string; mark?: string }> = [];
  let rest = text;
  while (rest.length > 0) {
    let at = -1;
    let mark = "";
    for (const m of marks) {
      const i = rest.indexOf(m);
      if (i !== -1 && (at === -1 || i < at)) {
        at = i;
        mark = m;
      }
    }
    if (at === -1) {
      out.push({ text: rest });
      break;
    }
    if (at > 0) out.push({ text: rest.slice(0, at) });
    out.push({ text: mark, mark: mark.slice(11, -1) });
    rest = rest.slice(at + mark.length);
  }
  return out;
}
