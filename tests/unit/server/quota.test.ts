import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

const mocks = vi.hoisted(() => ({
  checkSpend: vi.fn(async (_userId: string) => ({
    allowed: true,
    entitlement: {
      plan: "free" as const,
      monthlyGrantMicroUsd: 5_000_000,
      usedMicroUsd: 0,
      remainingMicroUsd: 5_000_000,
      creditBalanceMicroUsd: 0,
      creditsEnabled: false,
    },
  })),
}));

vi.mock("../../../src/services/billing-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/services/billing-service.js")>();
  return {
    serializeEntitlement: actual.serializeEntitlement,
    getBillingProvider: () => ({
      checkSpend: mocks.checkSpend,
      getEntitlement: vi.fn(),
    }),
  };
});

async function buildTestApp(auth: RequestAuth | null, rateLimit?: number) {
  if (rateLimit === undefined) delete process.env.AGENTIC_RATE_LIMIT_PER_HOUR;
  else process.env.AGENTIC_RATE_LIMIT_PER_HOUR = String(rateLimit);
  vi.resetModules();
  const { registerQuota, resetRateLimiter } = await import(
    "../../../src/server/plugins/quota.js"
  );
  resetRateLimiter();

  const app = Fastify();
  // Stand-in for the auth plugin: inject a fixed identity.
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    request.auth = auth;
  });
  await registerQuota(app);
  app.post(
    "/agentic",
    { preHandler: app.requireAgenticQuota },
    async () => ({ ok: true })
  );
  return app;
}

const userAuth: RequestAuth = {
  method: "api_key",
  userId: "user-1",
  apiKeyId: "key-1",
  contributorExternalId: "github:1",
  isService: false,
  isSession: false,
};

describe("agentic quota guard", () => {
  let savedLimit: string | undefined;
  beforeEach(() => {
    savedLimit = process.env.AGENTIC_RATE_LIMIT_PER_HOUR;
    mocks.checkSpend.mockReset().mockResolvedValue({
      allowed: true,
      entitlement: {
        plan: "free",
        monthlyGrantMicroUsd: 5_000_000,
        usedMicroUsd: 0,
        remainingMicroUsd: 5_000_000,
        creditBalanceMicroUsd: 0,
        creditsEnabled: false,
      },
    });
  });
  afterEach(() => {
    if (savedLimit === undefined) delete process.env.AGENTIC_RATE_LIMIT_PER_HOUR;
    else process.env.AGENTIC_RATE_LIMIT_PER_HOUR = savedLimit;
  });

  it("allows a user with remaining grant", async () => {
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(200);
    expect(mocks.checkSpend).toHaveBeenCalledWith("user-1");
  });

  it("returns 402 QUOTA_EXCEEDED when the monthly grant is exhausted", async () => {
    mocks.checkSpend.mockResolvedValue({
      allowed: false,
      entitlement: {
        plan: "free",
        monthlyGrantMicroUsd: 5_000_000,
        usedMicroUsd: 5_100_000,
        remainingMicroUsd: 0,
        creditBalanceMicroUsd: 0,
        creditsEnabled: false,
      },
    });
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("QUOTA_EXCEEDED");
    expect(res.json().entitlement.remaining_micro_usd).toBe(0);
    expect(res.json().error).toContain("not yet available");
  });

  it("points the 402 at buying credits when billing is enabled (#309)", async () => {
    mocks.checkSpend.mockResolvedValue({
      allowed: false,
      entitlement: {
        plan: "free",
        monthlyGrantMicroUsd: 5_000_000,
        usedMicroUsd: 5_100_000,
        remainingMicroUsd: 0,
        creditBalanceMicroUsd: 0,
        creditsEnabled: true,
      },
    });
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("/account");
    expect(res.json().entitlement.credits_enabled).toBe(true);
  });

  it("exempts service traffic with no acting user from the grant", async () => {
    const app = await buildTestApp({
      method: "env_key",
      userId: null,
      apiKeyId: null,
      contributorExternalId: null,
      isService: true,
      isSession: false,
    });
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(200);
    expect(mocks.checkSpend).not.toHaveBeenCalled();
  });

  it("rate-limits per caller", async () => {
    const app = await buildTestApp(userAuth, 2);
    expect(
      (await app.inject({ method: "POST", url: "/agentic" })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/agentic" })).statusCode
    ).toBe(200);
    const third = await app.inject({ method: "POST", url: "/agentic" });
    expect(third.statusCode).toBe(429);
    expect(third.json().code).toBe("RATE_LIMITED");
  });
});
