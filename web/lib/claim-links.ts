import type { TreeNode } from "./types";

// An argument's written form embeds inline claim references:
//   [[claim:<id>]]              — rendered as the claim's canonical text
//   [[claim:<id>|inline text]]  — rendered as the authored phrasing
// The backend validates ids as uuids; the parser here is looser so design
// fixtures with slug ids render the same way.
//
// Prose may point at two other kinds of record the same way (a finding's
// account does): [[argument:<id>|phrase]] and [[source:<id>|phrase]]. They
// are links and nothing more: an argument's written form is still made of
// its claims, so hasClaimLinks and orderByMention read claim links only.
const CLAIM_LINK = /\[\[claim:([^\]|]+)(?:\|([^\]]*))?\]\]/g;
const RECORD_LINK = /\[\[(claim|argument|source):([^\]|]+)(?:\|([^\]]*))?\]\]/g;

export type RecordKind = "argument" | "source";

export type WrittenFormSegment =
  | { kind: "text"; text: string }
  | { kind: "link"; claimId: string; display: string | null }
  | { kind: "record"; record: RecordKind; id: string; display: string | null };

export type ProseSegment = WrittenFormSegment | { kind: "url"; href: string };

/** Where a linked record's page is. */
export function recordHref(record: RecordKind, id: string): string {
  return record === "argument" ? `/arguments/${id}` : `/sources/${id}`;
}

/** Split a written form into plain-text and link segments, in order. */
export function parseWrittenForm(content: string): WrittenFormSegment[] {
  const segments: WrittenFormSegment[] = [];
  let last = 0;
  for (const m of content.matchAll(RECORD_LINK)) {
    if (m.index! > last) segments.push({ kind: "text", text: content.slice(last, m.index) });
    const id = m[2]!.trim();
    const display = m[3] ?? null;
    segments.push(
      m[1] === "claim"
        ? { kind: "link", claimId: m[2]!, display }
        : { kind: "record", record: m[1] as RecordKind, id, display }
    );
    last = m.index! + m[0].length;
  }
  if (last < content.length) segments.push({ kind: "text", text: content.slice(last) });
  return segments;
}

// A bare source URL cited in prose (issue #203). Deliberately simple: a run
// of non-whitespace after the scheme; sentence punctuation is trimmed off the
// end afterwards, since a URL usually sits mid-sentence or inside parens.
const BARE_URL = /https?:\/\/[^\s<>"“”]+/g;

/**
 * parseWrittenForm plus bare-URL detection: assessment prose carries the same
 * [[claim:<id>]] references as argument written forms, and may also cite its
 * sources by URL. Plain prose passes through as a single text segment.
 */
export function parseProse(content: string): ProseSegment[] {
  const segments: ProseSegment[] = [];
  for (const seg of parseWrittenForm(content)) {
    if (seg.kind !== "text") {
      segments.push(seg);
      continue;
    }
    let last = 0;
    for (const m of seg.text.matchAll(BARE_URL)) {
      let url = m[0];
      // Trailing sentence punctuation belongs to the prose, not the URL; a
      // trailing ")" comes off only when the URL itself opened no paren.
      while (/[.,;:!?'"’]$/.test(url) || (url.endsWith(")") && !url.includes("("))) {
        url = url.slice(0, -1);
      }
      if (url === "https://" || url === "http://") continue;
      if (m.index! > last) segments.push({ kind: "text", text: seg.text.slice(last, m.index) });
      segments.push({ kind: "url", href: url });
      last = m.index! + url.length;
    }
    if (last < seg.text.length) segments.push({ kind: "text", text: seg.text.slice(last) });
  }
  return segments;
}

// Distinguishes a real written form from the creation-time label that legacy
// arguments carry in `content` (the backfill upgrades those over time): only
// prose that references its subclaims is worth rendering as an argument.
export function hasClaimLinks(content: string): boolean {
  return content.search(CLAIM_LINK) !== -1;
}

/**
 * Order an argument's subclaims the way its written form introduces them
 * (#201): the prose is the reading order, the edge list is not. Items the
 * prose never mentions keep their original relative order, after the
 * mentioned ones. Content with no links (legacy label-only arguments)
 * leaves the order untouched.
 */
export function orderByMention<T>(
  items: T[],
  idOf: (item: T) => string,
  content: string | null | undefined,
): T[] {
  if (!content || items.length < 2) return items;
  const at = new Map<string, number>();
  let i = 0;
  for (const m of content.matchAll(CLAIM_LINK)) {
    if (!at.has(m[1]!)) at.set(m[1]!, i++);
  }
  if (at.size === 0) return items;
  return items
    .map((item, idx) => ({ item, idx, pos: at.get(idOf(item)) ?? Infinity }))
    .sort((a, b) => a.pos - b.pos || a.idx - b.idx)
    .map((e) => e.item);
}

/**
 * id → canonical text for every claim in a decomposition tree, so bare
 * [[claim:<id>]] references resolve to current claim text at render time
 * without another fetch — a written form's links are subclaims of the same
 * tree the caller is already holding.
 */
export function buildClaimTextMap(root: TreeNode | undefined | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!root) return map;
  const walk = (node: TreeNode) => {
    map.set(node.id, node.text);
    node.children.forEach(walk);
  };
  walk(root);
  return map;
}
