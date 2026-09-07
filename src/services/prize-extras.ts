/**
 * The prize read model for a claim page (docs/mathematics.md §8.3 and
 * §11.1): the claim's bounty (the live one, or the latest after a close)
 * with its state sentence, and every prize claim on it, rejected and
 * superseded ones included, since §14 makes every outcome part of the
 * record.
 */
import type { PrizeExtras } from "./claim-extras-types.js";
import { bountySummary, getLatestBountyForClaim } from "./bounty-service.js";
import { listPrizeClaimsForClaim, prizeClaimSummary } from "./prize-claim-service.js";

export async function loadPrizeExtras(claimId: string): Promise<PrizeExtras> {
  const bounty = await getLatestBountyForClaim(claimId);
  const claims = await listPrizeClaimsForClaim(claimId);
  return {
    bounty: bounty ? await bountySummary(bounty) : null,
    prize_claims: claims.map(prizeClaimSummary),
  };
}
