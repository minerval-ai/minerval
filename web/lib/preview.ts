import type { ClaimDetail } from "./types";
import {
  QUESTION_STANDING, UNASSESSED_META, disputeMeta, isStanding, isStatus, normalizeStatus, statusMeta,
} from "./ontology";
import { describeEstimate } from "./quantity";
import { fmtDate } from "./format";

// The graph's judgment of a node, as a link preview states it: the page's
// metadata description and the generated card (lib/og/card.tsx) both read
// this, so a pasted link says what the page says. The rule is the page's own
// (§10): the status describes the evidence, credence and verdict confidence
// go with it, dispute is reported beside it and never in its place, and a
// node with no current assessment reads as unassessed, not as a verdict.
// Every word here is one the claim page already uses (lib/ontology.ts,
// components/Assessment.tsx); a preview must not coin a label of its own.

export type PreviewVerdict =
  /** A claim's status: square badge in the status colour. */
  | { family: "status"; key: string; label: string; def: string }
  /** A question's standing: round badge in ink. */
  | { family: "standing"; key: string; label: string; def: string }
  /** A quantity's estimate, in words. */
  | { family: "estimate"; words: string };

export interface ClaimPreview {
  /** "Claim", "Question" or "Quantity", as the page's eyebrow names the node. */
  kind: "Claim" | "Question" | "Quantity";
  /** Set when the node is not active ("merged", "deprecated", "archived"). */
  state: string | null;
  text: string;
  /** Null when there is no current assessment. */
  verdict: PreviewVerdict | null;
  /** The label shown where a verdict would be when there is none. */
  unassessedLabel: string;
  /** "actively disputed" or "disputed", where the page shows it. */
  dispute: string | null;
  /** The Steward's probability that the claim is true, when stated. */
  credence: number | null;
  /** How sure the Steward is of the status itself. */
  verdictConfidence: number | null;
  /** When the current assessment was made (ISO). */
  assessedAt: string | null;
  /** "last assessed" or "last estimated", the page's wording for the date. */
  assessedVerb: string;
}

function sentence(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

export function claimPreview(detail: ClaimDetail): ClaimPreview {
  const { claim } = detail;
  const base = {
    state: claim.state !== "active" ? claim.state.replace(/_/g, " ") : null,
    text: claim.text,
    unassessedLabel: UNASSESSED_META.label,
    credence: null,
    verdictConfidence: null,
    assessedVerb: "last assessed",
  };
  const dispute = disputeMeta(claim.contestation)?.label ?? null;

  // The same dispatch the page makes (ClaimMargins, ClaimView).
  if (claim.kind === "question" && detail.question) {
    const q = detail.question;
    const standing = isStanding(q.standing) ? q.standing : null;
    return {
      ...base,
      kind: "Question",
      verdict: standing
        ? { family: "standing", key: standing, label: QUESTION_STANDING[standing].label, def: QUESTION_STANDING[standing].def }
        : null,
      // The question page shows dispute beside the standing either way.
      dispute,
      assessedAt: q.assessment?.summary ? q.assessment.assessed_at : null,
    };
  }

  if (claim.kind === "quantity" && detail.quantity) {
    const q = detail.quantity;
    const est = q.estimate;
    return {
      ...base,
      kind: "Quantity",
      verdict: est ? { family: "estimate", words: sentence(describeEstimate(est, q.definition.unit).words) } : null,
      unassessedLabel: "Not yet estimated",
      dispute: est ? dispute : null,
      assessedAt: q.assessed?.summary ? q.assessed.assessed_at : null,
      assessedVerb: "last estimated",
    };
  }

  // Live data can be mid-pipeline: an assessment row with an off-enum status
  // is not yet a verdict (ClaimView applies the same gate).
  const a = detail.assessment && isStatus(detail.assessment.status) ? detail.assessment : null;
  if (!a) return { ...base, kind: "Claim", verdict: null, dispute: null, assessedAt: null };
  const s = statusMeta(a.status);
  return {
    ...base,
    kind: "Claim",
    verdict: { family: "status", key: normalizeStatus(a.status), label: s.label, def: s.def },
    dispute,
    credence: typeof a.claim_credence === "number" ? a.claim_credence : null,
    verdictConfidence: typeof a.confidence === "number" ? a.confidence : null,
    assessedAt: a.assessed_at,
  };
}

/** The date a preview carries, or null when there is none to give. */
export function previewDate(iso: string | null): string | null {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  return fmtDate(iso);
}

/**
 * The judgment in one line of prose, for a page description: the verdict,
 * the figures that go with it, dispute, the date, then the verdict's
 * definition so the word is not left to be guessed at.
 */
export function describePreview(p: ClaimPreview): string {
  const when = previewDate(p.assessedAt);
  const parts: string[] = [];
  let tail = "";
  if (!p.verdict) {
    parts.push(p.unassessedLabel);
    if (p.dispute) parts.push(p.dispute);
    tail = p.kind === "Claim" ? UNASSESSED_META.def : "";
  } else if (p.verdict.family === "estimate") {
    parts.push(`The graph's estimate: ${p.verdict.words.replace(/\.$/, "")}`);
    if (p.dispute) parts.push(p.dispute);
    if (when) parts.push(`${p.assessedVerb} ${when}`);
  } else {
    parts.push(p.verdict.label);
    if (p.credence != null) parts.push(`credence ${p.credence.toFixed(2)}`);
    if (p.verdictConfidence != null) parts.push(`verdict confidence ${p.verdictConfidence.toFixed(2)}`);
    if (p.dispute) parts.push(p.dispute);
    if (when) parts.push(`${p.assessedVerb} ${when}`);
    tail = p.verdict.def;
  }
  if (p.state) parts.push(p.state);
  return `${parts.join(" · ")}.${tail ? ` ${tail}` : ""}`;
}

/** Text cut at a word boundary to at most `max` characters, with an ellipsis. */
export function truncateText(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return `${(at > max * 0.6 ? cut.slice(0, at) : cut).replace(/[\s,;:.]+$/, "")}…`;
}
