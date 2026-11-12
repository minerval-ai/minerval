/**
 * The parts of a page, and what a removal does to one
 * (docs/showing-a-page.md, "The parts of a page").
 *
 * A page shown below its label is divided into parts, and a part is what
 * the holders of `release` release or hold. The division is mechanical and
 * follows the page's own structure: no agent divides text or sorts it into
 * kinds. A text column is divided at its blank lines, and every other part
 * is one row of the page (an argument with its evaluation, a source's
 * reading, a subclaim with how it bears, a request the page records).
 *
 * A removal takes a span out of a part and leaves a mark in its place. The
 * rest of the part is the characters that were written, unchanged: nothing
 * here trims, rewraps or normalizes.
 *
 * Nothing in this file reads a database.
 */
import { markOf, type Mark } from "./page-fingerprint.js";

/**
 * The kinds of part, in the order a page lists them.
 *
 * `wording` is the node's own wording, present when the node itself is at
 * the page's label and so cannot be read on the other side. `gap` is
 * something the page records as missing: a request it keeps, or what a
 * question's assessment says remains open. `supplier` is the name of who
 * supplied one source and the words of any interest recorded for it.
 */
export const PART_KINDS = [
  "wording",
  "summary",
  "reasoning",
  "gap",
  "argument",
  "reading",
  "supplier",
  "stated_view",
  "subclaim",
] as const;
export type PartKind = (typeof PART_KINDS)[number];

/**
 * A part's kind as the record names it. An argument's says which way it
 * bears, so that "two arguments against are held" can be read off the
 * record and checked against the fingerprint.
 */
export function descriptorOf(kind: PartKind, stance?: string | null): string {
  if (kind !== "argument") return kind;
  return stance === "for" || stance === "against" || stance === "neutral" ? `argument:${stance}` : "argument";
}

const KIND_WORDS: Record<string, [one: string, several: string]> = {
  verdict: ["the page", "pages"],
  wording: ["the node's wording", "wordings"],
  summary: ["a paragraph of the summary", "paragraphs of the summary"],
  reasoning: ["a paragraph of reasoning", "paragraphs of reasoning"],
  gap: ["a gap the page records", "gaps the page records"],
  argument: ["an argument", "arguments"],
  "argument:for": ["an argument for", "arguments for"],
  "argument:against": ["an argument against", "arguments against"],
  "argument:neutral": ["an argument that takes neither side", "arguments that take neither side"],
  reading: ["a source's reading", "sources' readings"],
  supplier: ["a source's supplier and recorded interest, by name", "sources' suppliers and recorded interests, by name"],
  stated_view: ["a stated view", "stated views"],
  subclaim: ["a subclaim with how it bears", "subclaims with how they bear"],
};

/** A part's kind in words: "an argument against". */
export function kindWords(descriptor: string, count = 1): string {
  const words = KIND_WORDS[descriptor] ?? KIND_WORDS[descriptor.split(":")[0]!] ?? ["a part", "parts"];
  return count === 1 ? words[0] : `${count} ${words[1]}`;
}

function listed(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]!}`;
}

/**
 * What stands in place of a held part on the destination side. It names
 * the kind of part and who holds it, and nothing about what the part says.
 * `holders` are the parties that hold it or have not yet released it.
 */
export function heldWords(descriptor: string, holders: readonly string[]): string {
  const what = kindWords(descriptor);
  const capitalized = what.charAt(0).toUpperCase() + what.slice(1);
  return holders.length > 0 ? `[${capitalized}, held by ${listed(holders)}]` : `[${capitalized}, held]`;
}

/**
 * A text column as its paragraphs: the blocks between blank lines, each
 * exactly as written. A line that holds only spaces or tabs counts as
 * blank. Blocks with nothing in them are left out.
 */
export function paragraphsOf(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.split(/\r?\n(?:[ \t]*\r?\n)+/).filter((block) => block.trim().length > 0);
}

/** One removal by its place in the part as written. `end` is exclusive. */
export interface Removal {
  start: number;
  end: number;
  category: string;
}

export class RemovalError extends Error {}

/**
 * Where `passage` stands in `original`. The passage must be given exactly
 * as it appears. Where it appears more than once, `occurrence` says which
 * (1 for the first).
 */
export function locate(original: string, passage: string, occurrence?: number): { start: number; end: number } {
  if (passage.length === 0) throw new RemovalError("The passage to remove is empty.");
  const places: number[] = [];
  for (let at = original.indexOf(passage); at !== -1; at = original.indexOf(passage, at + 1)) places.push(at);
  if (places.length === 0) {
    throw new RemovalError(
      "That passage is not in this part as written. Give the passage exactly as it appears, character for character, " +
        "including its punctuation and spacing."
    );
  }
  if (places.length > 1 && occurrence === undefined) {
    throw new RemovalError(
      `That passage appears ${places.length} times in this part. Say which with occurrence (1 for the first), or give a longer passage.`
    );
  }
  const n = occurrence ?? 1;
  if (!Number.isInteger(n) || n < 1 || n > places.length) {
    throw new RemovalError(`That passage appears ${places.length} time${places.length === 1 ? "" : "s"} in this part, so occurrence ${n} is not one of them.`);
  }
  const start = places[n - 1]!;
  return { start, end: start + passage.length };
}

/** Whether a new removal would overlap one already made in the part. */
export function overlaps(removals: readonly Removal[], span: { start: number; end: number }): boolean {
  return removals.some((r) => span.start < r.end && r.start < span.end);
}

/**
 * The part as the Redactor left it: the text as written with each removed
 * span replaced by its mark, and where each mark stands in the result.
 */
export function applyRemovals(original: string, removals: readonly Removal[]): { text: string; marks: Mark[] } {
  const ordered = [...removals].sort((a, b) => a.start - b.start);
  let text = "";
  let from = 0;
  const marks: Mark[] = [];
  for (const r of ordered) {
    if (r.start < from || r.end > original.length || r.end <= r.start) {
      throw new RemovalError("A removal lies outside the part or overlaps another.");
    }
    text += original.slice(from, r.start);
    marks.push({ at: text.length, category: r.category });
    text += markOf(r.category);
    from = r.end;
  }
  text += original.slice(from);
  return { text, marks };
}

/** How many removals each category accounts for, with the categories in order of name. */
export function countByCategory(categories: readonly string[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const c of [...categories].sort()) counts[c] = (counts[c] ?? 0) + 1;
  return counts;
}
