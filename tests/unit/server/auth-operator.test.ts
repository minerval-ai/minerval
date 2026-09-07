/**
 * requireOperator (docs/mathematics.md §8.11): the operator key is its own
 * credential, presented as x-operator-key, compared in constant time,
 * closed when unset, and independent of the service key.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import Fastify from "fastify";

vi.mock("../../../src/services/api-key-service.js", () => ({ resolveApiKey: vi.fn(async () => null) }));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorByExternalId: vi.fn(async () => null),
  getOrCreateContributor: vi.fn(async () => ({ id: "dev", externalId: "dev:local", displayName: "dev", isSuspended: false })),
}));

async function buildApp(operatorKey: string | undefined) {
  if (operatorKey === undefined) delete process.env.MINERVAL_OPERATOR_KEY;
  else process.env.MINERVAL_OPERATOR_KEY = operatorKey;
  process.env.API_KEYS = "service-key";
  vi.resetModules();
  const { registerAuth } = await import("../../../src/server/plugins/auth.js");
  const app = Fastify();
  await registerAuth(app);
  app.post("/money", { preHandler: [app.requireOperator] }, async () => ({ ok: true }));
  return app;
}

afterEach(() => {
  delete process.env.MINERVAL_OPERATOR_KEY;
  delete process.env.API_KEYS;
});

describe("requireOperator", () => {
  it("passes the configured key and refuses a wrong or missing one with OPERATOR_KEY_REQUIRED", async () => {
    const app = await buildApp("op-secret-key");
    expect((await app.inject({ method: "POST", url: "/money", headers: { "x-operator-key": "op-secret-key" } })).statusCode).toBe(200);
    const wrong = await app.inject({ method: "POST", url: "/money", headers: { "x-operator-key": "op-secret-kex" } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toMatchObject({ code: "OPERATOR_KEY_REQUIRED" });
    expect((await app.inject({ method: "POST", url: "/money" })).statusCode).toBe(403);
    // The service key is not the operator key (§8.11): it moves no money.
    expect((await app.inject({ method: "POST", url: "/money", headers: { "x-api-key": "service-key" } })).statusCode).toBe(403);
    await app.close();
  });

  it("is closed when no operator key is configured, whatever is presented", async () => {
    const app = await buildApp(undefined);
    expect((await app.inject({ method: "POST", url: "/money", headers: { "x-operator-key": "" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/money", headers: { "x-operator-key": "anything" } })).statusCode).toBe(403);
    await app.close();
  });

  it("operatorKeyMatches compares in constant time and never matches an empty configuration", async () => {
    const { operatorKeyMatches } = await import("../../../src/server/plugins/auth.js");
    expect(operatorKeyMatches("abc", "abc")).toBe(true);
    expect(operatorKeyMatches("abc", "abd")).toBe(false);
    expect(operatorKeyMatches("abc", "ab")).toBe(false);
    expect(operatorKeyMatches("", "")).toBe(false);
    expect(operatorKeyMatches("", "x")).toBe(false);
    expect(operatorKeyMatches("abc", undefined)).toBe(false);
  });
});
