import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  ensureFreeGrants: vi.fn(async () => {}),
  getOwlBalanceMicroUsd: vi.fn(async () => 0),
}));

vi.mock("../../../src/services/owl-ledger-service.js", () => ({
  ensureFreeGrants: mocks.ensureFreeGrants,
  getOwlBalanceMicroUsd: mocks.getOwlBalanceMicroUsd,
}));

// stripeConfigured keys off config (STRIPE_SECRET_KEY), and the config is
// cached at module level — so each scenario re-imports the service with
// fresh modules after setting the env.
async function loadBillingService(stripeKey: string | undefined) {
  if (stripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = stripeKey;
  vi.resetModules();
  return import("../../../src/services/billing-service.js");
}

describe("stripeConfigured", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.STRIPE_SECRET_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  });

  it("is off with no key and off for an infra placeholder secret", async () => {
    expect((await loadBillingService(undefined)).stripeConfigured()).toBe(
      false
    );
    expect(
      (await loadBillingService("Xq3vGeneratedPlaceholder")).stripeConfigured()
    ).toBe(false);
  });

  it("activates on a real-looking key and flips creditsEnabled + packs", async () => {
    const svc = await loadBillingService("sk_test_123");
    expect(svc.stripeConfigured()).toBe(true);
    const e = await svc.getEntitlement("u-1");
    expect(e.creditsEnabled).toBe(true);
    expect(svc.serializeOwlPacks().length).toBeGreaterThan(0);
  });

  it("hides packs when purchases are off", async () => {
    const svc = await loadBillingService(undefined);
    expect(svc.serializeOwlPacks()).toEqual([]);
  });
});

describe("entitlement & spend checks", () => {
  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    mocks.ensureFreeGrants.mockReset().mockResolvedValue(undefined);
    mocks.getOwlBalanceMicroUsd.mockReset().mockResolvedValue(0);
  });

  it("ensures the lazy free grants before reading the balance", async () => {
    mocks.getOwlBalanceMicroUsd.mockResolvedValue(20_000_000);
    const svc = await loadBillingService(undefined);
    const e = await svc.getEntitlement("u-1");
    expect(mocks.ensureFreeGrants).toHaveBeenCalledWith("u-1");
    expect(e.owlBalance).toBe(5);
    expect(e.owlBalanceMicroUsd).toBe(20_000_000);
    expect(e.pricesOwls.claim_proposal).toBe(1);
    expect(e.pricesOwls.source_ingest).toBe(0.1);
  });

  it("serializes the wire shape in owls", async () => {
    mocks.getOwlBalanceMicroUsd.mockResolvedValue(6_000_000);
    const svc = await loadBillingService(undefined);
    const wire = svc.serializeEntitlement(await svc.getEntitlement("u-1"));
    expect(wire.owl_balance).toBe(1.5);
    expect(wire.owl_price_micro_usd).toBe(4_000_000);
    expect(wire.prices_owls.assessment).toBe(1);
    expect(wire.credits_enabled).toBe(false);
    expect(wire.signup_grant_owls).toBe(5);
    expect(wire.monthly_grant_owls).toBe(1);
  });

  it("allows spend when the balance covers the op's price", async () => {
    mocks.getOwlBalanceMicroUsd.mockResolvedValue(4_000_000);
    const svc = await loadBillingService(undefined);
    const { allowed, priceOwls } = await svc.checkSpend("u-1", "assessment");
    expect(allowed).toBe(true);
    expect(priceOwls).toBe(1);
  });

  it("denies spend when the balance is below the price", async () => {
    mocks.getOwlBalanceMicroUsd.mockResolvedValue(200_000); // 0.05 owl
    const svc = await loadBillingService(undefined);
    expect((await svc.checkSpend("u-1", "assessment")).allowed).toBe(false);
    expect((await svc.checkSpend("u-1", "source_ingest")).allowed).toBe(false);
  });

  it("prices fractional ops against the same balance", async () => {
    mocks.getOwlBalanceMicroUsd.mockResolvedValue(400_000); // 0.1 owl
    const svc = await loadBillingService(undefined);
    expect((await svc.checkSpend("u-1", "source_ingest")).allowed).toBe(true);
    expect((await svc.checkSpend("u-1", "claim_proposal")).allowed).toBe(false);
  });
});
