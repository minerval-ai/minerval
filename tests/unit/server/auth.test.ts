import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";

// The auth plugin resolves DB-backed keys and the dev-bypass account through
// these services; mock them so the plugin is testable without Postgres.
const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(async (_key: string) => null as unknown),
  getContributorByExternalId: vi.fn(async (_id: string) => null as unknown),
  getOrCreateContributor: vi.fn(
    async (input: { externalId: string; displayName: string }) => ({
      id: "dev-user-id",
      externalId: input.externalId,
      displayName: input.displayName,
      isSuspended: false,
    })
  ),
}));

vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: mocks.resolveApiKey,
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorByExternalId: mocks.getContributorByExternalId,
  getOrCreateContributor: mocks.getOrCreateContributor,
}));

// Builds a minimal app with the auth plugin and routes that echo the identity
// the plugin derived, plus guard probes.
async function buildTestApp(
  apiKeysEnv: string | undefined,
  environment?: string
) {
  if (apiKeysEnv === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = apiKeysEnv;
  if (environment === undefined) delete process.env.ENVIRONMENT;
  else process.env.ENVIRONMENT = environment;
  if (environment === "production") {
    // Production config now asserts the load-bearing model envs are set
    // (#100); satisfy the invariant so this suite tests auth, not that guard.
    process.env.STEWARD_MODEL = "claude-fable-5-1";
    process.env.CURATOR_MODEL = "claude-fable-5-1";
    process.env.AUDIT_MODEL = "claude-fable-5-1";
    process.env.ARBITRATION_MODEL = "claude-fable-5-1";
    process.env.EXTRACTOR_MODEL = "claude-fable-5-1";
  }
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");

  const app = Fastify();
  await registerAuth(app);
  app.get("/whoami", { preHandler: app.authenticate }, async (request) => ({
    contributor: request.contributorExternalId,
    user_id: request.auth?.userId ?? null,
    api_key_id: request.auth?.apiKeyId ?? null,
    method: request.auth?.method,
    is_service: request.auth?.isService,
    is_session: request.auth?.isSession,
  }));
  app.get(
    "/service-only",
    { preHandler: [app.authenticate, app.requireService] },
    async () => ({ ok: true })
  );
  app.get(
    "/session-only",
    { preHandler: [app.authenticate, app.requireSession] },
    async () => ({ ok: true })
  );
  app.get(
    "/user-only",
    { preHandler: [app.authenticate, app.requireUser] },
    async () => ({ ok: true })
  );
  return app;
}

const MODEL_ENVS = [
  "STEWARD_MODEL",
  "CURATOR_MODEL",
  "AUDIT_MODEL",
  "ARBITRATION_MODEL",
  "EXTRACTOR_MODEL",
];

describe("auth plugin", () => {
  let savedApiKeys: string | undefined;
  let savedEnv: string | undefined;
  const savedModels: Record<string, string | undefined> = {};

  beforeEach(() => {
    savedApiKeys = process.env.API_KEYS;
    savedEnv = process.env.ENVIRONMENT;
    for (const k of MODEL_ENVS) savedModels[k] = process.env[k];
    mocks.resolveApiKey.mockReset().mockResolvedValue(null);
    mocks.getContributorByExternalId.mockReset().mockResolvedValue(null);
  });

  afterEach(() => {
    if (savedApiKeys === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = savedApiKeys;
    if (savedEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnv;
    for (const k of MODEL_ENVS) {
      if (savedModels[k] === undefined) delete process.env[k];
      else process.env[k] = savedModels[k];
    }
  });

  describe("env-key binding (issue #10)", () => {
    it("resolves the contributor bound to the presented key", async () => {
      const app = await buildTestApp("k1:alice,k2");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "k1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().contributor).toBe("alice");
      expect(res.json().method).toBe("env_key");
    });

    it("leaves an unbound key with no contributor identity", async () => {
      const app = await buildTestApp("k1:alice,k2");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "k2" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().contributor).toBe(null);
    });

    it("a caller cannot pick its own identity — only the key binding counts", async () => {
      const app = await buildTestApp("k1:alice,k2:bob");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "k2" },
      });
      expect(res.json().contributor).toBe("bob");
    });

    it("rejects a missing or unknown key", async () => {
      const app = await buildTestApp("k1:alice");
      const missing = await app.inject({ method: "GET", url: "/whoami" });
      expect(missing.statusCode).toBe(401);
      const wrong = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "nope" },
      });
      expect(wrong.statusCode).toBe(401);
    });
  });

  describe("DB-backed keys (issue #70)", () => {
    it("resolves a DB key to its owning user", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: {
          id: "user-1",
          externalId: "github:42",
          isSuspended: false,
        },
      });
      const app = await buildTestApp("envkey");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "epk_something" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        contributor: "github:42",
        user_id: "user-1",
        api_key_id: "key-1",
        method: "api_key",
        is_service: false,
      });
    });

    it("DB keys win over env keys and are checked first", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: { id: "user-1", externalId: "github:42", isSuspended: false },
      });
      const app = await buildTestApp("k1:alice");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "k1" },
      });
      expect(res.json().method).toBe("api_key");
    });

    it("rejects a suspended account", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: { id: "user-1", externalId: "github:42", isSuspended: true },
      });
      const app = await buildTestApp("envkey");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "epk_x" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ACCOUNT_SUSPENDED");
    });
  });

  describe("acting user (x-acting-user)", () => {
    it("lets a service caller act on behalf of a provisioned user", async () => {
      mocks.getContributorByExternalId.mockResolvedValue({
        id: "user-9",
        externalId: "github:9",
        isSuspended: false,
      });
      const app = await buildTestApp("svc:ops");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "svc", "x-acting-user": "github:9" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        contributor: "github:9",
        user_id: "user-9",
        is_session: true,
      });
    });

    it("rejects acting-user from a non-service (consumer) key", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: { id: "user-1", externalId: "github:42", isSuspended: false },
      });
      const app = await buildTestApp("envkey");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "epk_x", "x-acting-user": "github:9" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("ACTING_USER_FORBIDDEN");
    });

    it("rejects an unknown acting user", async () => {
      const app = await buildTestApp("svc:ops");
      const res = await app.inject({
        method: "GET",
        url: "/whoami",
        headers: { "x-api-key": "svc", "x-acting-user": "github:404" },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().code).toBe("UNKNOWN_ACTING_USER");
    });
  });

  describe("route guards", () => {
    it("requireService rejects consumer keys and allows env keys", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: { id: "user-1", externalId: "github:42", isSuspended: false },
      });
      const app = await buildTestApp("svc");
      const consumer = await app.inject({
        method: "GET",
        url: "/service-only",
        headers: { "x-api-key": "epk_x" },
      });
      expect(consumer.statusCode).toBe(403);

      mocks.resolveApiKey.mockResolvedValue(null);
      const service = await app.inject({
        method: "GET",
        url: "/service-only",
        headers: { "x-api-key": "svc" },
      });
      expect(service.statusCode).toBe(200);
    });

    it("isDirectService is service trust WITHOUT acting-user forwarding (#157)", async () => {
      vi.resetModules();
      const { isDirectService } = await import(
        "../../../src/server/plugins/auth.js"
      );
      const base = {
        method: "api_key" as const,
        userId: null,
        apiKeyId: null,
        contributorExternalId: null,
      };
      expect(isDirectService(null)).toBe(false);
      // consumer key
      expect(
        isDirectService({ ...base, isService: false, isSession: false })
      ).toBe(false);
      // service key forwarding a signed-in user (web BFF) is user traffic
      expect(
        isDirectService({ ...base, isService: true, isSession: true })
      ).toBe(false);
      // direct service caller (internal seeding, dev bypass)
      expect(
        isDirectService({ ...base, isService: true, isSession: false })
      ).toBe(true);
    });

    it("requireSession rejects plain key auth, allows acting-user sessions", async () => {
      mocks.resolveApiKey.mockResolvedValue({
        key: { id: "key-1", scope: "user" },
        user: { id: "user-1", externalId: "github:42", isSuspended: false },
      });
      const app = await buildTestApp("svc");
      const plainKey = await app.inject({
        method: "GET",
        url: "/session-only",
        headers: { "x-api-key": "epk_x" },
      });
      expect(plainKey.statusCode).toBe(403);
      expect(plainKey.json().code).toBe("SESSION_REQUIRED");

      mocks.resolveApiKey.mockResolvedValue(null);
      mocks.getContributorByExternalId.mockResolvedValue({
        id: "user-9",
        externalId: "github:9",
        isSuspended: false,
      });
      const session = await app.inject({
        method: "GET",
        url: "/session-only",
        headers: { "x-api-key": "svc", "x-acting-user": "github:9" },
      });
      expect(session.statusCode).toBe(200);
    });

    it("requireUser rejects service traffic with no acting user", async () => {
      const app = await buildTestApp("svc");
      const res = await app.inject({
        method: "GET",
        url: "/user-only",
        headers: { "x-api-key": "svc" },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().code).toBe("USER_IDENTITY_REQUIRED");
    });
  });

  describe("dev bypass", () => {
    it("acts as the local dev account when no keys are configured", async () => {
      const app = await buildTestApp(undefined);
      const res = await app.inject({ method: "GET", url: "/whoami" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        contributor: "dev:local",
        user_id: "dev-user-id",
        method: "dev_bypass",
      });
    });

    it("fails closed in production even with no keys configured", async () => {
      const app = await buildTestApp(undefined, "production");
      const res = await app.inject({ method: "GET", url: "/whoami" });
      expect(res.statusCode).toBe(401);
    });
  });
});
