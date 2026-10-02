/**
 * A document's own structure (#507, phase 4): sections by heading, and in
 * them the passages, tables, notes, and references, each a span of the
 * document's readable text. The source page is drawn from this, and every
 * annotation on it, an instance of a claim today and an examination's
 * coverage and findings next, is anchored to a segment rather than to a
 * claim's view of the document.
 *
 * The segmenter is deterministic and works on the readable text
 * (`htmlToText`), the same text an agent reads and the quote check tests,
 * so offsets mean the same thing everywhere. That text keeps a document's
 * blocks apart with blank lines, so segmentation is the reading of those
 * blocks: a markdown heading, a numbered heading ("2.1 Methods"), or a
 * short title-like line opens a section; "Table 3" opens a table; blocks
 * under a "References" or "Notes" heading are references or notes; every
 * other block is a passage. A heuristic, written down and testable, never
 * a model: the same document always divides the same way.
 */
import { createHash, randomUUID } from "node:crypto";
import { rawQuery } from "../db/client.js";
import { htmlToText } from "./source-map-service.js";
import type { SourceSegmentKind } from "../schemas/common.js";

/** Segments beyond this are not recorded; a book is segmented up to here. */
export const MAX_SEGMENTS = 5000;

export interface DraftSegment {
  /** Index of the enclosing section in the returned list, or null. */
  parent: number | null;
  kind: SourceSegmentKind;
  label: string | null;
  start: number;
  end: number;
}

interface Block {
  text: string;
  start: number;
  end: number;
}

/** The text's blocks, separated by blank lines, with their offsets. */
function blocks(text: string): Block[] {
  const out: Block[] = [];
  const re = /\n[ \t]*\n+/g;
  let pos = 0;
  const push = (from: number, to: number) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) out.push({ text: trimmed, start: from + lead, end: from + lead + trimmed.length });
  };
  for (const m of text.matchAll(re)) {
    push(pos, m.index!);
    pos = m.index! + m[0].length;
  }
  push(pos, text.length);
  return out;
}

const REFERENCE_HEADINGS = /^(references|bibliography|works cited|literature cited|citations|sources)$/i;
const NOTE_HEADINGS = /^(notes|footnotes|endnotes)$/i;

/** A heading's level and label, or null when the block is not a heading. */
export function headingOf(block: string): { level: number; label: string } | null {
  if (block.includes("\n")) return null;
  const md = block.match(/^(#{1,6})\s+(.+?)\s*#*$/);
  if (md) return { level: md[1]!.length, label: md[2]!.trim() };
  if (block.length > 120) return null;
  const numbered = block.match(/^((?:\d+\.)*\d+)\.?\s+(\S.*)$/);
  if (numbered && !/[.!?;,]$/.test(numbered[2]!) && numbered[2]!.split(/\s+/).length <= 12) {
    return { level: numbered[1]!.split(".").length, label: block };
  }
  const words = block.split(/\s+/);
  if (
    words.length <= 12 &&
    /^[\p{Lu}\p{N}]/u.test(block) &&
    !/[.!?;,:"'”’)]$/.test(block) &&
    !/^(table|figure|fig\.)\s+\d/i.test(block)
  ) {
    return { level: 1, label: block };
  }
  return null;
}

/**
 * Divide readable text into segments. Pure: the same text always gives the
 * same segments. A section spans from its heading to the next heading at
 * its level or above; everything else is a leaf in the innermost open
 * section.
 */
export function segmentText(text: string): DraftSegment[] {
  const out: DraftSegment[] = [];
  // Open sections, innermost last: index into `out`, level, and leaf kind.
  const open: Array<{ index: number; level: number; leafKind: SourceSegmentKind }> = [];
  const close = (level: number, at: number) => {
    while (open.length && open[open.length - 1]!.level >= level) {
      out[open.pop()!.index]!.end = at;
    }
  };
  // Where the last block ended: a section closes there, not at the blank
  // lines before the next heading.
  let lastEnd = 0;
  for (const b of blocks(text)) {
    if (out.length >= MAX_SEGMENTS) break;
    const heading = headingOf(b.text);
    if (heading) {
      close(heading.level, lastEnd);
      lastEnd = b.end;
      const parent = open.length ? open[open.length - 1]! : null;
      const leafKind: SourceSegmentKind = REFERENCE_HEADINGS.test(heading.label.replace(/^[\d.\s]+/, ""))
        ? "reference"
        : NOTE_HEADINGS.test(heading.label.replace(/^[\d.\s]+/, ""))
          ? "note"
          : parent?.leafKind ?? "passage";
      out.push({ parent: parent?.index ?? null, kind: "section", label: heading.label, start: b.start, end: b.end });
      open.push({ index: out.length - 1, level: heading.level, leafKind });
      continue;
    }
    lastEnd = b.end;
    const parent = open.length ? open[open.length - 1]! : null;
    const table = b.text.match(/^(table\s+[\dIVXivx]+[A-Za-z]?)\b/i);
    const kind: SourceSegmentKind = table ? "table" : parent?.leafKind ?? "passage";
    out.push({
      parent: parent?.index ?? null,
      kind,
      label: table ? table[1]!.replace(/\s+/g, " ") : null,
      start: b.start,
      end: b.end,
    });
  }
  close(0, lastEnd);
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Where a quotation sits in the text: exactly, or with its words in order
 * across any punctuation and whitespace (curly quotes, a soft hyphen, a line
 * break). Null when it is not there.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (!q) return null;
  const exact = text.indexOf(q);
  if (exact >= 0) return { start: exact, end: exact + q.length };
  const words = q.normalize("NFKC").match(/[\p{L}\p{N}]+/gu);
  if (!words || words.length === 0) return null;
  const re = new RegExp(words.map(escapeRe).join("[^\\p{L}\\p{N}]+"), "iu");
  const m = re.exec(text);
  return m ? { start: m.index, end: m.index + m[0].length } : null;
}

/** The leaf segment holding an offset, or the innermost section when no leaf does. */
export function segmentAt<T extends { kind: string; start: number; end: number }>(
  segments: T[],
  offset: number
): T | null {
  let section: T | null = null;
  for (const s of segments) {
    if (offset < s.start || offset >= s.end) continue;
    if (s.kind !== "section") return s;
    section = s;
  }
  return section;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Segment a stored source, replacing any earlier segmentation, then anchor
 * its instances. Returns how many segments were written; zero when the
 * source has no stored text.
 */
export async function segmentSource(sourceId: string): Promise<{ segments: number; anchored: number }> {
  const [row] = await rawQuery<{ raw_content: string | null }>(
    `SELECT raw_content FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (!row?.raw_content?.trim()) return { segments: 0, anchored: 0 };
  const text = htmlToText(row.raw_content);
  const drafts = segmentText(text);

  await rawQuery(`UPDATE claim_instances SET segment_id = NULL WHERE source_id = $1`, [sourceId]);
  await rawQuery(`DELETE FROM source_segments WHERE source_id = $1`, [sourceId]);
  // Ids are made here so a child can name its parent in the same batch;
  // parents precede children in document order, so each batch's foreign
  // keys point at rows already inserted or inserted in the same statement.
  const ids = drafts.map(() => randomUUID());
  const BATCH = 500;
  for (let i = 0; i < drafts.length; i += BATCH) {
    const values: unknown[] = [];
    const rows = drafts.slice(i, i + BATCH).map((d, j) => {
      const base = j * 9;
      values.push(
        ids[i + j],
        sourceId,
        d.parent === null ? null : ids[d.parent],
        i + j,
        d.label,
        d.kind,
        d.start,
        d.end,
        sha256(text.slice(d.start, d.end))
      );
      return `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}::uuid, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9})`;
    });
    await rawQuery(
      `INSERT INTO source_segments (id, source_id, parent_id, ordinal, label, kind, char_start, char_end, text_hash)
       VALUES ${rows.join(", ")}`,
      values
    );
  }
  const anchored = await anchorInstances(sourceId, text);
  return { segments: drafts.length, anchored };
}

/**
 * Point each unanchored instance of a segmented source at the segment its
 * verbatim text sits in. Instances whose text is not in the document stay
 * unanchored.
 */
export async function anchorInstances(sourceId: string, knownText?: string): Promise<number> {
  const instances = await rawQuery<{ id: string; verbatim_text: string }>(
    `SELECT id, verbatim_text FROM claim_instances WHERE source_id = $1 AND segment_id IS NULL`,
    [sourceId]
  );
  if (instances.length === 0) return 0;
  const segments = await rawQuery<{ id: string; kind: string; start: number; end: number }>(
    `SELECT id, kind, char_start AS start, char_end AS "end" FROM source_segments
      WHERE source_id = $1 ORDER BY ordinal`,
    [sourceId]
  );
  if (segments.length === 0) return 0;
  let text = knownText;
  if (text === undefined) {
    const [row] = await rawQuery<{ raw_content: string | null }>(`SELECT raw_content FROM sources WHERE id = $1`, [sourceId]);
    text = htmlToText(row?.raw_content ?? "");
  }
  let anchored = 0;
  for (const inst of instances) {
    const at = locateQuote(text, inst.verbatim_text);
    if (!at) continue;
    const seg = segmentAt(segments, at.start);
    if (!seg) continue;
    await rawQuery(`UPDATE claim_instances SET segment_id = $2 WHERE id = $1`, [inst.id, seg.id]);
    anchored++;
  }
  return anchored;
}

/**
 * Segment a source the first time it has text, and anchor any instances
 * recorded since. Swallows every failure: the hook the fetch and extraction
 * paths call, where losing the structure must never lose the document.
 */
export async function segmentSourceOnce(sourceId: string): Promise<void> {
  try {
    const [row] = await rawQuery<{ segmented: boolean; has_text: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM source_segments WHERE source_id = $1) AS segmented,
              (raw_content IS NOT NULL AND raw_content <> '') AS has_text
         FROM sources WHERE id = $1`,
      [sourceId]
    );
    if (!row?.has_text) return;
    if (row.segmented) await anchorInstances(sourceId);
    else await segmentSource(sourceId);
  } catch (err) {
    console.error(
      `[source-segments] segmentation failed for ${sourceId}: ${err instanceof Error ? err.message : err}`
    );
  }
}

export interface DocumentInstanceView {
  instance_id: string;
  claim: { id: string; text: string; status: string | null };
  stance: string;
  verbatim_text: string;
  /** The claim Steward's reading of this appearance, in that claim's voice. */
  reading: { support: string; note: string | null; source_read: boolean } | null;
}

export interface DocumentSegmentView {
  id: string;
  parent_id: string | null;
  ordinal: number;
  kind: string;
  label: string | null;
  char_start: number;
  char_end: number;
  /** Leaves carry their text; a section's text is its children's. */
  text: string | null;
  instances: DocumentInstanceView[];
}

export interface SourceDocumentView {
  source_id: string;
  segmented: boolean;
  total_chars: number;
  segments: DocumentSegmentView[];
  /** Instances of claims on this source whose text was not found in it. */
  unanchored: DocumentInstanceView[];
}

/**
 * The document as annotated text: its segments in order, each passage with
 * the claims that assert or engage it and each claim Steward's reading. The
 * source page's body. Anchors instances recorded since the last pass first.
 */
export async function getSourceDocument(sourceId: string): Promise<SourceDocumentView | null> {
  const [row] = await rawQuery<{ raw_content: string | null }>(`SELECT raw_content FROM sources WHERE id = $1`, [sourceId]);
  if (!row) return null;
  const text = htmlToText(row.raw_content ?? "");
  await anchorInstances(sourceId, text).catch(() => 0);
  const [segments, instances] = await Promise.all([
    rawQuery<{
      id: string;
      parent_id: string | null;
      ordinal: number;
      kind: string;
      label: string | null;
      char_start: number;
      char_end: number;
    }>(
      `SELECT id, parent_id, ordinal, kind, label, char_start, char_end
         FROM source_segments WHERE source_id = $1 ORDER BY ordinal`,
      [sourceId]
    ),
    rawQuery<{
      id: string;
      segment_id: string | null;
      claim_id: string;
      claim_text: string;
      status: string | null;
      stance: string;
      verbatim_text: string;
      support: string | null;
      note: string | null;
      source_read: boolean | null;
    }>(
      `SELECT ci.id, ci.segment_id, ci.claim_id, c.text AS claim_text,
              (SELECT a.status FROM assessments a WHERE a.claim_id = c.id AND a.is_current = true
                ORDER BY a.assessed_at DESC LIMIT 1) AS status,
              ci.stance, ci.verbatim_text, r.support, r.note, r.source_read
         FROM claim_instances ci
         JOIN claims c ON c.id = ci.claim_id AND c.state = 'active'
         LEFT JOIN claim_instance_readings r ON r.instance_id = ci.id
        WHERE ci.source_id = $1
        ORDER BY ci.created_at`,
      [sourceId]
    ),
  ]);
  const view = (i: (typeof instances)[number]): DocumentInstanceView => ({
    instance_id: i.id,
    claim: { id: i.claim_id, text: i.claim_text, status: i.status },
    stance: i.stance,
    verbatim_text: i.verbatim_text,
    reading: i.support ? { support: i.support, note: i.note, source_read: i.source_read === true } : null,
  });
  const bySegment = new Map<string, DocumentInstanceView[]>();
  const unanchored: DocumentInstanceView[] = [];
  for (const i of instances) {
    if (!i.segment_id) {
      unanchored.push(view(i));
      continue;
    }
    const list = bySegment.get(i.segment_id) ?? [];
    list.push(view(i));
    bySegment.set(i.segment_id, list);
  }
  return {
    source_id: sourceId,
    segmented: segments.length > 0,
    total_chars: text.length,
    segments: segments.map((s) => ({
      id: s.id,
      parent_id: s.parent_id,
      ordinal: s.ordinal,
      kind: s.kind,
      label: s.label,
      char_start: s.char_start,
      char_end: s.char_end,
      text: s.kind === "section" ? null : text.slice(s.char_start, s.char_end),
      instances: bySegment.get(s.id) ?? [],
    })),
    unanchored,
  };
}
