import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";

/**
 * The platform account's two boundaries in the auth plugin (#529): a
 * platform-grantmaking key holds the granting conversations and nothing
 * else (never /fund), and nobody acts as the platform through
 * x-acting-user.
 */
const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(async (_key: string) => null as unknown),
  getContributorByExternalId: vi.fn(async (_id: string) => null as unknown),
  getOrCreateContributor: vi.fn(),
}));

vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: mocks.resolveApiKey,
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorByExternalId: mocks.getContributorByExternalId,
  getOrCreateContributor: mocks.getOrCreateContributor,
}));

const PLATFORM = {
  id: "platform-id",
  externalId: "platform:minerval",
  displayName: "Minerval",
  isSuspended: false,
};

function keyRow(scope: string) {
  return {
    key: { id: `key-${scope}`, scope },
    user: scope === "platform_grantmaking" ? PLATFORM : { id: "svc-owner", externalId: "svc:owner", isSuspended: false },
  };
}

async function buildApp() {
  process.env.API_KEYS = "env-service-key";
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const app = Fastify();
  await registerAuth(app);
  const echo = async (request: { auth: { userId: string | null; isService: boolean } | null }) => ({
    user_id: request.auth?.userId ?? null,
    is_service: request.auth?.isService ?? null,
  });
  app.post("/grant-conversations", { preHandler: app.authenticate }, echo);
  app.post("/grant-conversations/:id/messages", { preHandler: app.authenticate }, echo);
  app.get("/grant-conversations/:id", { preHandler: app.authenticate }, echo);
  app.post("/grant-conversations/:id/fund", { preHandler: app.authenticate }, echo);
  app.post("/claims/propose", { preHandler: app.authenticate }, echo);
  app.post("/grants/:id/topup", { preHandler: app.authenticate }, echo);
  app.get("/whoami", { preHandler: app.authenticate }, echo);
  return app;
}

describe("platform-grantmaking key", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.API_KEYS;
    mocks.resolveApiKey.mockReset();
    mocks.getContributorByExternalId.mockReset();
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = saved;
  });

  it("holds the platform's conversations as the platform, without service trust", async () => {
    mocks.resolveApiKey.mockResolvedValue(keyRow("platform_grantmaking"));
    const app = await buildApp();
    for (const [method, url] of [
      ["POST", "/grant-conversations"],
      ["POST", "/grant-conversations/c1/messages"],
      ["GET", "/grant-conversations/c1"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { "x-api-key": "epk_platform" } });
      expect(res.statusCode, `${method} ${url}`).toBe(200);
      expect(res.json()).toEqual({ user_id: "platform-id", is_service: false });
    }
  });

  it("is refused on /fund: the platform's money moves only under a public approval", async () => {
    mocks.resolveApiKey.mockResolvedValue(keyRow("platform_grantmaking"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/grant-conversations/c1/fund",
      headers: { "x-api-key": "epk_platform" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("KEY_SCOPE_PLATFORM_GRANTMAKING");
  });

  it("is refused on every other route", async () => {
    mocks.resolveApiKey.mockResolvedValue(keyRow("platform_grantmaking"));
    const app = await buildApp();
    for (const [method, url] of [
      ["POST", "/claims/propose"],
      ["POST", "/grants/g1/topup"],
      ["GET", "/whoami"],
    ] as const) {
      const res = await app.inject({ method, url, headers: { "x-api-key": "epk_platform" } });
      expect(res.statusCode, `${method} ${url}`).toBe(403);
      expect(res.json().code).toBe("KEY_SCOPE_PLATFORM_GRANTMAKING");
    }
  });

  it("cannot act for anyone", async () => {
    mocks.resolveApiKey.mockResolvedValue(keyRow("platform_grantmaking"));
    mocks.getContributorByExternalId.mockResolvedValue({ id: "u1", externalId: "github:1", isSuspended: false });
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/grant-conversations",
      headers: { "x-api-key": "epk_platform", "x-acting-user": "github:1" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("ACTING_USER_FORBIDDEN");
  });
});

describe("acting as the platform", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.API_KEYS;
    mocks.resolveApiKey.mockReset();
    mocks.getContributorByExternalId.mockReset();
    mocks.getContributorByExternalId.mockResolvedValue(PLATFORM);
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.API_KEYS;
    else process.env.API_KEYS = saved;
  });

  it("is refused for the env service key", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/grant-conversations",
      headers: { "x-api-key": "env-service-key", "x-acting-user": "platform:minerval" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PLATFORM_NOT_ACTABLE");
    expect(mocks.getContributorByExternalId).not.toHaveBeenCalled();
  });

  it("is refused for a service-scope DB key", async () => {
    mocks.resolveApiKey.mockResolvedValue(keyRow("service"));
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/grant-conversations/c1/fund",
      headers: { "x-api-key": "epk_service", "x-acting-user": "platform:minerval" },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe("PLATFORM_NOT_ACTABLE");
  });
});

describe("platformGrantmakingRouteAllowed", () => {
  it("allows the conversation routes and nothing else", async () => {
    const { platformGrantmakingRouteAllowed } = await import("../../../src/server/plugins/auth.js");
    expect(platformGrantmakingRouteAllowed("POST", "/grant-conversations")).toBe(true);
    expect(platformGrantmakingRouteAllowed("GET", "/grant-conversations")).toBe(true);
    expect(platformGrantmakingRouteAllowed("POST", "/grant-conversations/:id/messages")).toBe(true);
    expect(platformGrantmakingRouteAllowed("GET", "/grant-conversations/platform/:id")).toBe(true);
    expect(platformGrantmakingRouteAllowed("POST", "/grant-conversations/:id/fund")).toBe(false);
    expect(platformGrantmakingRouteAllowed("POST", "/grant-conversations/abc/fund/")).toBe(false);
    expect(platformGrantmakingRouteAllowed("POST", "/grant-conversations-evil")).toBe(false);
    expect(platformGrantmakingRouteAllowed("POST", "/grants")).toBe(false);
    expect(platformGrantmakingRouteAllowed("POST", "/operator/platform-mandates/fund")).toBe(false);
  });
});
