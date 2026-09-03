/**
 * The mathematics read models the claim payload carries beside the claim
 * (docs/mathematics.md §11.1): the published formal statement, the derived
 * machine-checked badge, the claim's domain tags, the bounty pinned to the
 * statement, the house solver's attempts, and the prize claims filed. Each
 * slice owns its loader; this module only composes them.
 */
import { rawQuery } from "../db/client.js";
import type {
  AttemptSummary,
  BountySummary,
  FormalizationSummary,
  PrizeClaimSummary,
  VerificationSummary,
} from "./claim-extras-types.js";
import { loadAttemptExtras } from "./attempt-extras.js";
import { loadPrizeExtras } from "./prize-extras.js";
import {
  getFormalizationSummary,
  getVerificationSummary,
} from "./formalization-service.js";

export interface ClaimExtras {
  formalization: FormalizationSummary | null;
  verification: VerificationSummary | null;
  domains: string[];
  bounty: BountySummary | null;
  attempts: AttemptSummary[];
  prize_claims: PrizeClaimSummary[];
}

export function emptyClaimExtras(): ClaimExtras {
  return {
    formalization: null,
    verification: null,
    domains: [],
    bounty: null,
    attempts: [],
    prize_claims: [],
  };
}

async function loadDomains(claimId: string): Promise<string[]> {
  const [row] = await rawQuery<{ domains: string[] | null }>(
    `SELECT domains FROM claims WHERE id = $1`,
    [claimId]
  );
  return row?.domains ?? [];
}

export async function loadClaimExtras(claimId: string): Promise<ClaimExtras> {
  const [formalization, verification, domains, prize, attempts] = await Promise.all([
    getFormalizationSummary(claimId),
    getVerificationSummary(claimId),
    loadDomains(claimId),
    loadPrizeExtras(claimId),
    loadAttemptExtras(claimId),
  ]);
  return {
    formalization,
    verification,
    domains,
    bounty: prize.bounty,
    attempts,
    prize_claims: prize.prize_claims,
  };
}
