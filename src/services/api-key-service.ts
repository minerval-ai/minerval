/**
 * API-key service (#70): mint, list, revoke, and resolve DB-backed API keys.
 *
 * Key material: "epk_" + 32 random bytes base64url (~43 chars, >250 bits of
 * entropy). Only the SHA-256 hash is stored; the plaintext is returned exactly
 * once at creation. High-entropy keys make a fast unsalted hash the correct
 * construction (no brute-force surface, O(1) indexed lookup) — this is the
 * standard design for API tokens, unlike user-chosen passwords.
 */
import crypto from "node:crypto";
import { and, desc, eq, isNull } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { apiKeys, contributors, type ApiKey, type Contributor } from "../db/schema.js";
import type { PLATFORM_GRANTMAKING_SCOPE } from "./platform-account.js";

export const API_KEY_PREFIX = "epk_";
const DISPLAY_PREFIX_LENGTH = 12; // "epk_" + 8 chars, enough to identify a key

export function hashApiKey(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function generateApiKeyPlaintext(): string {
  return API_KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
}

export interface CreatedApiKey {
  key: ApiKey;
  /** Full key material — shown once, never stored. */
  plaintext: string;
}

export async function createApiKey(input: {
  userId: string;
  name: string;
  /**
   * "user" (the default), "service" (first-party, may act for a user), or
   * "platform_grantmaking": the platform account's conversation-only key,
   * minted with the operator key (services/platform-account.ts).
   */
  scope?: "user" | "service" | typeof PLATFORM_GRANTMAKING_SCOPE;
}): Promise<CreatedApiKey> {
  const plaintext = generateApiKeyPlaintext();
  const db = getDb();
  const [key] = await db
    .insert(apiKeys)
    .values({
      userId: input.userId,
      name: input.name,
      keyPrefix: plaintext.slice(0, DISPLAY_PREFIX_LENGTH),
      keyHash: hashApiKey(plaintext),
      scope: input.scope ?? "user",
    })
    .returning();
  return { key: key!, plaintext };
}

export async function listApiKeys(userId: string): Promise<ApiKey[]> {
  const db = getDb();
  return db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.userId, userId))
    .orderBy(desc(apiKeys.createdAt));
}

/**
 * Soft-revoke a key owned by `userId`. Returns the revoked key, or null when
 * the key doesn't exist, belongs to someone else, or is already revoked —
 * ownership is part of the WHERE clause so a user can never revoke another
 * user's key.
 */
export async function revokeApiKey(
  userId: string,
  keyId: string
): Promise<ApiKey | null> {
  const db = getDb();
  const [revoked] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.userId, userId),
        isNull(apiKeys.revokedAt)
      )
    )
    .returning();
  return revoked ?? null;
}

export interface ResolvedApiKey {
  key: ApiKey;
  user: Contributor;
}

/**
 * Resolve a presented plaintext key to its row + owning user. Returns null
 * for unknown or revoked keys. Touches lastUsedAt out-of-band (fire and
 * forget) so auth latency doesn't take a write.
 */
export async function resolveApiKey(
  plaintext: string
): Promise<ResolvedApiKey | null> {
  const db = getDb();
  const [row] = await db
    .select({ key: apiKeys, user: contributors })
    .from(apiKeys)
    .innerJoin(contributors, eq(apiKeys.userId, contributors.id))
    .where(and(eq(apiKeys.keyHash, hashApiKey(plaintext)), isNull(apiKeys.revokedAt)))
    .limit(1);
  if (!row) return null;

  touchLastUsed(row.key.id);
  return row;
}

// Throttle lastUsedAt writes to once a minute per key so hot keys don't turn
// every request into an UPDATE.
const lastTouched = new Map<string, number>();
function touchLastUsed(keyId: string): void {
  const now = Date.now();
  const prev = lastTouched.get(keyId) ?? 0;
  if (now - prev < 60_000) return;
  lastTouched.set(keyId, now);
  getDb()
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, keyId))
    .then(
      () => {},
      (err) => console.error("[api-keys] lastUsedAt update failed:", err)
    );
}
