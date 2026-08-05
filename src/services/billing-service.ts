/**
 * Billing service — the owl economy's entitlement surface.
 *
 * The bill is the owl ledger (src/services/owl-ledger-service.ts): every
 * agentic operation has a flat owl price (src/services/owl.ts) charged as an
 * explicit debit at the quota gate, and balance = SUM(ledger). llm_usage
 * metering continues underneath as internal cost observability — it is no
 * longer what the user owes.
 *
 * Free-vs-priced boundary (also documented in docs/accounts.md):
 *   - Non-agentic reads (claim lookup, search, trees) are free and generous —
 *     they never touch this service.
 *   - Agentic surfaces (claim proposal, source ingestion, extension, MCP
 *     text tools) charge their flat price from the owl balance.
 *   - Contribution review costs are system overhead, not user spend: good-
 *     faith contribution stays free (#71) — and accepted contributions EARN
 *     owls (contribution-award-service).
 *
 * Whether owls can be PURCHASED depends on Stripe being configured; the free
 * signup/monthly grants work either way.
 */
import { loadConfig } from "../config.js";
import {
  ensureFreeGrants,
  getOwlBalanceMicroUsd,
} from "./owl-ledger-service.js";
import {
  microUsdToOwls,
  owlPacks,
  priceListOwls,
  priceOwls,
  type PricedOp,
} from "./owl.js";

/**
 * Is paid billing switched on for this deployment? True only when the secret
 * looks like an actual Stripe key — infra provisions placeholder secrets
 * before they're populated (like the Elicit key), and a placeholder must NOT
 * flip the API into advertising purchases that would fail.
 */
export function stripeConfigured(): boolean {
  return loadConfig().stripeSecretKey.startsWith("sk_");
}

export interface Entitlement {
  /** Spendable balance in owls (fractional) and its exact micro-USD value. */
  owlBalance: number;
  owlBalanceMicroUsd: number;
  /** Face value of one owl in micro-USD (the price-list denominator). */
  owlPriceMicroUsd: number;
  /** The flat price list, in owls — legible before anything is spent (§15). */
  pricesOwls: Record<PricedOp, number>;
  /** Whether this deployment can sell owls (drives the 402 message + UI). */
  creditsEnabled: boolean;
  signupGrantOwls: number;
  monthlyGrantOwls: number;
}

/** The wire shape (snake_case) shared by /users/me, /usage, and 402 bodies. */
export function serializeEntitlement(e: Entitlement) {
  return {
    owl_balance: e.owlBalance,
    owl_balance_micro_usd: e.owlBalanceMicroUsd,
    owl_price_micro_usd: e.owlPriceMicroUsd,
    prices_owls: e.pricesOwls,
    credits_enabled: e.creditsEnabled,
    signup_grant_owls: e.signupGrantOwls,
    monthly_grant_owls: e.monthlyGrantOwls,
  };
}

/**
 * The user's current entitlement. Ensures the free grants first (idempotent),
 * which is what makes the signup grant and monthly trickle "lazy" — they land
 * on whatever entitlement read sees the user first.
 */
export async function getEntitlement(userId: string): Promise<Entitlement> {
  const config = loadConfig();
  await ensureFreeGrants(userId);
  const balanceMicro = await getOwlBalanceMicroUsd(userId);
  return {
    owlBalance: microUsdToOwls(balanceMicro),
    owlBalanceMicroUsd: balanceMicro,
    owlPriceMicroUsd: config.owlPriceMicroUsd,
    pricesOwls: priceListOwls(),
    creditsEnabled: stripeConfigured(),
    signupGrantOwls: config.signupGrantOwls,
    monthlyGrantOwls: config.monthlyGrantOwls,
  };
}

export interface SpendCheck {
  allowed: boolean;
  priceOwls: number;
  entitlement: Entitlement;
}

/** Can the user afford this operation right now? Read-only — no charge. */
export async function checkSpend(
  userId: string,
  op: PricedOp
): Promise<SpendCheck> {
  const entitlement = await getEntitlement(userId);
  const price = priceOwls(op);
  return {
    allowed: entitlement.owlBalance >= price,
    priceOwls: price,
    entitlement,
  };
}

/** Serialized purchase packs for entitlement/402/account surfaces. */
export function serializeOwlPacks() {
  if (!stripeConfigured()) return [];
  return owlPacks().map((p) => ({
    id: p.id,
    owls: p.owls,
    price_cents: p.priceCents,
    discount_percent: p.discountPercent,
  }));
}
