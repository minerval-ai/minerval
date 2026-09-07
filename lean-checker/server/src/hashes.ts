/**
 * The two hashes of design section 5.1, plus the submission digest.
 *
 * `source_hash` is what a reader or an outside solver recomputes from the
 * published statement text and the pin: it covers the normalised source and
 * the pin id, under a versioned prefix so a future change to the
 * normalisation cannot collide with today's values.
 *
 * `expr_hash` is what the checker compares across pins: a digest of the
 * statement body as Lean prints it under `pp.all`, which the checker
 * executable returns as `pp_all`. Same print, same elaborated body.
 */
import { createHash } from "node:crypto";

export const SOURCE_HASH_VERSION = "minerval-statement-v1";
export const EXPR_HASH_VERSION = "minerval-expr-v1";

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

/**
 * CRLF to LF, trailing whitespace stripped from every line, trailing blank
 * lines dropped, exactly one final newline, Unicode NFC. Nothing inside a
 * line changes, so the normalised text still elaborates identically.
 */
export function normalizeSource(source: string): string {
  const lines = source
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.replace(/[ \t\f\v]+$/u, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines.join("\n") + "\n";
}

export function sourceHash(source: string, pinId: string): string {
  return sha256Hex(`${SOURCE_HASH_VERSION}\n${pinId}\n${normalizeSource(source)}`);
}

export function exprHash(ppAll: string): string {
  return sha256Hex(`${EXPR_HASH_VERSION}\n${ppAll.trim()}`);
}

/** The digest of the submission exactly as received, bytes of UTF-8. */
export function submissionSha256(submission: string): string {
  return sha256Hex(Buffer.from(submission, "utf8"));
}
