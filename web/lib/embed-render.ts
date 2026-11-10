import type { ClaimCard } from "./types";
import { OWL_PATH } from "../app/Mark";
import {
  EMBED_HEIGHT_MESSAGE, cardJudgment, embedDate, escapeHtml, judgmentLine, judgmentSentence,
} from "./embed";
import type { EmbedJudgment } from "./embed";

// What an embed looks like: the chrome-less card page and the SVG badge, both
// rendered to a string. They are served into other people's pages, so each is
// one self-contained response: no stylesheet, font, script or image is
// fetched, and nothing of the site's own shell (masthead, footer, theme
// script, client runtime) comes along.

// The site's palette (app/globals.css), restated because neither response can
// read the site's stylesheet: the page inlines its styles, and a badge is an
// image whose colours must be literals. tests/unit/web/embed.test.ts holds
// each value here to the one in globals.css.
export const EMBED_PALETTE = {
  light: {
    "--paper": "#fbfaf6", "--paper-sunk": "#f3f1ea", "--paper-card": "#fefdfb",
    "--ink": "#1a1813", "--ink-soft": "#423d33", "--muted": "#756f60", "--faint": "#9b9484",
    "--rule": "#e2ddd0", "--rule-soft": "#ece8dd", "--link": "#2a5078",
    "--st-verified": "#1f6b46", "--st-verified-tint": "#e7f1ea",
    "--st-supported": "#4f7d4a", "--st-supported-tint": "#ecf2e8",
    "--st-inconclusive": "#9a6d12", "--st-inconclusive-tint": "#f6efde",
    "--st-doubtful": "#9a5f48", "--st-doubtful-tint": "#f4ebe5",
    "--st-contradicted": "#8f3a2c", "--st-contradicted-tint": "#f4e6e1",
    "--st-unknown": "#8b8576", "--st-unknown-tint": "#eeece4",
    "--owl-ink": "#063f1d",
  },
  dark: {
    "--paper": "#121314", "--paper-sunk": "#1b1c1e", "--paper-card": "#17181a",
    "--ink": "#e9e9e6", "--ink-soft": "#c6c7c3", "--muted": "#93958f", "--faint": "#6f716c",
    "--rule": "#2b2d30", "--rule-soft": "#222426", "--link": "#84b4ea",
    "--st-verified": "#62c08a", "--st-verified-tint": "#15261c",
    "--st-supported": "#98c27e", "--st-supported-tint": "#1b2318",
    "--st-inconclusive": "#e0b14f", "--st-inconclusive-tint": "#2a2313",
    "--st-doubtful": "#dd9d80", "--st-doubtful-tint": "#2b1f19",
    "--st-contradicted": "#ef8571", "--st-contradicted-tint": "#2f1b17",
    "--st-unknown": "#a6a8a2", "--st-unknown-tint": "#212224",
    "--owl-ink": "#62c08a",
  },
} as const;

type PaletteKey = keyof (typeof EMBED_PALETTE)["light"];

function vars(theme: "light" | "dark"): string {
  return Object.entries(EMBED_PALETTE[theme]).map(([k, v]) => `${k}:${v}`).join(";");
}

// The site's type (globals.css), minus the faces a host page will not have
// loaded: an embed fetches no fonts.
const SERIF = `"Charter","Source Serif 4","Iowan Old Style","Palatino Linotype",Georgia,serif`;
const SANS = `Inter,-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif`;

// The viewer's colour scheme decides unless the address names one
// (?theme=light|dark sets data-theme on the root).
const STYLE = `
:root{${vars("light")};color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${vars("dark")};color-scheme:dark}}
:root[data-theme="dark"]{${vars("dark")};color-scheme:dark}
*{box-sizing:border-box}
html{font-size:16px;-webkit-text-size-adjust:100%;background:transparent}
body{margin:0;background:transparent;color:var(--ink);font-family:${SERIF};line-height:1.45;font-variant-emoji:text;-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
a:hover{text-decoration:underline;text-underline-offset:2px}
.card{border:1px solid var(--rule);border-radius:4px;background:var(--paper-card);padding:13px 16px 11px;overflow-wrap:anywhere;min-width:0}
.eyebrow{display:flex;flex-wrap:wrap;align-items:center;gap:.45rem;margin:0;font-family:${SANS};font-size:.66rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.state{padding:.05rem .4rem;border:1px dashed var(--faint);border-radius:2px;color:var(--ink-soft)}
.text{margin:.3rem 0 .7rem;font-size:1.06rem;line-height:1.42;font-weight:400;text-wrap:pretty}
.judgment{display:flex;flex-wrap:wrap;align-items:center;gap:.4rem .65rem;margin:0;font-family:${SANS}}
.badge{display:inline-flex;align-items:center;gap:.4rem;font-weight:600;font-size:.7rem;letter-spacing:.07em;text-transform:uppercase;padding:.2rem .5rem .18rem;border-radius:2px;border:1px solid currentColor;white-space:nowrap}
.badge .glyph{font-size:.82rem;line-height:1}
.badge.standing{border-radius:999px;color:var(--ink-soft);background:var(--paper-card)}
.badge.standing-answered{color:var(--ink)}
.badge.standing-ill_posed{border-style:dashed}
.badge.unassessed{color:var(--muted);border-style:dashed;background:transparent;font-weight:500}
.estimate{flex:1 1 100%;margin:0;font-family:${SERIF};font-size:.98rem;line-height:1.4;color:var(--ink)}
.estimate .sc{margin-right:.5rem;font-family:${SANS};font-size:.66rem;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--muted)}
.conf,.when{font-size:.74rem;letter-spacing:.01em;color:var(--muted);white-space:nowrap}
.dispute{font-size:.8rem;color:var(--ink-soft);white-space:nowrap}
.dispute.active{font-weight:600}
.foot{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.25rem .9rem;margin-top:.75rem;padding-top:.5rem;border-top:1px solid var(--rule-soft);font-family:${SANS};font-size:.72rem;color:var(--muted)}
.foot>span{display:inline-flex;align-items:center;flex-wrap:wrap}
.brand{display:inline-flex;align-items:center;gap:.32rem;font-family:${SERIF};font-size:.86rem;font-weight:600;color:var(--ink)}
.brand svg{display:block}
.asof{margin-left:.5rem;white-space:nowrap}
.open{color:var(--link);white-space:nowrap}
.note{margin:.3rem 0 0;font-size:.9rem;color:var(--muted)}
`.trim();

// Tells a framing page how tall the card is, on load and whenever that
// changes, so a host script can fit the iframe to it. The message says only
// which claim and how tall, so it is sent to any parent.
const HEIGHT_SCRIPT =
  `(function(){if(window.parent===window)return;var d=document.documentElement,i=d.getAttribute("data-claim-id"),l=0;` +
  `function p(){var h=Math.ceil(d.getBoundingClientRect().height);if(!h||h===l)return;l=h;` +
  `window.parent.postMessage({type:"${EMBED_HEIGHT_MESSAGE}",id:i,height:h},"*")}` +
  `window.addEventListener("load",p);window.addEventListener("resize",function(){l=0;p()});` +
  `if(window.ResizeObserver)new ResizeObserver(p).observe(d);p()})()`;

function owl(size: number): string {
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false">` +
    `<path d="${OWL_PATH}" fill="var(--owl-ink)" fill-rule="evenodd"/></svg>`
  );
}

function statusStyle(key: string): string {
  return `color:var(--st-${key});background:var(--st-${key}-tint)`;
}

function judgmentHtml(j: EmbedJudgment): string {
  const out: string[] = [];
  const v = j.verdict;
  if (!v) {
    const cls = j.kind === "Question" ? "badge standing unassessed" : "badge unassessed";
    out.push(`<span class="${cls}" title="${escapeHtml(j.unassessedDef)}">${escapeHtml(j.unassessedLabel)}</span>`);
  } else if (v.family === "estimate") {
    out.push(`<p class="estimate"><span class="sc">Estimate</span>${escapeHtml(v.words)}</p>`);
  } else {
    const cls = v.family === "standing" ? `badge standing standing-${v.key}` : "badge";
    const style = v.family === "status" ? ` style="${statusStyle(v.key)}"` : "";
    out.push(
      `<span class="${cls}"${style} title="${escapeHtml(v.def)}">` +
      `<span class="glyph" aria-hidden="true">${escapeHtml(v.glyph)}</span>${escapeHtml(v.label)}</span>`,
    );
  }
  if (j.verdictConfidence != null) {
    const what = j.kind === "Question"
      ? "How sure the Steward is that this standing is the right reading of the evidence, from 0 to 1."
      : "How sure the Steward is that this status is the right reading of the evidence, from 0 to 1. Not the probability that the claim is true.";
    out.push(`<span class="conf" title="${escapeHtml(what)}">${escapeHtml(j.confidenceLabel)} ${j.verdictConfidence.toFixed(2)}</span>`);
  }
  if (j.dispute) {
    out.push(
      `<span class="dispute${j.disputeLevel === "active" ? " active" : ""}" ` +
      `title="How actively this claim is disputed, recorded separately from where the evidence points.">${escapeHtml(j.dispute)}</span>`,
    );
  }
  const when = embedDate(j.assessedAt);
  if (when) out.push(`<span class="when">${escapeHtml(j.assessedVerb)} ${escapeHtml(when)}</span>`);
  return out.join("");
}

function documentHtml(opts: {
  title: string; claimId: string; theme: "light" | "dark" | null; body: string;
}): string {
  return (
    `<!doctype html><html lang="en"${opts.theme ? ` data-theme="${opts.theme}"` : ""} data-claim-id="${escapeHtml(opts.claimId)}">` +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<meta name="robots" content="noindex"><title>${escapeHtml(opts.title)}</title>` +
    `<style>${STYLE}</style></head><body>${opts.body}<script>${HEIGHT_SCRIPT}</script></body></html>`
  );
}

function foot(asOf: string, href: string, action: string): string {
  return (
    `<footer class="foot"><span><span class="brand">${owl(15)}Minerval</span>` +
    `<span class="asof">as of ${escapeHtml(asOf)}</span></span>` +
    `<a class="open" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(action)} ↗︎</a></footer>`
  );
}

/** Only an http(s) address is ever written into a link. */
function safeHref(url: string, fallback: string): string {
  return /^https?:\/\//i.test(url) ? url : fallback;
}

export interface EmbedPageOptions {
  theme: "light" | "dark" | null;
  /** The site's origin, for links when the card gives none. */
  origin: string;
  /** When this rendering was made (ISO): the embed's "as of" date. */
  now: string;
}

/** The card page for one node. */
export function renderEmbedPage(card: ClaimCard, opts: EmbedPageOptions): string {
  const j = cardJudgment(card);
  const href = safeHref(card.page_url, `${opts.origin}/claims/${encodeURIComponent(card.id)}`);
  const body =
    `<article class="card" aria-label="${escapeHtml(`${j.kind} on Minerval. ${judgmentSentence(j)}`)}">` +
    `<p class="eyebrow"><span>${j.kind}</span>${j.state ? `<span class="state">${escapeHtml(j.state)}</span>` : ""}</p>` +
    `<p class="text"><a href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(card.text)}</a></p>` +
    `<div class="judgment">${judgmentHtml(j)}</div>` +
    foot(embedDate(opts.now) ?? "", href, "View on Minerval") +
    `</article>`;
  return documentHtml({ title: `${card.text} · Minerval`, claimId: card.id, theme: opts.theme, body });
}

/** The small card shown where a claim would be when there is none to show. */
export function renderEmbedNotice(
  kind: "not_found" | "unavailable", claimId: string, opts: EmbedPageOptions,
): string {
  const heading = kind === "not_found" ? "Claim not found." : "This claim cannot be shown right now.";
  const note = kind === "not_found"
    ? "There is no claim at this address. The link may be mistyped or out of date."
    : "Minerval could not be reached for its current judgment. The claim's page may still open.";
  const href = kind === "not_found" ? `${opts.origin}/claims` : `${opts.origin}/claims/${encodeURIComponent(claimId)}`;
  const body =
    `<article class="card"><p class="text" style="margin:0">${heading}</p><p class="note">${note}</p>` +
    foot(embedDate(opts.now) ?? "", href, kind === "not_found" ? "Browse claims on Minerval" : "Open the claim on Minerval") +
    `</article>`;
  return documentHtml({ title: `${heading} · Minerval`, claimId, theme: opts.theme, body });
}

// ---------------------------------------------------------------------------
// The badge: the same judgment in one line, as a small image for a README.
// GitHub and other hosts proxy and sanitise SVG, so it uses plain shapes and
// text only: no styles, fonts, images or links.
// ---------------------------------------------------------------------------

// Approximate advance widths at 11px in the Verdana-like faces the badge
// asks for. Exactness is not needed: each run of text carries a textLength,
// so whatever face renders it is fitted to the box drawn for it.
function textWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    if (" .,:;'|!iIljt·".includes(ch)) w += 4.1;
    else if ("mwMW%≈".includes(ch)) w += 10.2;
    else if (/[A-Z0-9]/.test(ch)) w += 7.4;
    else if (/[frJ()−-]/.test(ch)) w += 4.9;
    else w += 6.6;
  }
  return Math.round(w);
}

function badgeColours(j: EmbedJudgment | null): { fg: string; bg: string } {
  const p: Record<PaletteKey, string> = EMBED_PALETTE.light;
  if (j?.verdict?.family === "status") {
    return {
      fg: p[`--st-${j.verdict.key}` as PaletteKey] ?? p["--ink-soft"],
      bg: p[`--st-${j.verdict.key}-tint` as PaletteKey] ?? p["--paper-card"],
    };
  }
  // A standing and an estimate are in ink, never a status colour; a node
  // with no judgment is quieter still.
  if (j?.verdict) return { fg: p["--ink-soft"], bg: p["--paper-card"] };
  return { fg: p["--muted"], bg: p["--paper"] };
}

function badgeSvg(message: string, label: string, j: EmbedJudgment | null): string {
  const p = EMBED_PALETTE.light;
  const name = "minerval";
  const nameW = textWidth(name);
  const msgW = textWidth(message);
  const left = 6 + 13 + 4 + nameW + 7;
  const right = 8 + msgW + 8;
  const width = left + right;
  const { fg, bg } = badgeColours(j);
  const dashed = j && !j.verdict ? ` stroke-dasharray="3 2"` : "";
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" viewBox="0 0 ${width} 20" role="img" aria-label="${escapeHtml(label)}">` +
    `<title>${escapeHtml(label)}</title>` +
    `<clipPath id="r"><rect width="${width}" height="20" rx="3"/></clipPath>` +
    `<g clip-path="url(#r)"><rect width="${left}" height="20" fill="${p["--paper-sunk"]}"/>` +
    `<rect x="${left}" width="${right}" height="20" fill="${bg}"/></g>` +
    `<rect x="${left + 0.5}" y="0.5" width="${right - 1}" height="19" fill="none" stroke="${fg}" stroke-opacity=".55"${dashed}/>` +
    `<rect x=".5" y=".5" width="${width - 1}" height="19" rx="3" fill="none" stroke="${fg}" stroke-opacity=".55"/>` +
    `<path transform="translate(6 3.5) scale(.542)" d="${OWL_PATH}" fill="${p["--owl-ink"]}" fill-rule="evenodd"/>` +
    `<g font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">` +
    `<text x="${6 + 13 + 4}" y="14" fill="${p["--ink"]}" textLength="${nameW}" lengthAdjust="spacingAndGlyphs">${name}</text>` +
    `<text x="${left + 8}" y="14" fill="${fg}" textLength="${msgW}" lengthAdjust="spacingAndGlyphs">${escapeHtml(message)}</text>` +
    `</g></svg>`
  );
}

/** The badge for one node: "minerval | supported · 0.80 · disputed". */
export function renderBadge(card: ClaimCard, now: string): string {
  const j = cardJudgment(card);
  const asOf = embedDate(now);
  const label = `Minerval: ${judgmentSentence(j)}${asOf ? ` (as of ${asOf})` : ""}`;
  return badgeSvg(judgmentLine(j), label, j);
}

/** The neutral badge shown when there is no judgment to report. */
export function renderBadgeNotice(kind: "not_found" | "unavailable"): string {
  const message = kind === "not_found" ? "not found" : "unavailable";
  return badgeSvg(message, `Minerval: claim ${message}`, null);
}
