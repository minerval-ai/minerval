/**
 * A stored or fetched document as the text a person reads on the page.
 *
 * One reader for every place that turns HTML into text: the stored copy a
 * quotation is checked against and the source page is drawn from
 * (`htmlToText`), and the page an agent opens with read_page (`htmlText`).
 * They must agree, because an agent quotes from the one and the quote check
 * tests against the other.
 *
 * The rules (#1127), which follow what a browser shows:
 *
 * - Inline markup (`<a>`, `<span>`, `<em>`, ...) is removed with nothing in
 *   its place. Whitespace is kept only where the document has it, so
 *   `often wrong</a><span>. The` reads "often wrong. The", not "wrong . The".
 * - A line break comes only from `<br>` and a blank line only from a block
 *   element. A newline in the HTML source is whitespace like any other.
 * - `h1` to `h6` are carried as markdown headings ("## Methods"), so the
 *   segmenter reads the document's own headings rather than guessing them.
 * - What a reader operates rather than reads is left out: `button`, `nav`,
 *   `form`, `aside`, `role="button"`, and share and subscribe widgets known
 *   by their class or id. A "Share" button is not a line of the document.
 *
 * Good enough to read a page and to test a quotation against; not a layout
 * engine and not an HTML parser. It is one pass over the tags, in time
 * linear in the document: stored and fetched content is hostile input, and
 * an earlier version built from regular expressions took minutes on a long
 * run of unclosed `<!--` or `<script`.
 */

/**
 * The named character references of HTML 4 (Latin-1, symbols and Greek,
 * special), plus `apos` and a few HTML5 spellings that science pages use.
 * Not the full HTML5 table of two thousand names, but enough that a page's
 * `&ne;` or `&alpha;` reads as the character the browser shows (#483).
 */
const LATIN1 =
  "nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr " +
  "deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest " +
  "Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml " +
  "ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig " +
  "agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml " +
  "eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml";
const GREEK =
  "Alpha Beta Gamma Delta Epsilon Zeta Eta Theta Iota Kappa Lambda Mu Nu Xi Omicron Pi Rho";
const GREEK_TAIL = "Sigma Tau Upsilon Phi Chi Psi Omega";
const NAMED_CODEPOINTS: Record<string, number> = {
  quot: 34, amp: 38, apos: 39, lt: 60, gt: 62,
  fnof: 402, OElig: 338, oelig: 339, Scaron: 352, scaron: 353, Yuml: 376, circ: 710, tilde: 732,
  sigmaf: 962, thetasym: 977, upsih: 978, piv: 982,
  ensp: 8194, emsp: 8195, thinsp: 8201, zwnj: 8204, zwj: 8205, lrm: 8206, rlm: 8207,
  ndash: 8211, mdash: 8212, lsquo: 8216, rsquo: 8217, sbquo: 8218, ldquo: 8220, rdquo: 8221,
  bdquo: 8222, dagger: 8224, Dagger: 8225, bull: 8226, hellip: 8230, permil: 8240, prime: 8242,
  Prime: 8243, lsaquo: 8249, rsaquo: 8250, oline: 8254, frasl: 8260, euro: 8364, image: 8465,
  weierp: 8472, real: 8476, trade: 8482, alefsym: 8501,
  larr: 8592, uarr: 8593, rarr: 8594, darr: 8595, harr: 8596, crarr: 8629,
  lArr: 8656, uArr: 8657, rArr: 8658, dArr: 8659, hArr: 8660,
  forall: 8704, part: 8706, exist: 8707, empty: 8709, nabla: 8711, isin: 8712, notin: 8713,
  ni: 8715, prod: 8719, sum: 8721, minus: 8722, lowast: 8727, radic: 8730, prop: 8733,
  infin: 8734, ang: 8736, and: 8743, or: 8744, cap: 8745, cup: 8746, int: 8747, there4: 8756,
  sim: 8764, cong: 8773, asymp: 8776, ne: 8800, equiv: 8801, le: 8804, ge: 8805, sub: 8834,
  sup: 8835, nsub: 8836, sube: 8838, supe: 8839, oplus: 8853, otimes: 8855, perp: 8869,
  sdot: 8901, lceil: 8968, rceil: 8969, lfloor: 8970, rfloor: 8971, lang: 10216, rang: 10217,
  loz: 9674, spades: 9824, clubs: 9827, hearts: 9829, diams: 9830,
  // HTML5 spellings common on science pages.
  pm: 177, half: 189, centerdot: 183, neq: 8800, leq: 8804, geq: 8805, approx: 8776,
  hyphen: 8208, minusplus: 8723, mp: 8723,
};

const ENTITIES: Record<string, string> = (() => {
  const table: Record<string, string> = {};
  LATIN1.split(" ").forEach((name, i) => (table[name] = String.fromCodePoint(160 + i)));
  GREEK.split(" ").forEach((name, i) => {
    table[name] = String.fromCodePoint(913 + i);
    table[name.toLowerCase()] = String.fromCodePoint(945 + i);
  });
  // No capital final sigma: the upper-case block skips U+03A2.
  GREEK_TAIL.split(" ").forEach((name, i) => {
    table[name] = String.fromCodePoint(931 + i);
    table[name.toLowerCase()] = String.fromCodePoint(963 + i);
  });
  for (const [name, code] of Object.entries(NAMED_CODEPOINTS)) table[name] = String.fromCodePoint(code);
  return table;
})();

/**
 * Decode character references: numeric ones always, named ones from the
 * table above. Names are case-sensitive (`&Delta;` is not `&delta;`), with a
 * lower-case fallback for spellings like `&AMP;`. An unknown name is left
 * as written rather than guessed at.
 */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body] ?? ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Whether stored content looks like an HTML document rather than plain text. */
export function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 4000);
  return /<(!doctype\s+html|html|head|body)[\s>]/i.test(head) || /<\/?(p|div|span|a|br|h[1-6])[\s>]/i.test(head);
}

const names = (list: string) => new Set(list.split(" "));

/** Elements a browser sets on lines of their own: a blank line on either side. */
const BLOCK = names(
  "address article aside blockquote body caption dd details dialog div dl dt fieldset figcaption figure footer " +
    "form h1 h2 h3 h4 h5 h6 header hgroup hr li main nav ol p pre section summary table tbody tfoot thead tr ul"
);

/** Elements with no content and no closing tag. */
const VOID = names("area base br col embed hr img input link meta param source track wbr");

/**
 * Elements whose content is not the document's text: what a browser does not
 * show (`head`, `script`, `style`, `noscript`, `template`, `svg`), and what a
 * reader operates rather than reads (`button`, `nav`, `form`, `aside`).
 */
const DROPPED = names("head script style noscript template svg button nav form aside");

/** Dropped elements whose content is not markup, so only their own closing tag ends them. */
const RAW_TEXT = names("script style");

/**
 * A class or id that names a share or subscribe widget: "share",
 * "share-buttons", "social-share", "subscription-widget-wrap", and a few
 * that go by a product's name (Jetpack's "sharedaddy", AddToAny, and
 * Substack's "button-wrapper" and "post-ufi", which hold its Share,
 * Subscribe and Comment buttons). Deliberately narrow: "share-price" and
 * "subscriber-count" are a document's own words, and a comment thread is
 * kept, since people quote from one.
 */
const CHROME_TOKEN =
  /^(?:(?:social[-_]?)?(?:share|sharing|subscribe|subscription)(?:[-_]?(?:buttons?|btns?|bar|box|widget|dialog|links?|tools?|icons?|menu|modal|popup|cta|prompt|this)(?:[-_].*)?)?|sharedaddy|sd-sharing|addtoany.*|a2a_kit|button-wrapper|post-ufi)$/i;

const ROLE_BUTTON = /\brole\s*=\s*["']?button\b/i;
const CLASS_OR_ID = /\b(?:class|id)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;

/** Whether an opening tag is one of the controls and widgets left out by what it says of itself. */
function isChrome(tag: string): boolean {
  if (ROLE_BUTTON.test(tag)) return true;
  for (const m of tag.matchAll(CLASS_OR_ID)) {
    const value = m[1] ?? m[2] ?? m[3] ?? "";
    // A value with no word of the pattern in it is not split and tested token by token.
    if (!/shar|subscri|addtoany|a2a_kit|button-wrapper|post-ufi/i.test(value)) continue;
    if (value.split(/\s+/).some((token) => CHROME_TOKEN.test(token))) return true;
  }
  return false;
}

/** A heading longer than this is taken for an unclosed `<h2>` with the page after it, and left as text. */
const MAX_HEADING_CHARS = 300;

/**
 * How many elements dropped for their class, id or role may turn out to have
 * no closing tag before the reader stops dropping by attribute. Each one
 * costs a second pass over the rest of the document, and where money cannot
 * bound a cost the count has to: this is a pure function over hostile
 * input, with no run and no budget to charge, and without a bound a page of
 * unclosed `<x role=button>` would cost time quadratic in its length.
 * Nothing is lost at the bound: the elements are read as text.
 */
const MAX_UNCLOSED_CHROME = 4;

const TAG_NAME = /[a-zA-Z][a-zA-Z0-9:-]*/y;

export interface ReadableText {
  text: string;
  /** How many `h1` to `h6` headings the text carries as markdown lines. */
  headings: number;
}

/**
 * Read markup as text, whatever it looks like: every tag is taken for a tag.
 * `htmlToText` is this for content that looks like HTML, and leaves plain
 * text alone.
 */
export function readHtml(html: string): ReadableText {
  const out: string[] = [];
  let headings = 0;
  // The open heading: its level and where its text starts in `out`.
  let heading: { level: number; start: number } | null = null;
  // The dropped element being skipped: its name, how many of that name are
  // open inside it, and where its opening tag ended, to go back to if it is
  // never closed.
  let skip: { name: string; depth: number; resume: number; chrome: boolean } | null = null;
  // Once something has no end after one start, it has none after any later
  // start either: remembered, so the rest of the document is not searched again.
  const unclosed = new Set<string>();
  let unclosedChrome = 0;
  let noCommentEnd = false;

  const emit = (s: string) => {
    if (!skip && s) out.push(s);
  };
  // A text node: its whitespace, line breaks included, is one space.
  const emitText = (s: string) => emit(s.replace(/[ \t\n\r\f\v]+/g, " "));
  const closeHeading = (closed: boolean) => {
    if (!heading) return;
    const { level, start } = heading;
    heading = null;
    if (!closed) return;
    const body = out.splice(start).join("");
    const label = body.replace(/\s+/g, " ").trim();
    if (!label) return;
    if (label.length > MAX_HEADING_CHARS) {
      out.push(body);
      return;
    }
    out.push(`${"#".repeat(level)} ${label}`);
    headings++;
  };

  let pos = 0;
  for (;;) {
    const lt = html.indexOf("<", pos);
    if (lt < 0) {
      // The end, inside a dropped element that was never closed. Dropping it
      // would lose the rest of the document to one missing tag, so go back
      // and read what follows its opening tag.
      if (skip) {
        if (skip.chrome) unclosedChrome++;
        else unclosed.add(skip.name);
        pos = skip.resume;
        skip = null;
        continue;
      }
      emitText(html.slice(pos));
      break;
    }
    emitText(html.slice(pos, lt));

    if (html.startsWith("<!--", lt)) {
      const end = noCommentEnd ? -1 : html.indexOf("-->", lt + 4);
      if (end < 0) {
        noCommentEnd = true;
        emit("<");
        pos = lt + 1;
      } else {
        pos = end + 3;
      }
      continue;
    }

    const closing = html[lt + 1] === "/";
    TAG_NAME.lastIndex = lt + (closing ? 2 : 1);
    const named = TAG_NAME.exec(html);
    const declaration = !closing && (html[lt + 1] === "!" || html[lt + 1] === "?");
    if (!named && !declaration) {
      // "3 < 4", "<>": a less-than sign, not a tag.
      emit("<");
      pos = lt + 1;
      continue;
    }
    const gt = html.indexOf(">", lt + 1);
    if (gt < 0) {
      // No `>` after this `<` means none after any later one: the rest is text.
      if (skip) {
        // Handled at the end, above.
        pos = html.length;
        continue;
      }
      emitText(html.slice(lt));
      break;
    }
    pos = gt + 1;
    if (!named) continue;
    const name = named[0].toLowerCase();
    const selfClosed = html[gt - 1] === "/";

    if (skip) {
      if (RAW_TEXT.has(name) && !closing && !selfClosed && name !== skip.name) {
        // A script inside a dropped element: its text is not markup.
        pos = rawTextEnd(html, name, pos, unclosed) ?? pos;
      } else if (name === skip.name) {
        if (closing) skip.depth--;
        else if (!selfClosed) skip.depth++;
        if (skip.depth === 0) skip = null;
      }
      continue;
    }

    if (closing) {
      if (/^h[1-6]$/.test(name)) closeHeading(true);
      if (BLOCK.has(name)) emit("\n\n");
      else if (name === "td" || name === "th") emit(" ");
      continue;
    }

    if (/^h[1-6]$/.test(name)) {
      // A heading opened inside an open one: the first was never closed.
      closeHeading(false);
      emit("\n\n");
      heading = { level: Number(name[1]), start: out.length };
      continue;
    }
    if (BLOCK.has(name)) emit("\n\n");
    else if (name === "br") emit("\n");
    else if (name === "td" || name === "th") emit(" ");
    if (VOID.has(name) || selfClosed) continue;

    if (RAW_TEXT.has(name)) {
      // Unclosed, it is read on from its opening tag, like any other dropped element.
      pos = rawTextEnd(html, name, pos, unclosed) ?? pos;
      continue;
    }
    if (DROPPED.has(name) && !unclosed.has(name)) {
      skip = { name, depth: 1, resume: pos, chrome: false };
    } else if (unclosedChrome < MAX_UNCLOSED_CHROME && isChrome(html.slice(lt, gt + 1))) {
      skip = { name, depth: 1, resume: pos, chrome: true };
    }
  }

  const text = decodeEntities(out.join(""))
    // One space for a run of them. Runs are single spaces already except
    // where an entity or a no-break space made one; the newlines are the
    // reader's own, from `<br>` and block elements.
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, headings };
}

/**
 * Where the text of a `<script>` or `<style>` opened just before `from`
 * ends: after its closing tag, or null when it has none.
 */
function rawTextEnd(html: string, name: string, from: number, unclosed: Set<string>): number | null {
  if (unclosed.has(name)) return null;
  // One of the two fixed names of RAW_TEXT, so safe to build a pattern from.
  const close = new RegExp(`<\\/${name}\\s*>`, "gi");
  close.lastIndex = from;
  const m = close.exec(html);
  if (!m) {
    unclosed.add(name);
    return null;
  }
  return m.index + m[0].length;
}

/**
 * A stored document as readable text, and how many headings of its own it
 * carries. HTML is read by the rules at the top of this file. Plain text
 * passes through with its entities decoded and its whitespace normalized:
 * an extractor that stripped the tags can still leave `&ne;` behind (#483).
 */
export function readableText(content: string): ReadableText {
  if (!looksLikeHtml(content)) {
    // The lookbehind starts a match only where a run of spaces and tabs
    // starts, so a long run not followed by a newline is scanned once, not
    // once per character (quadratic).
    const text = decodeEntities(content).replace(/\r\n?/g, "\n").replace(/(?<![ \t])[ \t]+\n/g, "\n").trim();
    return { text, headings: 0 };
  }
  return readHtml(content);
}

/** The readable text of a stored document (`readableText`), alone. */
export function htmlToText(content: string): string {
  return readableText(content).text;
}
