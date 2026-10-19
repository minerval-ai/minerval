/**
 * The identity of a web page for the shared analysis cache: a normalized URL
 * and its hash. Two readers of the same article should land on the same key
 * however they arrived (tracking parameters, a fragment, http vs https, a
 * trailing slash), and the browser extension computes the same key on its
 * side to look the page up (extension/lib/page-url.ts mirrors this file; a
 * shared test holds the two to the same vectors).
 */
import crypto from "crypto";

/** Query parameters that say how a reader arrived, never which page it is. */
const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "dclid",
  "msclkid",
  "mc_cid",
  "mc_eid",
  "igshid",
  "ref",
  "ref_src",
  "triedredirect",
  "showwelcomeonshare",
]);

function isTrackingParam(name: string): boolean {
  const n = name.toLowerCase();
  return n.startsWith("utm_") || TRACKING_PARAMS.has(n);
}

/**
 * Normalize a page URL, or return null for anything that is not an http(s)
 * page. The scheme becomes https, a leading "www." and the fragment go,
 * tracking parameters are dropped and the rest sorted, and a trailing slash
 * is trimmed from any path but the root.
 */
export function normalizePageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([a, av], [b, bv]) => (a === b ? (av < bv ? -1 : av > bv ? 1 : 0) : a < b ? -1 : 1));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : "";
  let path = url.pathname;
  if (path.length > 1) path = path.replace(/\/+$/, "") || "/";
  const port = url.port && url.port !== "443" && url.port !== "80" ? `:${url.port}` : "";

  return `https://${host}${port}${path}${query}`;
}

/** Hex SHA-256 of a normalized page URL: the shared cache's key. */
export function pageUrlHash(normalizedUrl: string): string {
  return crypto.createHash("sha256").update(normalizedUrl).digest("hex");
}

/**
 * Hex characters of the hash a lookup reveals. 16 bits: each prefix stands
 * for one in 65,536 of all URLs, so a lookup that misses tells the server
 * nothing usable about the page, and a bucket's full hashes stay few enough
 * to send back whole.
 */
export const PAGE_HASH_PREFIX_CHARS = 4;
