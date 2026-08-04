/**
 * Billing service — the seam where Stripe attaches (#70), now attached (#309).
 *
 * Two providers implement the interface #70 shipped:
 *   - FreeTierBillingProvider — everyone on the monthly trial grant; beyond it
 *     agentic endpoints 402. Active while Stripe is unconfigured.
 *   - StripeBillingProvider — the same free grant, plus purchased credits from
 *     credits_ledger (bought via Stripe Checkout, credited by webhook — see
 *     src/routes/billing.ts). Selected automatically when STRIPE_SECRET_KEY
 *     holds a real key. Nothing at the call sites (quota preHandler,
 *     /users/me, /usage) changed — exactly the swap #70 planned.
 *
 * Free-vs-metered boundary (also documented in docs/accounts.md):
 *   - Non-agentic reads (claim lookup, search, trees) are free and generous —
 *     they never touch this service.
 *   - Agentic surfaces (source ingestion, claim proposal, future extension /
 *     chat endpoints) consume the monthly grant.
 *   - Contribution review costs are system overhead, not user spend: good-
 *     faith contribution stays free (#71).
 */
import { loadConfig } from "../config.js";
import { getMonthToDateCostMicroUsd } from "./usage-service.js";
import { getCreditBalanceMicroUsd } from "./credit-service.js";

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
  plan: "free" | "credits";
  /** Monthly grant of metered (agentic) usage, in micro-USD of derived cost. */
  monthlyGrantMicroUsd: number;
  usedMicroUsd: number;
  remainingMicroUsd: number;
  /** Purchased-credit balance in micro-USD (always 0 on the free provider). */
  creditBalanceMicroUsd: number;
  /** Whether this deployment can sell credits (drives the 402 message + UI). */
  creditsEnabled: boolean;
}

export interface SpendCheck {
  allowed: boolean;
  entitlement: Entitlement;
}

/** The wire shape (snake_case) shared by /users/me, /usage, and 402 bodies. */
export function serializeEntitlement(e: Entitlement) {
  return {
    plan: e.plan,
    monthly_grant_micro_usd: e.monthlyGrantMicroUsd,
    used_micro_usd: e.usedMicroUsd,
    remaining_micro_usd: e.remainingMicroUsd,
    credit_balance_micro_usd: e.creditBalanceMicroUsd,
    credits_enabled: e.creditsEnabled,
  };
}

export interface BillingProvider {
  getEntitlement(userId: string): Promise<Entitlement>;
  /** May the user start a new metered (agentic) operation right now? */
  checkSpend(userId: string): Promise<SpendCheck>;
}

/**
 * The pre-payments provider: everyone is on the free plan with a monthly
 * trial grant (FREE_TIER_MONTHLY_USD). Beyond it, agentic endpoints return
 * 402 — purchasing credits is "not yet available" until Stripe lands.
 */
class FreeTierBillingProvider implements BillingProvider {
  async getEntitlement(userId: string): Promise<Entitlement> {
    const grant = Math.round(loadConfig().freeTierMonthlyUsd * 1_000_000);
    const used = await getMonthToDateCostMicroUsd(userId);
    return {
      plan: "free",
      monthlyGrantMicroUsd: grant,
      usedMicroUsd: used,
      remainingMicroUsd: Math.max(0, grant - used),
      creditBalanceMicroUsd: 0,
      creditsEnabled: false,
    };
  }

  async checkSpend(userId: string): Promise<SpendCheck> {
    const entitlement = await this.getEntitlement(userId);
    // A grant of 0 disables the free trial entirely; otherwise allow starting
    // an operation while any grant remains (the operation itself is metered,
    // so a user can overshoot by at most one operation — acceptable slack for
    // a trial tier, and the next request is blocked).
    return { allowed: entitlement.remainingMicroUsd > 0, entitlement };
  }
}

/**
 * Paid billing (#309): free monthly grant first, then purchased credits.
 * Usage is still metered once in llm_usage — the credit balance is derived
 * (grants minus beyond-grant usage, src/services/credit-service.ts), so
 * spending needs no per-call ledger writes. The same one-operation overshoot
 * slack as the free tier applies at the credit floor.
 */
class StripeBillingProvider implements BillingProvider {
  async getEntitlement(userId: string): Promise<Entitlement> {
    const grant = Math.round(loadConfig().freeTierMonthlyUsd * 1_000_000);
    const [used, creditBalance] = await Promise.all([
      getMonthToDateCostMicroUsd(userId),
      getCreditBalanceMicroUsd(userId),
    ]);
    return {
      plan: creditBalance > 0 ? "credits" : "free",
      monthlyGrantMicroUsd: grant,
      usedMicroUsd: used,
      remainingMicroUsd: Math.max(0, grant - used),
      creditBalanceMicroUsd: creditBalance,
      creditsEnabled: true,
    };
  }

  async checkSpend(userId: string): Promise<SpendCheck> {
    const entitlement = await this.getEntitlement(userId);
    return {
      allowed:
        entitlement.remainingMicroUsd > 0 ||
        entitlement.creditBalanceMicroUsd > 0,
      entitlement,
    };
  }
}

let _provider: BillingProvider | null = null;

export function getBillingProvider(): BillingProvider {
  if (!_provider) {
    _provider = stripeConfigured()
      ? new StripeBillingProvider()
      : new FreeTierBillingProvider();
  }
  return _provider;
}

/** Test hook / future Stripe swap-in point. */
export function setBillingProvider(provider: BillingProvider | null): void {
  _provider = provider;
}
