/**
 * The attempt read model for a claim page (docs/mathematics.md §7.7 and
 * §11.1): every attempt on the claim, newest first, with the report and
 * notebook only once published. On a bounty-bearing claim an unpublished
 * attempt exposes only its id, variant, status, dates, and cost, never its
 * outcome, so a house proof cannot be inferred in the gap before the
 * Steward's decision.
 */
import type { AttemptSummary } from "./claim-extras-types.js";
import {
  claimHasLiveBounty,
  listClaimAttempts,
  serializeAttemptSummary,
} from "./attempt-service.js";

export async function loadAttemptExtras(claimId: string): Promise<AttemptSummary[]> {
  const rows = await listClaimAttempts(claimId);
  if (rows.length === 0) return [];
  const bountyBearing = await claimHasLiveBounty(claimId);
  return rows.map((row) => serializeAttemptSummary(row, { bountyBearing }));
}
