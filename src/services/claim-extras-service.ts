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
import { listResearchRunsForClaim } from "./research-run-service.js";
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
  /** Investigations the Steward delegated to the researcher (#298), disclosed with their cost. */
  research_runs: ResearchRunSummary[];
}

export interface ResearchRunSummary {
  id: string;
  requested_by: string;
  task: string;
  model: string;
  model_tier: string;
  status: string;
  spent_micro_usd: number;
  turns: number;
  started_at: string;
  finished_at: string | null;
}

export function emptyClaimExtras(): ClaimExtras {
  return {
    formalization: null,
    verification: null,
    domains: [],
    bounty: null,
    attempts: [],
    prize_claims: [],
    research_runs: [],
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
  const [formalization, verification, domains, prize, attempts, research] = await Promise.all([
    getFormalizationSummary(claimId),
    getVerificationSummary(claimId),
    loadDomains(claimId),
    loadPrizeExtras(claimId),
    loadAttemptExtras(claimId),
    listResearchRunsForClaim(claimId).catch(() => []),
  ]);
  return {
    formalization,
    verification,
    domains,
    bounty: prize.bounty,
    attempts,
    prize_claims: prize.prize_claims,
    // The report and notebook stay on the run (the Steward's get_research_run
    // and the record); the page discloses the brief, the model, and the cost.
    research_runs: research.map((r) => ({
      id: r.id,
      requested_by: r.requested_by,
      task: r.task,
      model: r.model,
      model_tier: r.model_tier,
      status: r.status,
      spent_micro_usd: r.spent_micro_usd,
      turns: r.turns,
      started_at: new Date(r.started_at).toISOString(),
      finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    })),
  };
}
