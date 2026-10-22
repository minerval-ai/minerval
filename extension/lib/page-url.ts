/**
 * Page identity for the shared analysis cache, mirroring the server's
 * src/services/page-url.ts (a shared test holds the two to the same vectors):
 * a normalized URL and its SHA-256. Lookups send only the hash's first
 * PAGE_HASH_PREFIX_CHARS characters.
 */

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

export async function pageUrlHash(normalizedUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(normalizedUrl)
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const PAGE_HASH_PREFIX_CHARS = 4;
