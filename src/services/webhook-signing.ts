/**
 * What a webhook delivery carries so its receiver can trust it
 * (docs/events.md, "Webhook"): the Standard Webhooks signature the MCP
 * Events extension profiles, the caller's secret and what it must be, and
 * the id a subscription is known by.
 *
 * This file holds no database and no network.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const SECRET_PREFIX = "whsec_";
/** A Standard Webhooks symmetric secret is 24 to 64 random bytes. */
const SECRET_MIN_BYTES = 24;
const SECRET_MAX_BYTES = 64;

/**
 * The bytes of a caller's signing secret, or null when it is not one:
 * `whsec_` and then the base64 of 24 to 64 bytes. The caller makes the
 * secret and the server never does, so the party that checks deliveries is
 * the one that holds it from the start.
 */
export function secretBytes(secret: unknown): Buffer | null {
  if (typeof secret !== "string" || !secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return null;
  const bytes = Buffer.from(encoded, "base64");
  // A string that only looks like base64 decodes to something that does not
  // encode back to it.
  if (bytes.toString("base64").replace(/=+$/, "") !== encoded.replace(/=+$/, "")) return null;
  return bytes.length >= SECRET_MIN_BYTES && bytes.length <= SECRET_MAX_BYTES ? bytes : null;
}

/** A secret of the right shape, for a test or an example. A caller makes its own. */
export function makeSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString("base64");
}

/** The `v1,` signature of one delivery: HMAC-SHA256 over `id.timestamp.body`, under the secret's bytes. */
export function signDelivery(secret: Buffer, messageId: string, timestampSeconds: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${messageId}.${timestampSeconds}.${body}`, "utf8").digest("base64");
  return `v1,${mac}`;
}

/** Whether one of a header's space-separated signatures is this delivery's, compared in constant time. */
export function verifyDelivery(
  secret: Buffer,
  messageId: string,
  timestampSeconds: number,
  body: string,
  header: string
): boolean {
  const want = Buffer.from(signDelivery(secret, messageId, timestampSeconds, body), "utf8");
  return header.split(/\s+/).some((candidate) => {
    const got = Buffer.from(candidate, "utf8");
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

/** The headers every delivery carries. Each attempt is signed afresh, so a retry is not stale to its receiver. */
export function deliveryHeaders(input: {
  secret: Buffer;
  /** A secret being replaced: signed with both for a while, so a delivery in flight verifies under either. */
  previousSecret?: Buffer | null;
  messageId: string;
  subscriptionId: string;
  body: string;
  now?: Date;
}): Record<string, string> {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const signatures = [signDelivery(input.secret, input.messageId, timestamp, input.body)];
  if (input.previousSecret) signatures.push(signDelivery(input.previousSecret, input.messageId, timestamp, input.body));
  return {
    "content-type": "application/json",
    "webhook-id": input.messageId,
    "webhook-timestamp": String(timestamp),
    "webhook-signature": signatures.join(" "),
    "x-mcp-subscription-id": input.subscriptionId,
  };
}

/** An id for one delivered message: letters, digits, `_` and `-`, and never made from the event's own id. */
export function messageId(kind: "event" | "verification" | "terminated" | "gap" = "event"): string {
  const random = randomBytes(18).toString("base64url");
  return kind === "event" ? `msg_${random}` : `msg_${kind}_${random}`;
}

/** JSON with its keys in order at every depth, so two equal sets of arguments are the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * A subscription's id: derived from who asked, where it delivers and what it
 * listens for, so the same four always give the same id. It routes a
 * delivery to the right secret at the receiver; knowing it authorizes
 * nothing, and no request takes it as proof of anything.
 */
export function subscriptionId(principal: string, url: string, name: string, args: unknown): string {
  const key = canonicalJson([principal, url, name, args ?? {}]);
  return `sub_${createHash("sha256").update(key, "utf8").digest("hex").slice(0, 32)}`;
}

/** Whether a receiver's answer to a challenge is the challenge, compared in constant time. */
export function challengeAnswered(challenge: string, responseBody: string): boolean {
  let answer: unknown;
  try {
    answer = (JSON.parse(responseBody) as { challenge?: unknown }).challenge;
  } catch {
    return false;
  }
  if (typeof answer !== "string") return false;
  const a = Buffer.from(answer, "utf8");
  const b = Buffer.from(challenge, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
