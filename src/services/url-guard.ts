/**
 * SSRF guard for server-side URL fetching (#source ingestion).
 *
 * Ingest URLs are attacker-influenceable three ways: user source
 * proposals, grant plans, and the autonomous review agent extending its
 * own plan from web research. The fetcher runs inside the VPC, so an
 * unguarded fetch reaches the cloud metadata endpoint (169.254.169.254),
 * internal services, and localhost. This module is the chokepoint:
 *
 *  - only http/https, on the default or explicitly standard ports;
 *  - the hostname must resolve, and EVERY resolved address must be
 *    public — loopback, RFC1918, link-local (incl. the metadata range),
 *    CGNAT, unspecified, multicast/broadcast, and their IPv6 kin
 *    (::1, ::, fc00::/7, fe80::/10, v4-mapped) are all refused;
 *  - redirects are followed manually (bounded), re-validating every hop,
 *    so a public URL cannot bounce the fetcher into the VPC.
 *
 * Residual risk, accepted and documented: DNS rebinding (a hostname that
 * re-resolves between our check and the socket connect). Closing that
 * fully requires pinning the connection to the validated IP (a custom
 * undici dispatcher); revisit if ingest ever handles genuinely hostile
 * sources at scale.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;
const FETCH_TIMEOUT_MS = 60_000;
/** Responses larger than this are cut off — extraction reads text, and an
 * unbounded body is a memory-exhaustion vector, not a source. */
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

function ipv4ToInt(ip: string): number {
  const [a, b, c, d] = ip.split(".").map(Number);
  return ((a! << 24) | (b! << 16) | (c! << 8) | d!) >>> 0;
}

function inCidr4(ip: number, base: string, maskBits: number): boolean {
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ip & mask) === (ipv4ToInt(base) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network" / unspecified
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["224.0.0.0", 3], // multicast + reserved + broadcast (224.0.0.0–255.255.255.255)
];

function isPrivateV4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  return PRIVATE_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

function isPrivateIp(ip: string): boolean {
  if (isIP(ip) === 4) return isPrivateV4(ip);
  const lower = ip.toLowerCase();
  // v4-mapped / v4-translated IPv6 — judge the embedded v4. The URL
  // parser may hand us either the dotted form (::ffff:127.0.0.1) or the
  // normalized hex form (::ffff:7f00:1); decode both.
  const v4 = lower.match(/(?:^|:)(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) return isPrivateV4(v4[1]!);
  const v4hex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (v4hex) {
    const hi = parseInt(v4hex[1]!, 16);
    const lo = parseInt(v4hex[2]!, 16);
    return isPrivateV4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }
  if (lower === "::" || lower === "::1") return true;
  if (lower.startsWith("fe8") || lower.startsWith("fe9") ||
      lower.startsWith("fea") || lower.startsWith("feb")) {
    return true; // fe80::/10 link-local
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // fc00::/7 ULA
  if (lower.startsWith("ff")) return true; // multicast
  return false;
}

/**
 * Validate one URL for server-side fetching: http/https only, and every
 * address its host resolves to must be public. Throws UnsafeUrlError.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(
      `Refusing to fetch non-HTTP(S) URL (${url.protocol}//…)`
    );
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Refusing URL with embedded credentials");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateIp(host)) {
      throw new UnsafeUrlError(`Refusing non-public address: ${host}`);
    }
    return url;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`Hostname does not resolve: ${host}`);
  }
  if (addresses.length === 0) {
    throw new UnsafeUrlError(`Hostname does not resolve: ${host}`);
  }
  for (const { address } of addresses) {
    if (isPrivateIp(address)) {
      throw new UnsafeUrlError(
        `Refusing ${host}: resolves to non-public address ${address}`
      );
    }
  }
  return url;
}

/**
 * Fetch a public URL's body as text: every hop validated, redirects
 * bounded, response time- and size-capped. The one sanctioned way for
 * ingestion to touch the network.
 */
export async function fetchPublicUrl(
  rawUrl: string,
  init: { userAgent?: string } = {}
): Promise<string> {
  let current = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const url = await assertPublicHttpUrl(current);
    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        "User-Agent": init.userAgent ?? "Minerval/1.0 (Knowledge Graph Indexer)",
      },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      // Drain the redirect body so the connection can be reused.
      await response.arrayBuffer().catch(() => undefined);
      if (!location) {
        throw new Error(`Redirect from ${current} with no Location header`);
      }
      current = new URL(location, url).toString();
      continue;
    }
    if (!response.ok) {
      throw new Error(`Failed to fetch ${current}: ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) return "";
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new Error(
          `Response from ${current} exceeds ${MAX_RESPONSE_BYTES} bytes`
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new UnsafeUrlError(`Too many redirects fetching ${rawUrl}`);
}
