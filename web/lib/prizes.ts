import type {
  AttemptOutcome, AttemptSummary, BountyStatus, BountySummary, PrizeClaimStatus,
  PrizeClaimSummary,
} from "./types";
import { formatUsd, fmtDateLong } from "./format";

// The prize vocabulary (docs/mathematics.md §8): which bounty states a page
// shows, what each prize-claim state means to the claimant, and the phrases
// the attempt log and the prize section share. Kept in one place so the claim
// page, the map, the account page, and the mandate page say the same thing.

// A bounty is shown once it is live or resolved; the two pre-confirmation
// states are bookkeeping the public never sees.
export const BOUNTY_LIVE: ReadonlySet<BountyStatus> = new Set<BountyStatus>([
  "open", "claim_pending", "house_result_pending", "rebinding",
]);
export const BOUNTY_RESOLVED: ReadonlySet<BountyStatus> = new Set<BountyStatus>([
  "paid", "resolved_internally", "resolved_unpaid", "expired", "withdrawn",
]);

export function isBountyLive(status: BountyStatus | string | null | undefined): boolean {
  return typeof status === "string" && BOUNTY_LIVE.has(status as BountyStatus);
}
export function isBountyShown(status: BountyStatus | string | null | undefined): boolean {
  return typeof status === "string"
    && (BOUNTY_LIVE.has(status as BountyStatus) || BOUNTY_RESOLVED.has(status as BountyStatus));
}

// The amount of a live bounty, for the map's ring and the cards' chip; null
// when there is none or it has resolved.
export function liveBountyMicro(b: BountySummary | null | undefined): number | null {
  return b && isBountyLive(b.status) ? b.amount_micro_usd : null;
}

export const BOUNTY_STATUS_LABEL: Record<BountyStatus, string> = {
  requested: "requested",
  confirm_pending: "awaiting confirmation",
  open: "open",
  claim_pending: "submission under review",
  house_result_pending: "house result under review",
  rebinding: "statement revised; prize held",
  paid: "paid",
  resolved_internally: "settled by the house solver",
  resolved_unpaid: "closed without payout",
  expired: "expired",
  withdrawn: "withdrawn",
};

// What each prize-claim state means, in the graph's voice, for the public
// submissions list on a claim page.
export const PRIZE_CLAIM_STATUS_LABEL: Record<PrizeClaimStatus, string> = {
  queued: "queued for the checker",
  checking: "being checked",
  check_error: "checker error; held for an operator",
  checked: "passed the checker; awaiting review",
  in_review: "with the claim's steward",
  in_challenge_window: "accepted; in the challenge window",
  payable: "accepted; payable",
  defect_award_pending: "exposed a statement defect; award pending",
  paid: "paid",
  rejected: "rejected",
  voided: "voided",
  withdrawn: "withdrawn",
  superseded: "superseded by an earlier submission",
  forfeited: "forfeited",
};

const REJECTED_STAGE_LABEL = {
  check: "rejected by the checker",
  review: "rejected at review",
  steward: "rejected by the steward",
} as const;

export function prizeClaimStateLabel(c: PrizeClaimSummary): string {
  if (c.status === "rejected" && c.rejected_stage) return REJECTED_STAGE_LABEL[c.rejected_stage];
  return PRIZE_CLAIM_STATUS_LABEL[c.status] ?? String(c.status).replace(/_/g, " ");
}

// The claimant's next step for each live state, for the account page.
export function prizeClaimNextStep(c: { status: PrizeClaimStatus; window_ends_at?: string | null }): string {
  switch (c.status) {
    case "queued":
      return "Waiting for the checker. Submissions on one statement are checked in order of receipt; yours keeps its place.";
    case "checking":
      return "The checker is running your submission against the pinned Lean and Mathlib versions.";
    case "check_error":
      return "The checker hit an infrastructure error. An operator will resolve it; your place in the queue is kept.";
    case "checked":
      return "Passed the checker. The Contribution Reviewer is checking form, good faith, identity, and duplicates, never the proof.";
    case "in_review":
      return "With the claim's steward, who judges only whether the statement proved is the statement posted.";
    case "in_challenge_window":
      return c.window_ends_at
        ? `Accepted. The prize becomes payable after the challenge window closes on ${fmtDateLong(c.window_ends_at)}, unless a challenge succeeds.`
        : "Accepted. The prize becomes payable when the public challenge window closes, unless a challenge succeeds.";
    case "payable":
    case "defect_award_pending":
      return "Complete the three steps below to receive the prize.";
    case "paid":
      return "Paid.";
    case "rejected":
      return "Rejected. The reasons are on the record, and a rejection is appealable.";
    case "voided":
      return "Voided by an operator. The note is public, and a void is appealable like any rejection.";
    case "withdrawn":
      return "Withdrawn.";
    case "superseded":
      return "An earlier submission was accepted and paid; this submission is credited on the claim page and no prize is owed.";
    case "forfeited":
      return "The steps were not completed within ninety days of the prize becoming payable, and the prize lapsed.";
  }
}

export const ATTEMPT_VARIANT_LABEL: Record<AttemptSummary["variant"], string> = {
  standard: "standard effort",
  max: "maximum effort",
};

// What the solver came back with, as the attempt log states it.
export const ATTEMPT_OUTCOME_LABEL: Record<AttemptOutcome, string> = {
  proof: "produced a checked proof",
  disproof: "produced a checked disproof",
  partial: "partial progress; did not settle it",
  reduction: "reduced it to a simpler statement; did not settle it",
  negative: "found nothing; did not settle it",
  none: "no result",
};

export function attemptOutcomeLabel(a: Pick<AttemptSummary, "outcome" | "status">): string {
  if (a.outcome) return ATTEMPT_OUTCOME_LABEL[a.outcome] ?? a.outcome;
  return a.status.replace(/_/g, " ");
}

// The challenge window an accepted submission waits through before it is
// payable (§8.5): fourteen days below the tier, thirty at or above.
export const PRIZE_WINDOW_TIER_MICRO = 1_000_000_000;
export function challengeWindowDays(amountMicro: number): 14 | 30 {
  return amountMicro >= PRIZE_WINDOW_TIER_MICRO ? 30 : 14;
}

export const PRIZE_PAYEE_STEPS_DAYS = 90;

// What the prize asks for, as the lead sentence words it.
export function resolutionPhrase(resolution: BountySummary["resolution"]): string {
  return resolution === "either" ? "proof or disproof" : resolution;
}

// The house-attempt sentence in the prize section (§8.3), built from the
// bounty's own attempt disclosure. Empty when nothing was attempted.
export function houseAttemptSentence(attempts: BountySummary["attempts"]): string {
  if (attempts.length === 0) return "";
  const sorted = [...attempts].sort((a, b) => b.finished_at.localeCompare(a.finished_at));
  const last = sorted[0];
  const effort = last.variant === "max" ? "maximum effort" : "standard effort";
  const settled = last.outcome === "proof" || last.outcome === "disproof";
  const what = settled
    ? `produced a checked ${last.outcome}`
    : "did not settle it";
  if (sorted.length === 1) {
    return `Minerval's own solver attempted this statement on ${fmtDateLong(last.finished_at)} at ${effort} (${formatUsd(last.cost_micro_usd)} of compute) and ${what}; its report is public.`;
  }
  const total = sorted.reduce((s, a) => s + a.cost_micro_usd, 0);
  const times = sorted.length === 2 ? "twice" : `${sorted.length} times`;
  return `Minerval's own solver attempted this statement ${times}, most recently on ${fmtDateLong(last.finished_at)} at ${effort} (${formatUsd(total)} of compute in all), and ${what}; the reports are public.`;
}

export function submissionsPhrase(n: number): string {
  if (n === 0) return "No submissions yet.";
  if (n === 1) return "One submission received.";
  const words = ["", "", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"];
  return `${words[n] ?? n} submissions received.`;
}

// The two sentences the rules require beside every payment surface.
export const PRIZE_PAYMENT_SENTENCE =
  "Prizes are paid in owls, one owl per dollar, which buy metered work on the graph and are never redeemable for cash; a prize is taxable income at its dollar value.";

export const PRIZE_TAX_SANCTIONS_NOTICE =
  "Prizes are income to the winner and are reported and withheld as United States law requires: a W-9 or W-8BEN before payment, and withholding where the law calls for it. Every payee is screened against sanctions lists before payment. Residents of comprehensively sanctioned jurisdictions are not eligible, and, for now, neither are residents of Italy or Brazil.";
