/**
 * Stripe client wrapper (#309). The ONLY module that talks to Stripe.
 *
 * Scope is deliberately small: sell prepaid usage credits via Stripe Checkout
 * (dynamic amount, one-off payment) and verify webhook signatures. Invoices,
 * receipts, and payment-method management stay on Stripe-hosted surfaces;
 * subscriptions/metered-billing plans can layer on later without touching the
 * credit ledger this feeds.
 */
import Stripe from "stripe";
import { loadConfig } from "../config.js";

let _stripe: Stripe | null = null;

function getStripe(): Stripe {
  if (!_stripe) {
    const key = loadConfig().stripeSecretKey;
    if (!key) throw new Error("STRIPE_SECRET_KEY is not configured");
    _stripe = new Stripe(key);
  }
  return _stripe;
}

/** Test hook. */
export function setStripeClient(client: Stripe | null): void {
  _stripe = client as Stripe | null;
}

export interface CheckoutSessionResult {
  /** Stripe-hosted payment page to redirect the buyer to. */
  url: string;
  sessionId: string;
}

/**
 * Create a Checkout Session for a one-off credit purchase. The user identity
 * rides in metadata + client_reference_id so the webhook can credit the right
 * ledger without any state on our side.
 */
export async function createCreditCheckoutSession(input: {
  userId: string;
  amountUsd: number;
  email?: string | null;
}): Promise<CheckoutSessionResult> {
  const config = loadConfig();
  const accountUrl = `${config.publicWebBaseUrl}/account`;
  const session = await getStripe().checkout.sessions.create({
    mode: "payment",
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "usd",
          unit_amount: Math.round(input.amountUsd * 100),
          product_data: {
            name: "Minerval API credits",
            description:
              "Prepaid credits for LLM-backed Minerval API usage. " +
              "Drawn down per request in proportion to the model work " +
              "involved; no expiry.",
          },
        },
      },
    ],
    metadata: { user_id: input.userId },
    client_reference_id: input.userId,
    ...(input.email ? { customer_email: input.email } : {}),
    success_url: `${accountUrl}?purchase=success`,
    cancel_url: `${accountUrl}?purchase=cancelled`,
  });
  if (!session.url) {
    throw new Error("Stripe returned a Checkout Session without a URL");
  }
  return { url: session.url, sessionId: session.id };
}

/**
 * Verify a webhook delivery's signature against STRIPE_WEBHOOK_SECRET and
 * parse it. Throws on a missing secret, bad signature, or stale timestamp —
 * the route turns that into a 400.
 */
export function verifyWebhookEvent(
  rawBody: Buffer | string,
  signatureHeader: string
): Stripe.Event {
  const secret = loadConfig().stripeWebhookSecret;
  if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET is not configured");
  return Stripe.webhooks.constructEvent(rawBody, signatureHeader, secret);
}
