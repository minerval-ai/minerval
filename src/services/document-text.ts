/**
 * Turning a fetched document body into text the graph can store (#430).
 *
 * The fetcher used to decode every response as UTF-8 and hand the result
 * on as if it were text. For a PDF that produced its binary bytes, which
 * carry NUL characters; Postgres refuses NUL in a `text` column, so every
 * PDF a Steward tried to open failed with "invalid byte sequence for
 * encoding UTF8: 0x00" and no PDF source could be read whole. Two things
 * fix that here:
 *
 *  - a PDF body (by magic number or content type) has its text extracted,
 *    page by page, through pdf.js (via `unpdf`, which bundles it without
 *    a DOM or a worker);
 *  - every body, extracted or decoded, is scrubbed of NUL and the other
 *    control characters no text column accepts and no reader wants.
 *
 * A PDF that pdf.js cannot open (encrypted, truncated, not a PDF at all
 * despite its header) is a clean fetch failure, not stored garbage.
 */
import { extractText } from "unpdf";

const PDF_MAGIC = "%PDF-";

/** Control characters other than tab, line feed, and carriage return. */
const UNSTORABLE_CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * Text as Postgres will take it: NUL and the other C0 controls (and DEL)
 * removed. Tab and newlines survive; they are layout, not noise. Applied
 * to everything the fetcher returns and again at the store, so a fetcher
 * a caller substituted cannot reintroduce the failure.
 */
export function sanitizeStoredText(text: string): string {
  return text.replace(UNSTORABLE_CONTROL, "");
}

/** Whether a body is a PDF: the header says so, or the server did. */
export function looksLikePdf(body: Uint8Array, contentType?: string | null): boolean {
  if (body.byteLength >= PDF_MAGIC.length) {
    let header = "";
    for (let i = 0; i < PDF_MAGIC.length; i++) header += String.fromCharCode(body[i] ?? 0);
    if (header === PDF_MAGIC) return true;
  }
  return /^\s*application\/pdf\b/i.test(contentType ?? "");
}

/**
 * The text of a PDF, pages separated by a blank line, in reading order as
 * pdf.js recovers it. Throws when the document cannot be opened.
 */
export async function extractPdfText(body: Uint8Array): Promise<string> {
  // Handed bytes rather than a document proxy, unpdf opens the document
  // and destroys it once the text is out.
  const { text } = await extractText(new Uint8Array(body), { mergePages: false });
  return text
    .map((page) => page.replace(/[ \t]+\n/g, "\n").trim())
    .filter((page) => page.length > 0)
    .join("\n\n");
}

/**
 * A fetched body as storable text: a PDF's extracted text, anything else
 * decoded as UTF-8; both scrubbed. `where` names the document in the
 * error when a PDF will not open.
 */
export async function bodyToText(
  body: Uint8Array,
  contentType: string | null | undefined,
  where: string
): Promise<string> {
  if (looksLikePdf(body, contentType)) {
    let text: string;
    try {
      text = await extractPdfText(body);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(`Could not extract text from the PDF at ${where}: ${reason}`);
    }
    return sanitizeStoredText(text);
  }
  return sanitizeStoredText(Buffer.from(body).toString("utf8"));
}
