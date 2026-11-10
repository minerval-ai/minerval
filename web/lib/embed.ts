import type { ClaimCard } from "./types";
import {
  QUESTION_STANDING, STATUS, UNASSESSED_META, disputeLevel, disputeMeta, isStanding, isStatus,
} from "./ontology";
import type { DisputeLevel } from "./ontology";
import { describeEstimate } from "./quantity";
import { fmtDate } from "./format";

// The graph's judgment of a node as an embed states it: the embed page, the
// badge and the oEmbed endpoint all read this, so a claim shown on someone
// else's site says what its own page says. The rule is the page's (§10): a
// status goes with its confidence, dispute is reported beside it and never in
// its place, and a node with no current judgment reads as unassessed, not as
// a verdict. Every label is one the claim page already uses (lib/ontology.ts,
// lib/quantity.ts); an embed must not coin one of its own.
//
// Link previews derive the same judgment from the claim's full detail
// (lib/preview.ts, `claimPreview`). This module reads the claim card instead,
// which is all an embed fetches, and keeps the same shape and dispatch so the
// two can become one derivation with two readers.
//
// No server-only imports: the claim page's Embed panel builds its snippets
// from here in the browser.

export type EmbedVerdict =
  /** A claim's status: square badge in the status colour. */
  | { family: "status"; key: string; label: string; glyph: string; def: string }
  /** A question's standing: round badge in ink. */
  | { family: "standing"; key: string; label: string; glyph: string; def: string }
  /** A quantity's estimate: the figure a reader takes away, and the sentence. */
  | { family: "estimate"; lead: string; words: string };

export interface EmbedJudgment {
  /** "Claim", "Question" or "Quantity", as the page's eyebrow names the node. */
  kind: "Claim" | "Question" | "Quantity";
  /** Set when the node is not active ("merged", "deprecated", "archived"). */
  state: string | null;
  text: string;
  /** Null when there is no current judgment of the node's kind. */
  verdict: EmbedVerdict | null;
  /** The label shown where a verdict would be when there is none. */
  unassessedLabel: string;
  /** What the unassessed label means, for a title. */
  unassessedDef: string;
  /** "actively disputed" or "disputed", where the page shows it. */
  dispute: string | null;
  disputeLevel: DisputeLevel | null;
  /** How sure the Steward is of the status, or of a question's standing. */
  verdictConfidence: number | null;
  /** The page's words for that figure. */
  confidenceLabel: string;
  /** When the current judgment was made (ISO). */
  assessedAt: string | null;
  /** "last assessed" or "last estimated", the page's wording for the date. */
  assessedVerb: string;
}

function sentence(s: string): string {
  const t = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

function confidence(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function cardJudgment(card: ClaimCard): EmbedJudgment {
  const base = {
    state: card.state !== "active" ? card.state.replace(/_/g, " ") : null,
    text: card.text,
    unassessedLabel: UNASSESSED_META.label as string,
    unassessedDef: UNASSESSED_META.def as string,
    verdictConfidence: null,
    confidenceLabel: "verdict confidence",
    assessedVerb: "last assessed",
  };
  const level = disputeLevel(card.contestation);
  const dispute = disputeMeta(card.contestation)?.label ?? null;

  if (card.kind === "question") {
    const standing = isStanding(card.standing) ? card.standing : null;
    return {
      ...base,
      kind: "Question",
      verdict: standing ? { family: "standing", key: standing, ...QUESTION_STANDING[standing] } : null,
      unassessedDef: "This question has not yet been assessed.",
      // The question page shows dispute beside the standing either way.
      dispute,
      disputeLevel: level,
      verdictConfidence: standing ? confidence(card.assessment_confidence) : null,
      // The card's own word for it; a standing is not a verdict on a proposition.
      confidenceLabel: "confidence",
      assessedAt: standing ? card.assessed_at : null,
    };
  }

  if (card.kind === "quantity") {
    let verdict: EmbedVerdict | null = null;
    if (card.estimate && typeof card.estimate.form === "string") {
      try {
        const w = describeEstimate(card.estimate, card.unit ?? { kind: "measure" });
        verdict = { family: "estimate", lead: w.lead, words: sentence(w.words) };
      } catch {
        // An estimate this build cannot read is not shown as a figure.
      }
    }
    return {
      ...base,
      kind: "Quantity",
      verdict,
      unassessedLabel: "Not yet estimated",
      unassessedDef: "This quantity has no current estimate.",
      dispute: verdict ? dispute : null,
      disputeLevel: verdict ? level : null,
      assessedAt: verdict ? card.assessed_at : null,
      assessedVerb: "last estimated",
    };
  }

  // Live data can be mid-pipeline: an off-enum status is not yet a verdict
  // (ClaimView and the link preview apply the same gate).
  if (!isStatus(card.assessment_status)) {
    return { ...base, kind: "Claim", verdict: null, dispute: null, disputeLevel: null, assessedAt: null };
  }
  const s = STATUS[card.assessment_status];
  return {
    ...base,
    kind: "Claim",
    verdict: { family: "status", key: card.assessment_status, label: s.label, glyph: s.glyph, def: s.def },
    dispute,
    disputeLevel: level,
    verdictConfidence: confidence(card.assessment_confidence),
    assessedAt: card.assessed_at,
  };
}

/** The date an embed carries, or null when there is none to give. */
export function embedDate(iso: string | null | undefined): string | null {
  if (!iso || Number.isNaN(new Date(iso).getTime())) return null;
  return fmtDate(iso);
}

/**
 * The judgment in one short line, for the badge: "supported · 0.80 ·
 * disputed", "unassessed", "leaning · 0.60", "17 to 100 million". Short, but
 * whole: the confidence and the dispute travel with the status.
 */
export function judgmentLine(j: EmbedJudgment): string {
  const parts: string[] = [];
  if (!j.verdict) parts.push(j.unassessedLabel.toLowerCase());
  else if (j.verdict.family === "estimate") parts.push(j.verdict.lead);
  else parts.push(j.verdict.label.toLowerCase());
  if (j.verdictConfidence != null) parts.push(j.verdictConfidence.toFixed(2));
  if (j.dispute) parts.push(j.dispute);
  if (j.state) parts.push(j.state);
  return parts.join(" · ");
}

/** The same line with its figures named, for a title or a screen reader. */
export function judgmentSentence(j: EmbedJudgment): string {
  const parts: string[] = [];
  if (!j.verdict) parts.push(j.unassessedLabel);
  else if (j.verdict.family === "estimate") parts.push(j.verdict.words.replace(/\.$/, ""));
  else parts.push(j.verdict.label);
  if (j.verdictConfidence != null) parts.push(`${j.confidenceLabel} ${j.verdictConfidence.toFixed(2)}`);
  if (j.dispute) parts.push(j.dispute);
  const when = embedDate(j.assessedAt);
  if (when) parts.push(`${j.assessedVerb} ${when}`);
  if (j.state) parts.push(j.state);
  return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// Addresses and the snippets a site owner pastes.
// ---------------------------------------------------------------------------

/** The site's public home, for snippets built where no request says otherwise. */
export const SITE_ORIGIN = "https://minerval.ai";

/** The message an embed page posts to its parent so the host can size the iframe. */
export const EMBED_HEIGHT_MESSAGE = "minerval:embed:height";

export const EMBED_DEFAULT_WIDTH = 480;

/** What an embed address accepts as an id: one path segment, nothing that needs escaping. */
export function isEmbeddableId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(id);
}

/**
 * The claim a URL names, when it is a claim page on one of `origins` (or on
 * minerval.ai); null for anything else, including a claim's subpages.
 */
export function claimIdFromPageUrl(raw: string, origins: readonly string[] = []): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const own = url.hostname === "minerval.ai" || url.hostname === "www.minerval.ai" || origins.includes(url.origin);
  if (!own) return null;
  const m = /^\/claims\/([^/]+)\/?$/.exec(url.pathname);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  return isEmbeddableId(id) ? id : null;
}

/**
 * A fixed iframe cannot size itself, so the iframe snippet and the oEmbed
 * response state a height that fits the text at that width: the card's
 * padding and footer plus the lines the text is likely to take. The page
 * scrolls inside the frame if the guess falls short; the script embed
 * measures instead.
 */
export function estimateEmbedHeight(textLength: number, width: number, kind?: string): number {
  const inner = Math.max(120, width - 34);
  const perLine = Math.max(12, Math.floor(inner / 8.1));
  // A quantity's estimate is a sentence of its own under the text.
  const lines = Math.max(1, Math.ceil(textLength / perLine)) + (kind === "quantity" ? 2 : 0);
  // Below about 400px the judgment row and the footer each wrap to two lines.
  const fixed = width < 400 ? 176 : 150;
  return fixed + lines * 25;
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clip(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).replace(/[\s,;:.]+$/, "")}…`;
}

export function embedPageUrl(origin: string, id: string, theme?: "light" | "dark"): string {
  return `${origin}/embed/claims/${encodeURIComponent(id)}${theme ? `?theme=${theme}` : ""}`;
}

export function badgeUrl(origin: string, id: string): string {
  return `${origin}/embed/claims/${encodeURIComponent(id)}/badge.svg`;
}

export function claimPageUrl(origin: string, id: string): string {
  return `${origin}/claims/${encodeURIComponent(id)}`;
}

/** The iframe on its own: works anywhere HTML does, at a fixed height. */
export function iframeSnippet(
  origin: string, id: string, text: string,
  size: { width?: number; height?: number; kind?: string } = {},
): { html: string; width: number; height: number } {
  const width = size.width ?? EMBED_DEFAULT_WIDTH;
  const height = size.height ?? estimateEmbedHeight(text.length, width, size.kind);
  const html =
    `<iframe src="${escapeHtml(embedPageUrl(origin, id))}" title="${escapeHtml(`Minerval: ${clip(text, 90)}`)}" ` +
    `width="${width}" height="${height}" style="border:0;max-width:100%" loading="lazy"></iframe>`;
  return { html, width, height };
}

/**
 * The script embed: a quoted claim that links to its page, which embed.js
 * replaces with the card and keeps sized. Without the script it stays a
 * readable quotation with its link.
 */
export function scriptSnippet(origin: string, id: string, text: string): string {
  return (
    `<blockquote class="minerval-claim" data-claim-id="${escapeHtml(id)}">` +
    `<a href="${escapeHtml(claimPageUrl(origin, id))}">${escapeHtml(text)}</a></blockquote>\n` +
    `<script async src="${escapeHtml(origin)}/embed.js"></script>`
  );
}

/** The badge, as Markdown for a README: the image, linked to the claim's page. */
export function badgeMarkdown(origin: string, id: string): string {
  return `[![Minerval's judgment of this claim](${badgeUrl(origin, id)})](${claimPageUrl(origin, id)})`;
}
