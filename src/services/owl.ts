/**
 * The owl — Minerval's unit of account.
 *
 * Cost is measured in dollars, not owls, and one owl of spend covers one
 * dollar of metered cost, one for one: an action that costs a dollar costs
 * a whole owl. What an owl SELLS for ($4, the "tetradrachm") is a separate
 * number: the platform's whole margin lives in the purchase price, openly,
 * and never in the meter. Owls are strictly one-way: bought or earned,
 * then spent, never redeemable for cash.
 *
 * Nothing here is a fixed price. Every operation is metered at real cost;
 * the numbers in this module are CAPS — the most an operation may cost —
 * so a button can carry one legible figure ("up to 1 owl") before the work
 * runs. The cap is charged when the operation starts, the meter records
 * what the work really cost, and the unused fraction settles back to the
 * balance (owl-ledger-service.settleMeteredCharge). When a run costs more
 * than its cap, the platform absorbs the overage: the cap is a ceiling the
 * user can rely on, priced near the average. Agents deciding where effort
 * goes reason in expected marginal value over expected marginal cost, and
 * a fixed price anywhere would distort that — caps keep the display honest
 * without un-metering anything.
 *
 * This module is the single home of the conversion math, the canonical cap
 * list for bounded operations, and the purchase-pack definitions (bulk
 * discounts). Open-ended work (deep decomposition, grants) carries an
 * escrowed owl budget instead of a per-operation cap.
 */
import { loadConfig } from "../config.js";

/** Operations with a per-run owl cap, charged cap-then-settle at the quota gate. */
export type PricedOp =
  | "claim_proposal"
  | "assessment"
  | "source_ingest"
  | "extension_analysis"
  | "extension_chat"
  | "text_analysis";

/** What one owl costs to BUY, in micro-USD ($4). Purchase display only. */
export function owlPriceMicroUsd(): number {
  return loadConfig().owlPriceMicroUsd;
}

/** What one owl of SPEND covers, in micro-USD of metered cost ($1). */
export function owlCostMicroUsd(): number {
  return loadConfig().owlCostMicroUsd;
}

/** Convert owls (possibly fractional) to micro-USD of metered cost. */
export function owlsToMicroUsd(owls: number): number {
  return Math.round(owls * owlCostMicroUsd());
}

/** Convert micro-USD of metered cost to owls, at milli-owl precision. */
export function microUsdToOwls(microUsd: number): number {
  return Math.round((microUsd / owlCostMicroUsd()) * 1000) / 1000;
}

/**
 * The canonical cap list, in owls: the MOST each operation can cost.
 * Serialized into entitlements and 402 bodies so the ceiling on everything
 * is legible before it is incurred (§15); the actual charge is the metered
 * cost, settled after the run.
 */
export function capListOwls(): Record<PricedOp, number> {
  const c = loadConfig();
  return {
    // Proposing a claim commands a full Steward pass on it — the same work
    // as an assessment order, so the same cap. This is what the signup
    // grant's "5 free claims" buys.
    claim_proposal: c.capClaimProposalOwls,
    // A user-ordered (re)assessment of an existing claim, best model.
    assessment: c.capAssessmentOwls,
    // Ingest a URL: extraction + matching over one source.
    source_ingest: c.capSourceIngestOwls,
    // Browser-extension page analysis / chat exchange.
    extension_analysis: c.capExtensionAnalysisOwls,
    extension_chat: c.capExtensionChatOwls,
    // MCP text tools (match_claim, extract_claims, assess_text).
    text_analysis: c.capTextAnalysisOwls,
  };
}

/** The cap for one operation, in owls. */
export function capOwls(op: PricedOp): number {
  return capListOwls()[op];
}

/** The cap for one operation, in face-value micro-USD. */
export function capMicroUsd(op: PricedOp): number {
  return owlsToMicroUsd(capOwls(op));
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
