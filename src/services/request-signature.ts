/**
 * Signed requests from a connected deployment to the public graph
 * (docs/organizations.md, "Signed requests"; #1118).
 *
 * A deployment holds an Ed25519 key that never leaves it, and signs each
 * request it makes with it. The signature is over eight lines, in the style
 * of the publisher registration (src/published-page/verify.ts):
 *
 *   minerval-request/1
 *   <host>
 *   <METHOD>
 *   <path with query string, as sent>
 *   <hex sha-256 of the body, or of nothing>
 *   <created, unix seconds>
 *   <nonce>
 *   <key id>
 *
 * and travels in one header:
 *
 *   Authorization: Minerval-Deployment key_id="…", created="…", nonce="…", signature="…"
 *
 * Both sides use this module: the deployment to sign (services/
 * public-graph-client.ts), the public graph to check (server/plugins/
 * auth.ts and routes/deployments.ts).
 */
import { createHash, randomBytes, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from "node:crypto";
import { keyIdOf, parsePublicKey } from "./mirror-batch.js";

export const SIGNATURE_SCHEME = "Minerval-Deployment";
export const STATEMENT_FORMAT = "minerval-request/1";
/** How far a request's `created` may be from the server's clock, either way. */
export const CLOCK_SKEW_SECONDS = 5 * 60;
/** How long a write's nonce is remembered: longer than the skew either way. */
export const NONCE_MEMORY_SECONDS = 10 * 60;

export interface SignedParts {
  host: string;
  method: string;
  /** The path and query string exactly as sent. */
  path: string;
  /** Hex sha-256 of the body bytes, or of nothing. */
  bodyHash: string;
  created: number;
  nonce: string;
  keyId: string;
}

export function sha256Hex(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export const EMPTY_BODY_HASH = sha256Hex(Buffer.alloc(0));

export function requestStatement(p: SignedParts): string {
  return [STATEMENT_FORMAT, p.host.toLowerCase(), p.method.toUpperCase(), p.path, p.bodyHash, String(p.created), p.nonce, p.keyId].join("\n");
}

/** The Authorization header for a request, signed with the deployment's private key. */
export function signRequest(
  privateKey: KeyObject,
  publicKey: string,
  req: { host: string; method: string; path: string; body?: Buffer | string | null },
  now: Date = new Date()
): string {
  const parts: SignedParts = {
    host: req.host,
    method: req.method,
    path: req.path,
    bodyHash: req.body === undefined || req.body === null ? EMPTY_BODY_HASH : sha256Hex(req.body),
    created: Math.floor(now.getTime() / 1000),
    nonce: randomBytes(16).toString("hex"),
    keyId: keyIdOf(publicKey),
  };
  const signature = cryptoSign(null, Buffer.from(requestStatement(parts), "utf8"), privateKey).toString("base64");
  return `${SIGNATURE_SCHEME} key_id="${parts.keyId}", created="${parts.created}", nonce="${parts.nonce}", signature="${signature}"`;
}

export interface PresentedSignature {
  keyId: string;
  created: number;
  nonce: string;
  signature: string;
}

/** Whether an Authorization header is a deployment's signature (and not a Bearer token). */
export function isSignedRequest(authorization: string | undefined): boolean {
  return typeof authorization === "string" && authorization.startsWith(`${SIGNATURE_SCHEME} `);
}

/** The parts of a presented signature, or null where the header is not well formed. */
export function parseSignatureHeader(authorization: string): PresentedSignature | null {
  if (!isSignedRequest(authorization)) return null;
  const fields = new Map<string, string>();
  for (const m of authorization.slice(SIGNATURE_SCHEME.length + 1).matchAll(/([a-z_]+)="([^"]*)"/g)) {
    fields.set(m[1]!, m[2]!);
  }
  const keyId = fields.get("key_id") ?? "";
  const created = Number(fields.get("created"));
  const nonce = fields.get("nonce") ?? "";
  const signature = fields.get("signature") ?? "";
  if (!/^[0-9a-f]{64}$/.test(keyId) || !Number.isInteger(created) || !/^[0-9A-Za-z_-]{16,128}$/.test(nonce) || !signature) {
    return null;
  }
  return { keyId, created, nonce, signature };
}

export type SignatureFault =
  | "MALFORMED"
  | "KEY_MISMATCH"
  | "STALE"
  | "BAD_SIGNATURE";

export const SIGNATURE_FAULT_WORDS: Record<SignatureFault, string> = {
  MALFORMED: "The deployment's signature is not well formed.",
  KEY_MISMATCH: "The signature names a different key from the one it is checked against.",
  STALE: "The signed time is more than five minutes from the server's clock. Check the deployment machine's clock.",
  BAD_SIGNATURE:
    "The signature does not check out against the deployment's key for this host, method, path and body.",
};

/**
 * Check a presented signature against a public key, for the request as it
 * arrived. The nonce is not checked here: the caller records it for writes.
 */
export function checkSignature(
  presented: PresentedSignature,
  publicKey: string,
  req: { host: string; method: string; path: string; bodyHash: string },
  now: Date = new Date()
): SignatureFault | null {
  if (keyIdOf(publicKey) !== presented.keyId) return "KEY_MISMATCH";
  if (Math.abs(Math.floor(now.getTime() / 1000) - presented.created) > CLOCK_SKEW_SECONDS) return "STALE";
  const statement = requestStatement({
    host: req.host,
    method: req.method,
    path: req.path,
    bodyHash: req.bodyHash,
    created: presented.created,
    nonce: presented.nonce,
    keyId: presented.keyId,
  });
  let ok = false;
  try {
    ok = cryptoVerify(null, Buffer.from(statement, "utf8"), parsePublicKey(publicKey), Buffer.from(presented.signature, "base64"));
  } catch {
    ok = false;
  }
  return ok ? null : "BAD_SIGNATURE";
}
