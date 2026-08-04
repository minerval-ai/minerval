import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import Stripe from "stripe";

// Real signature verification: the webhook secret must be in config BEFORE
// anything calls loadConfig (config caches at module level).
const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const mocks = vi.hoisted(() => ({
  stripeConfigured: vi.fn(() => true),
  createCreditCheckoutSession: vi.fn(async () => ({
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    sessionId: "cs_test_1",
  })),
  grantCredits: vi.fn(async () => true),
  listCreditLedger: vi.fn(async () => []),
  getContributorById: vi.fn(async () => ({
    id: "u-1",
    email: "buyer@example.com",
  })),
}));

vi.mock("../../../src/services/billing-service.js", () => ({
  stripeConfigured: mocks.stripeConfigured,
}));
vi.mock("../../../src/services/stripe-service.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/services/stripe-service.js")>();
  return {
    ...actual,
    createCreditCheckoutSession: mocks.createCreditCheckoutSession,
  };
});
vi.mock("../../../src/services/credit-service.js", () => ({
  grantCredits: mocks.grantCredits,
  listCreditLedger: mocks.listCreditLedger,
}));
vi.mock("../../../src/services/contributor-service.js", () => ({
  getContributorById: mocks.getContributorById,
}));

import { billingRoutes } from "../../../src/routes/billing.js";

async function buildApp(userId: string | null = "u-1") {
  const app = Fastify();
  app.decorateRequest("auth", null);
  app.addHook("onRequest", async (request) => {
    (request as { auth: unknown }).auth = userId
      ? {
          method: "api_key",
          userId,
          apiKeyId: "key-1",
          contributorExternalId: "github:1",
          isService: true,
          isSession: true,
        }
      : null;
  });
  app.decorate("authenticate", async () => {});
  app.decorate("requireSession", async () => {});
  app.decorate("requireUser", async () => {});
  await app.register(billingRoutes, { prefix: "/billing" });
  return app;
}

function signedWebhook(event: Record<string, unknown>) {
  const payload = JSON.stringify(event);
  return {
    payload,
    signature: Stripe.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    }),
  };
}

function checkoutCompletedEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: "evt_1",
    type: "checkout.session.completed",
    data: {
      object: {
        id: "cs_test_1",
        payment_status: "paid",
        amount_total: 2000,
        metadata: { user_id: "u-1" },
        client_reference_id: null,
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  mocks.stripeConfigured.mockReset().mockReturnValue(true);
  mocks.createCreditCheckoutSession.mockClear();
  mocks.grantCredits.mockReset().mockResolvedValue(true);
  mocks.listCreditLedger.mockReset().mockResolvedValue([]);
  mocks.getContributorById
    .mockReset()
    .mockResolvedValue({ id: "u-1", email: "buyer@example.com" });
});

describe("POST /billing/checkout", () => {
  it("returns the Stripe-hosted checkout URL", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { amount_usd: 20 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    expect(mocks.createCreditCheckoutSession).toHaveBeenCalledWith({
      userId: "u-1",
      amountUsd: 20,
      email: "buyer@example.com",
    });
  });

  it("returns 503 when Stripe is not configured", async () => {
    mocks.stripeConfigured.mockReturnValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { amount_usd: 20 },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("rejects amounts outside the configured bounds", async () => {
    const app = await buildApp();
    for (const amount of [1, 10_000]) {
      const res = await app.inject({
        method: "POST",
        url: "/billing/checkout",
        payload: { amount_usd: amount },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().code).toBe("AMOUNT_OUT_OF_RANGE");
    }
    expect(mocks.createCreditCheckoutSession).not.toHaveBeenCalled();
  });
});

describe("POST /billing/webhook", () => {
  it("rejects a delivery with no signature", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      payload: checkoutCompletedEvent(),
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("rejects a delivery signed with the wrong secret", async () => {
    const app = await buildApp();
    const payload = JSON.stringify(checkoutCompletedEvent());
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: "whsec_wrong",
        }),
      },
      payload,
    });
    expect(res.statusCode).toBe(400);
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("credits a paid checkout session (cents → micro-USD)", async () => {
    const app = await buildApp();
    const { payload, signature } = signedWebhook(checkoutCompletedEvent());
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.grantCredits).toHaveBeenCalledWith({
      userId: "u-1",
      amountMicroUsd: 20_000_000,
      reason: "purchase",
      stripeEventId: "evt_1",
      stripeCheckoutSessionId: "cs_test_1",
    });
  });

  it("does not credit an unpaid (delayed-payment) session", async () => {
    const app = await buildApp();
    const { payload, signature } = signedWebhook(
      checkoutCompletedEvent({ payment_status: "unpaid" })
    );
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });

  it("acknowledges event types it does not handle", async () => {
    const app = await buildApp();
    const { payload, signature } = signedWebhook({
      id: "evt_2",
      type: "payment_intent.created",
      data: { object: {} },
    });
    const res = await app.inject({
      method: "POST",
      url: "/billing/webhook",
      headers: {
        "content-type": "application/json",
        "stripe-signature": signature,
      },
      payload,
    });
    expect(res.statusCode).toBe(200);
    expect(mocks.grantCredits).not.toHaveBeenCalled();
  });
});

describe("GET /billing/ledger", () => {
  it("serializes the user's credit history", async () => {
    mocks.listCreditLedger.mockResolvedValue([
      {
        id: "cl-1",
        amountMicroUsd: 20_000_000,
        reason: "purchase",
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/billing/ledger" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([
      {
        id: "cl-1",
        amount_micro_usd: 20_000_000,
        reason: "purchase",
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(mocks.listCreditLedger).toHaveBeenCalledWith("u-1");
  });
});
