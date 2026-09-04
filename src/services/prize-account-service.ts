/**
 * The signed-in claimant's own prize claims, as GET /users/me lists them
 * (docs/mathematics.md §8.7): the public summary of each, the claim it is
 * on, the amount at stake, and where the winner's three steps stand once
 * the claim is payable. Payee details, provider ids, and tax data never
 * serialize; only the state of each step does. The shape is the web's
 * OpenPrizeClaim (web/lib/types.ts), field for field.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import type { PrizeClaimStatus, PrizeClaimSummary } from "./claim-extras-types.js";
import type { PayeeRecord } from "./prize-claim-service.js";

export interface OpenPrizeClaim extends PrizeClaimSummary {
  claim_id: string;
  claim_text: string;
  amount_micro_usd: number;
  window_ends_at: string | null;
  payee_deadline_at: string | null;
  payee_status: "pending" | "submitted" | "verified" | null;
  tax_form_status: "pending" | "received" | null;
  screening_status: "pending" | "cleared" | "blocked" | null;
  paid_at: string | null;
}

/** One row of the account query: the prize claim joined to its bounty and claim. */
export interface OpenPrizeClaimRow {
  id: string;
  contribution_id: string;
  claim_id: string;
  direction: "proof" | "disproof";
  status: PrizeClaimStatus;
  rejected_stage: "check" | "review" | "steward" | null;
  credit_name: string | null;
  submitted_at: Date | string;
  updated_at: Date | string;
  window_ends_at: Date | string | null;
  payee: PayeeRecord | null;
  defect_award_micro_usd: number | string | null;
  claim_text: string;
  bounty_amount_micro_usd: number | string;
  tax_form_received: boolean;
  paid_at: Date | string | null;
}

/** The states from which the winner's steps (and their deadline) apply. */
const STEPS_APPLY: ReadonlySet<PrizeClaimStatus> = new Set<PrizeClaimStatus>([
  "payable",
  "defect_award_pending",
  "paid",
  "forfeited",
]);

function iso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

/**
 * Project one row onto the account shape. Pure, so the projection is
 * pinned without a database.
 *
 * The payee deadline runs PRIZE_PAYEE_STEPS_DAYS from the moment the claim
 * became payable. The transition to `payable` stamps `payee.payable_at`;
 * a claim that reached the steps another way (a defect award) carries no
 * such stamp, and `updated_at` stands in for it, the same fallback the
 * forfeiter uses when it applies the deadline.
 */
export function openPrizeClaimFromRow(
  row: OpenPrizeClaimRow,
  opts: { payeeStepsDays: number }
): OpenPrizeClaim {
  const stepsApply = STEPS_APPLY.has(row.status);
  const payee = row.payee ?? {};
  const payableSince = stepsApply ? new Date(payee.payable_at ?? row.updated_at) : null;
  const deadline = payableSince
    ? new Date(payableSince.getTime() + opts.payeeStepsDays * 86_400_000)
    : null;
  const defectAward = row.defect_award_micro_usd === null || row.defect_award_micro_usd === undefined
    ? null
    : Number(row.defect_award_micro_usd);
  const screening = payee.screening_result ?? null;
  return {
    id: row.id,
    credit_name: row.credit_name ?? "a contributor",
    direction: row.direction,
    submitted_at: new Date(row.submitted_at).toISOString(),
    status: row.status,
    rejected_stage: row.rejected_stage,
    contribution_id: row.contribution_id,
    claim_id: row.claim_id,
    claim_text: row.claim_text,
    // A defect award is owed at the award, not the bounty; every other
    // claim is owed the bounty it was filed against.
    amount_micro_usd: defectAward ?? Number(row.bounty_amount_micro_usd),
    window_ends_at: iso(row.window_ends_at),
    payee_deadline_at: deadline ? deadline.toISOString() : null,
    // The API records identity in one step and never verifies it
    // separately, so "verified" is never served; the web's type allows it.
    payee_status: !stepsApply ? null : payee.identity_recorded_at ? "submitted" : "pending",
    tax_form_status: !stepsApply ? null : row.tax_form_received ? "received" : "pending",
    // Anything other than a clear screening blocks payment (prize-payout-service).
    screening_status: !stepsApply ? null : screening === null ? "pending" : screening === "clear" ? "cleared" : "blocked",
    paid_at: iso(row.paid_at),
  };
}

/**
 * Every prize claim the account has filed, newest first: live ones with
 * their next step, settled ones for the record. The tax form is read from
 * the attachments table (a restricted attachment of kind tax_form on the
 * claim's contribution, or the one the payee record names), the identity
 * and screening states from the payee JSON, and the payment from the
 * payout row.
 */
export async function listOpenPrizeClaimsFor(claimantId: string, limit = 100): Promise<OpenPrizeClaim[]> {
  const rows = await rawQuery<OpenPrizeClaimRow>(
    `SELECT pc.id, pc.contribution_id, pc.claim_id, pc.direction, pc.status, pc.rejected_stage,
            pc.credit_name, pc.submitted_at, pc.updated_at, pc.window_ends_at, pc.payee,
            pc.defect_award_micro_usd::bigint AS defect_award_micro_usd,
            c.text AS claim_text,
            b.amount_micro_usd::bigint AS bounty_amount_micro_usd,
            EXISTS (SELECT 1 FROM attachments a
                     WHERE a.contribution_id = pc.contribution_id
                       AND (a.kind = 'tax_form'
                            OR a.id::text = pc.payee->>'tax_form_attachment_id')) AS tax_form_received,
            (SELECT MIN(pp.paid_at) FROM prize_payouts pp
              WHERE pp.prize_claim_id = pc.id AND pp.paid_at IS NOT NULL) AS paid_at
       FROM prize_claims pc
       JOIN bounties b ON b.id = pc.bounty_id
       JOIN claims c ON c.id = pc.claim_id
      WHERE pc.claimant_id = $1
      ORDER BY pc.submitted_at DESC, pc.id ASC
      LIMIT $2`,
    [claimantId, limit]
  );
  const payeeStepsDays = loadConfig().prizePayeeStepsDays;
  return rows.map((row) => openPrizeClaimFromRow(row, { payeeStepsDays }));
}
