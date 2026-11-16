import type {
  DocumentInstance,
  DocumentSegment,
  Examination,
  ExaminationFinding,
  InstanceSupport,
  SourceDocument,
  SourceEventKind,
  SourcePage,
} from "@/lib/types";
// Relative, not "@/lib/format", so the unit suite can load this file.
import { fmtDate, partialDate } from "../../lib/format";

// The source page's view model (#507): the document's own outline, which
// leaves each examination covered, and where findings sit. Derived here so the
// components only lay it out; nothing in it weighs or ranks the source.

export interface Leaf {
  seg: DocumentSegment;
  /** Labels of the sections between the top-level group and this leaf. */
  sub: string | null;
}

export interface Group {
  id: string;
  label: string | null;
  leaves: Leaf[];
}

export interface ExamView {
  exam: Examination;
  code: string;
  color: string;
  /** Short name for chips and the outline. */
  short: string;
  /** Leaf id → facets examined there. */
  covered: Map<string, string[]>;
}

// Neutral hues kept apart from the status colours: an examination's colour
// identifies it and must never read as a verdict.
const EXAM_COLORS = ["#4b5f86", "#6a4f7c", "#2f6b6b", "#7a5a3a", "#5b6470", "#7a4a5a"];

export const LEAF_KINDS = new Set(["passage", "table", "note", "reference"]);

export function groupsOf(doc: SourceDocument | null): Group[] {
  if (!doc || !doc.segmented) return [];
  const byId = new Map(doc.segments.map((s) => [s.id, s]));
  const sorted = [...doc.segments].sort((a, b) => a.ordinal - b.ordinal);
  const groups: Group[] = [];
  const groupFor = new Map<string, Group>();
  let opening: Group | null = null;
  for (const s of sorted) {
    if (s.kind === "section" && !s.parent_id) {
      const g = { id: s.id, label: s.label, leaves: [] };
      groups.push(g);
      groupFor.set(s.id, g);
      continue;
    }
    if (!LEAF_KINDS.has(s.kind)) continue;
    // Walk up to the top-level section, collecting the labels in between.
    const path: string[] = [];
    let p = s.parent_id ? byId.get(s.parent_id) : undefined;
    let top: DocumentSegment | undefined;
    while (p) {
      if (!p.parent_id) top = p;
      else if (p.label) path.unshift(p.label);
      p = p.parent_id ? byId.get(p.parent_id) : undefined;
    }
    let g = top ? groupFor.get(top.id) : undefined;
    if (!g) {
      // Leaves before the first heading form an untitled opening group; one
      // that follows a section is still the document's order, so append.
      const last = groups[groups.length - 1];
      if (!top && last && last === opening) g = last;
      else {
        g = opening = { id: `open-${s.id}`, label: null, leaves: [] };
        groups.push(g);
      }
    }
    g.leaves.push({ seg: s, sub: path.length ? path.join(" · ") : null });
  }
  return groups.filter((g) => g.leaves.length > 0 || g.label);
}

function descendants(doc: SourceDocument, id: string): string[] {
  const kids = new Map<string, string[]>();
  for (const s of doc.segments) {
    if (!s.parent_id) continue;
    const list = kids.get(s.parent_id) ?? [];
    list.push(s.id);
    kids.set(s.parent_id, list);
  }
  const out: string[] = [];
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    out.push(cur);
    stack.push(...(kids.get(cur) ?? []));
  }
  return out;
}

export function examViews(page: SourcePage): ExamView[] {
  const doc = page.document;
  const kinds = new Map((doc?.segments ?? []).map((s) => [s.id, s.kind]));
  return [...page.examinations]
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((exam, i) => {
      const covered = new Map<string, string[]>();
      for (const c of exam.coverage) {
        // Coverage recorded on a section covers every leaf under it.
        const ids = doc ? descendants(doc, c.segment_id) : [c.segment_id];
        for (const id of ids) {
          if (!LEAF_KINDS.has(kinds.get(id) ?? "")) continue;
          const f = covered.get(id) ?? [];
          if (!f.includes(c.facet)) f.push(c.facet);
          covered.set(id, f);
        }
      }
      return {
        exam,
        code: String.fromCharCode(65 + (i % 26)),
        color: EXAM_COLORS[i % EXAM_COLORS.length]!,
        short: exam.claim ? clip(exam.claim.text, 34) : "Document review",
        covered,
      };
    });
}

export function clip(text: string, n: number): string {
  return text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text;
}

/** Every claim named on the page, by id, for naming the claims that cite a finding. */
export function claimNames(page: SourcePage): Map<string, string> {
  const m = new Map<string, string>();
  const add = (i: DocumentInstance) => m.set(i.claim.id, i.claim.text);
  for (const s of page.document?.segments ?? []) s.instances.forEach(add);
  page.document?.unanchored.forEach(add);
  for (const e of page.examinations) if (e.claim) m.set(e.claim.id, e.claim.text);
  return m;
}

export function findingsBySegment(views: ExamView[]): Map<string, Array<{ f: ExaminationFinding; ev: ExamView }>> {
  const m = new Map<string, Array<{ f: ExaminationFinding; ev: ExamView }>>();
  for (const ev of views) {
    for (const f of ev.exam.findings) {
      if (!f.segment_id) continue;
      const list = m.get(f.segment_id) ?? [];
      list.push({ f, ev });
      m.set(f.segment_id, list);
    }
  }
  return m;
}

// --- words ------------------------------------------------------------------------

export const SUPPORT_WORD: Record<InstanceSupport, string> = {
  supports: "Supports",
  overstates: "Overstates",
  understates: "Understates",
  asserts_without_evidence: "Without evidence",
  evidence_not_shown: "Evidence not shown",
  contradicts_own_evidence: "Against its own evidence",
  unclear: "Unclear",
};

export const SUPPORT_CLS: Record<InstanceSupport, string> = {
  supports: "st-supported",
  overstates: "st-inconclusive",
  understates: "st-unknown",
  asserts_without_evidence: "st-contradicted",
  evidence_not_shown: "st-unknown",
  contradicts_own_evidence: "st-contradicted",
  unclear: "st-unknown",
};

export const EVENT_WORD: Record<SourceEventKind, string> = {
  correction: "Corrected",
  retraction: "Retracted",
  expression_of_concern: "Expression of concern",
  update: "Updated",
  removal: "Removed",
};

const AGENT_NAMES: Record<string, string> = {
  claim_steward: "a claim's Steward",
  grantmaker: "the Grantmaker",
  request: "a request",
  researcher: "Researcher",
  audit_agent: "Audit agent",
  correction_watcher: "Correction watcher",
  metadata_fetcher: "Metadata fetcher",
  facts_fetcher: "Facts fetcher",
  segmenter: "Segmenter",
};

export function agentName(id: string): string {
  return AGENT_NAMES[id] ?? id.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
}

export function kindLabel(sourceType: string): string {
  return sourceType.replace(/_/g, " ");
}

export { partialDate };

/** Table text as rows of cells when it splits cleanly, else null. */
export function tableRows(text: string): string[][] | null {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;
  const sep = lines.every((l) => l.includes(" | ")) ? " | " : lines.every((l) => l.includes("\t")) ? "\t" : null;
  if (!sep) return null;
  return lines.map((l) => l.split(sep).map((c) => c.trim()));
}

/** A date-only value at its own precision; a timestamp as the site's meta lines show it. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "–";
  if (/^\d{4}(-\d{2}){0,2}$/.test(iso)) return partialDate(iso)!;
  return fmtDate(iso);
}

// --- context words (lineage, prominence, history) ------------------------------------

type Relation = "repeats" | "derives_from" | "reanalyzes" | "republishes" | "cites_as_evidence" | "responds_to";
type Fidelity = "faithful" | "strengthened" | "weakened" | "distorted" | "misattributed" | "unclear";

/** Fidelities the claim map flags as divergent. */
export const DIVERGENT_FIDELITY = new Set<string>(["strengthened", "weakened", "distorted", "misattributed"]);

// Upstream, this source is the subject ("Draws its statement from it");
// downstream, the other document is ("Restates it"), so "it" is this source.
const RELATION_VERB: Record<Relation, string> = {
  repeats: "restates it",
  derives_from: "draws its statement from it",
  reanalyzes: "reanalyzes its data",
  republishes: "republishes it",
  cites_as_evidence: "cites it",
  responds_to: "responds to it",
};
const FIDELITY_UP: Record<Fidelity, string> = {
  faithful: " faithfully",
  strengthened: " more strongly than that document supports",
  weakened: " more cautiously than that document warrants",
  distorted: " in a way that document does not support",
  misattributed: ", crediting it with something it does not say",
  unclear: "",
};
const FIDELITY_DOWN: Record<Fidelity, string> = {
  faithful: " faithfully",
  strengthened: " more strongly than this source supports",
  weakened: " more cautiously than this source warrants",
  distorted: " in a way this source does not support",
  misattributed: ", crediting it with something it does not say",
  unclear: "",
};

export function relationWords(
  relations: Array<{ relation_type: string; fidelity: string; claims: number }>,
  side: "up" | "down",
): string {
  const fid = side === "up" ? FIDELITY_UP : FIDELITY_DOWN;
  const parts = relations.map((r) => {
    const verb = RELATION_VERB[r.relation_type as Relation] ?? r.relation_type.replace(/_/g, " ");
    const how = fid[r.fidelity as Fidelity] ?? "";
    return `${verb}${how}, on ${r.claims} ${r.claims === 1 ? "claim" : "claims"}`;
  });
  const text = parts.join("; ");
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : "";
}

export const FIDELITY_WORD: Record<string, string> = {
  faithful: "faithful",
  strengthened: "stronger",
  weakened: "weaker",
  distorted: "distorted",
  misattributed: "misattributed",
  unclear: "unclear",
};

export const HISTORY_WORD: Record<string, string> = {
  retrieved: "Entered the graph",
  facts: "Facts",
  segmented: "Divided",
  event: "Notice",
  reading: "Reading",
  examination: "Examination",
  finding: "Findings",
  audit_note: "Audit note",
  citation: "Citation",
  watch: "Correction watch",
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// --- how much the page has to show (#507) ----------------------------------------

/** The steps every source goes through on entering the graph; news about none in particular. */
export const INTAKE_KINDS = new Set<string>(["retrieved", "facts", "segmented"]);

export interface SourceShape {
  /** Passages a claim marks or an examination found something in. */
  touched: number;
  /** Examinations, plus requests bearing on the document. */
  examined: number;
  lineage: number;
  /** Copies, other versions, copies-of, corrections and recorded interests. */
  facts: number;
  /** History rows beyond the intake steps. */
  history: number;
  /**
   * Anything beyond a few quoted passages is recorded. A busy page keeps the
   * outline rail, the facts band, the prominence figures and the passage map;
   * a quiet one, a source quoted once or twice and nothing else, leads with
   * its text and says in one line what has not happened.
   */
  busy: boolean;
}

export function sourceShape(page: SourcePage, groups: Group[], findingSegs: ReadonlySet<string>): SourceShape {
  const touched = groups
    .flatMap((g) => g.leaves)
    .filter((l) => l.seg.instances.length > 0 || findingSegs.has(l.seg.id)).length;
  const ctx = page.context;
  const examined = page.examinations.length + (ctx?.reviews?.requests.length ?? 0);
  const lineage = ctx ? ctx.lineage.draws_on.total + ctx.lineage.drawn_on_by.total : 0;
  const f = page.facts;
  const facts = f.copies.length + f.versions.length + f.copy_of.length + f.events.length + (f.interests?.length ?? 0);
  const history = (ctx?.history ?? []).filter((h) => !INTAKE_KINDS.has(h.kind)).length;
  return {
    touched,
    examined,
    lineage,
    facts,
    history,
    busy: examined > 0 || lineage > 0 || facts > 0 || touched >= 3,
  };
}

/**
 * The one line that stands in for the sections a quiet page leaves out, in
 * the page's own words. Null when nothing it covers is missing, or when the
 * graph has not said (no context served), since silence is not absence.
 */
export function absentLine(page: SourcePage, shape: SourceShape): string | null {
  const parts: string[] = [];
  const asked = (page.context?.reviews?.requests ?? []).some((r) => r.live);
  if (page.examinations.length === 0) parts.push(asked ? "Not examined; a review has been asked for." : "Not examined or reviewed.");
  if (page.context && shape.lineage === 0) parts.push("No other source draws on it or is drawn on by it.");
  return parts.length ? parts.join(" ") : null;
}
