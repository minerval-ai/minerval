/**
 * OAuth 2.1 authorization server for the remote MCP endpoint (#73 follow-up).
 *
 * Hosted MCP clients (Claude.ai / Cowork custom connectors) can't send custom
 * headers, and their connector UI only speaks OAuth. This service implements
 * the pieces the MCP authorization spec requires of us:
 *
 *   - dynamic client registration (RFC 7591)
 *   - the authorization-code grant with mandatory PKCE S256 (OAuth 2.1)
 *   - refresh-token rotation with reuse detection
 *
 * The interactive half (login + consent) lives on the web frontend, which
 * owns sessions (#70); the API only validates requests and mints codes and
 * tokens. All secrets — client secrets, authorization codes, tokens — are
 * high-entropy random strings stored as unsalted SHA-256 hashes, the same
 * construction as API keys (see api-key-service.ts for the rationale).
 */
import crypto from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { getDb, withTransaction, type TxQuery } from "../db/client.js";
import {
  contributors,
  oauthAuthorizationRequests,
  oauthClients,
  oauthTokens,
  type Contributor,
  type OAuthAuthorizationRequest,
  type OAuthClient,
  type OAuthToken,
} from "../db/schema.js";

export type { OAuthClient } from "../db/schema.js";

// Prefixes make token kinds recognizable at the auth boundary without a DB
// hit: the auth plugin routes eoat_* bearers here instead of to api_keys.
export const ACCESS_TOKEN_PREFIX = "eoat_";
export const REFRESH_TOKEN_PREFIX = "eort_";
export const AUTH_CODE_PREFIX = "eoac_";
export const CLIENT_SECRET_PREFIX = "eocs_";

export const CONSENT_TTL_MS = 10 * 60 * 1000; // authorize → consent window
export const CODE_TTL_MS = 5 * 60 * 1000; // code mint → exchange window
export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const SUPPORTED_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type TokenEndpointAuthMethod = (typeof SUPPORTED_AUTH_METHODS)[number];

export function isOAuthAccessToken(token: string): boolean {
  return token.startsWith(ACCESS_TOKEN_PREFIX);
}

export function hashToken(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext, "utf8").digest("hex");
}

function randomToken(prefix: string): string {
  return prefix + crypto.randomBytes(32).toString("base64url");
}

/** PKCE S256 (RFC 7636): challenge === BASE64URL(SHA256(verifier)). */
export function verifyPkceS256(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const derived = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  return (
    derived.length === challenge.length &&
    crypto.timingSafeEqual(Buffer.from(derived), Buffer.from(challenge))
  );
}

// --- clients -----------------------------------------------------------------

export interface RegisteredClient {
  client: OAuthClient;
  /** Present only for confidential clients; shown once, never stored. */
  clientSecret: string | null;
}

export async function registerClient(input: {
  name: string;
  redirectUris: string[];
  tokenEndpointAuthMethod: TokenEndpointAuthMethod;
  logoUri?: string | null;
  clientUri?: string | null;
}): Promise<RegisteredClient> {
  const db = getDb();
  const clientSecret =
    input.tokenEndpointAuthMethod === "none"
      ? null
      : randomToken(CLIENT_SECRET_PREFIX);
  const [client] = await db
    .insert(oauthClients)
    .values({
      clientId: crypto.randomUUID(),
      clientSecretHash: clientSecret ? hashToken(clientSecret) : null,
      name: input.name,
      redirectUris: input.redirectUris,
      tokenEndpointAuthMethod: input.tokenEndpointAuthMethod,
      logoUri: input.logoUri ?? null,
      clientUri: input.clientUri ?? null,
    })
    .returning();
  return { client: client!, clientSecret };
}

export async function getClientByClientId(
  clientId: string
): Promise<OAuthClient | null> {
  const db = getDb();
  const [client] = await db
    .select()
    .from(oauthClients)
    .where(eq(oauthClients.clientId, clientId))
    .limit(1);
  return client ?? null;
}

// --- authorization requests / codes ------------------------------------------

export async function createAuthorizationRequest(input: {
  client: OAuthClient;
  redirectUri: string;
  scope: string | null;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}): Promise<OAuthAuthorizationRequest> {
  const db = getDb();
  const [row] = await db
    .insert(oauthAuthorizationRequests)
    .values({
      clientId: input.client.id,
      redirectUri: input.redirectUri,
      scope: input.scope,
      state: input.state,
      codeChallenge: input.codeChallenge,
      codeChallengeMethod: "S256",
      resource: input.resource,
      expiresAt: new Date(Date.now() + CONSENT_TTL_MS),
    })
    .returning();
  return row!;
}

export interface AuthorizationRequestView {
  request: OAuthAuthorizationRequest;
  client: OAuthClient;
}

export async function getAuthorizationRequest(
  requestId: string
): Promise<AuthorizationRequestView | null> {
  const db = getDb();
  const [row] = await db
    .select({ request: oauthAuthorizationRequests, client: oauthClients })
    .from(oauthAuthorizationRequests)
    .innerJoin(
      oauthClients,
      eq(oauthAuthorizationRequests.clientId, oauthClients.id)
    )
    .where(eq(oauthAuthorizationRequests.id, requestId))
    .limit(1);
  return row ?? null;
}

export interface ConsentOutcome {
  /** Where to send the user's browser (the client's redirect_uri + params). */
  redirectTo: string;
}

/**
 * Approve a pending request on behalf of the consenting user: mint the
 * single-use authorization code and build the client redirect. The
 * status guard in the WHERE clause makes double-approval a no-op.
 */
export async function approveAuthorizationRequest(input: {
  requestId: string;
  userId: string;
}): Promise<ConsentOutcome | null> {
  const db = getDb();
  const code = randomToken(AUTH_CODE_PREFIX);
  const [row] = await db
    .update(oauthAuthorizationRequests)
    .set({
      status: "approved",
      userId: input.userId,
      codeHash: hashToken(code),
      codeExpiresAt: new Date(Date.now() + CODE_TTL_MS),
    })
    .where(
      and(
        eq(oauthAuthorizationRequests.id, input.requestId),
        eq(oauthAuthorizationRequests.status, "pending")
      )
    )
    .returning();
  if (!row || row.expiresAt.getTime() < Date.now()) return null;

  const url = new URL(row.redirectUri);
  url.searchParams.set("code", code);
  if (row.state !== null) url.searchParams.set("state", row.state);
  return { redirectTo: url.toString() };
}

export async function denyAuthorizationRequest(
  requestId: string
): Promise<ConsentOutcome | null> {
  const db = getDb();
  const [row] = await db
    .update(oauthAuthorizationRequests)
    .set({ status: "denied" })
    .where(
      and(
        eq(oauthAuthorizationRequests.id, requestId),
        eq(oauthAuthorizationRequests.status, "pending")
      )
    )
    .returning();
  if (!row) return null;

  const url = new URL(row.redirectUri);
  url.searchParams.set("error", "access_denied");
  url.searchParams.set("error_description", "The user denied the request");
  if (row.state !== null) url.searchParams.set("state", row.state);
  return { redirectTo: url.toString() };
}

// --- token issuance -----------------------------------------------------------

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
  scope: string | null;
}

async function issueTokenPair(
  input: {
    grantId: string;
    clientId: string; // oauth_clients.id (uuid)
    userId: string;
    scope: string | null;
  },
  db: TxQuery["db"] = getDb()
): Promise<IssuedTokens> {
  const accessToken = randomToken(ACCESS_TOKEN_PREFIX);
  const refreshToken = randomToken(REFRESH_TOKEN_PREFIX);
  const now = Date.now();
  await db.insert(oauthTokens).values([
    {
      grantId: input.grantId,
      clientId: input.clientId,
      userId: input.userId,
      tokenHash: hashToken(accessToken),
      tokenType: "access",
      scope: input.scope,
      expiresAt: new Date(now + ACCESS_TOKEN_TTL_MS),
    },
    {
      grantId: input.grantId,
      clientId: input.clientId,
      userId: input.userId,
      tokenHash: hashToken(refreshToken),
      tokenType: "refresh",
      scope: input.scope,
      expiresAt: new Date(now + REFRESH_TOKEN_TTL_MS),
    },
  ]);
  return {
    accessToken,
    refreshToken,
    expiresInSeconds: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    scope: input.scope,
  };
}

export type TokenErrorCode = "invalid_grant" | "invalid_request";

export class OAuthTokenError extends Error {
  constructor(
    readonly code: TokenErrorCode,
    message: string
  ) {
    super(message);
  }
}

/**
 * The authorization_code grant: consume the code (single-use), verify PKCE
 * and the redirect_uri/client bindings, and issue the first token pair of a
 * new grant.
 */
export async function exchangeAuthorizationCode(input: {
  code: string;
  client: OAuthClient;
  redirectUri: string;
  codeVerifier: string;
}): Promise<IssuedTokens> {
  const db = getDb();
  // Atomically claim the code: the status flip in the WHERE clause means a
  // replayed code loses the race instead of double-issuing.
  const [row] = await db
    .update(oauthAuthorizationRequests)
    .set({ status: "consumed", consumedAt: new Date() })
    .where(
      and(
        eq(oauthAuthorizationRequests.codeHash, hashToken(input.code)),
        eq(oauthAuthorizationRequests.status, "approved")
      )
    )
    .returning();
  if (!row) {
    throw new OAuthTokenError(
      "invalid_grant",
      "Unknown, expired, or already-used authorization code"
    );
  }
  if (
    row.clientId !== input.client.id ||
    row.redirectUri !== input.redirectUri ||
    !row.codeExpiresAt ||
    row.codeExpiresAt.getTime() < Date.now() ||
    !row.userId
  ) {
    throw new OAuthTokenError(
      "invalid_grant",
      "Authorization code does not match this client and redirect_uri, or has expired"
    );
  }
  if (!verifyPkceS256(input.codeVerifier, row.codeChallenge)) {
    throw new OAuthTokenError("invalid_grant", "PKCE verification failed");
  }
  return issueTokenPair({
    grantId: crypto.randomUUID(),
    clientId: row.clientId,
    userId: row.userId,
    scope: row.scope,
  });
}

/**
 * The refresh_token grant, with rotation: every refresh revokes the presented
 * token and issues a fresh pair in the same grant. Presenting an
 * already-revoked refresh token is treated as theft (RFC 6819) — the entire
 * grant is revoked.
 */
export async function refreshAccessToken(input: {
  refreshToken: string;
  client: OAuthClient;
}): Promise<IssuedTokens> {
  const db = getDb();
  const [row] = await db
    .select()
    .from(oauthTokens)
    .where(eq(oauthTokens.tokenHash, hashToken(input.refreshToken)))
    .limit(1);
  if (!row || row.tokenType !== "refresh" || row.clientId !== input.client.id) {
    throw new OAuthTokenError("invalid_grant", "Unknown refresh token");
  }
  if (row.revokedAt) {
    await revokeGrant(row.grantId);
    throw new OAuthTokenError(
      "invalid_grant",
      "Refresh token was already used; the grant has been revoked. Re-authorize."
    );
  }
  if (row.expiresAt.getTime() < Date.now()) {
    throw new OAuthTokenError("invalid_grant", "Refresh token expired");
  }
  // Atomically claim the token: the revoked_at guard in the WHERE clause
  // means a concurrent refresh with the same token loses the race instead
  // of double-issuing, and is then treated as reuse. The claim and the new
  // pair commit together: the losing UPDATE comes back empty only once the
  // winner has committed, so the loser's grant revocation below also
  // catches the pair the winner just minted.
  const issued = await withTransaction(async (tx) => {
    const [claimed] = await tx.db
      .update(oauthTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(oauthTokens.id, row.id), isNull(oauthTokens.revokedAt)))
      .returning({ id: oauthTokens.id });
    if (!claimed) return null;
    return issueTokenPair(
      {
        grantId: row.grantId,
        clientId: row.clientId,
        userId: row.userId,
        scope: row.scope,
      },
      tx.db
    );
  });
  if (!issued) {
    await revokeGrant(row.grantId);
    throw new OAuthTokenError(
      "invalid_grant",
      "Refresh token was already used; the grant has been revoked. Re-authorize."
    );
  }
  return issued;
}

export async function revokeGrant(grantId: string): Promise<void> {
  const db = getDb();
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(eq(oauthTokens.grantId, grantId), isNull(oauthTokens.revokedAt))
    );
}

// --- resource-server side: bearer resolution ----------------------------------

export interface ResolvedAccessToken {
  token: OAuthToken;
  user: Contributor;
}

/** Resolve a presented access token; null for unknown/expired/revoked. */
export async function resolveAccessToken(
  plaintext: string
): Promise<ResolvedAccessToken | null> {
  const db = getDb();
  const [row] = await db
    .select({ token: oauthTokens, user: contributors })
    .from(oauthTokens)
    .innerJoin(contributors, eq(oauthTokens.userId, contributors.id))
    .where(
      and(
        eq(oauthTokens.tokenHash, hashToken(plaintext)),
        eq(oauthTokens.tokenType, "access"),
        isNull(oauthTokens.revokedAt)
      )
    )
    .limit(1);
  if (!row || row.token.expiresAt.getTime() < Date.now()) return null;

  touchLastUsed(row.token.id);
  return row;
}

// Throttle lastUsedAt writes like api-key-service does, so hot tokens don't
// turn every MCP call into an UPDATE.
const lastTouched = new Map<string, number>();
function touchLastUsed(tokenId: string): void {
  const now = Date.now();
  const prev = lastTouched.get(tokenId) ?? 0;
  if (now - prev < 60_000) return;
  lastTouched.set(tokenId, now);
  getDb()
    .update(oauthTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(oauthTokens.id, tokenId))
    .then(
      () => {},
      (err) => console.error("[oauth] lastUsedAt update failed:", err)
    );
}

/** List a user's active grants (for a future dashboard "connected apps" UI). */
export async function listGrants(userId: string): Promise<
  Array<{ grantId: string; client: OAuthClient; createdAt: Date }>
> {
  const db = getDb();
  const rows = await db
    .select({ token: oauthTokens, client: oauthClients })
    .from(oauthTokens)
    .innerJoin(oauthClients, eq(oauthTokens.clientId, oauthClients.id))
    .where(
      and(
        eq(oauthTokens.userId, userId),
        eq(oauthTokens.tokenType, "refresh"),
        isNull(oauthTokens.revokedAt)
      )
    );
  return rows.map((r) => ({
    grantId: r.token.grantId,
    client: r.client,
    createdAt: r.token.createdAt,
  }));
}

/** Revoke every grant a user holds for the given clients (dashboard action). */
export async function revokeGrants(
  userId: string,
  grantIds: string[]
): Promise<void> {
  if (grantIds.length === 0) return;
  const db = getDb();
  await db
    .update(oauthTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(oauthTokens.userId, userId),
        inArray(oauthTokens.grantId, grantIds),
        isNull(oauthTokens.revokedAt)
      )
    );
}
