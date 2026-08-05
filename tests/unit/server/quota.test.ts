import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import type { RequestAuth } from "../../../src/server/plugins/auth.js";

function entitlement(owlBalance: number, creditsEnabled = false) {
  return {
    owlBalance,
    owlBalanceMicroUsd: owlBalance * 4_000_000,
    owlPriceMicroUsd: 4_000_000,
    pricesOwls: {
      claim_proposal: 1,
      assessment: 1,
      source_ingest: 0.1,
      extension_analysis: 0.1,
      extension_chat: 0.1,
      text_analysis: 0.1,
    },
    creditsEnabled,
    signupGrantOwls: 5,
    monthlyGrantOwls: 1,
  };
}

const mocks = vi.hoisted(() => ({
  checkSpend: vi.fn(),
  getEntitlement: vi.fn(),
  chargeOwls: vi.fn(async () => ({ charged: true, entryId: "entry-1" })),
  refundOwls: vi.fn(async () => {}),
}));

vi.mock("../../../src/services/billing-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/services/billing-service.js")>();
  return {
    serializeEntitlement: actual.serializeEntitlement,
    serializeOwlPacks: () => [],
    checkSpend: mocks.checkSpend,
    getEntitlement: mocks.getEntitlement,
  };
});
vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  chargeOwls: mocks.chargeOwls,
  refundOwls: mocks.refundOwls,
}));

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
    { preHandler: app.requireAgenticQuota("claim_proposal") },
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

describe("agentic quota guard (owl economy)", () => {
  let savedLimit: string | undefined;
  beforeEach(() => {
    savedLimit = process.env.AGENTIC_RATE_LIMIT_PER_HOUR;
    mocks.checkSpend.mockReset().mockResolvedValue({
      allowed: true,
      priceOwls: 1,
      entitlement: entitlement(5),
    });
    mocks.getEntitlement.mockReset().mockResolvedValue(entitlement(0));
    mocks.chargeOwls
      .mockReset()
      .mockResolvedValue({ charged: true, entryId: "entry-1" });
    mocks.refundOwls.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    if (savedLimit === undefined) delete process.env.AGENTIC_RATE_LIMIT_PER_HOUR;
    else process.env.AGENTIC_RATE_LIMIT_PER_HOUR = savedLimit;
  });

  it("allows a user whose balance covers the price", async () => {
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(200);
    expect(mocks.checkSpend).toHaveBeenCalledWith("user-1", "claim_proposal");
  });

  it("returns 402 INSUFFICIENT_OWLS when the balance can't cover the price", async () => {
    mocks.checkSpend.mockResolvedValue({
      allowed: false,
      priceOwls: 1,
      entitlement: entitlement(0),
    });
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(402);
    expect(res.json().code).toBe("INSUFFICIENT_OWLS");
    expect(res.json().price_owls).toBe(1);
    expect(res.json().entitlement.owl_balance).toBe(0);
    expect(res.json().error).toContain("not enabled");
  });

  it("points the 402 at buying owls when billing is enabled", async () => {
    mocks.checkSpend.mockResolvedValue({
      allowed: false,
      priceOwls: 1,
      entitlement: entitlement(0, true),
    });
    const app = await buildTestApp(userAuth);
    const res = await app.inject({ method: "POST", url: "/agentic" });
    expect(res.statusCode).toBe(402);
    expect(res.json().error).toContain("/account");
    expect(res.json().entitlement.credits_enabled).toBe(true);
  });

  it("exempts service traffic with no acting user from pricing", async () => {
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

describe("charge-at-start helpers", () => {
  beforeEach(() => {
    mocks.getEntitlement.mockReset().mockResolvedValue(entitlement(0));
    mocks.chargeOwls
      .mockReset()
      .mockResolvedValue({ charged: true, entryId: "entry-1" });
    mocks.refundOwls.mockReset().mockResolvedValue(undefined);
  });

  async function loadQuota() {
    vi.resetModules();
    return import("../../../src/server/plugins/quota.js");
  }

  it("chargeAgenticOp writes the debit and returns the entry id", async () => {
    const { chargeAgenticOp } = await loadQuota();
    const result = await chargeAgenticOp(
      { userId: "user-1", apiKeyId: null, method: "api_key" },
      "claim_proposal",
      { claimId: "claim-9" }
    );
    expect(result.allowed).toBe(true);
    expect(result.entryId).toBe("entry-1");
    expect(mocks.chargeOwls).toHaveBeenCalledWith({
      userId: "user-1",
      priceOwls: 1,
      op: "claim_proposal",
      claimId: "claim-9",
      contributionId: null,
    });
  });

  it("chargeAgenticOp turns a lost check-then-charge race into a 402 decision", async () => {
    mocks.chargeOwls.mockResolvedValue({ charged: false, entryId: null });
    const { chargeAgenticOp } = await loadQuota();
    const result = await chargeAgenticOp(
      { userId: "user-1", apiKeyId: null, method: "api_key" },
      "claim_proposal"
    );
    expect(result.allowed).toBe(false);
    expect(result.statusCode).toBe(402);
    expect(result.code).toBe("INSUFFICIENT_OWLS");
  });

  it("chargeAgenticOp lets system work through without charging", async () => {
    const { chargeAgenticOp } = await loadQuota();
    const result = await chargeAgenticOp(
      { userId: null, apiKeyId: null, method: "env_key" },
      "claim_proposal"
    );
    expect(result.allowed).toBe(true);
    expect(mocks.chargeOwls).not.toHaveBeenCalled();
  });

  it("withAgenticCharge refunds when the work throws", async () => {
    const { withAgenticCharge } = await loadQuota();
    await expect(
      withAgenticCharge(
        { userId: "user-1", apiKeyId: null, method: "api_key" },
        "extension_chat",
        {},
        async () => {
          throw new Error("provider outage");
        }
      )
    ).rejects.toThrow("provider outage");
    expect(mocks.refundOwls).toHaveBeenCalledWith({
      userId: "user-1",
      priceOwls: 0.1,
      op: "extension_chat",
      claimId: null,
      contributionId: null,
    });
  });

  it("withAgenticCharge returns the work's value on success without refunding", async () => {
    const { withAgenticCharge } = await loadQuota();
    const run = await withAgenticCharge(
      { userId: "user-1", apiKeyId: null, method: "api_key" },
      "extension_chat",
      {},
      async () => "result"
    );
    expect(run).toEqual({ ok: true, value: "result" });
    expect(mocks.refundOwls).not.toHaveBeenCalled();
  });
});
