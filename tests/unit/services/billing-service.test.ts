import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getMonthToDateCostMicroUsd: vi.fn(async () => 0),
  getCreditBalanceMicroUsd: vi.fn(async () => 0),
}));

vi.mock("../../../src/services/usage-service.js", () => ({
  getMonthToDateCostMicroUsd: mocks.getMonthToDateCostMicroUsd,
}));
vi.mock("../../../src/services/credit-service.js", () => ({
  getCreditBalanceMicroUsd: mocks.getCreditBalanceMicroUsd,
}));

// The provider swap keys off config (STRIPE_SECRET_KEY), and both the config
// and the provider are cached at module level — so each scenario re-imports
// the service with fresh modules after setting the env.
async function loadBillingService(stripeKey: string | undefined) {
  if (stripeKey === undefined) delete process.env.STRIPE_SECRET_KEY;
  else process.env.STRIPE_SECRET_KEY = stripeKey;
  vi.resetModules();
  return import("../../../src/services/billing-service.js");
}

describe("billing provider swap (#309)", () => {
  let savedKey: string | undefined;
  beforeEach(() => {
    savedKey = process.env.STRIPE_SECRET_KEY;
    mocks.getMonthToDateCostMicroUsd.mockReset().mockResolvedValue(0);
    mocks.getCreditBalanceMicroUsd.mockReset().mockResolvedValue(0);
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.STRIPE_SECRET_KEY;
    else process.env.STRIPE_SECRET_KEY = savedKey;
  });

  it("stays on the free tier when Stripe is unconfigured", async () => {
    const svc = await loadBillingService(undefined);
    expect(svc.stripeConfigured()).toBe(false);
    const e = await svc.getBillingProvider().getEntitlement("u-1");
    expect(e.creditsEnabled).toBe(false);
    expect(e.creditBalanceMicroUsd).toBe(0);
    expect(mocks.getCreditBalanceMicroUsd).not.toHaveBeenCalled();
  });

  it("treats an infra placeholder secret as unconfigured", async () => {
    const svc = await loadBillingService("Xq3vGeneratedPlaceholder");
    expect(svc.stripeConfigured()).toBe(false);
    const e = await svc.getBillingProvider().getEntitlement("u-1");
    expect(e.creditsEnabled).toBe(false);
  });

  it("activates the Stripe provider on a real-looking key", async () => {
    const svc = await loadBillingService("sk_test_123");
    expect(svc.stripeConfigured()).toBe(true);
    mocks.getCreditBalanceMicroUsd.mockResolvedValue(3_000_000);
    const e = await svc.getBillingProvider().getEntitlement("u-1");
    expect(e.creditsEnabled).toBe(true);
    expect(e.creditBalanceMicroUsd).toBe(3_000_000);
    expect(e.plan).toBe("credits");
  });
});

describe("StripeBillingProvider spend checks", () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = "sk_test_123";
    mocks.getMonthToDateCostMicroUsd.mockReset();
    mocks.getCreditBalanceMicroUsd.mockReset();
  });
  afterEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  async function provider() {
    vi.resetModules();
    const svc = await import("../../../src/services/billing-service.js");
    return svc.getBillingProvider();
  }

  it("allows spend on the free grant even with zero credits", async () => {
    mocks.getMonthToDateCostMicroUsd.mockResolvedValue(1_000_000);
    mocks.getCreditBalanceMicroUsd.mockResolvedValue(0);
    const { allowed, entitlement } = await (await provider()).checkSpend("u-1");
    expect(allowed).toBe(true);
    expect(entitlement.plan).toBe("free");
  });

  it("allows spend on credits after the free grant is exhausted", async () => {
    mocks.getMonthToDateCostMicroUsd.mockResolvedValue(6_000_000);
    mocks.getCreditBalanceMicroUsd.mockResolvedValue(2_500_000);
    const { allowed, entitlement } = await (await provider()).checkSpend("u-1");
    expect(allowed).toBe(true);
    expect(entitlement.remainingMicroUsd).toBe(0);
    expect(entitlement.creditBalanceMicroUsd).toBe(2_500_000);
  });

  it("denies spend when both the grant and credits are exhausted", async () => {
    mocks.getMonthToDateCostMicroUsd.mockResolvedValue(6_000_000);
    mocks.getCreditBalanceMicroUsd.mockResolvedValue(0);
    const { allowed } = await (await provider()).checkSpend("u-1");
    expect(allowed).toBe(false);
  });
});
