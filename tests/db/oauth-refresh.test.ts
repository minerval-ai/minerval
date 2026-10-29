/**
 * refreshAccessToken (src/services/oauth-service.ts) against real Postgres:
 * refresh-token rotation and its RFC 6819 reuse detection. The route tests
 * mock the service, so only a real database can show that two requests
 * carrying the same refresh token cannot both rotate it.
 */
import crypto from "node:crypto";
import { describe, it, expect } from "vitest";
import {
  approveAuthorizationRequest,
  createAuthorizationRequest,
  exchangeAuthorizationCode,
  hashToken,
  OAuthTokenError,
  refreshAccessToken,
  registerClient,
  resolveAccessToken,
  type IssuedTokens,
  type OAuthClient,
} from "../../src/services/oauth-service.js";
import { rawQuery, withTransaction } from "../../src/db/client.js";
import { seedUser } from "./helpers.js";

const REDIRECT_URI = "https://client.example/callback";
const REUSE_MESSAGE =
  "Refresh token was already used; the grant has been revoked. Re-authorize.";

/** A fresh grant minted through the real authorize → consent → code flow. */
async function mintGrant(label: string): Promise<{
  client: OAuthClient;
  userId: string;
  tokens: IssuedTokens;
  grantId: string;
}> {
  const userId = await seedUser(`oauth-${label}`);
  const { client } = await registerClient({
    name: `dbtest ${label}`,
    redirectUris: [REDIRECT_URI],
    tokenEndpointAuthMethod: "none",
  });
  const verifier = crypto.randomBytes(48).toString("base64url");
  const challenge = crypto
    .createHash("sha256")
    .update(verifier, "ascii")
    .digest("base64url");
  const request = await createAuthorizationRequest({
    client,
    redirectUri: REDIRECT_URI,
    scope: "mcp",
    state: null,
    codeChallenge: challenge,
    resource: null,
  });
  const consent = await approveAuthorizationRequest({
    requestId: request.id,
    userId,
  });
  const code = new URL(consent!.redirectTo).searchParams.get("code")!;
  const tokens = await exchangeAuthorizationCode({
    code,
    client,
    redirectUri: REDIRECT_URI,
    codeVerifier: verifier,
  });
  const [row] = await rawQuery<{ grant_id: string }>(
    `SELECT grant_id FROM oauth_tokens WHERE token_hash = $1`,
    [hashToken(tokens.refreshToken)]
  );
  return { client, userId, tokens, grantId: row!.grant_id };
}

async function grantTokens(grantId: string) {
  return rawQuery<{
    token_hash: string;
    token_type: string;
    client_id: string;
    user_id: string;
    scope: string | null;
    expires_at: Date;
    revoked_at: Date | null;
  }>(
    `SELECT token_hash, token_type, client_id, user_id, scope, expires_at,
            revoked_at
       FROM oauth_tokens WHERE grant_id = $1`,
    [grantId]
  );
}

/** Wait until `n` backends in this database are blocked on a lock. */
async function waitForLockWaiters(n: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const [row] = await rawQuery<{ waiting: number }>(
      `SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`
    );
    if (row!.waiting >= n) return;
    if (Date.now() > deadline) {
      throw new Error(
        `expected ${n} refreshes blocked on the token row, saw ${row!.waiting}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function expectOneWinnerOneReuse(
  results: PromiseSettledResult<IssuedTokens>[]
): IssuedTokens {
  const won = results.filter(
    (r): r is PromiseFulfilledResult<IssuedTokens> => r.status === "fulfilled"
  );
  const lost = results.filter(
    (r): r is PromiseRejectedResult => r.status === "rejected"
  );
  expect(won).toHaveLength(1);
  expect(lost).toHaveLength(1);
  const err = lost[0]!.reason as OAuthTokenError;
  expect(err).toBeInstanceOf(OAuthTokenError);
  expect(err.code).toBe("invalid_grant");
  expect(err.message).toBe(REUSE_MESSAGE);
  return won[0]!.value;
}

async function expectGrantFullyRevoked(
  grantId: string,
  winner: IssuedTokens
): Promise<void> {
  const rows = await grantTokens(grantId);
  // The original pair plus exactly one rotated pair — never two.
  expect(rows).toHaveLength(4);
  expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  // Including the pair the winning request was just handed.
  expect(await resolveAccessToken(winner.accessToken)).toBeNull();
}

describe("refreshAccessToken", () => {
  it("an honest refresh rotates the token within the same grant", async () => {
    const { client, userId, tokens, grantId } = await mintGrant("rotate");

    const next = await refreshAccessToken({
      refreshToken: tokens.refreshToken,
      client,
    });
    expect(next.accessToken.startsWith("eoat_")).toBe(true);
    expect(next.refreshToken.startsWith("eort_")).toBe(true);
    expect(next.accessToken).not.toBe(tokens.accessToken);
    expect(next.refreshToken).not.toBe(tokens.refreshToken);
    expect(next.expiresInSeconds).toBe(3600);
    expect(next.scope).toBe("mcp");

    const rows = await grantTokens(grantId);
    expect(rows).toHaveLength(4);
    const byHash = new Map(rows.map((r) => [r.token_hash, r]));
    // Only the presented refresh token is revoked; the earlier access token
    // keeps working until it expires, as before.
    expect(byHash.get(hashToken(tokens.refreshToken))!.revoked_at).not.toBeNull();
    expect(byHash.get(hashToken(tokens.accessToken))!.revoked_at).toBeNull();
    for (const [hash, type] of [
      [hashToken(next.accessToken), "access"],
      [hashToken(next.refreshToken), "refresh"],
    ] as const) {
      const row = byHash.get(hash)!;
      expect(row.token_type).toBe(type);
      expect(row.client_id).toBe(client.id);
      expect(row.user_id).toBe(userId);
      expect(row.scope).toBe("mcp");
      expect(row.revoked_at).toBeNull();
      expect(row.expires_at.getTime()).toBeGreaterThan(Date.now());
    }
    expect((await resolveAccessToken(tokens.accessToken))?.user.id).toBe(userId);
    expect((await resolveAccessToken(next.accessToken))?.user.id).toBe(userId);

    // The rotated token rotates again.
    const third = await refreshAccessToken({
      refreshToken: next.refreshToken,
      client,
    });
    expect(third.refreshToken).not.toBe(next.refreshToken);
    const after = await grantTokens(grantId);
    expect(after).toHaveLength(6);
    expect(after.filter((r) => r.revoked_at !== null)).toHaveLength(2);
  });

  it("replaying a rotated refresh token revokes the whole grant", async () => {
    const { client, tokens, grantId } = await mintGrant("replay");
    const next = await refreshAccessToken({
      refreshToken: tokens.refreshToken,
      client,
    });

    await expect(
      refreshAccessToken({ refreshToken: tokens.refreshToken, client })
    ).rejects.toThrow(REUSE_MESSAGE);
    await expectGrantFullyRevoked(grantId, next);
  });

  it("CONCURRENCY: two refreshes that both pass the revoked check → one rotation, grant revoked", async () => {
    const { client, tokens, grantId } = await mintGrant("race-forced");
    const refresh = () =>
      refreshAccessToken({ refreshToken: tokens.refreshToken, client });

    // Force the TOCTOU interleaving: hold the token row's lock so both
    // requests read it as unrevoked, then both queue on the write; only
    // then let them go.
    let racing!: Promise<PromiseSettledResult<IssuedTokens>[]>;
    await withTransaction(async (tx) => {
      await tx.query(
        `SELECT id FROM oauth_tokens WHERE token_hash = $1 FOR UPDATE`,
        [hashToken(tokens.refreshToken)]
      );
      racing = Promise.allSettled([refresh(), refresh()]);
      await waitForLockWaiters(2);
    });

    const winner = expectOneWinnerOneReuse(await racing);
    await expectGrantFullyRevoked(grantId, winner);
  });

  it("CONCURRENCY: unorchestrated parallel refreshes never both rotate", async () => {
    for (let round = 0; round < 10; round++) {
      const { client, tokens, grantId } = await mintGrant(`race-${round}`);
      const refresh = () =>
        refreshAccessToken({ refreshToken: tokens.refreshToken, client });
      const winner = expectOneWinnerOneReuse(
        await Promise.allSettled([refresh(), refresh()])
      );
      await expectGrantFullyRevoked(grantId, winner);
    }
  });
});
