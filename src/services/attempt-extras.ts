/**
 * The attempt read model for a claim page (docs/mathematics.md §7.7 and
 * §11.1). Filled in by the solver slice; until then a claim has no attempts.
 */
import type { AttemptSummary } from "./claim-extras-types.js";

export async function loadAttemptExtras(_claimId: string): Promise<AttemptSummary[]> {
  return [];
}
