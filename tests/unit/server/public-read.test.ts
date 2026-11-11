/**
 * Public reads as a cacheable, browser-facing surface
 * (src/server/plugins/public-read.ts, src/server/plugins/cors.ts).
 *
 * Two apps. The real one (buildApp) shows the policy on the routes as they
 * are registered, and that no authenticated route is ever marked public. A
 * small one, built from the same plugins, covers the cases the real routes
 * would need a database for.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";

vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: vi.fn(async () => null),
}));

const PUBLIC_POLICY = "public, max-age=60, stale-while-revalidate=300";
const NO_STORE = "private, no-store";
const UUID = "11111111-1111-4111-8111-111111111111";

const savedEnv = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

/** Fresh modules, so the config singleton is re-read from this env. */
async function loadPlugins(env: Record<string, string> = {}) {
  resetEnv();
  Object.assign(process.env, {
    ENVIRONMENT: "staging",
    LOG_LEVEL: "fatal",
    // With a key configured, an anonymous caller is refused rather than
    // waved through by the dev bypass.
    API_KEYS: "env-service-key",
    ...env,
  });
  vi.resetModules();
  return {
    ...(await import("../../../src/server/plugins/cors.js")),
    ...(await import("../../../src/server/plugins/auth.js")),
    ...(await import("../../../src/server/plugins/public-read.js")),
    ...(await import("../../../src/server/optional-auth.js")),
  };
}

async function smallApp(env: Record<string, string> = {}) {
  const p = await loadPlugins(env);
  const app = Fastify();
  await p.registerCors(app);
  await p.registerAuth(app);
  await p.registerPublicRead(app);

  const optionalAuth = p.optionalAuthHook(async (request: never, reply: never) => {
    if (p.presentsCredentials(request)) await app.authenticate(request, reply);
  });

  app.get("/open", async () => ({ id: 1, statement: "water is wet", extra: "x" }));
  app.post("/open", async () => ({ ok: true }));
  app.get("/open/missing", async (_request, reply) => reply.code(404).send({ error: "nope" }));
  app.get("/open/own-private", async (_request, reply) =>
    reply.header("cache-control", "no-store").send({ a: 1 })
  );
  app.get("/open/own-public", async (_request, reply) =>
    reply.header("cache-control", "public, max-age=30").send({ a: 1 })
  );
  app.get("/open/binary", async (_request, reply) =>
    reply.type("application/pdf").send(Buffer.from("%PDF"))
  );
  app.get("/optional", { preHandler: [optionalAuth] }, async (request) => ({
    viewer: request.auth?.method ?? "anonymous",
  }));
  app.get("/inline", async (request, reply) => {
    // A handler that resolves an identity itself, with no hook to show it.
    request.auth = { method: "env_key" } as never;
    return reply.send({ secret: true });
  });
  app.get("/private", { preHandler: [app.authenticate] }, async () => ({ mine: true }));
  app.get("/operator", { preHandler: [app.requireOperator] }, async () => ({ ops: true }));
  app.get("/unvouched", { preHandler: [async () => {}] }, async () => ({ a: 1 }));
  app.get("/gated-early", { onRequest: async () => {} }, async () => ({ a: 1 }));
  app.get("/health", async () => ({ status: "ok" }));
  app.get("/oauth/thing", async () => ({ a: 1 }));

  // A sibling scope with a later onSend that rewrites the body, the way a
  // `fields=` pruner would: the ETag must describe what is actually sent.
  await app.register(async (scope) => {
    scope.addHook("onSend", async (request, _reply, payload) => {
      const fields = (request.query as { fields?: string }).fields;
      if (!fields || typeof payload !== "string") return payload;
      const body = JSON.parse(payload) as Record<string, unknown>;
      const keep = fields.split(",");
      return JSON.stringify(Object.fromEntries(Object.entries(body).filter(([k]) => keep.includes(k))));
    });
    scope.get("/pruned", async () => ({ id: 1, statement: "water is wet", extra: "x" }));
  });

  await app.ready();
  return app;
}

afterAll(resetEnv);

describe("a public read", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await smallApp();
  });
  afterAll(() => app.close());

  it("is cacheable, open to any origin, and carries a validator", async () => {
    const res = await app.inject({ url: "/open", headers: { origin: "https://embedder.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(PUBLIC_POLICY);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers.etag).toMatch(/^W\/"[\w-]+"$/);
    // Nothing varies on the origin, so the edge can hand one copy to every site.
    expect(String(res.headers.vary)).not.toMatch(/origin/i);
    expect(res.headers.vary).toBe("Authorization, X-API-Key");
  });

  it("answers HEAD with the headers the GET would carry", async () => {
    const get = await app.inject({ url: "/open" });
    const head = await app.inject({ method: "HEAD", url: "/open" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["cache-control"]).toBe(PUBLIC_POLICY);
    expect(head.headers.etag).toBe(get.headers.etag);
    expect(head.headers.vary).toBe(get.headers.vary);

    const keyed = await app.inject({ method: "HEAD", url: "/open", headers: { "x-api-key": "anything" } });
    expect(keyed.headers["cache-control"]).toBe(NO_STORE);
    expect(keyed.headers.etag).toBeUndefined();
  });

  it("answers If-None-Match with a 304 and no body", async () => {
    const first = await app.inject({ url: "/open" });
    const etag = first.headers.etag as string;
    const again = await app.inject({ url: "/open", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
    expect(again.headers.etag).toBe(etag);
    expect(again.headers["cache-control"]).toBe(PUBLIC_POLICY);
    expect(again.headers["access-control-allow-origin"]).toBe("*");

    const strong = await app.inject({
      url: "/open",
      headers: { "if-none-match": `"other", ${etag.replace(/^W\//, "")}` },
    });
    expect(strong.statusCode).toBe(304);
    const stale = await app.inject({ url: "/open", headers: { "if-none-match": 'W/"stale"' } });
    expect(stale.statusCode).toBe(200);
  });

  it("takes its ETag from the bytes sent, after a later hook rewrites them", async () => {
    const full = await app.inject({ url: "/pruned" });
    const pruned = await app.inject({ url: "/pruned?fields=id" });
    expect(pruned.json()).toEqual({ id: 1 });
    expect(pruned.headers.etag).not.toBe(full.headers.etag);
    // The full body's tag must not validate the pruned one.
    const cross = await app.inject({
      url: "/pruned?fields=id",
      headers: { "if-none-match": full.headers.etag as string },
    });
    expect(cross.statusCode).toBe(200);
    const same = await app.inject({
      url: "/pruned?fields=id",
      headers: { "if-none-match": pruned.headers.etag as string },
    });
    expect(same.statusCode).toBe(304);
  });

  it("is private the moment the request carries a credential", async () => {
    for (const headers of [
      { "x-api-key": "env-service-key" },
      { "x-api-key": "not-a-real-key" },
      { authorization: "Bearer whatever" },
      { "x-operator-key": "anything" },
      { "x-acting-user": "github:1" },
      { cookie: "session=1" },
    ]) {
      const res = await app.inject({ url: "/open", headers });
      expect(res.headers["cache-control"], JSON.stringify(headers)).toBe(NO_STORE);
      expect(res.headers.etag).toBeUndefined();
    }
  });

  it("gives no 304 to a credentialed request, even with a matching tag", async () => {
    const etag = (await app.inject({ url: "/open" })).headers.etag as string;
    const res = await app.inject({
      url: "/open",
      headers: { "x-api-key": "env-service-key", "if-none-match": etag },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(NO_STORE);
  });

  it("stays public behind optional auth for an anonymous caller only", async () => {
    const anonymous = await app.inject({ url: "/optional" });
    expect(anonymous.json()).toEqual({ viewer: "anonymous" });
    expect(anonymous.headers["cache-control"]).toBe(PUBLIC_POLICY);

    const keyed = await app.inject({ url: "/optional", headers: { "x-api-key": "env-service-key" } });
    expect(keyed.json()).toEqual({ viewer: "env_key" });
    expect(keyed.headers["cache-control"]).toBe(NO_STORE);
    expect(keyed.headers.etag).toBeUndefined();
  });

  it("leaves what is not a 200 GET of JSON or text without a policy", async () => {
    for (const req of [
      { method: "GET" as const, url: "/open/missing" },
      { method: "POST" as const, url: "/open" },
      { method: "GET" as const, url: "/open/binary" },
    ]) {
      const res = await app.inject(req);
      expect(res.headers["cache-control"], req.url).toBeUndefined();
      expect(res.headers.etag, req.url).toBeUndefined();
    }
  });

  it("keeps a policy the route set itself", async () => {
    const own = await app.inject({ url: "/open/own-private" });
    expect(own.headers["cache-control"]).toBe("no-store");
    expect(own.headers.etag).toBeUndefined();

    const pub = await app.inject({ url: "/open/own-public" });
    expect(pub.headers["cache-control"]).toBe("public, max-age=30");
    expect(pub.headers.etag).toBeDefined();
  });

  it("leaves the excluded surfaces alone", async () => {
    for (const url of ["/health", "/oauth/thing"]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"], url).toBeUndefined();
      expect(res.headers.etag, url).toBeUndefined();
    }
  });
});

describe("an authenticated route", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await smallApp();
  });
  afterAll(() => app.close());

  it("is never public: refused or served, the answer is no-store", async () => {
    const refused = await app.inject({ url: "/private" });
    expect(refused.statusCode).toBe(401);
    expect(refused.headers["cache-control"]).toBe(NO_STORE);

    const served = await app.inject({ url: "/private", headers: { "x-api-key": "env-service-key" } });
    expect(served.statusCode).toBe(200);
    expect(served.headers["cache-control"]).toBe(NO_STORE);
    expect(served.headers.etag).toBeUndefined();

    const operator = await app.inject({ url: "/operator" });
    expect(operator.statusCode).toBe(403);
    expect(operator.headers["cache-control"]).toBe(NO_STORE);
  });

  it("includes any route with a hook nobody vouched for", async () => {
    for (const url of ["/unvouched", "/gated-early"]) {
      const res = await app.inject({ url });
      expect(res.statusCode).toBe(200);
      expect(res.headers["cache-control"], url).toBe(NO_STORE);
      expect(res.headers.etag, url).toBeUndefined();
    }
    expect(app.readClasses.get("GET /unvouched")).toBe("authenticated");
    expect(app.readClasses.get("GET /optional")).toBe("open");
  });

  it("includes a request a handler authenticated inline", async () => {
    const res = await app.inject({ url: "/inline" });
    expect(res.headers["cache-control"]).toBe(NO_STORE);
  });
});

describe("configuration", () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reads the cache lifetimes from config", async () => {
    app = await smallApp({
      PUBLIC_READ_MAX_AGE_SECONDS: "5",
      PUBLIC_READ_STALE_WHILE_REVALIDATE_SECONDS: "0",
    });
    const res = await app.inject({ url: "/open" });
    expect(res.headers["cache-control"]).toBe("public, max-age=5, stale-while-revalidate=0");
  });

  it("with CORS_ORIGINS set, restricts origins and keeps reads out of shared caches", async () => {
    // Production refuses to boot without its model envs; any known id will do.
    const { MODELS } = await import("../../../src/llm/models.js");
    const models = Object.fromEntries(
      [
        "STEWARD_MODEL",
        "CURATOR_MODEL",
        "AUDIT_MODEL",
        "ARBITRATION_MODEL",
        "EXTRACTOR_MODEL",
        "SOLVER_MODEL",
        "STEWARD_STRONG_MODEL",
      ].map((name) => [name, MODELS.strong])
    );
    app = await smallApp({
      ...models,
      ENVIRONMENT: "production",
      CORS_ORIGINS: "https://a.example, https://b.example",
    });
    const allowed = await app.inject({ url: "/open", headers: { origin: "https://a.example" } });
    expect(allowed.headers["access-control-allow-origin"]).toBe("https://a.example");
    expect(String(allowed.headers.vary)).toMatch(/origin/i);
    // A reflected origin must not be stored where the next site would get it.
    expect(allowed.headers["cache-control"]).toBe("private, max-age=60");

    const other = await app.inject({ url: "/open", headers: { origin: "https://evil.example" } });
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("answers a preflight with the same methods and headers as before", async () => {
    app = await smallApp();
    const res = await app.inject({
      method: "OPTIONS",
      url: "/open",
      headers: {
        origin: "https://embedder.example",
        "access-control-request-method": "GET",
        "access-control-request-headers": "x-api-key",
      },
    });
    expect(res.statusCode).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-methods"]).toBe("GET, POST, PATCH, DELETE, OPTIONS");
    expect(res.headers["access-control-allow-headers"]).toBe("Content-Type, Authorization, X-API-Key");
  });
});

describe("the real app", () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    resetEnv();
    Object.assign(process.env, { ENVIRONMENT: "staging", LOG_LEVEL: "fatal", API_KEYS: "env-service-key" });
    vi.resetModules();
    const { buildApp } = await import("../../../src/server/app.js");
    app = await buildApp();
    await app.ready();
  });
  afterAll(() => app?.close());

  const concrete = (url: string) => url.replace(/:[A-Za-z_]+/g, UUID);

  it("serves a public read with the policy, any origin, and an ETag", async () => {
    const res = await app.inject({ url: "/prizes/rules", headers: { origin: "https://embedder.example" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(PUBLIC_POLICY);
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers.etag).toMatch(/^W\//);

    const again = await app.inject({
      url: "/prizes/rules",
      headers: { "if-none-match": res.headers.etag as string },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe("");
  });

  it("serves the same route privately to a caller with a key", async () => {
    const res = await app.inject({ url: "/prizes/rules", headers: { "x-api-key": "env-service-key" } });
    expect(res.statusCode).toBe(200);
    expect(res.headers["cache-control"]).toBe(NO_STORE);
    expect(res.headers.etag).toBeUndefined();
  });

  it("tells an anonymous caller the rate limit it is under, and a keyed one nothing", async () => {
    const anonymous = await app.inject({ url: "/prizes/rules", headers: { origin: "https://embedder.example" } });
    expect(anonymous.headers["ratelimit-policy"]).toBe("300;w=60");
    // A script on another site can read it.
    expect(String(anonymous.headers["access-control-expose-headers"])).toMatch(/RateLimit-Policy/i);

    const keyed = await app.inject({ url: "/prizes/rules", headers: { "x-api-key": "env-service-key" } });
    expect(keyed.headers["ratelimit-policy"]).toBeUndefined();

    const health = await app.inject({ url: "/health" });
    expect(health.headers["ratelimit-policy"]).toBeUndefined();
  });

  it("answers HEAD on a public read with the GET's headers", async () => {
    const get = await app.inject({ url: "/prizes/rules" });
    const head = await app.inject({ method: "HEAD", url: "/prizes/rules" });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["cache-control"]).toBe(PUBLIC_POLICY);
    expect(head.headers.etag).toBe(get.headers.etag);
  });

  it("classifies every route outside the excluded surfaces", () => {
    const excluded = /^\/(health|mcp|oauth|\.well-known)(\/|$)/;
    for (const route of app.routeCatalog) {
      const key = `${route.method} ${route.url}`;
      if (excluded.test(route.url)) expect(app.readClasses.has(key), key).toBe(false);
      else expect(app.readClasses.get(key), key).toBeDefined();
    }
  });

  it("never answers an anonymous caller publicly on an authenticated route", async () => {
    const gated = app.routeCatalog.filter(
      (r) => r.method === "GET" && app.readClasses.get(`GET ${r.url}`) === "authenticated"
    );
    // Vacuous otherwise.
    expect(gated.length).toBeGreaterThan(15);
    for (const route of gated) {
      const res = await app.inject({ url: concrete(route.url) });
      expect([400, 401, 403], route.url).toContain(res.statusCode);
      expect(res.headers["cache-control"], route.url).toBe(NO_STORE);
      expect(res.headers.etag, route.url).toBeUndefined();
    }
  });

  it("marks open only routes whose every preHandler is optional auth", () => {
    // The account-bound reads, by name: a regression that opened one of
    // these would otherwise pass every check above.
    for (const key of [
      "GET /users/me",
      "GET /api-keys",
      "GET /usage",
      "GET /billing/ledger",
      "GET /orders",
      "GET /orders/:id",
      "GET /grants",
      "GET /grant-conversations/:id",
      "GET /budget-jobs/:id",
      "GET /reports",
      "GET /operator/prizes",
      "GET /extension/analysis/:content_hash",
    ]) {
      expect(app.readClasses.get(key), key).toBe("authenticated");
    }
    expect(app.readClasses.get("GET /claims/:claim_id")).toBe("open");
    expect(app.readClasses.get("GET /runs/:run_id")).toBe("open");
  });

  it("leaves the OAuth discovery policy as the route set it", async () => {
    const res = await app.inject({ url: "/.well-known/oauth-authorization-server" });
    expect(res.headers["cache-control"]).toBe("public, max-age=3600");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
  });
});

describe("the anonymous rate limit is stated where callers read it", () => {
  const root = resolve(__dirname, "../../..");
  const doc = (path: string) => readFileSync(resolve(root, path), "utf8").replace(/\s+/g, " ");

  it("in the OpenAPI description, from config", async () => {
    resetEnv();
    Object.assign(process.env, {
      ENVIRONMENT: "staging",
      LOG_LEVEL: "fatal",
      ANONYMOUS_RATE_LIMIT_PER_MINUTE: "120",
    });
    vi.resetModules();
    const { apiDescription } = await import("../../../src/server/plugins/swagger.js");
    expect(apiDescription()).toContain("120 requests per minute");
    expect(apiDescription()).toContain("max-age=60");
  });

  it("in the docs, at the same figure as the default", async () => {
    const { ANONYMOUS_RATE_LIMIT_PER_MINUTE_DEFAULT: limit } = await import("../../../src/config.js");
    for (const path of ["docs/architecture.md", "docs/infrastructure.md"]) {
      expect(doc(path), path).toContain(`${limit} requests per minute`);
      // No other per-minute figure may sit beside it.
      const figures = [...doc(path).matchAll(/(\d[\d,]*) requests per minute/g)].map((m) => m[1]);
      expect(new Set(figures), path).toEqual(new Set([String(limit)]));
    }
  });
});
