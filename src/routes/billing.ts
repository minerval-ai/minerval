/**
 * Billing routes: buying owls with Stripe Checkout.
 *
 *   GET  /billing/packs    — the purchasable owl packs (public: prices are
 *     legible before sign-in, §15).
 *   POST /billing/checkout — dashboard-only (requireSession, like key
 *     minting): start a Checkout Session for an owl pack and return the
 *     Stripe-hosted payment URL. A leaked consumer key can read balances but
 *     never initiate payment flows.
 *   POST /billing/webhook  — Stripe's server-to-server callback. Unauthenti-
 *     cated by design; trust comes from the signature check against
 *     STRIPE_WEBHOOK_SECRET over the RAW request body. Credits the ledger
 *     idempotently (unique idempotency key per checkout session), so
 *     Stripe's retries and duplicate success events are safe.
 *   GET  /billing/ledger   — the acting user's owl history.
 *
 * The webhook credits the pack's FACE value (owls × owl price), not the
 * discounted cash amount — the bulk discount is cheaper cash for the same
 * owls, not fewer owls.
 *
 * Invoices/receipts stay on Stripe-hosted surfaces (Checkout emails a receipt
 * when configured) — deliberately no invoice code here.
 */
import type { FastifyInstance } from "fastify";
import type Stripe from "stripe";
import { stripeConfigured } from "../services/billing-service.js";
import {
  createOwlPackCheckoutSession,
  verifyWebhookEvent,
} from "../services/stripe-service.js";
import {
  listOwlLedger,
  recordOwlEntry,
  OWL_REASONS,
} from "../services/owl-ledger-service.js";
import { getOwlPack, owlPacks, owlsToMicroUsd } from "../services/owl.js";
import { getContributorById } from "../services/contributor-service.js";

/** Credit a paid Checkout Session to its buyer's ledger. Idempotent. */
async function creditCheckoutSession(
  app: FastifyInstance,
  event: Stripe.Event,
  session: Stripe.Checkout.Session
): Promise<void> {
  // Two success events can describe one purchase (card payments complete
  // synchronously; delayed methods complete later) — both funnel here and
  // the idempotency key makes the second a no-op.
  if (session.payment_status !== "paid") return;
  const userId = session.metadata?.user_id ?? session.client_reference_id;
  if (!userId) {
    app.log.error(
      { sessionId: session.id },
      "stripe checkout session has no user attribution; not crediting"
    );
    return;
  }
  const owls = Number(session.metadata?.owls ?? 0);
  if (!Number.isFinite(owls) || owls <= 0) {
    app.log.error(
      { sessionId: session.id },
      "stripe checkout session has no owl count in metadata; not crediting"
    );
    return;
  }
  const credited = await recordOwlEntry({
    userId,
    amountMicroUsd: owlsToMicroUsd(owls),
    reason: OWL_REASONS.purchase,
    idempotencyKey: `stripe:${session.id}`,
    stripeEventId: event.id,
  });
  app.log.info(
    { userId, sessionId: session.id, owls, credited },
    credited ? "credited owl purchase" : "duplicate stripe delivery ignored"
  );
}

export async function billingRoutes(app: FastifyInstance): Promise<void> {
  // GET /billing/packs — what owls cost here. Public.
  app.get("/packs", {
    schema: {
      tags: ["billing"],
      summary: "List purchasable owl packs (with bulk discounts)",
    },
    handler: async (_request, reply) => {
      return reply.send({
        credits_enabled: stripeConfigured(),
        packs: owlPacks().map((p) => ({
          id: p.id,
          owls: p.owls,
          price_cents: p.priceCents,
          discount_percent: p.discountPercent,
        })),
      });
    },
  });

  // POST /billing/checkout — returns the Stripe-hosted payment page URL.
  app.post("/checkout", {
    schema: {
      tags: ["billing"],
      summary: "Start a Stripe Checkout session for an owl pack",
      body: {
        type: "object",
        required: ["pack_id"],
        properties: {
          pack_id: { type: "string", minLength: 1 },
        },
      },
    },
    preHandler: [app.authenticate, app.requireSession, app.requireUser],
    handler: async (request, reply) => {
      if (!stripeConfigured()) {
        return reply.code(503).send({
          error: "Owl purchases are not enabled on this deployment",
          code: "BILLING_NOT_CONFIGURED",
        });
      }
      const { pack_id } = request.body as { pack_id: string };
      const pack = getOwlPack(pack_id);
      if (!pack) {
        return reply.code(400).send({
          error: `Unknown owl pack: ${pack_id}. See GET /billing/packs.`,
          code: "UNKNOWN_PACK",
        });
      }
      const userId = request.auth!.userId!;
      const user = await getContributorById(userId);
      const session = await createOwlPackCheckoutSession({
        userId,
        pack,
        email: user?.email ?? null,
      });
      return reply.send({
        checkout_url: session.url,
        session_id: session.sessionId,
      });
    },
  });

  // GET /billing/ledger — owl history for the dashboard.
  app.get("/ledger", {
    schema: {
      tags: ["billing"],
      summary: "List the authenticated user's owl ledger entries",
    },
    preHandler: [app.authenticate, app.requireUser],
    handler: async (request, reply) => {
      const entries = await listOwlLedger(request.auth!.userId!);
      return reply.send({
        entries: entries.map((e) => ({
          id: e.id,
          amount_micro_usd: e.amountMicroUsd,
          reason: e.reason,
          op: e.op,
          claim_id: e.claimId,
          contribution_id: e.contributionId,
          job_id: e.jobId,
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
