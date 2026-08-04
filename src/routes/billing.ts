/**
 * Billing routes (#309): buying usage credits with Stripe Checkout.
 *
 *   POST /billing/checkout — dashboard-only (requireSession, like key
 *     minting): start a Checkout Session for a credit purchase and return the
 *     Stripe-hosted payment URL. A leaked consumer key can read balances but
 *     never initiate payment flows.
 *   POST /billing/webhook  — Stripe's server-to-server callback. Unauthenti-
 *     cated by design; trust comes from the signature check against
 *     STRIPE_WEBHOOK_SECRET over the RAW request body. Credits the ledger
 *     idempotently (unique checkout-session id), so Stripe's retries and
 *     duplicate success events are safe.
 *   GET  /billing/ledger   — the acting user's credit history.
 *
 * Invoices/receipts stay on Stripe-hosted surfaces (Checkout emails a receipt
 * when configured) — deliberately no invoice code here.
 */
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { loadConfig } from "../config.js";
import { stripeConfigured } from "../services/billing-service.js";
import {
  createCreditCheckoutSession,
  verifyWebhookEvent,
} from "../services/stripe-service.js";
import { grantCredits, listCreditLedger } from "../services/credit-service.js";
import { getContributorById } from "../services/contributor-service.js";

/** Credit a paid Checkout Session to its buyer's ledger. Idempotent. */
async function creditCheckoutSession(
  app: FastifyInstance,
  event: Stripe.Event,
  session: Stripe.Checkout.Session
): Promise<void> {
  // Two success events can describe one purchase (card payments complete
  // synchronously; delayed methods complete later) — both funnel here and the
  // session-id uniqueness makes the second a no-op.
  if (session.payment_status !== "paid") return;
  const userId = session.metadata?.user_id ?? session.client_reference_id;
  if (!userId) {
    app.log.error(
      { sessionId: session.id },
      "stripe checkout session has no user attribution; not crediting"
    );
    return;
  }
  const amountCents = session.amount_total ?? 0;
  if (amountCents <= 0) return;
  const credited = await grantCredits({
    userId,
    // cents → micro-USD
    amountMicroUsd: amountCents * 10_000,
    reason: "purchase",
    stripeEventId: event.id,
    stripeCheckoutSessionId: session.id,
  });
  app.log.info(
    { userId, sessionId: session.id, amountCents, credited },
    credited ? "credited stripe purchase" : "duplicate stripe delivery ignored"
  );
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // POST /billing/checkout — returns the Stripe-hosted payment page URL.
  app.post("/checkout", {
    schema: {
      tags: ["billing"],
      summary: "Start a Stripe Checkout session for a credit purchase",
      body: {
        type: "object",
        required: ["amount_usd"],
        properties: {
          amount_usd: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      const config = loadConfig();
      if (!stripeConfigured()) {
        return reply.code(503).send({
          error: "Credit purchases are not enabled on this deployment",
          code: "BILLING_NOT_CONFIGURED",
        });
      }
      const { amount_usd } = request.body as { amount_usd: number };
      if (
        amount_usd < config.creditPurchaseMinUsd ||
        amount_usd > config.creditPurchaseMaxUsd
      ) {
        return reply.code(400).send({
          error:
            `Credit purchases must be between $${config.creditPurchaseMinUsd} ` +
            `and $${config.creditPurchaseMaxUsd}`,
          code: "AMOUNT_OUT_OF_RANGE",
        });
      }
      const userId = request.auth!.userId!;
      const user = await getContributorById(userId);
      const session = await createCreditCheckoutSession({
        userId,
        amountUsd: amount_usd,
        email: user?.email ?? null,
      });
      return reply.send({
        checkout_url: session.url,
        session_id: session.sessionId,
      });
    },
  });

  // GET /billing/ledger — credit history for the dashboard.
  app.get("/ledger", {
    schema: {
      tags: ["billing"],
      summary: "List the authenticated user's credit grants",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const entries = await listCreditLedger(request.auth!.userId!);
      return reply.send({
        entries: entries.map((e) => ({
          id: e.id,
          amount_micro_usd: e.amountMicroUsd,
          reason: e.reason,
          created_at: e.createdAt?.toISOString(),
        })),
      });
    },
  });

  // POST /billing/webhook — in its own scope so the raw-body content-type
  // parser (required for signature verification) applies to nothing else.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => done(null, body)
    );

    scope.post("/webhook", {
      schema: {
        tags: ["billing"],
        summary: "Stripe webhook receiver (signature-verified)",
      },
      handler: async (request, reply) => {
        const signature = request.headers["stripe-signature"];
        if (typeof signature !== "string") {
          return reply
            .code(400)
            .send({ error: "Missing stripe-signature header" });
        }
        let event: Stripe.Event;
        try {
          event = verifyWebhookEvent(request.body as Buffer, signature);
        } catch (err) {
          request.log.warn(
            { err: err instanceof Error ? err.message : err },
            "rejected stripe webhook"
          );
          return reply.code(400).send({ error: "Invalid webhook signature" });
        }

        switch (event.type) {
          case "checkout.session.completed":
          case "checkout.session.async_payment_succeeded":
            await creditCheckoutSession(
              app,
              event,
              event.data.object as Stripe.Checkout.Session
            );
            break;
          default:
            // Acknowledge everything else — Stripe sends whatever the
            // endpoint is subscribed to, and unhandled types are not errors.
            break;
        }
        return reply.send({ received: true });
      },
    });
  });
}
