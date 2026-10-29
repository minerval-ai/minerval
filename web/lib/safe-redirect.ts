/**
 * Return-to targets (e.g. /signin?callbackUrl=...) come from the query
 * string, so they must be same-site relative paths — never an open redirect.
 *
 * "Starts with / but not //" is not enough: browsers treat "\" as "/" in
 * http(s) URLs and drop tab/CR/LF anywhere in a URL, so "/\evil.example" or
 * "/\t/evil.example" in a Location header resolve to https://evil.example.
 * Accept only a single leading "/" that is not followed by "/" or "\", and
 * only if the value still resolves to the same origin once parsed the way a
 * browser parses it (the WHATWG URL parser, which applies both rules above).
 */
const PROBE_ORIGIN = "https://minerval.invalid";

export function isSafeRelativePath(value: string | undefined): value is string {
  if (!value?.startsWith("/")) return false;
  if (value[1] === "/" || value[1] === "\\") return false;
  try {
    return new URL(value, PROBE_ORIGIN).origin === PROBE_ORIGIN;
  } catch {
    return false;
  }
}
