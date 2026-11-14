/**
 * A published page in the shape of a node's page
 * (docs/published-pages.md, "On the claim's page").
 *
 * A package carries a page as its parts, each the text its Steward wrote
 * (services/showing-service.ts, readPage). A reader should meet it as the
 * page it is: the same verdict band, assessment, reasoning, arguments,
 * sources and subclaims as on any node's page, with each removal marked
 * where it was made and each held part standing in its place. This file
 * turns the parts back into that shape.
 *
 * It only reads. Text is passed through exactly as released, marks
 * included. Where a part does not open with the heading its kind is
 * written with, it is given as plain text and nothing is guessed.
 *
 * It imports nothing but types, so the web app carries a copy
 * (web/lib/published-page/, written by the sync script).
 */
import type { PackageMark, PackagePart, PublishedPagePackage } from "./verify.js";

/** A part that is held, in the words that stand in its place. */
export interface HeldBlock {
  part: number;
  /** "An argument against", as the page's own structure names it. */
  what: string;
  by: string[];
  /** The reasons given, from the fixed list. Chosen by whoever holds the part, and checked by nobody. */
  reasons: string[];
  since: string | null;
}

export interface TextBlock {
  part: number;
  text: string;
  marks: PackageMark[];
}

export type Block = ({ held: HeldBlock } & { text?: undefined }) | (TextBlock & { held?: undefined });

export interface ShapedArgument {
  part: number;
  held?: HeldBlock;
  stance: string | null;
  name: string | null;
  /** The written form. Null when the part is only this label's evaluation of an argument recorded elsewhere. */
  content: string | null;
  rating: string | null;
  decisive: boolean;
  evaluation: string | null;
}

export interface ShapedReading {
  part: number;
  held?: HeldBlock;
  stance: string | null;
  passage: string | null;
  context: string | null;
  how_read: string | null;
  /** The part as released, when it does not open as a reading is written. */
  text: string | null;
}

export interface ShapedSubclaim {
  part: number;
  held?: HeldBlock;
  relation: string | null;
  /** The subclaim's wording, where the subclaim itself was written at the page's label. */
  wording: string | null;
  reasoning: string | null;
}

export interface ShapedSource {
  source: number;
  kind: string;
  fingerprint: string | null;
  supplied_by: string;
  interest_recorded: boolean;
  /** Who supplied it, by name, and the words of any recorded interest: a part like any other, so it may be held. */
  supplier: Block | null;
}

export interface PublishedPageShape {
  node_kind: string | null;
  verdict: Record<string, unknown> | null;
  version_of: string | null;
  assessed_by_model: string | null;
  coverage: { examined: boolean; on: string[] } | null;
  /** The node's own wording as assessed, where the node exists only in the publishing deployment. */
  wording: Block | null;
  summary: Block[];
  reasoning: Block[];
  gaps: Block[];
  gap_facts: { requests: Array<{ state: string; addressed_to_someone: boolean; filed: string }>; names_what_remains_open: boolean } | null;
  arguments: ShapedArgument[];
  readings: ShapedReading[];
  sources: ShapedSource[];
  stated_views: Block[];
  subclaims: ShapedSubclaim[];
  removals: Record<string, number>;
  parts: number;
  held_parts: number;
  /** "2 arguments against, a paragraph of reasoning". */
  held_kinds: string;
}

const KIND_WORDS: Record<string, [string, string]> = {
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

/** A part's kind in words, as the deployment's own pages say it (services/page-parts.ts). */
export function kindInWords(descriptor: string, count = 1): string {
  const words = KIND_WORDS[descriptor] ?? KIND_WORDS[descriptor.split(":")[0]!] ?? ["a part", "parts"];
  return count === 1 ? words[0] : `${count} ${words[1]}`;
}

function heldOf(part: PackagePart): HeldBlock {
  const what = kindInWords(part.descriptor);
  return {
    part: part.part,
    what: what.charAt(0).toUpperCase() + what.slice(1),
    by: part.held?.by ?? [],
    reasons: part.held?.reasons ?? [],
    since: part.held?.since ?? null,
  };
}

const isReleased = (part: PackagePart): part is PackagePart & { text: string } => typeof part.text === "string";

function block(part: PackagePart): Block {
  return isReleased(part) ? { part: part.part, text: part.text, marks: part.marks ?? [] } : { held: heldOf(part) };
}

/** The paragraphs of a part's text: its heading line, then the blocks between blank lines. */
function paragraphs(text: string): string[] {
  return text.split(/\n\n/);
}

function shapeArgument(part: PackagePart): ShapedArgument {
  const stanceOf = part.descriptor.split(":")[1] ?? null;
  const base: ShapedArgument = { part: part.part, stance: stanceOf, name: null, content: null, rating: null, decisive: false, evaluation: null };
  if (!isReleased(part)) return { ...base, held: heldOf(part) };
  const paras = paragraphs(part.text);
  const head = paras[0] ?? "";
  const at = paras.findIndex((p, i) => i > 0 && p.startsWith("Evaluation: "));
  const body = at === -1 ? paras.slice(1) : paras.slice(1, at);
  const rating = at === -1 ? null : paras[at]!.slice("Evaluation: ".length);
  const evaluation = at === -1 ? null : paras.slice(at + 1).join("\n\n") || null;
  const named = /^Argument \(([^)]*)\)(?:: ([\s\S]*))?$/.exec(head);
  const decisive = rating !== null && /; decisive$/.test(rating);
  const cleanRating = rating === null ? null : rating.replace(/; decisive$/, "");
  if (named) {
    return { ...base, stance: named[1] || stanceOf, name: named[2] ?? null, content: body.join("\n\n"), rating: cleanRating, decisive, evaluation };
  }
  if (head === "Evaluation of an argument recorded at another label") {
    return { ...base, rating: cleanRating, decisive, evaluation };
  }
  // Not written as an argument is written: give it whole.
  return { ...base, content: part.text };
}

function shapeReading(part: PackagePart): ShapedReading {
  const base: ShapedReading = { part: part.part, stance: null, passage: null, context: null, how_read: null, text: null };
  if (!isReleased(part)) return { ...base, held: heldOf(part) };
  const paras = paragraphs(part.text);
  const head = /^Reading of a source \(([^)]*)\)$/.exec(paras[0] ?? "");
  if (!head) return { ...base, text: part.text };
  // A passage may itself hold blank lines, so each field runs to the next heading.
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const p of paras.slice(1)) {
    const m = /^(Passage|Context|Stated probability|Stated estimate|How it was read): ([\s\S]*)$/.exec(p);
    if (m) {
      current = m[1]!;
      fields[current] = [m[2]!];
    } else if (current) fields[current]!.push(p);
  }
  const get = (k: string) => (fields[k] ? fields[k]!.join("\n\n") : null);
  return { ...base, stance: head[1] ?? null, passage: get("Passage"), context: get("Context"), how_read: get("How it was read") };
}

function shapeSubclaim(part: PackagePart): ShapedSubclaim {
  const base: ShapedSubclaim = { part: part.part, relation: null, wording: null, reasoning: null };
  if (!isReleased(part)) return { ...base, held: heldOf(part) };
  const paras = paragraphs(part.text);
  const head = /^Subclaim \(([^)]*)\)(?:: ([\s\S]*))?$/.exec(paras[0] ?? "");
  if (!head) return { ...base, reasoning: part.text };
  return { ...base, relation: head[1] ?? null, wording: head[2] ?? null, reasoning: paras.slice(1).join("\n\n") || null };
}

/** The page a package carries, in the shape of a node's page. Null when the package carries no shown page. */
export function shapeOfPublishedPage(pkg: PublishedPagePackage): PublishedPageShape | null {
  const page = pkg.page;
  if (!page || !page.always_shown) return null;
  let header: Record<string, unknown>;
  try {
    header = JSON.parse(page.always_shown.text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const of = (kind: string) => page.parts.filter((p) => p.kind === kind);
  const suppliers = of("supplier");
  const sources = ((header.sources ?? []) as Array<{ source: number; kind: string; fingerprint: string | null; supplied_by: string; interest_recorded: boolean }>).map(
    (s): ShapedSource => {
      // A supplier part opens "Supplier of source N: ...". A held one cannot be matched to its source by text, so held
      // ones are given to the sources that have no released one, in order.
      const released = suppliers.find((p) => isReleased(p) && p.text.startsWith(`Supplier of source ${s.source}: `));
      return { ...s, supplier: released ? block(released) : null };
    }
  );
  const heldSuppliers = suppliers.filter((p) => !isReleased(p));
  const unnamed = sources.filter((s) => s.supplier === null && (s.supplied_by !== "not_recorded" || s.interest_recorded));
  heldSuppliers.forEach((p, i) => {
    if (unnamed[i]) unnamed[i]!.supplier = block(p);
  });
  const held = page.parts.filter((p) => !isReleased(p));
  const counts = new Map<string, number>();
  for (const p of held) counts.set(p.descriptor, (counts.get(p.descriptor) ?? 0) + 1);
  const wording = of("wording")[0];
  const gaps = of("gap");
  const made = (header.made ?? {}) as { assessed_by_model?: string | null };
  return {
    node_kind: typeof header.node_kind === "string" ? header.node_kind : null,
    verdict: (header.verdict as Record<string, unknown>) ?? null,
    version_of: page.version_of,
    assessed_by_model: made.assessed_by_model ?? null,
    coverage: (header.coverage as { examined: boolean; on: string[] }) ?? null,
    wording: wording ? block(wording) : null,
    summary: of("summary").map(block),
    reasoning: of("reasoning").map(block),
    gaps: gaps.map(block),
    gap_facts: (header.gaps as PublishedPageShape["gap_facts"]) ?? null,
    arguments: of("argument").map(shapeArgument),
    readings: of("reading").map(shapeReading),
    sources,
    stated_views: of("stated_view").map(block),
    subclaims: of("subclaim").map(shapeSubclaim),
    removals: (header.removals as Record<string, number>) ?? {},
    parts: page.parts.length,
    held_parts: held.length,
    held_kinds: [...counts.entries()].map(([d, n]) => kindInWords(d, n)).join(", "),
  };
}

/** The page as one text, for a reader with no page to render it on: an agent, a search index, a diff. */
export function publishedPageAsText(pkg: PublishedPagePackage): string {
  const page = pkg.page;
  if (!page || !page.always_shown) return "";
  const lines: string[] = [];
  for (const part of page.parts) {
    if (isReleased(part)) lines.push(part.text, "");
    else {
      const h = heldOf(part);
      lines.push(`[${h.what}, held${h.by.length > 0 ? ` by ${h.by.join(" and ")}` : ""}${h.reasons.length > 0 ? `. Reason given: ${h.reasons.join("; ")}` : ""}]`, "");
    }
  }
  return lines.join("\n").trimEnd();
}
