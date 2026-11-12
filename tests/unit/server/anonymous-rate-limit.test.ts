/**
 * The anonymous rate limit (src/server/plugins/anonymous-rate-limit.ts): a
 * count per address on requests with no credential the API recognises,
 * stated on every counted response and in the 429 past it.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

const mocks = vi.hoisted(() => ({
  resolveApiKey: vi.fn(async (_key: string): Promise<unknown> => null),
  resolveAccessToken: vi.fn(async (_token: string): Promise<unknown> => null),
}));
vi.mock("../../../src/services/api-key-service.js", () => ({
  resolveApiKey: mocks.resolveApiKey,
}));
vi.mock("../../../src/services/oauth-service.js", () => ({
  isOAuthAccessToken: (token: string) => token.startsWith("eoat_"),
  resolveAccessToken: mocks.resolveAccessToken,
}));

const savedEnv = { ...process.env };
function resetEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key];
  }
  Object.assign(process.env, savedEnv);
}

const LIMIT = 3;
let app: FastifyInstance | undefined;

async function build(env: Record<string, string> = {}) {
  resetEnv();
  Object.assign(process.env, {
    ENVIRONMENT: "staging",
    LOG_LEVEL: "fatal",
    API_KEYS: "env-service-key",
    MINERVAL_OPERATOR_KEY: "operator-secret",
    ANONYMOUS_RATE_LIMIT_PER_MINUTE: String(LIMIT),
    ...env,
  });
  vi.resetModules();
  mocks.resolveApiKey.mockReset().mockResolvedValue(null);
  mocks.resolveAccessToken.mockReset().mockResolvedValue(null);
  const { registerAnonymousRateLimit } = await import(
    "../../../src/server/plugins/anonymous-rate-limit.js"
  );
  app = Fastify();
  await registerAnonymousRateLimit(app);
  app.get("/read", async () => ({ ok: true }));
  app.post("/write", async () => ({ ok: true }));
  app.options("/read", async () => ({ ok: true }));
  app.get("/health", async () => ({ ok: true }));
  await app.ready();
  return app;
}

/** Statuses of `n` requests in a row. */
async function statuses(
  a: FastifyInstance,
  n: number,
  headers: Record<string, string> = {},
  url = "/read"
) {
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((await a.inject({ url, headers })).statusCode);
  return out;
}

afterEach(async () => {
  vi.useRealTimers();
  await app?.close();
  app = undefined;
  resetEnv();
});

describe("a request without credentials", () => {
  it("is told the limit on every response, and refused past it", async () => {
    const a = await build();
    const first = await a.inject({ url: "/read" });
    expect(first.statusCode).toBe(200);
    expect(first.headers["ratelimit-policy"]).toBe(`${LIMIT};w=60`);

    expect(await statuses(a, LIMIT - 1)).toEqual([200, 200]);

    const refused = await a.inject({ url: "/read" });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["ratelimit-policy"]).toBe(`${LIMIT};w=60`);
    expect(Number(refused.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(refused.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(refused.headers["cache-control"]).toBe("no-store");
    const body = refused.json();
    expect(body.error.code).toBe("ANONYMOUS_RATE_LIMITED");
    expect(body.error.message).toContain(`${LIMIT} requests per minute`);
    expect(body.error.message).toContain("no account or budget");
    expect(body.error.request_id).toBeTruthy();
  });

  it("counts every method on one allowance", async () => {
    const a = await build();
    expect(await statuses(a, LIMIT)).toEqual([200, 200, 200]);
    expect((await a.inject({ method: "POST", url: "/write" })).statusCode).toBe(429);
  });

  it("is counted per address, from cf-connecting-ip", async () => {
    const a = await build();
    expect(await statuses(a, LIMIT + 1, { "cf-connecting-ip": "203.0.113.1" })).toEqual([
      200, 200, 200, 429,
    ]);
    expect(await statuses(a, 1, { "cf-connecting-ip": "203.0.113.2" })).toEqual([200]);
  });

  it("is let through again when the minute has passed", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const a = await build();
    expect(await statuses(a, LIMIT + 1)).toEqual([200, 200, 200, 429]);
    vi.advanceTimersByTime(59_000);
    expect(await statuses(a, 1)).toEqual([429]);
    vi.advanceTimersByTime(1_000);
    expect(await statuses(a, 1)).toEqual([200]);
  });

  it("is not counted on a preflight or a health check", async () => {
    const a = await build();
    for (let i = 0; i < LIMIT + 2; i++) {
      expect((await a.inject({ method: "OPTIONS", url: "/read" })).statusCode).toBe(200);
      expect((await a.inject({ url: "/health" })).statusCode).toBe(200);
    }
    expect(await statuses(a, LIMIT)).toEqual([200, 200, 200]);
  });
});

describe("a request with a credential", () => {
  it("is exempt with an env key, and is not told a limit it is not under", async () => {
    const a = await build();
    const res = await a.inject({ url: "/read", headers: { "x-api-key": "env-service-key" } });
    expect(res.headers["ratelimit-policy"]).toBeUndefined();
    expect(await statuses(a, LIMIT + 3, { "x-api-key": "env-service-key" })).not.toContain(429);
    expect(mocks.resolveApiKey).not.toHaveBeenCalled();
  });

  it("is exempt with a live API key, looked up once and remembered", async () => {
    const a = await build();
    mocks.resolveApiKey.mockResolvedValue({ key: { id: "k1" }, user: { id: "u1" } });
    expect(await statuses(a, LIMIT + 3, { "x-api-key": "epk_live" })).not.toContain(429);
    expect(mocks.resolveApiKey).toHaveBeenCalledTimes(1);
  });

  it("is exempt with a live OAuth token", async () => {
    const a = await build();
    mocks.resolveAccessToken.mockResolvedValue({ token: {}, user: { id: "u1" } });
    expect(
      await statuses(a, LIMIT + 3, { authorization: "Bearer eoat_live" })
    ).not.toContain(429);
  });

  it("is exempt with the operator key", async () => {
    const a = await build();
    expect(
      await statuses(a, LIMIT + 3, { "x-operator-key": "operator-secret" })
    ).not.toContain(429);
  });

  it("is counted like no key when the key is made up", async () => {
    const a = await build();
    expect(await statuses(a, LIMIT + 1, { "x-api-key": "epk_made_up" })).toEqual([
      200, 200, 200, 429,
    ]);
    // Refused before any further lookup: the limit bounds the lookups too.
    expect(mocks.resolveApiKey).toHaveBeenCalledTimes(LIMIT + 1);
    // And it shares the anonymous allowance of its address.
    expect(await statuses(a, 1)).toEqual([429]);
  });

  it("is counted when only a header that proves nothing is sent", async () => {
    const a = await build();
    for (const headers of [
      { "x-acting-user": "github:1" },
      { cookie: "session=1" },
      { authorization: "Basic abc" },
      { "x-minerval-mcp-dispatch": "not-a-live-nonce" },
      { "x-operator-key": "wrong" },
    ]) {
      const fresh = await build();
      expect(await statuses(fresh, LIMIT + 1, headers), JSON.stringify(headers)).toEqual([
        200, 200, 200, 429,
      ]);
      await fresh.close();
    }
    await a.close();
  });

  it("is counted when the key lookup fails", async () => {
    const a = await build();
    mocks.resolveApiKey.mockRejectedValue(new Error("db down"));
    expect(await statuses(a, LIMIT + 1, { "x-api-key": "epk_live" })).toEqual([
      200, 200, 200, 429,
    ]);
  });
});

describe("an in-process MCP dispatch", () => {
  it("is exempt while its nonce is in flight", async () => {
    const a = await build();
    const { dispatchToRoute } = await import("../../../src/mcp/dispatch.js");
    const auth = {
      method: "api_key" as const,
      userId: "u1",
      apiKeyId: "k1",
      contributorExternalId: "github:1",
      isService: false,
      isSession: false,
    };
    for (let i = 0; i < LIMIT + 3; i++) {
      const res = await dispatchToRoute(a, auth, { method: "GET", url: "/read" });
      expect(res.statusCode).toBe(200);
    }
  });
});

describe("keyless local development", () => {
  it("is not counted: every caller is the dev account", async () => {
    const a = await build({ API_KEYS: "", ENVIRONMENT: "development" });
    const res = await a.inject({ url: "/read" });
    expect(res.headers["ratelimit-policy"]).toBeUndefined();
    expect(await statuses(a, LIMIT + 3)).not.toContain(429);
  });

  it("is still not counted when the deployment says it is open in so many words", async () => {
    const a = await build({ API_KEYS: "", ENVIRONMENT: "development", READS: "open" });
    expect(await statuses(a, LIMIT + 3, { "x-api-key": "made-up" })).not.toContain(429);
    expect(await statuses(a, LIMIT + 3)).not.toContain(429);
  });
});

// A members-only deployment has no dev account (src/permissions.ts), so the
// keyless case does not exist there: with no key configured, outside
// production, a caller with no key or a made-up one is counted all the same.
describe("a members-only deployment with no key configured", () => {
  const KEYLESS = { API_KEYS: "", ENVIRONMENT: "development", READS: "members" };

  it("counts a request with no credential", async () => {
    const a = await build(KEYLESS);
    const first = await a.inject({ url: "/read" });
    expect(first.headers["ratelimit-policy"]).toBe(`${LIMIT};w=60`);
    expect(await statuses(a, LIMIT)).toEqual([200, 200, 429]);
  });

  it("counts a made-up key like no key at all", async () => {
    const a = await build(KEYLESS);
    const headers = { "x-api-key": "made-up" };
    expect(await statuses(a, LIMIT + 1, headers)).toEqual([200, 200, 200, 429]);
    const refused = await a.inject({ url: "/read", headers });
    expect(refused.json().error.code).toBe("ANONYMOUS_RATE_LIMITED");
  });

  it("still exempts a live key and the operator key", async () => {
    const a = await build(KEYLESS);
    mocks.resolveApiKey.mockResolvedValue({ user: { id: "u1" }, key: { id: "k1" } });
    expect(await statuses(a, LIMIT + 2, { "x-api-key": "epk_live" })).not.toContain(429);
    expect(await statuses(a, LIMIT + 2, { "x-operator-key": "operator-secret" })).not.toContain(429);
  });
});
