/**
 * Sending one webhook POST to an address a caller gave (docs/events.md,
 * "Where a webhook may send").
 *
 * The address is a stranger's choice and this process sits inside the
 * deployment's network, so every send goes through here:
 *
 *  - `https` only, with no credentials in the address;
 *  - the host is resolved now, at the moment of sending, and every address
 *    it resolves to must be public, unless the deployment lists the host in
 *    EVENT_WEBHOOK_ALLOWED_HOSTS (a receiver on its own network);
 *  - the connection is made to the address that was checked, with the
 *    host's name in the Host header and in TLS, so the name cannot resolve
 *    to something else between the check and the connection;
 *  - a redirect is not followed: it is an answer like any other, and a
 *    failed one, because where it leads was not checked;
 *  - the wait is short and the answer's body is read only as far as a
 *    challenge needs.
 *
 * What comes back is a category and never the receiver's words, so the
 * result cannot be used to read what an address of the caller's choosing
 * answers.
 */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import { isIP } from "node:net";
import { loadConfig } from "../config.js";
import { isPrivateIp } from "./url-guard.js";

/** Why a delivery did not land, in the categories a subscriber is shown. */
export type DeliveryFailure = "connection_refused" | "timeout" | "tls_error" | "http_4xx" | "http_5xx" | "challenge_failed";

export type SendResult =
  | { ok: true; status: number; body: string }
  | { ok: false; failure: DeliveryFailure; status?: number };

export type WebhookSend = (url: string, headers: Record<string, string>, body: string) => Promise<SendResult>;

/** How long a receiver has to answer. It should accept the event and do its work afterwards. */
export const WEBHOOK_TIMEOUT_MS = 5_000;
/** How much of an answer is read: enough for a challenge echoed back. */
const MAX_RESPONSE_BYTES = 4 * 1024;

/** What is wrong with a callback address as written, in a sentence; null when nothing is. Resolves nothing. */
export function callbackUrlProblem(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > 2000) return "delivery.url must be an https address of at most 2000 characters.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "delivery.url is not a valid address.";
  }
  if (url.protocol !== "https:") return "delivery.url must use https: a delivery and its signature must not cross the network in the clear.";
  if (url.username || url.password) return "delivery.url must not carry credentials; deliveries are authenticated by their signature.";
  if (url.hash) return "delivery.url must not carry a fragment.";
  return null;
}

function allowedHost(host: string): boolean {
  return loadConfig().eventWebhookAllowedHosts.includes(host.toLowerCase());
}

/** The address to connect to for a host, checked now; null when the host may not be reached. */
export async function resolveCallbackAddress(host: string): Promise<{ address: string; family: 4 | 6 } | null> {
  const bare = host.replace(/^\[|\]$/g, "");
  const allowed = allowedHost(bare);
  if (isIP(bare)) {
    if (isPrivateIp(bare) && !allowed) return null;
    return { address: bare, family: isIP(bare) === 6 ? 6 : 4 };
  }
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookup(bare, { all: true, verbatim: true });
  } catch {
    return null;
  }
  if (addresses.length === 0) return null;
  // Every address must pass: a name that resolves to one public address and
  // one private one is refused, not tried until the private one answers.
  if (!allowed && addresses.some((a) => isPrivateIp(a.address))) return null;
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/** POST one body to a callback address, by the rules above. */
export const sendWebhook: WebhookSend = async (rawUrl, headers, body) => {
  if (callbackUrlProblem(rawUrl)) return { ok: false, failure: "connection_refused" };
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const target = await resolveCallbackAddress(host);
  if (!target) return { ok: false, failure: "connection_refused" };
  return new Promise<SendResult>((resolve) => {
    let settled = false;
    const done = (r: SendResult) => {
      if (settled) return;
      settled = true;
      resolve(r);
    };
    const req = request(
      {
        method: "POST",
        host: target.address,
        family: target.family,
        port: url.port ? Number(url.port) : 443,
        path: `${url.pathname}${url.search}`,
        // The name the certificate must be for, and the name the receiver routes on.
        servername: isIP(host) ? undefined : host,
        headers: { ...headers, host: url.host, "content-length": String(Buffer.byteLength(body, "utf8")) },
        timeout: WEBHOOK_TIMEOUT_MS,
        // One connection for one delivery: nothing is kept open to an address a caller chose.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
          else res.destroy();
        });
        const finish = () => {
          if (status >= 200 && status < 300) {
            done({ ok: true, status, body: Buffer.concat(chunks).toString("utf8") });
          } else if (status >= 500) done({ ok: false, failure: "http_5xx", status });
          // A redirect is not followed, so it is a delivery that did not land.
          else done({ ok: false, failure: "http_4xx", status });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      }
    );
    req.on("timeout", () => {
      req.destroy();
      done({ ok: false, failure: "timeout" });
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      const code = String(err.code ?? "");
      const tls = code.startsWith("ERR_TLS") || code.startsWith("CERT_") || /certificate|SSL|TLS/i.test(err.message);
      done({ ok: false, failure: tls ? "tls_error" : "connection_refused" });
    });
    req.end(body);
  });
};
