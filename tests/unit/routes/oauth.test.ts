/**
 * OAuth 2.1 endpoints for the remote MCP server (#73 follow-up): discovery
 * metadata, dynamic client registration, the authorize→consent→code
 * choreography, and the token endpoint — with the DB-touching service
 * functions mocked. PKCE verification itself is covered in
 * tests/unit/services/oauth-service.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import formbody from "@fastify/formbody";

const CLIENT_DB_ID = "11111111-1111-4111-8111-111111111111";
const REQUEST_ID = "22222222-2222-4222-8222-222222222222";

const CLIENT_ROW = {
  id: CLIENT_DB_ID,
  clientId: "client-abc",
  clientSecretHash: null,
  name: "Claude",
  redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
  tokenEndpointAuthMethod: "none",
  logoUri: null,
  clientUri: "https://claude.ai",
  createdAt: new Date("2026-07-01T00:00:00Z"),
};

const mocks = vi.hoisted(() => ({
  registerClient: vi.fn(),
  getClientByClientId: vi.fn(),
  createAuthorizationRequest: vi.fn(),
  getAuthorizationRequest: vi.fn(),
  approveAuthorizationRequest: vi.fn(),
  denyAuthorizationRequest: vi.fn(),
  exchangeAuthorizationCode: vi.fn(),
  refreshAccessToken: vi.fn(),
  resolveAccessToken: vi.fn(async () => null as unknown),
  getContributorByExternalId: vi.fn(async () => null as unknown),
}));

vi.mock("../../../src/services/oauth-service.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../src/services/oauth-service.js")
  >()),
  registerClient: mocks.registerClient,
  getClientByClientId: mocks.getClientByClientId,
  createAuthorizationRequest: mocks.createAuthorizationRequest,
  getAuthorizationRequest: mocks.getAuthorizationRequest,
  approveAuthorizationRequest: mocks.approveAuthorizationRequest,
  denyAuthorizationRequest: mocks.denyAuthorizationRequest,
  exchangeAuthorizationCode: mocks.exchangeAuthorizationCode,
  refreshAccessToken: mocks.refreshAccessToken,
  resolveAccessToken: mocks.resolveAccessToken,
}));
vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: vi.fn(async () => null),
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorByExternalId: mocks.getContributorByExternalId,
  getOrCreateContributor: vi.fn(),
}));

let app: FastifyInstance;

beforeAll(async () => {
  process.env.API_KEYS = "svc-key";
  process.env.ENVIRONMENT = "development";
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { oauthRoutes } = await import("../../../src/routes/oauth.js");

  app = Fastify();
  await app.register(formbody);
  await registerAuth(app);
  await app.register(oauthRoutes);
  // Probe routes on and off the MCP surface, to pin down token audience
  // binding: OAuth access tokens must only authenticate under /mcp.
  app.post(
    "/mcp",
    { preHandler: [app.authenticate] },
    async (request) => ({ user_id: request.auth?.userId ?? null })
  );
  app.get(
    "/probe",
    { preHandler: [app.authenticate] },
    async (request) => ({ user_id: request.auth?.userId ?? null })
  );
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  mocks.registerClient.mockReset();
  mocks.getClientByClientId
    .mockReset()
    .mockImplementation(async (id: string) =>
      id === "client-abc" ? CLIENT_ROW : null
    );
  mocks.createAuthorizationRequest.mockReset();
  mocks.getAuthorizationRequest.mockReset();
  mocks.approveAuthorizationRequest.mockReset();
  mocks.denyAuthorizationRequest.mockReset();
  mocks.exchangeAuthorizationCode.mockReset();
  mocks.refreshAccessToken.mockReset();
  mocks.getContributorByExternalId.mockReset().mockResolvedValue({
    id: "user-1",
    externalId: "github:42",
    displayName: "Tester",
    isSuspended: false,
  });
});

describe("discovery metadata", () => {
  it.each([
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/mcp",
  ])("%s advertises the endpoints and S256-only PKCE", async (path) => {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.issuer).toBe("http://localhost:3000");
    expect(body.authorization_endpoint).toBe(
      "http://localhost:3000/oauth/authorize"
    );
    expect(body.token_endpoint).toBe("http://localhost:3000/oauth/token");
    expect(body.registration_endpoint).toBe(
      "http://localhost:3000/oauth/register"
    );
    expect(body.code_challenge_methods_supported).toEqual(["S256"]);
    expect(body.grant_types_supported).toEqual([
      "authorization_code",
      "refresh_token",
    ]);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });

  it.each([
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-protected-resource/mcp",
  ])("%s points at the /mcp resource and this issuer", async (path) => {
    const res = await app.inject({ method: "GET", url: path });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resource).toBe("http://localhost:3000/mcp");
    expect(body.authorization_servers).toEqual(["http://localhost:3000"]);
    expect(body.bearer_methods_supported).toEqual(["header"]);
  });
});

describe("POST /oauth/register (RFC 7591)", () => {
  it("registers a public client without a secret", async () => {
    mocks.registerClient.mockResolvedValue({
      client: CLIENT_ROW,
      clientSecret: null,
    });
    const res = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        client_name: "Claude",
        token_endpoint_auth_method: "none",
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.client_id).toBe("client-abc");
    expect(body.client_secret).toBeUndefined();
    expect(body.token_endpoint_auth_method).toBe("none");
    expect(mocks.registerClient).toHaveBeenCalledWith(
      expect.objectContaining({ tokenEndpointAuthMethod: "none" })
    );
  });

  it("returns the secret exactly once for confidential clients", async () => {
    mocks.registerClient.mockResolvedValue({
      client: {
        ...CLIENT_ROW,
        tokenEndpointAuthMethod: "client_secret_basic",
        clientSecretHash: "hash",
      },
      clientSecret: "eocs_secret",
    });
    const res = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: ["https://example.com/cb"] },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().client_secret).toBe("eocs_secret");
    expect(res.json().client_secret_expires_at).toBe(0);
  });

  it("rejects non-https redirect URIs (localhost excepted)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: ["http://evil.example.com/cb"] },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_redirect_uri");
    expect(mocks.registerClient).not.toHaveBeenCalled();

    const local = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: ["http://localhost:6274/callback"] },
    });
    mocks.registerClient.mockResolvedValue({
      client: CLIENT_ROW,
      clientSecret: null,
    });
    expect(local.statusCode).not.toBe(400);
  });

  it("rejects unsupported auth methods and grant types", async () => {
    const badMethod = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        redirect_uris: ["https://example.com/cb"],
        token_endpoint_auth_method: "private_key_jwt",
      },
    });
    expect(badMethod.statusCode).toBe(400);

    const badGrant = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: {
        redirect_uris: ["https://example.com/cb"],
        grant_types: ["client_credentials"],
      },
    });
    expect(badGrant.statusCode).toBe(400);
  });
});

describe("GET /oauth/authorize", () => {
  const goodQuery = {
    client_id: "client-abc",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    code_challenge: "a".repeat(43),
    code_challenge_method: "S256",
    state: "xyz",
    scope: "mcp",
  };

  it("parks the request and redirects to the web consent page", async () => {
    mocks.createAuthorizationRequest.mockResolvedValue({ id: REQUEST_ID });
    const res = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: goodQuery,
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(
      `https://minerval.ai/oauth/consent?request_id=${REQUEST_ID}`
    );
  });

  it("400s (no redirect) on unknown client or unregistered redirect_uri", async () => {
    const unknownClient = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...goodQuery, client_id: "nope" },
    });
    expect(unknownClient.statusCode).toBe(400);

    const badRedirect = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...goodQuery, redirect_uri: "https://evil.example.com/cb" },
    });
    expect(badRedirect.statusCode).toBe(400);
  });

  it("redirects errors back to the client for PKCE/response_type problems", async () => {
    const noPkce = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...goodQuery, code_challenge: "" },
    });
    expect(noPkce.statusCode).toBe(302);
    const url = new URL(noPkce.headers.location as string);
    expect(url.origin + url.pathname).toBe(
      "https://claude.ai/api/mcp/auth_callback"
    );
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("xyz");

    const plainPkce = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...goodQuery, code_challenge_method: "plain" },
    });
    expect(
      new URL(plainPkce.headers.location as string).searchParams.get("error")
    ).toBe("invalid_request");

    const badType = await app.inject({
      method: "GET",
      url: "/oauth/authorize",
      query: { ...goodQuery, response_type: "token" },
    });
    expect(
      new URL(badType.headers.location as string).searchParams.get("error")
    ).toBe("unsupported_response_type");
  });
});

describe("POST /oauth/token", () => {
  const TOKENS = {
    accessToken: "eoat_access",
    refreshToken: "eort_refresh",
    expiresInSeconds: 3600,
    scope: "mcp",
  };

  it("exchanges a code (form-encoded, public client + PKCE)", async () => {
    mocks.exchangeAuthorizationCode.mockResolvedValue(TOKENS);
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-abc",
        code: "eoac_code",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "v".repeat(43),
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe("no-store");
    const body = res.json();
    expect(body.access_token).toBe("eoat_access");
    expect(body.refresh_token).toBe("eort_refresh");
    expect(body.token_type).toBe("Bearer");
    expect(body.expires_in).toBe(3600);
  });

  it("rotates refresh tokens", async () => {
    mocks.refreshAccessToken.mockResolvedValue(TOKENS);
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "client-abc",
        refresh_token: "eort_old",
      }).toString(),
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.refreshAccessToken).toHaveBeenCalledWith(
      expect.objectContaining({ refreshToken: "eort_old" })
    );
  });

  it("401s when client authentication fails", async () => {
    mocks.getClientByClientId.mockResolvedValue({
      ...CLIENT_ROW,
      tokenEndpointAuthMethod: "client_secret_basic",
      clientSecretHash: "not-the-hash-of-anything",
    });
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-abc",
        client_secret: "wrong",
        code: "c",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "v".repeat(43),
      }).toString(),
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe("invalid_client");
  });

  it("maps OAuthTokenError to RFC 6749 error bodies", async () => {
    const { OAuthTokenError } = await import(
      "../../../src/services/oauth-service.js"
    );
    mocks.exchangeAuthorizationCode.mockRejectedValue(
      new OAuthTokenError("invalid_grant", "code replayed")
    );
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: "client-abc",
        code: "eoac_used",
        redirect_uri: "https://claude.ai/api/mcp/auth_callback",
        code_verifier: "v".repeat(43),
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: "invalid_grant",
      error_description: "code replayed",
    });
  });

  it("rejects unknown grant types", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: "client-abc",
      }).toString(),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("unsupported_grant_type");
  });
});

describe("consent back-channel", () => {
  it("GET /oauth/requests/:id requires service trust and renders the client", async () => {
    mocks.getAuthorizationRequest.mockResolvedValue({
      request: {
        id: REQUEST_ID,
        status: "pending",
        scope: "mcp",
        redirectUri: "https://claude.ai/api/mcp/auth_callback",
        expiresAt: new Date(Date.now() + 60_000),
      },
      client: CLIENT_ROW,
    });

    const unauthed = await app.inject({
      method: "GET",
      url: `/oauth/requests/${REQUEST_ID}`,
    });
    expect(unauthed.statusCode).toBe(401);

    const res = await app.inject({
      method: "GET",
      url: `/oauth/requests/${REQUEST_ID}`,
      headers: { "x-api-key": "svc-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().client.name).toBe("Claude");
    expect(res.json().client.redirect_host).toBe("claude.ai");
    expect(res.json().expired).toBe(false);
  });

  it("approve requires session trust and returns the client redirect", async () => {
    mocks.approveAuthorizationRequest.mockResolvedValue({
      redirectTo:
        "https://claude.ai/api/mcp/auth_callback?code=eoac_x&state=xyz",
    });

    // A bare consumer identity (no x-acting-user session) must be refused.
    const noSession = await app.inject({
      method: "POST",
      url: `/oauth/requests/${REQUEST_ID}/approve`,
      headers: { "x-api-key": "svc-key" },
    });
    expect(noSession.statusCode).toBe(403);

    const res = await app.inject({
      method: "POST",
      url: `/oauth/requests/${REQUEST_ID}/approve`,
      headers: { "x-api-key": "svc-key", "x-acting-user": "github:42" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect_to).toContain("code=eoac_x");
    expect(mocks.approveAuthorizationRequest).toHaveBeenCalledWith({
      requestId: REQUEST_ID,
      userId: "user-1",
    });
  });

  it("approve/deny 410 once the request is gone", async () => {
    mocks.approveAuthorizationRequest.mockResolvedValue(null);
    const approve = await app.inject({
      method: "POST",
      url: `/oauth/requests/${REQUEST_ID}/approve`,
      headers: { "x-api-key": "svc-key", "x-acting-user": "github:42" },
    });
    expect(approve.statusCode).toBe(410);

    mocks.denyAuthorizationRequest.mockResolvedValue(null);
    const deny = await app.inject({
      method: "POST",
      url: `/oauth/requests/${REQUEST_ID}/deny`,
      headers: { "x-api-key": "svc-key" },
    });
    expect(deny.statusCode).toBe(410);
  });

  it("OAuth access tokens authenticate /mcp but are refused elsewhere (audience binding)", async () => {
    mocks.resolveAccessToken.mockResolvedValue({
      token: { id: "tok-1", userId: "user-1", scope: "mcp" },
      user: {
        id: "user-1",
        externalId: "github:42",
        displayName: "Tester",
        isSuspended: false,
      },
    });

    const mcp = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: { authorization: "Bearer eoat_token" },
    });
    expect(mcp.statusCode).toBe(200);
    expect(mcp.json().user_id).toBe("user-1");

    const rest = await app.inject({
      method: "GET",
      url: "/probe",
      headers: { authorization: "Bearer eoat_token" },
    });
    expect(rest.statusCode).toBe(403);
    expect(rest.json().code).toBe("INSUFFICIENT_SCOPE");
    expect(rest.headers["www-authenticate"]).toContain("insufficient_scope");
  });

  it("deny returns the access_denied redirect", async () => {
    mocks.denyAuthorizationRequest.mockResolvedValue({
      redirectTo:
        "https://claude.ai/api/mcp/auth_callback?error=access_denied&state=xyz",
    });
    const res = await app.inject({
      method: "POST",
      url: `/oauth/requests/${REQUEST_ID}/deny`,
      headers: { "x-api-key": "svc-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().redirect_to).toContain("error=access_denied");
  });
});
