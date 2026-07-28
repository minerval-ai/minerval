/**
 * Text capture + quote anchoring.
 *
 * The content script sends the server READABLE TEXT built by walking the
 * page's visible text nodes. Annotations come back as exact quotes
 * (`original_text`). Because capture and anchoring share the same index, a
 * quote can be mapped back to precise (text node, offset) positions and
 * highlighted with a Range — no DOM rewriting, robust to dynamic pages
 * (rebuild the index and re-anchor on mutation).
 */

const SKIP_TAGS = new Set([
  "SCRIPT",
  "STYLE",
  "NOSCRIPT",
  "TEMPLATE",
  "IFRAME",
  "SVG",
  "CANVAS",
  "TEXTAREA",
  "INPUT",
  "SELECT",
  "BUTTON",
]);

/** Tags whose boundaries should read as line breaks in the captured text. */
const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "SECTION",
  "ARTICLE",
  "MAIN",
  "HEADER",
  "FOOTER",
  "ASIDE",
  "NAV",
  "LI",
  "UL",
  "OL",
  "TABLE",
  "TR",
  "TD",
  "TH",
  "BLOCKQUOTE",
  "PRE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "FIGURE",
  "FIGCAPTION",
  "BR",
  "HR",
]);

export interface TextIndex {
  /** Concatenated visible text; this exact string is sent to the server. */
  text: string;
  /**
   * Per-character provenance: chars[i] is the text node + offset that
   * produced text[i], or null for synthesized separators.
   */
  chars: Array<{ node: Text; offset: number } | null>;
}

function isVisible(el: Element): boolean {
  // offsetParent is null for display:none subtrees (and fixed elements, so
  // double-check with computed style only in the ambiguous case).
  const html = el as HTMLElement;
  if (html.offsetParent !== null) return true;
  const style = window.getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden";
}

export function buildTextIndex(root: Node): TextIndex {
  const parts: string[] = [];
  const chars: TextIndex["chars"] = [];
  let length = 0;

  const pushSeparator = (sep: string) => {
    if (length === 0) return;
    if (parts.length && /\s$/.test(parts[parts.length - 1]!)) return;
    parts.push(sep);
    chars.push(null);
    length += 1;
  };

  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      if (!data) return;
      parts.push(data);
      for (let i = 0; i < data.length; i++) {
        chars.push({ node: node as Text, offset: i });
      }
      length += data.length;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (el instanceof HTMLElement && el.hidden) return;
    if (el.getAttribute("aria-hidden") === "true") return;
    if (el.hasAttribute("data-minerval-ui")) return;
    if (!isVisible(el)) return;

    const isBlock = BLOCK_TAGS.has(el.tagName);
    if (isBlock) pushSeparator("\n");
    for (let child = el.firstChild; child; child = child.nextSibling) {
      walk(child);
    }
    if (isBlock) pushSeparator("\n");
  };

  walk(root);
  return { text: parts.join(""), chars };
}

// --- Normalized matching (DOM-free, unit-testable) --------------------------

/** Canonicalize characters that vary between page text and model echoes. */
function canonChar(ch: string): string {
  switch (ch) {
    case "‘":
    case "’":
    case "ʼ":
      return "'";
    case "“":
    case "”":
      return '"';
    case "–":
    case "—":
      return "-";
    case " ":
      return " ";
    default:
      return ch;
  }
}

export interface Normalized {
  norm: string;
  /** map[i] = index into the source string of the char producing norm[i]. */
  map: number[];
}

/** Collapse whitespace runs to single spaces, canonicalize, keep a back-map. */
export function normalizeWithMap(source: string): Normalized {
  let norm = "";
  const map: number[] = [];
  let pendingSpace = false;
  for (let i = 0; i < source.length; i++) {
    const ch = canonChar(source[i]!);
    if (/\s/.test(ch)) {
      pendingSpace = norm.length > 0;
      continue;
    }
    if (pendingSpace) {
      norm += " ";
      map.push(i); // attribute the space to the following char's position
      pendingSpace = false;
    }
    norm += ch;
    map.push(i);
  }
  return { norm, map };
}

export interface Occurrence {
  /** Start/end (exclusive) offsets into the SOURCE string. */
  start: number;
  end: number;
}

/**
 * Find occurrences of `quote` in `source`, tolerant of whitespace and
 * typographic-character differences. Falls back to case-insensitive search.
 */
export function findOccurrences(
  source: Normalized,
  quote: string,
  limit = 5
): Occurrence[] {
  const needle = normalizeWithMap(quote).norm;
  if (needle.length < 3) return [];

  const search = (hay: string, ndl: string): number[] => {
    const hits: number[] = [];
    let from = 0;
    while (hits.length < limit) {
      const at = hay.indexOf(ndl, from);
      if (at === -1) break;
      hits.push(at);
      from = at + 1;
    }
    return hits;
  };

  let hits = search(source.norm, needle);
  if (hits.length === 0) {
    hits = search(source.norm.toLowerCase(), needle.toLowerCase());
  }

  return hits.map((at) => ({
    start: source.map[at]!,
    end: source.map[at + needle.length - 1]! + 1,
  }));
}

// --- Back to the DOM ---------------------------------------------------------

/** Nearest real character position at or after `pos` (skips separators). */
function charAt(
  index: TextIndex,
  pos: number,
  dir: 1 | -1
): { node: Text; offset: number } | null {
  for (let i = pos; i >= 0 && i < index.chars.length; i += dir) {
    const c = index.chars[i];
    if (c) return c;
  }
  return null;
}

/** Build a DOM Range for an occurrence found in index.text. */
export function occurrenceToRange(
  index: TextIndex,
  occ: Occurrence
): Range | null {
  const start = charAt(index, occ.start, 1);
  const end = charAt(index, occ.end - 1, -1);
  if (!start || !end) return null;
  try {
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    return range;
  } catch {
    // A node was detached between indexing and anchoring; caller re-indexes.
    return null;
  }
}
