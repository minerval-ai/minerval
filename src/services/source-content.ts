/**
 * A source's content hash (#547): SHA-256 of its stored text, as UTF-8,
 * written with the text the one time the text is stored.
 *
 * A source's text is only ever filled when it is empty, so the hash fixes
 * what was read: evidence cannot be swapped under the judgments made on it,
 * and a judgment's record of what it was made against (judgment_inputs)
 * names the text by this hash. A different text for the same document is a
 * different source. Two sources can hold the same text (one document at two
 * addresses), so the hash identifies the content, not the row.
 *
 * In SQL the same value is encode(sha256(convert_to(raw_content, 'UTF8')), 'hex').
 */
import { createHash } from "node:crypto";

/** The hash to store with `content`; null for no content. */
export function sourceContentHash(content: string | null | undefined): string | null {
  if (!content) return null;
  return createHash("sha256").update(content, "utf8").digest("hex");
}
