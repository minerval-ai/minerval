// The requests pages' own logic, kept apart from their markup so it can be
// tested: what the index's URL says and how a filter changes it, how a long
// ask is read as a headline and its parts, and how a request's funding and
// importance are put in words.

import type { RequestItem, RequestState } from "./types";

// ---------------------------------------------------------------------------
// Reading an ask
// ---------------------------------------------------------------------------

/**
 * An ask as a reader takes it in: a headline (its first sentence), the rest
 * of its opening, the numbered or lettered parts it lists, and what follows
 * them. Requests are filed as one paragraph, often of several hundred words,
 * and most that ask for more than one thing number the things, "(1) ...;
 * (2) ...". Nothing is dropped or reworded: the four pieces, joined, are the
 * ask.
 */
export interface AskParts {
  headline: string;
  rest: string | null;
  parts: string[];
  /** "1" or "a": how the parts were marked, so they are listed the same way. */
  marker: "1" | "a" | null;
  tail: string | null;
}

// Words that end in a full stop without ending a sentence.
const ABBREVIATIONS = new Set([
  "al", "e.g", "i.e", "eg", "ie", "vs", "cf", "fig", "figs", "no", "nos", "dr", "mr", "mrs", "ms", "st",
  "etc", "approx", "ca", "vol", "pp", "p", "eq", "eqs", "sec", "ch", "ed", "eds", "inc", "ltd", "co", "jr", "sr",
  "u.s", "u.k", "e.u", "ref", "refs", "tab", "app", "op", "resp",
]);

/** Where the first sentence of `text` ends (the index after its stop), or -1 if it is one sentence. */
export function firstSentenceEnd(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(" || ch === "[") depth++;
    else if ((ch === ")" || ch === "]") && depth > 0) depth--;
    else if (depth === 0 && (ch === "." || ch === "?" || ch === "!")) {
      const next = text[i + 1];
      const after = text[i + 2];
      if (next !== " " || !after || !/[A-Z0-9("“'‘]/.test(after)) continue;
      if (ch === ".") {
        const word = /([A-Za-z.]+)$/.exec(text.slice(0, i))?.[1] ?? "";
        // An abbreviation, or an initial ("J. Smith").
        if (ABBREVIATIONS.has(word.toLowerCase()) || /^[A-Z]$/.test(word)) continue;
      }
      return i + 1;
    }
  }
  return -1;
}

/** The markers "(1)", "(2)", ... or "(a)", "(b)", ... in order, where at least two run in sequence. */
function listMarkers(text: string): { at: number; end: number; kind: "1" | "a" }[] {
  for (const kind of ["1", "a"] as const) {
    const found: { at: number; end: number; kind: "1" | "a" }[] = [];
    let want = 0;
    let from = 0;
    for (;;) {
      const label = kind === "1" ? String(want + 1) : String.fromCharCode(97 + want);
      const token = `(${label})`;
      // A marker opens the text or follows a space, and is followed by a space.
      let at = text.indexOf(token, from);
      while (at > 0 && text[at - 1] !== " ") at = text.indexOf(token, at + 1);
      if (at < 0 || text[at + token.length] !== " ") break;
      found.push({ at, end: at + token.length + 1, kind });
      from = at + token.length;
      want++;
    }
    if (found.length >= 2) return found;
  }
  return [];
}

/** A listed part without the joining words before the next marker ("...; and"). */
function clean(s: string): string {
  return s
    .trim()
    .replace(/[;,]?\s+(and|or)$/i, "")
    .replace(/[;,]$/, "")
    .trim();
}

/** The first sentence of `text` as the headline, and what follows it. */
function headlineOf(text: string): { headline: string; rest: string | null } {
  const end = firstSentenceEnd(text);
  if (end < 0) return { headline: text, rest: null };
  return { headline: text.slice(0, end).trim(), rest: text.slice(end).trim() || null };
}

export function splitAsk(ask: string): AskParts {
  const text = ask.replace(/\s+/g, " ").trim();
  const markers = listMarkers(text);
  const lead = markers.length > 0 ? text.slice(0, markers[0]!.at).trim() : text;
  // A list that opens the ask has nothing before it to lead with: the ask
  // is read as prose, headed by its first sentence.
  if (markers.length === 0 || !lead) return { ...headlineOf(text), parts: [], marker: null, tail: null };
  const parts = markers.map((m, i) => text.slice(m.end, markers[i + 1]?.at).trim());
  // What follows the last part, when it is a sentence of its own, is said of them all.
  let tail: string | null = null;
  const last = parts[parts.length - 1]!;
  const end = firstSentenceEnd(last);
  if (end > 0) {
    parts[parts.length - 1] = last.slice(0, end).trim();
    tail = last.slice(end).trim() || null;
  }
  return { ...headlineOf(lead), parts: parts.map(clean), marker: markers[0]!.kind, tail };
}

/** The headline of an ask alone: what a list or a margin shows. */
export function askHeadline(ask: string): string {
  return splitAsk(ask).headline;
}

// ---------------------------------------------------------------------------
// What a request's figures say
// ---------------------------------------------------------------------------

export const LIVE_STATES: RequestState[] = ["open", "addressed", "in_progress"];

export function isLive(r: Pick<RequestItem, "state">): boolean {
  return LIVE_STATES.includes(r.state);
}

/** Importance 0..1 as the 1 to 10 the graph's other pages show; null when it bears on no node. */
export function importanceOutOfTen(importance: number | null | undefined): number | null {
  if (typeof importance !== "number" || !Number.isFinite(importance)) return null;
  return Math.min(10, Math.max(1, Math.round(importance * 10)));
}

function usd(n: number): string {
  return n >= 100 ? `$${Math.round(n).toLocaleString("en-US")}` : `$${n.toFixed(2)}`;
}

/**
 * Where the money for a request's work stands, in a few words, and whether
 * it is waiting on a funder. Null when there is nothing to say: a closed
 * request, or one whose work is not on the ledger.
 */
export function fundingWords(r: RequestItem): { words: string; waiting: boolean } | null {
  if (!isLive(r)) return null;
  const l = r.ledger;
  if (!l) return r.state === "in_progress" ? { words: "under way", waiting: false } : null;
  if (l.status === "running") return { words: "funded and under way", waiting: false };
  if (l.backing_usd > 0) return { words: "commissioned, starting shortly", waiting: false };
  if (l.variant === "scope") return { words: "not yet priced: a short scoping pass comes first", waiting: true };
  return { words: `${usd(l.cost_usd)} to do, waiting for a funder`, waiting: true };
}

// ---------------------------------------------------------------------------
// The index's view, as its URL says it
// ---------------------------------------------------------------------------

export type RequestsOrder = "importance" | "recent" | "relevance";

/** "live" is every request still open to work; "any" is every request. */
export type RequestsStands = "live" | "any" | RequestState;

export interface RequestsView {
  q: string | null;
  tag: string | null;
  stands: RequestsStands;
  asked: "anyone" | "named" | null;
  /** Only those whose work waits for a funder. */
  waiting: boolean;
  /** Null is the default: closest first under a search, most important otherwise. */
  order: RequestsOrder | null;
  page: number;
}

export const REQUESTS_PER_PAGE = 30;

const STATES: RequestState[] = ["open", "addressed", "in_progress", "met", "declined", "withdrawn", "moot"];

type Params = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}

export function parseRequestsView(sp: Params): RequestsView {
  const stands = one(sp.stands);
  const asked = one(sp.asked);
  const order = one(sp.order);
  const page = Number(one(sp.page));
  return {
    q: one(sp.q)?.slice(0, 300) ?? null,
    tag: one(sp.tag)?.slice(0, 120) ?? null,
    stands: stands === "any" || STATES.includes(stands as RequestState) ? (stands as RequestsStands) : "live",
    asked: asked === "anyone" || asked === "named" ? asked : null,
    waiting: one(sp.waiting) === "1",
    order: order === "importance" || order === "recent" || order === "relevance" ? order : null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** The order in force: what was asked for, else the default for the view. */
export function requestsOrderInForce(view: RequestsView): RequestsOrder {
  if (view.order === "relevance" && !view.q) return "importance";
  return view.order ?? (view.q ? "relevance" : "importance");
}

export function hasRequestFilters(view: RequestsView): boolean {
  return !!(view.q || view.tag || view.stands !== "live" || view.asked || view.waiting);
}

/**
 * The URL of the view with something changed. Changing a filter goes back
 * to the first page; a default is left out, so the plain index is /requests.
 */
export function requestsHref(
  view: RequestsView,
  change: Partial<{
    q: string | null;
    tag: string | null;
    stands: RequestsStands;
    asked: "anyone" | "named" | null;
    waiting: boolean;
    order: RequestsOrder | null;
    page: number;
  }> = {}
): string {
  const next: RequestsView = { ...view, ...change, page: change.page ?? 1 } as RequestsView;
  const p = new URLSearchParams();
  if (next.q) p.set("q", next.q);
  if (next.tag) p.set("tag", next.tag);
  if (next.stands !== "live") p.set("stands", next.stands);
  if (next.asked) p.set("asked", next.asked);
  if (next.waiting) p.set("waiting", "1");
  if (next.order) p.set("order", next.order);
  if (next.page > 1) p.set("page", String(next.page));
  const s = p.toString();
  return s ? `/requests?${s}` : "/requests";
}

/** The API's query for a view: GET /requests takes `state` as one state, or "live". */
export function requestsApiQuery(view: RequestsView): URLSearchParams {
  const p = new URLSearchParams({
    limit: String(REQUESTS_PER_PAGE),
    offset: String((view.page - 1) * REQUESTS_PER_PAGE),
    order: requestsOrderInForce(view),
    facets: "true",
  });
  if (view.stands !== "any") p.set("state", view.stands);
  if (view.q) p.set("q", view.q);
  if (view.tag) p.set("tag", view.tag);
  if (view.asked) p.set("asked", view.asked);
  if (view.waiting) p.set("waiting", "true");
  return p;
}
