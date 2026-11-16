/**
 * Quotations with cuts in them. A recorder who quotes "the board said in a
 * statement. [...] A company spokesperson clarified" has left text out, the
 * way any writer quoting a story does. Each piece is the source's words; the
 * join is the recorder's. So a quotation with cuts is checked piece by
 * piece, each in the document after the one before, and is reported as
 * elided rather than verbatim: whoever reads it can see the cut was made and
 * read what it left out.
 *
 * Pure: the matching for the source page's anchors (source-segment-service),
 * for the quote check on a reading (source-map-service), and for the
 * recording tools' refusal of a cut that does not hold.
 */

export interface Span {
  start: number;
  end: number;
}

/**
 * The marks of a cut: `[...]`, `[…]`, `(...)`, `(…)`, a bare `…`, and three
 * or more dots, spaced or not. A source's own ellipsis is no problem: a
 * quotation is first looked for whole, and only split when it is not there.
 */
const CUT = /\[\s*(?:\.\s*){2,}\]|\[\s*…\s*\]|\(\s*(?:\.\s*){2,}\)|\(\s*…\s*\)|…|\.(?:\s?\.){2,}/gu;

const HAS_WORD = /[\p{L}\p{N}]/u;

/**
 * The pieces of a quotation between its cuts, trimmed, with any piece that
 * holds no word left out (a cut at the start or end leaves one). One piece
 * means no cut inside the quotation.
 */
export function quotePieces(quote: string): string[] {
  return quote
    .split(CUT)
    .map((p) => p.trim())
    .filter((p) => HAS_WORD.test(p));
}

/** Whether the quotation leaves text out between two of its pieces. */
export function hasCut(quote: string): boolean {
  return quotePieces(quote).length > 1;
}

/**
 * How much of the document one cut may leave out, in characters. A cut is
 * the recorder's, and the reader has to be able to read what it skipped
 * beside the pieces it joined; a join across more than this is two passages,
 * and is recorded as two. Told to the recording agents in the verbatim_text
 * description (steward-tools.ts, argument-instance-tools.ts, kind-tools.ts).
 */
export const MAX_CUT_CHARS = 3000;

/**
 * How many placements are tried before the search gives up. A guard on the
 * matcher's own work, not a limit on anyone: a short piece ("the") occurs
 * often, and each occurrence is a branch.
 */
const MAX_STEPS = 2000;

/**
 * Where each piece sits, in order, each after the one before and with at
 * most MAX_CUT_CHARS between them. `occurrences(piece, from)` lists where a
 * piece occurs at or after `from`, in increasing order. Returns the spans,
 * or, where they cannot all be placed, the index of the first piece that
 * could not be (the furthest the search reached).
 */
export function placePieces(
  pieces: string[],
  occurrences: (piece: string, from: number) => Iterable<Span>,
  maxCut = MAX_CUT_CHARS
): { spans: Span[] } | { missing: number } {
  let steps = 0;
  let furthest = 0;
  const place = (i: number, from: number): Span[] | null => {
    furthest = Math.max(furthest, i);
    if (i === pieces.length) return [];
    for (const at of occurrences(pieces[i]!, from)) {
      if (i > 0 && at.start - from > maxCut) break;
      if (++steps > MAX_STEPS) return null;
      const rest = place(i + 1, at.end);
      if (rest) return [at, ...rest];
    }
    return null;
  };
  const spans = place(0, 0);
  return spans ? { spans } : { missing: Math.min(furthest, pieces.length - 1) };
}

/** Every occurrence of `needle` in `haystack` at or after `from`. */
export function* substringsFrom(haystack: string, needle: string, from: number): Iterable<Span> {
  if (!needle) return;
  for (let at = haystack.indexOf(needle, from); at >= 0; at = haystack.indexOf(needle, at + 1)) {
    yield { start: at, end: at + needle.length };
  }
}

/**
 * The document's text around a quotation with cuts, for a reader: each piece
 * as the document has it, and between two pieces what the cut left out.
 */
export function quotedParts(text: string, spans: Span[]): Array<{ text: string; omitted?: true }> {
  const out: Array<{ text: string; omitted?: true }> = [];
  spans.forEach((s, i) => {
    if (i > 0) {
      const gap = text.slice(spans[i - 1]!.end, s.start).trim();
      if (gap) out.push({ text: gap, omitted: true });
    }
    out.push({ text: text.slice(s.start, s.end) });
  });
  return out;
}

/**
 * The rule as the recording agents are told it, in each verbatim_text
 * description: what a cut must be, and the limit the recording tools hold
 * it to (recordedQuoteProblem in source-map-service.ts).
 */
export const CUT_RULE =
  `Quote one passage. If you leave text out, mark each cut "[...]": every piece must be the ` +
  `source's own words in the source's order, each cut may leave out at most ` +
  `${MAX_CUT_CHARS.toLocaleString("en-US")} characters, and the cut must not change what the ` +
  `passage says. A quotation with cuts is refused when its pieces are not in the source's stored text.`;

/** The same rule for the Extractor, which quotes the document in front of it. */
export const CUT_RULE_DOCUMENT =
  `Quote one passage. If you leave text out, mark each cut "[...]": every piece must be the ` +
  `document's own words in its order, each cut may leave out at most ` +
  `${MAX_CUT_CHARS.toLocaleString("en-US")} characters, and the cut must not change what the ` +
  `passage says.`;
