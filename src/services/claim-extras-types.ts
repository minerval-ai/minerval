/**
 * Read models the claim payload, the list, and the map carry for the
 * mathematics surfaces (docs/mathematics.md §11.1). The web app consumes
 * these shapes by name; keep them stable.
 */
export interface FormalizationSummary {
  id: string;
  version: number;
  status: "draft" | "reviewed" | "published" | "retired";
  pin_id: string;
  lean_toolchain: string;
  mathlib_rev: string;
  mathlib_tag: string | null;
  namespace: string;
  statement_source: string;
  pp_type: string;
  source_hash: string;
  expr_hash: string;
  correspondence: string | null;
  published_at: string | null;
  review_period_ends_at: string | null;
}

/** The derived machine-checked badge; null when no accepted check is recorded as an argument. */
export interface VerificationSummary {
  kind: "proof" | "disproof";
  lean_check_id: string;
  checked_at: string;
  formalization_id: string;
  pin_id: string;
}

export type BountyStatus =
  | "requested"
  | "confirm_pending"
  | "open"
  | "claim_pending"
  | "house_result_pending"
  | "rebinding"
  | "paid"
  | "resolved_internally"
  | "resolved_unpaid"
  | "expired"
  | "withdrawn";

export type AttemptOutcome = "proof" | "disproof" | "partial" | "reduction" | "negative" | "none";

export interface BountySummary {
  id: string;
  amount_micro_usd: number;
  status: BountyStatus;
  resolution: "proof" | "disproof" | "either";
  formalization_id: string;
  source_hash: string;
  expr_hash: string;
  pin_id: string;
  opened_at: string | null;
  expires_at: string | null;
  withdraw_effective_at: string | null;
  rules_version: string;
  submissions: number;
  attempts: Array<{
    id: string;
    finished_at: string;
    variant: "standard" | "max";
    cost_micro_usd: number;
    outcome: AttemptOutcome;
  }>;
  awarded: { credit_name: string; paid_at: string; amount_micro_usd: number } | null;
  /** The state sentence in the graph's voice, rendered server-side. */
  state_sentence: string;
  terms_url: string;
}

export type PrizeClaimStatus =
  | "queued"
  | "checking"
  | "check_error"
  | "checked"
  | "in_review"
  | "in_challenge_window"
  | "payable"
  | "defect_award_pending"
  | "paid"
  | "rejected"
  | "voided"
  | "withdrawn"
  | "superseded"
  | "forfeited";

export interface PrizeClaimSummary {
  id: string;
  credit_name: string;
  direction: "proof" | "disproof";
  submitted_at: string;
  status: PrizeClaimStatus;
  rejected_stage: "check" | "review" | "steward" | null;
  contribution_id: string;
}

export interface AttemptSummary {
  id: string;
  claim_id: string;
  variant: "standard" | "max";
  effort: string;
  status: string;
  outcome: AttemptOutcome | null;
  is_calibration: boolean;
  spent_micro_usd: number;
  turns: number;
  started_at: string;
  finished_at: string | null;
  published_at: string | null;
  report: {
    informal_argument: string;
    approaches_tried: string[];
    obstruction: string;
    what_would_help: string;
    confidence: number;
  } | null;
  notebook: Record<string, string> | null;
}

export interface PrizeExtras {
  bounty: BountySummary | null;
  prize_claims: PrizeClaimSummary[];
}
