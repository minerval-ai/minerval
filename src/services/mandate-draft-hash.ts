/**
 * The hash that pins a Grantmaker's draft to the approval that funds it
 * (#529). A platform mandate's money is approved in a pull request that
 * carries a snapshot of the draft and this hash; the operator route funds
 * the conversation only while its stored draft still hashes the same, so a
 * draft revised after review cannot be funded on the old approval.
 *
 * Pure (no database, no config) so the script that writes and checks the
 * request files computes exactly what the server computes.
 */
import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every depth. The draft round-trips
 * through Postgres jsonb, which does not preserve key order, so the hash is
 * taken over this form, never over a raw JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortKeys(v);
    }
    return out;
  }
  return value;
}

/** Hex SHA-256 of the draft's canonical JSON. */
export function mandateDraftHash(draft: unknown): string {
  return createHash("sha256").update(canonicalJson(draft)).digest("hex");
}
