/**
 * The prize read model for a claim page (docs/mathematics.md §8.3 and
 * §11.1). Filled in by the prize slice; until then a claim has no bounty.
 */
import type { PrizeExtras } from "./claim-extras-types.js";

export async function loadPrizeExtras(_claimId: string): Promise<PrizeExtras> {
  return { bounty: null, prize_claims: [] };
}
