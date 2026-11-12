/**
 * The one setting that says who a deployment serves (src/permissions.ts,
 * src/server/plugins/members-only.ts).
 *
 * At its starting value nothing here binds: the public graph registers no
 * hook, mounts no route for permissions, and serves every open route to an
 * anonymous caller as before. That is checked over the real app's whole
 * catalog of open routes. At "members", a small app built from the same
 * plugins covers the hook's own cases without a database; the real tables
 * are in tests/db/members-only.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const MEMBER = { id: "11111111-1111-4111-8111-111111111111", externalId: "oidc:member" };
const NEWCOMER = { id: "22222222-2222-4222-8222-222222222222", externalId: "oidc:newcomer" };
const UUID = "33333333-3333-4333-8333-333333333333";

const resolveApiKey = vi.fn(async (key: string) => {
  const user = key === "member-key" ? MEMBER : key === "newcomer-key" ? NEWCOMER : null;
  return user ? { user: { ...user, isSuspended: false }, key: { id: `k-${user.id}`, scope: "user" } } : null;
});
vi.mock("../../../src/services/api-key-service.js", () => ({ resolveApiKey }));

const resolveStanding = vi.fn(async (accountId: string) =>
  accountId === MEMBER.id
    ? {
        member: true,
        grants: [{ permission: "read", label: "internal", partyId: null, group: null }],
        clearance: ["internal", "public"],
        rawSourceLabels: ["public"],
        groups: [],
      }
    : { member: false, grants: [], clearance: ["public"], rawSourceLabels: ["public"], groups: [] }
);
vi.mock("../../../src/services/permission-service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/permission-service.js")>()),
  resolveStanding,
}));

vi.mock("../../../src/services/contributor-service.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/services/contributor-service.js")>()),
  getContributorByExternalId: vi.fn(async (externalId: string) =>
    externalId === MEMBER.externalId ? { ...MEMBER, isSuspended: false } : null
  ),
  getOrCreateContributor: vi.fn(async () => ({ id: "dev-user", externalId: "dev:local", isSuspended: false })),
}));

// The open routes read the database. None is reachable in the unit suite,
// and none is needed to see whether a request was let through to its route.
vi.mock("../../../src/db/client.js", async (orig) => ({
  ...(await orig<typeof import("../../../src/db/client.js")>()),
  rawQuery: vi.fn(async () => []),
}));

const savedEnv = { ...process.env };
function setEnv(env: Record<string, string>) {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv, { LOG_LEVEL: "fatal" }, env);
  delete process.env.READS;
  delete process.env.API_KEYS;
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  vi.resetModules();
}

afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
});

/**
 * A small app from the real plugins, with one route of each kind. With
 * `rateLimit`, the anonymous limit is registered where the real app has it:
 * before the hook that authenticates every request.
 */
async function smallApp(env: Record<string, string>, rateLimit = false): Promise<FastifyInstance> {
  setEnv(env);
  const { registerCors } = await import("../../../src/server/plugins/cors.js");
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const { registerRouteCatalog } = await import("../../../src/server/plugins/route-catalog.js");
  const { registerMembersOnly } = await import("../../../src/server/plugins/members-only.js");
  const { requirePermission } = await import("../../../src/server/require-permission.js");
  const { currentClearance } = await import("../../../src/llm/usage-context.js");

  const app = Fastify();
  await registerCors(app);
  await registerAuth(app);
  await registerRouteCatalog(app);
  if (rateLimit) {
    const { registerAnonymousRateLimit } = await import("../../../src/server/plugins/anonymous-rate-limit.js");
    await registerAnonymousRateLimit(app);
  }
  await registerMembersOnly(app);

  app.get("/health", async () => ({ status: "ok" }));
  app.get("/open", async (request) => ({ viewer: request.auth?.userId ?? null, clearance: currentClearance() }));
  app.get("/private", { preHandler: [app.authenticate] }, async (request) => ({
    viewer: request.auth?.userId ?? null,
    method: request.auth?.method,
    standing: request.auth?.standing ?? null,
  }));
  app.post("/fund", { preHandler: [app.authenticate, app.requireUser, requirePermission("fund")] }, async () => ({
    funded: true,
  }));
  app.post("/users/provision", { preHandler: [app.authenticate, app.requireService] }, async () => ({ ok: true }));
  app.get("/users/me", { preHandler: [app.authenticate, app.requireUser] }, async (request) => ({
    id: request.auth!.userId,
  }));
  app.post("/operator/thing", { preHandler: [app.requireOperator] }, async () => ({ ops: true }));
  await app.ready();
  return app;
}

describe("with the setting at its starting value", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    setEnv({ ENVIRONMENT: "staging", API_KEYS: "env-service-key" });
    const { buildApp } = await import("../../../src/server/app.js");
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app?.close());

  const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, UUID);

  it("registers nothing: no classes, no routes for permissions, no tools for them", async () => {
    expect(app.hasDecorator("signInClasses")).toBe(false);
    const urls = app.routeCatalog.map((r) => r.url);
    expect(urls.filter((u) => /^\/(permissions|parties|labels)(\/|$)|\/party$|^\/operator\/administrators$/.test(u))).toEqual([]);

    const { buildMcpServer } = await import("../../../src/mcp/server.js");
    const server = buildMcpServer({
      auth: { method: "api_key", userId: "u", apiKeyId: "k", contributorExternalId: "x:u", isService: false, isSession: false },
      requestId: "r",
      app,
    });
    const tools = Object.keys((server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools);
    expect(tools.filter((t) => /permission|parties|labels|list_accounts/.test(t))).toEqual([]);
    // A caller with no standing is offered every tool of a route that names a permission.
    expect(tools).toEqual(expect.arrayContaining(["fund_mandate", "start_grant_conversation", "submit_source", "order_assessment"]));
    const { withheldRouteTools } = await import("../../../src/mcp/route-tools.js");
    expect(withheldRouteTools(app, { method: "api_key", userId: "u", apiKeyId: "k", contributorExternalId: "x:u", isService: false, isSession: false })).toEqual([]);
  });

  it("lets an anonymous caller through to every open route, as before", async () => {
    const open = app.routeCatalog.filter((r) => app.readClasses.get(`${r.method} ${r.url}`) === "open");
    // The whole catalog of open routes, not a sample of it.
    expect(open.length).toBeGreaterThan(70);
    for (const route of open) {
      const res = await app.inject({ method: route.method as "GET", url: concrete(route.url) });
      const key = `${route.method} ${route.url}`;
      expect(res.statusCode, key).not.toBe(401);
      expect(res.body, key).not.toMatch(/SIGN_IN_REQUIRED|NOT_A_MEMBER|PERMISSION_REQUIRED/);
    }
  });

  it("keeps every route's class as the route's own guards make it", () => {
    // The guards this change added sit only on routes that already
    // authenticated, so no route moved between open and authenticated.
    const guarded = app.routeCatalog.filter((r) => r.permissions.length > 0);
    expect(guarded.length).toBeGreaterThan(10);
    for (const route of guarded) {
      expect(app.readClasses.get(`${route.method} ${route.url}`), route.url).toBe("authenticated");
    }
    for (const key of ["GET /claims/:claim_id", "GET /claims", "GET /mandates", "GET /sources/:source_id", "GET /setup/features", "GET /runs/:run_id"]) {
      expect(app.readClasses.get(key), key).toBe("open");
    }
  });

  it("asks no permission of anyone: a guarded act answers as its own rules say", async () => {
    const small = await smallApp({ ENVIRONMENT: "staging", API_KEYS: "env-service-key" });
    try {
      const res = await small.inject({ method: "POST", url: "/fund", headers: { "x-api-key": "member-key" } });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ funded: true });
      expect(resolveStanding).not.toHaveBeenCalled();
      // No standing is resolved and no clearance is set: a read sees public alone.
      const open = await small.inject({ url: "/open" });
      expect(open.json()).toEqual({ viewer: null, clearance: ["public"] });
      const priv = await small.inject({ url: "/private", headers: { "x-api-key": "member-key" } });
      expect(priv.json()).toEqual({ viewer: MEMBER.id, method: "api_key", standing: null });
    } finally {
      await small.close();
    }
  });

  it("keeps the dev bypass where no key is configured outside production", async () => {
    const small = await smallApp({ ENVIRONMENT: "development" });
    try {
      const res = await small.inject({ url: "/private" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ viewer: "dev-user", method: "dev_bypass" });
    } finally {
      await small.close();
    }
  });
});

describe("members-only", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await smallApp({ ENVIRONMENT: "staging", API_KEYS: "web-tier-key", READS: "members", MINERVAL_OPERATOR_KEY: "op" });
  });
  afterAll(() => app?.close());

  it("refuses a request with no credential on a route that has no guard of its own", async () => {
    const res = await app.inject({ url: "/open" });
    expect(res.statusCode).toBe(401);
    expect(res.json().code).toBe("SIGN_IN_REQUIRED");
    expect((await app.inject({ url: "/health" })).statusCode).toBe(200);
  });

  it("has no dev bypass, whatever the environment and whether or not a key is configured", async () => {
    const dev = await smallApp({ ENVIRONMENT: "development", READS: "members" });
    try {
      for (const url of ["/open", "/private"]) {
        const res = await dev.inject({ url });
        expect(res.statusCode, url).toBe(401);
        expect(res.json().code, url).toBe("SIGN_IN_REQUIRED");
      }
    } finally {
      await dev.close();
    }
  });

  it("counts a made-up key against its address in every environment, and past the limit the hook is never reached", async () => {
    // No key configured, outside production: on an open deployment this is
    // keyless local development and nothing is counted. Here there is no
    // dev account, so the anonymous limit stands in front of the hook.
    const dev = await smallApp({ ENVIRONMENT: "development", READS: "members", ANONYMOUS_RATE_LIMIT_PER_MINUTE: "3" }, true);
    try {
      const headers = { "x-api-key": "made-up", "cf-connecting-ip": "203.0.113.7" };
      resolveApiKey.mockClear();
      for (let i = 0; i < 3; i++) {
        const res = await dev.inject({ url: "/open", headers });
        expect(res.statusCode).toBe(401);
        expect(res.headers["ratelimit-policy"]).toBe("3;w=60");
      }
      // Each of those was looked up twice: once by the limit, to see whether
      // the key is one it knows, and once by the hook that authenticates.
      expect(resolveApiKey).toHaveBeenCalledTimes(6);

      const refused = await dev.inject({ url: "/open", headers });
      expect(refused.statusCode).toBe(429);
      expect(refused.json().error.code).toBe("ANONYMOUS_RATE_LIMITED");
      // The limit's own look, and nothing after it: the hook did not run.
      expect(resolveApiKey).toHaveBeenCalledTimes(7);

      // A request with no credential is counted the same way, and looks nothing up.
      resolveApiKey.mockClear();
      const bare = { "cf-connecting-ip": "203.0.113.8" };
      const seen: number[] = [];
      for (let i = 0; i < 4; i++) seen.push((await dev.inject({ url: "/open", headers: bare })).statusCode);
      expect(seen).toEqual([401, 401, 401, 429]);
      expect(resolveApiKey).not.toHaveBeenCalled();
    } finally {
      await dev.close();
    }
  });

  it("serves a member, with a standing resolved once and kept through the route's own authenticate", async () => {
    resolveApiKey.mockClear();
    resolveStanding.mockClear();
    const res = await app.inject({ url: "/private", headers: { "x-api-key": "member-key" } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      viewer: MEMBER.id,
      standing: { member: true, clearance: ["internal", "public"] },
    });
    expect(resolveApiKey).toHaveBeenCalledTimes(1);
    expect(resolveStanding).toHaveBeenCalledTimes(1);

    const open = await app.inject({ url: "/open", headers: { "x-api-key": "member-key" } });
    expect(open.json()).toEqual({ viewer: MEMBER.id, clearance: ["internal", "public"] });
  });

  it("serves the web tier acting for a member, and nothing to the web tier acting for nobody", async () => {
    const acting = await app.inject({ url: "/open", headers: { "x-api-key": "web-tier-key", "x-acting-user": MEMBER.externalId } });
    expect(acting.statusCode).toBe(200);
    expect(acting.json().viewer).toBe(MEMBER.id);

    const nobody = await app.inject({ url: "/open", headers: { "x-api-key": "web-tier-key" } });
    expect(nobody.statusCode).toBe(401);
    expect(nobody.json()).toEqual({
      error:
        "This credential does not act for a person, and this deployment serves only people who are " +
        "signed in. A service key says who is asking with x-acting-user.",
      code: "SIGN_IN_REQUIRED",
    });
    // The one route it may call with nobody named is the one that signs a person in.
    const provision = await app.inject({ method: "POST", url: "/users/provision", headers: { "x-api-key": "web-tier-key" } });
    expect(provision.statusCode).toBe(200);
    // A member's own key is not the web tier's.
    const byMember = await app.inject({ method: "POST", url: "/users/provision", headers: { "x-api-key": "member-key" } });
    expect(byMember.statusCode).toBe(403);
  });

  it("tells a signed-in account with no grant who it is, and serves it nothing else", async () => {
    const me = await app.inject({ url: "/users/me", headers: { "x-api-key": "newcomer-key" } });
    expect(me.statusCode).toBe(200);
    const open = await app.inject({ url: "/open", headers: { "x-api-key": "newcomer-key" } });
    expect(open.statusCode).toBe(403);
    expect(open.json().code).toBe("NOT_A_MEMBER");
  });

  it("holds a guarded act to its permission", async () => {
    const res = await app.inject({ method: "POST", url: "/fund", headers: { "x-api-key": "member-key" } });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: "PERMISSION_REQUIRED", permission: "fund" });
    expect(app.routeCatalog.find((r) => r.url === "/fund")!.permissions).toEqual(["fund"]);
    expect(app.routeCatalog.find((r) => r.url === "/open")!.permissions).toEqual([]);
  });

  it("leaves a route that takes the operator key to check it, and lets a preflight through", async () => {
    expect((await app.inject({ method: "POST", url: "/operator/thing" })).json().code).toBe("OPERATOR_KEY_REQUIRED");
    const ok = await app.inject({ method: "POST", url: "/operator/thing", headers: { "x-operator-key": "op" } });
    expect(ok.statusCode).toBe(200);
    expect(app.signInClasses.get("POST /operator/thing")).toBe("own_credential");
    expect(app.signInClasses.get("GET /open")).toBe("member");
    expect(app.signInClasses.get("HEAD /health")).toBe("anyone");

    const preflight = await app.inject({
      method: "OPTIONS",
      url: "/open",
      headers: { origin: "https://app.example", "access-control-request-method": "GET" },
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.body).toBe("");
  });
});

describe("permissions in words", () => {
  it("names each permission once, with its scope, what it covers and what it never lets anyone do", async () => {
    const { PERMISSIONS, PERMISSION_DEFINITIONS, holdsPermission, heldPermissions, PUBLIC_STANDING, standingOf, membersOnly } =
      await import("../../../src/permissions.js");
    expect([...PERMISSIONS]).toEqual(["direct", "release", "fund", "read", "read_sources", "administer"]);
    for (const name of PERMISSIONS) {
      const d = PERMISSION_DEFINITIONS[name];
      expect(d.covers.length, name).toBeGreaterThan(30);
      expect(d.never.length, name).toBeGreaterThan(15);
      expect(d.phrase, name).not.toMatch(/[.—]/);
    }
    expect(PERMISSIONS.filter((p) => PERMISSION_DEFINITIONS[p].scope === "label")).toEqual(["read", "read_sources"]);
    expect(PERMISSIONS.filter((p) => PERMISSION_DEFINITIONS[p].scope === "party")).toEqual(["release"]);

    // No standing is the public one: nothing held, public to read.
    expect(standingOf(null)).toBe(PUBLIC_STANDING);
    expect(standingOf({})).toBe(PUBLIC_STANDING);
    expect(PUBLIC_STANDING.clearance).toEqual(["public"]);
    expect(holdsPermission(PUBLIC_STANDING, "read")).toBe(false);

    const standing = {
      ...PUBLIC_STANDING,
      member: true,
      grants: [
        { permission: "read" as const, label: "internal", partyId: null, group: null },
        { permission: "release" as const, label: null, partyId: "p1", group: "reviewers" },
      ],
    };
    expect(heldPermissions(standing)).toEqual(["release", "read"]);
    expect(holdsPermission(standing, "read", { label: "internal" })).toBe(true);
    expect(holdsPermission(standing, "read", { label: "restricted" })).toBe(false);
    expect(holdsPermission(standing, "release", { partyId: "p1" })).toBe(true);
    expect(holdsPermission(standing, "release", { partyId: "p2" })).toBe(false);
    expect(holdsPermission(standing, "administer")).toBe(false);

    expect(membersOnly({})).toBe(false);
    expect(membersOnly({ reads: "open" })).toBe(false);
    expect(membersOnly({ reads: "members" })).toBe(true);
  });
});

describe("the settings", () => {
  async function config(env: Record<string, string>) {
    setEnv({ ENVIRONMENT: "staging", ...env });
    return (await import("../../../src/config.js")).loadConfig();
  }

  it("start as the public graph: open, no first administrator, twelve hours", async () => {
    const c = await config({});
    expect(c.reads).toBe("open");
    expect(c.firstAdministrator).toBe("");
    expect(c.signInValidHours).toBe(12);
  });

  it("take members, a sign-in identity, and a number of hours", async () => {
    const c = await config({ READS: "members", FIRST_ADMINISTRATOR: " oidc:00u1abcd ", SIGN_IN_VALID_HOURS: "8" });
    expect(c.reads).toBe("members");
    expect(c.firstAdministrator).toBe("oidc:00u1abcd");
    expect(c.signInValidHours).toBe(8);
  });

  it("refuse a value that is neither, and a first administrator that is not an identity", async () => {
    await expect(config({ READS: "private" })).rejects.toThrow();
    await expect(config({ FIRST_ADMINISTRATOR: "alice@example.org" })).rejects.toThrow(
      /FIRST_ADMINISTRATOR must be a sign-in identity of the form/
    );
    await expect(config({ SIGN_IN_VALID_HOURS: "0" })).rejects.toThrow();
  });
});

describe("what an outside MCP caller is told", () => {
  it("is nothing more on the public graph, and the tools its permissions leave out in a members-only deployment", async () => {
    const auth = (grants: Array<{ permission: string }>) => ({
      method: "api_key" as const,
      userId: "u",
      apiKeyId: "k",
      contributorExternalId: "x:u",
      isService: false,
      isSession: false,
      standing: {
        member: true,
        grants: grants.map((g) => ({ ...g, label: null, partyId: null, group: null })),
        clearance: ["public"],
        rawSourceLabels: ["public"],
        groups: [],
      },
    });
    const instructionsFor = async (env: Record<string, string>, grants: Array<{ permission: string }>) => {
      setEnv({ ENVIRONMENT: "staging", API_KEYS: "k", ...env });
      const { buildApp } = await import("../../../src/server/app.js");
      const { buildMcpServer } = await import("../../../src/mcp/server.js");
      const { MCP_INSTRUCTIONS } = await import("../../../src/mcp/caller-skills.js");
      const app = await buildApp();
      await app.ready();
      try {
        const server = buildMcpServer({ auth: auth(grants) as never, requestId: "r", app });
        const instructions = (server.server as unknown as { _instructions?: string })._instructions ?? "";
        return { instructions, base: MCP_INSTRUCTIONS };
      } finally {
        await app.close();
      }
    };

    const open = await instructionsFor({}, []);
    expect(open.instructions).toBe(open.base);

    const limited = await instructionsFor({ READS: "members" }, [{ permission: "fund" }]);
    expect(limited.instructions.startsWith(limited.base)).toBe(true);
    expect(limited.instructions).toContain("your user does not hold all of them");
    expect(limited.instructions).toMatch(/Without the permission to direct the graph: .*start_grant_conversation/);
    expect(limited.instructions).not.toMatch(/Without the permission to fund work/);

    const all = await instructionsFor({ READS: "members" }, [{ permission: "fund" }, { permission: "direct" }, { permission: "administer" }]);
    expect(all.instructions).toBe(all.base);
  });
});
