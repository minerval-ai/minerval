/**
 * The owl — Minerval's unit of account.
 *
 * One owl is a fixed face value (OWL_PRICE default $4, the "tetradrachm") that
 * buys one claim assessment: roughly $1 of frontier-model work at the same 4×
 * margin the metered era charged (usageMarkupMultiplier). Users, agents, and
 * price lists reason in owls; ledgers and cost accounting stay in micro-USD.
 * Owls are strictly one-way — bought or earned, then spent; never redeemable
 * for cash.
 *
 * This module is the single home of the conversion math, the canonical price
 * list for flat-priced operations, and the purchase-pack definitions (bulk
 * discounts). Open-ended operations (deep decomposition, grantor agents) are
 * not priced here — they are funded with escrowed owl budgets instead.
 */
import { loadConfig } from "../config.js";

/** Operations with a flat owl price, charged at the quota gate. */
export type PricedOp =
  | "claim_proposal"
  | "assessment"
  | "source_ingest"
  | "extension_analysis"
  | "extension_chat"
  | "text_analysis";

export function owlPriceMicroUsd(): number {
  return loadConfig().owlPriceMicroUsd;
}

/** Convert owls (possibly fractional) to face-value micro-USD. */
export function owlsToMicroUsd(owls: number): number {
  return Math.round(owls * owlPriceMicroUsd());
}

/** Convert face-value micro-USD to owls, rounded to milli-owl precision. */
export function microUsdToOwls(microUsd: number): number {
  return Math.round((microUsd / owlPriceMicroUsd()) * 1000) / 1000;
}

/**
 * The canonical price list, in owls. Serialized into entitlements and 402
 * bodies so the cost of everything is legible before it is incurred (§15).
 */
export function priceListOwls(): Record<PricedOp, number> {
  const c = loadConfig();
  return {
    // Proposing a claim commands a full Steward pass on it — the same work
    // as an assessment order, so the same price. This is what the signup
    // grant's "5 free claims" buys.
    claim_proposal: c.priceClaimProposalOwls,
    // A user-ordered (re)assessment of an existing claim.
    assessment: c.priceAssessmentOwls,
    // Ingest a URL: extraction + matching over one source.
    source_ingest: c.priceSourceIngestOwls,
    // Browser-extension page analysis / chat exchange.
    extension_analysis: c.priceExtensionAnalysisOwls,
    extension_chat: c.priceExtensionChatOwls,
    // MCP text tools (match_claim, extract_claims, assess_text).
    text_analysis: c.priceTextAnalysisOwls,
  };
}

export function priceOwls(op: PricedOp): number {
  return priceListOwls()[op];
}

export function priceMicroUsd(op: PricedOp): number {
  return owlsToMicroUsd(priceOwls(op));
}

export interface OwlPack {
  id: string;
  owls: number;
  priceCents: number;
  /** Percent saved vs. buying the same owls at face value, 0 for none. */
  discountPercent: number;
}

/**
 * Purchase packs, parsed from config ("owls:cents,owls:cents,…"). Larger
 * packs price owls below face value — the bulk discount is visible as
 * discountPercent so the UI never has to re-derive it.
 */
export function owlPacks(): OwlPack[] {
  const c = loadConfig();
  const faceCentsPerOwl = c.owlPriceMicroUsd / 10_000;
  return c.owlPacks.map(({ owls, priceCents }) => {
    const faceCents = owls * faceCentsPerOwl;
    const discountPercent =
      faceCents > 0
        ? Math.max(0, Math.round((1 - priceCents / faceCents) * 100))
        : 0;
    return { id: `owls_${owls}`, owls, priceCents, discountPercent };
  });
}

export function getOwlPack(packId: string): OwlPack | undefined {
  return owlPacks().find((p) => p.id === packId);
}
