import { describe, it, expect, vi, beforeEach } from "vitest";
import Fastify from "fastify";
import Stripe from "stripe";

// Real signature verification: the webhook secret must be in config BEFORE
// anything calls loadConfig (config caches at module level).
const WEBHOOK_SECRET = "whsec_test_secret";
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

const mocks = vi.hoisted(() => ({
  stripeConfigured: vi.fn(() => true),
  createOwlPackCheckoutSession: vi.fn(async () => ({
    url: "https://checkout.stripe.com/c/pay/cs_test_1",
    sessionId: "cs_test_1",
  })),
  recordOwlEntry: vi.fn(async () => true),
  listOwlLedger: vi.fn(async () => []),
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
    createOwlPackCheckoutSession: mocks.createOwlPackCheckoutSession,
  };
});
vi.mock("../../../src/services/owl-ledger-service.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../src/services/owl-ledger-service.js")
  >();
  return {
    ...actual,
    recordOwlEntry: mocks.recordOwlEntry,
    listOwlLedger: mocks.listOwlLedger,
  };
});
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
        metadata: { user_id: "u-1", owls: "5" },
        client_reference_id: null,
        ...overrides,
      },
    },
  };
}

beforeEach(() => {
  mocks.stripeConfigured.mockReset().mockReturnValue(true);
  mocks.createOwlPackCheckoutSession.mockClear();
  mocks.recordOwlEntry.mockReset().mockResolvedValue(true);
  mocks.listOwlLedger.mockReset().mockResolvedValue([]);
  mocks.getContributorById
    .mockReset()
    .mockResolvedValue({ id: "u-1", email: "buyer@example.com" });
});

describe("GET /billing/packs", () => {
  it("lists the configured packs with bulk discounts", async () => {
    const app = await buildApp(null);
    const res = await app.inject({ method: "GET", url: "/billing/packs" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.credits_enabled).toBe(true);
    // Defaults: Clutch 5/$20 (face value), then increasing discounts up
    // to Parliament (mandate-scale funding at half face).
    expect(body.packs[0]).toEqual({
      id: "owls_5",
      owls: 5,
      name: "Clutch",
      price_cents: 2000,
      discount_percent: 0,
    });
    expect(body.packs.map((p: { name: string }) => p.name)).toEqual([
      "Clutch",
      "Perch",
      "Wisdom",
      "Parliament",
    ]);
    expect(
      body.packs.map((p: { discount_percent: number }) => p.discount_percent)
    ).toEqual([0, 10, 25, 50]);
    const largest = body.packs[body.packs.length - 1];
    expect(largest.owls).toBe(500);
    expect(largest.price_cents).toBe(100_000); // $1,000 for $2,000 face
  });
});

describe("POST /billing/checkout", () => {
  it("returns the Stripe-hosted checkout URL for a pack", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { pack_id: "owls_5" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com/);
    expect(mocks.createOwlPackCheckoutSession).toHaveBeenCalledWith({
      userId: "u-1",
      pack: expect.objectContaining({ id: "owls_5", owls: 5 }),
      email: "buyer@example.com",
    });
  });

  it("returns 503 when Stripe is not configured", async () => {
    mocks.stripeConfigured.mockReturnValue(false);
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { pack_id: "owls_5" },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().code).toBe("BILLING_NOT_CONFIGURED");
  });

  it("rejects an unknown pack", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/billing/checkout",
      payload: { pack_id: "owls_7" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().code).toBe("UNKNOWN_PACK");
    expect(mocks.createOwlPackCheckoutSession).not.toHaveBeenCalled();
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
    expect(mocks.recordOwlEntry).not.toHaveBeenCalled();
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
    expect(mocks.recordOwlEntry).not.toHaveBeenCalled();
  });

  it("credits a paid checkout session with the pack's owls, idempotently", async () => {
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
    // 5 owls × $1 of spend each = 5,000,000 micro-USD of cost coverage,
    // regardless of the (possibly discounted) cash amount Stripe collected
    // — the margin lives in the purchase price, not in the balance.
    expect(mocks.recordOwlEntry).toHaveBeenCalledWith({
      userId: "u-1",
      amountMicroUsd: 5_000_000,
      reason: "purchase",
      idempotencyKey: "stripe:cs_test_1",
      stripeEventId: "evt_1",
    });
  });

  it("does not credit a session with no owl count in metadata", async () => {
    const app = await buildApp();
    const { payload, signature } = signedWebhook(
      checkoutCompletedEvent({ metadata: { user_id: "u-1" } })
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
    expect(mocks.recordOwlEntry).not.toHaveBeenCalled();
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
    expect(mocks.recordOwlEntry).not.toHaveBeenCalled();
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
    expect(mocks.recordOwlEntry).not.toHaveBeenCalled();
  });
});

describe("GET /billing/ledger", () => {
  it("serializes the user's owl history", async () => {
    mocks.listOwlLedger.mockResolvedValue([
      {
        id: "ol-1",
        amountMicroUsd: -4_000_000,
        reason: "charge",
        op: "claim_proposal",
        claimId: null,
        contributionId: "contrib-1",
        jobId: null,
        createdAt: new Date("2026-08-01T00:00:00Z"),
      },
    ]);
    const app = await buildApp();
    const res = await app.inject({ method: "GET", url: "/billing/ledger" });
    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([
      {
        id: "ol-1",
        amount_micro_usd: -4_000_000,
        reason: "charge",
        op: "claim_proposal",
        claim_id: null,
        contribution_id: "contrib-1",
        job_id: null,
        created_at: "2026-08-01T00:00:00.000Z",
      },
    ]);
    expect(mocks.listOwlLedger).toHaveBeenCalledWith("u-1");
  });
});
