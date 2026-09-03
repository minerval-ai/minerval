/**
 * Paying the prize in owls (docs/mathematics.md §8.7, §8.9).
 *
 * The winner's steps first: identity and residency on `prize_claims.payee`,
 * the tax form as a restricted attachment of kind `tax_form`, and the
 * sanctions screening the operator records. Then payPrize: refused unless
 * the claim is payable (or a defect award is pending), the audit outcome is
 * recorded without a send-back, sign-off is recorded where required, and
 * all three payee steps are recorded. It writes the `prize_payouts` row
 * (kind owls, provider internal, withholding computed), then the owl_ledger
 * `prize_award` row net of withholding under the idempotency key
 * `prize:<prize_claim_id>:owls` in daily tranches of at most
 * PRIZE_OWL_TRANCHE_USD, increments contributors.owls_prized_micro_usd,
 * posts the fund's owl_prize debit at the cash amount and a
 * withholding_remitted debit for any withholding, marks the claim paid, and
 * supersedes the other non-tie-group claims. Everything money-moving runs
 * in one transaction under a row lock, so two racing payouts produce one.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { loadConfig, type Config } from "../config.js";
import { OWL_REASONS } from "./owl-ledger-service.js";
import { asRunner, postOwlPrizeDebit, postWithholdingRemitted, postDefectAward, type Runner } from "./prize-pool-service.js";
import { getBountyById, closeBounty, formatUsd, usdToMicro, setBountyStatus } from "./bounty-service.js";
import {
  claimsToSupersede,
  getPrizeClaimById,
  listPrizeClaimsForBounty,
  promotionCheck,
  tieGroupSettled,
  tieGroupShare,
  transitionPrizeClaim,
  updatePrizeClaimFields,
  SHARING_STATUSES,
  type PayeeRecord,
  type PrizeClaimRow,
} from "./prize-claim-service.js";
import { insertAttachment, validateTaxForm, type IncomingFile } from "./attachment-service.js";

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

export interface WithholdingInput {
  usPerson: boolean;
  hasTin: boolean;
  treatyPosition: boolean;
}

/**
 * Withholding (§8.9): 30 percent for a non-U.S. person with no treaty
 * position, 24 percent backup withholding for a U.S. person without a TIN,
 * else zero. Pure; the rate table is the law's, not a knob.
 */
export function withholdingMicroUsd(grossMicroUsd: number, input: WithholdingInput): number {
  const gross = Math.max(0, Math.round(grossMicroUsd));
  if (!input.usPerson) return input.treatyPosition ? 0 : Math.floor(gross * 0.3);
  return input.hasTin ? 0 : Math.floor(gross * 0.24);
}

export interface Tranche {
  index: number;
  amount_micro_usd: number;
  due_at: string;
  idempotency_key: string;
}

/** The idempotency key of a tranche: the first is `prize:<id>:owls`, the rest are numbered. */
export function trancheKey(prizeClaimId: string, index: number): string {
  return index === 0 ? `prize:${prizeClaimId}:owls` : `prize:${prizeClaimId}:owls:${index + 1}`;
}

/**
 * Daily tranches of at most PRIZE_OWL_TRANCHE_USD (§8.7, §9.1): the first
 * written at payment, one more each UTC day. A pure function of the net
 * amount, the tranche size, and the payment time, so the sweep recomputes
 * the schedule instead of storing it.
 */
export function trancheSchedule(
  prizeClaimId: string,
  netMicroUsd: number,
  paidAt: Date,
  trancheUsd: number
): Tranche[] {
  const size = Math.max(1, usdToMicro(trancheUsd));
  const out: Tranche[] = [];
  let remaining = Math.max(0, Math.round(netMicroUsd));
  let i = 0;
  while (remaining > 0) {
    const amount = Math.min(size, remaining);
    out.push({
      index: i,
      amount_micro_usd: amount,
      due_at: new Date(paidAt.getTime() + i * 86_400_000).toISOString(),
      idempotency_key: trancheKey(prizeClaimId, i),
    });
    remaining -= amount;
    i++;
  }
  return out;
}

export type PayRefusalCode =
  | "NOT_FOUND"
  | "NOT_PAYABLE"
  | "WINDOW_OPEN"
  | "AUDIT_OUTCOME_MISSING"
  | "AUDIT_SEND_BACK"
  | "SIGNOFF_REQUIRED"
  | "PAYEE_STEPS_INCOMPLETE"
  | "ALREADY_PAID";

export interface PayPreconditions {
  status: string;
  windowElapsed: boolean;
  auditOutcome: string | null;
  signoffRequired: boolean;
  signedOff: boolean;
  payee: PayeeRecord | null;
}

/** The refusal, if any, before a single owl moves — a pure function of the record. */
export function payRefusal(p: PayPreconditions): { code: PayRefusalCode; message: string } | null {
  if (p.status === "paid") return { code: "ALREADY_PAID", message: "the prize was already paid" };
  if (p.status !== "payable" && p.status !== "defect_award_pending") {
    return { code: "NOT_PAYABLE", message: `prize claim is ${p.status}; only a payable claim is paid` };
  }
  if (!p.windowElapsed) return { code: "WINDOW_OPEN", message: "the challenge window has not elapsed" };
  if (p.auditOutcome === null) return { code: "AUDIT_OUTCOME_MISSING", message: "no audit outcome is recorded" };
  if (p.auditOutcome === "send_back") return { code: "AUDIT_SEND_BACK", message: "the audit sent the decision back for fresh review" };
  if (p.signoffRequired && !p.signedOff) return { code: "SIGNOFF_REQUIRED", message: "a human sign-off is required and not recorded" };
  if (!p.payee?.identity_recorded_at || !p.payee?.tax_form_recorded_at || !p.payee?.screening_result) {
    return { code: "PAYEE_STEPS_INCOMPLETE", message: "identity, the tax form, and the sanctions screening must all be recorded" };
  }
  if (p.payee.screening_result !== "clear") {
    return { code: "PAYEE_STEPS_INCOMPLETE", message: `the sanctions screening returned ${p.payee.screening_result}; payment is refused` };
  }
  return null;
}

/** Jurisdictions ineligible by rule (§8.9), ISO 3166-1 alpha-2. */
export const INELIGIBLE_COUNTRIES = ["CU", "IR", "KP", "SY", "IT", "BR"] as const;

// ---------------------------------------------------------------------------
// The winner's steps
// ---------------------------------------------------------------------------

export async function recordPayeeIdentity(input: {
  prizeClaimId: string;
  userId: string;
  legalName: string;
  country: string;
  usPerson: boolean;
  hasTin: boolean;
  treatyPosition?: boolean;
}): Promise<{ ok: true; payee: PayeeRecord } | { ok: false; status: 403 | 404 | 409 | 422; message: string }> {
  const pc = await getPrizeClaimById(input.prizeClaimId);
  if (!pc) return { ok: false, status: 404, message: "prize claim not found" };
  if (pc.claimant_id !== input.userId) return { ok: false, status: 403, message: "only the winner records the payee" };
  if (pc.status !== "payable" && pc.status !== "defect_award_pending") {
    return { ok: false, status: 409, message: `prize claim is ${pc.status}; the payee steps follow payable` };
  }
  const country = String(input.country ?? "").toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) return { ok: false, status: 422, message: "country must be ISO 3166-1 alpha-2" };
  if ((INELIGIBLE_COUNTRIES as readonly string[]).includes(country)) {
    return { ok: false, status: 422, message: `prizes cannot lawfully be paid to residents of ${country}` };
  }
  if (!input.legalName?.trim()) return { ok: false, status: 422, message: "a legal name is required" };
  const payee: PayeeRecord = {
    ...(pc.payee ?? {}),
    legal_name: input.legalName.trim().slice(0, 200),
    country,
    us_person: !!input.usPerson,
    has_tin: !!input.hasTin,
    treaty_position: !!input.treatyPosition,
    identity_recorded_at: new Date().toISOString(),
  };
  await updatePrizeClaimFields(asRunner(), pc.id, { payee }, {
    actor: `contributor:${input.userId}`,
    reason: `identity and residency recorded (${country}, ${input.usPerson ? "U.S. person" : "non-U.S. person"})`,
    action: "payee_identity",
  });
  return { ok: true, payee };
}

export async function recordTaxForm(input: {
  prizeClaimId: string;
  userId: string;
  kind: "w9" | "w8ben";
  file: IncomingFile;
}): Promise<{ ok: true; attachment_id: string } | { ok: false; status: 403 | 404 | 409 | 422; message: string }> {
  const pc = await getPrizeClaimById(input.prizeClaimId);
  if (!pc) return { ok: false, status: 404, message: "prize claim not found" };
  if (pc.claimant_id !== input.userId) return { ok: false, status: 403, message: "only the winner uploads the tax form" };
  if (pc.status !== "payable" && pc.status !== "defect_award_pending") {
    return { ok: false, status: 409, message: `prize claim is ${pc.status}; the payee steps follow payable` };
  }
  if (input.kind !== "w9" && input.kind !== "w8ben") return { ok: false, status: 422, message: "kind must be w9 or w8ben" };
  const validated = validateTaxForm(input.file);
  if ("code" in validated) return { ok: false, status: 422, message: validated.message };
  const attachmentId = await insertAttachment({
    ...validated,
    contributionId: pc.contribution_id,
    ownerId: input.userId,
    visibility: "restricted",
    metadata: { tax_form_kind: input.kind },
  });
  const payee: PayeeRecord = {
    ...(pc.payee ?? {}),
    tax_form_kind: input.kind,
    tax_form_attachment_id: attachmentId,
    tax_form_recorded_at: new Date().toISOString(),
  };
  await updatePrizeClaimFields(asRunner(), pc.id, { payee }, {
    actor: `contributor:${input.userId}`,
    reason: `tax form (${input.kind}) uploaded as a restricted attachment`,
    action: "payee_tax_form",
  });
  return { ok: true, attachment_id: attachmentId };
}

export const SCREENING_RESULTS = ["clear", "potential_match", "match", "unclear"] as const;

/** POST /prize-claims/:id/screening (operator): OFAC's result, recorded by a person. */
export async function recordScreening(input: {
  prizeClaimId: string;
  result: string;
  recordedBy: string;
  note?: string;
}): Promise<{ ok: true } | { ok: false; status: 404 | 409 | 422; message: string }> {
  const pc = await getPrizeClaimById(input.prizeClaimId);
  if (!pc) return { ok: false, status: 404, message: "prize claim not found" };
  if (!(SCREENING_RESULTS as readonly string[]).includes(input.result)) {
    return { ok: false, status: 422, message: `result must be one of ${SCREENING_RESULTS.join(", ")}` };
  }
  if (pc.status !== "payable" && pc.status !== "defect_award_pending" && pc.status !== "in_challenge_window") {
    return { ok: false, status: 409, message: `prize claim is ${pc.status}` };
  }
  const payee: PayeeRecord = {
    ...(pc.payee ?? {}),
    screening_result: input.result,
    screening_recorded_by: input.recordedBy,
    screening_recorded_at: new Date().toISOString(),
  };
  await updatePrizeClaimFields(asRunner(), pc.id, { payee }, {
    actor: `operator:${input.recordedBy}`,
    reason: `sanctions screening recorded: ${input.result}${input.note ? ` (${input.note})` : ""}`,
    action: "payee_screening",
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The grant
// ---------------------------------------------------------------------------

export interface PayPrizeResult {
  ok: true;
  prize_claim_id: string;
  payout_id: string;
  gross_micro_usd: number;
  withholding_micro_usd: number;
  net_micro_usd: number;
  first_tranche_micro_usd: number;
  tranches: number;
  bounty_status: string;
  superseded: string[];
  duplicate: boolean;
}

export type PayPrizeRefusal = { ok: false; code: PayRefusalCode; message: string };

/**
 * Pay the prize (§8.7). One transaction under `FOR UPDATE` on the prize
 * claim: the payout row, the first owl tranche, the contributor's prized
 * total, the fund's debits, the claim to `paid`, supersession, and the
 * bounty to `paid` once its tie group is terminal.
 */
export async function payPrize(
  prizeClaimId: string,
  opts: { actor?: string; now?: Date; config?: Config } = {}
): Promise<PayPrizeResult | PayPrizeRefusal> {
  const config = opts.config ?? loadConfig();
  const now = opts.now ?? new Date();
  const actor = opts.actor ?? "prize_payout_service";
  const pre = await getPrizeClaimById(prizeClaimId);
  if (!pre) return { ok: false, code: "NOT_FOUND", message: "prize claim not found" };
  const check = await promotionCheck(pre, now);
  const refusal = payRefusal({
    status: pre.status,
    windowElapsed: check.window.elapsed,
    auditOutcome: pre.audit_outcome,
    signoffRequired: check.signoff.required,
    signedOff: pre.signed_off_at !== null,
    payee: pre.payee,
  });
  if (refusal) return { ok: false, ...refusal };

  return withTransaction(async (tx): Promise<PayPrizeResult | PayPrizeRefusal> => {
    const [locked] = await tx.query<{ status: string }>(`SELECT status FROM prize_claims WHERE id = $1 FOR UPDATE`, [prizeClaimId]);
    if (!locked) return { ok: false, code: "NOT_FOUND", message: "prize claim not found" };
    if (locked.status === "paid") {
      const [existing] = await tx.query<{ id: string; amount_micro_usd: string; withholding_micro_usd: string }>(
        `SELECT id, amount_micro_usd, withholding_micro_usd FROM prize_payouts WHERE idempotency_key = $1`,
        [trancheKey(prizeClaimId, 0)]
      );
      return { ok: false, code: "ALREADY_PAID", message: `the prize was already paid${existing ? ` (payout ${existing.id})` : ""}` };
    }
    const pc = (await getPrizeClaimById(prizeClaimId, tx)) as PrizeClaimRow;
    if (pc.status !== "payable" && pc.status !== "defect_award_pending") {
      return { ok: false, code: "NOT_PAYABLE", message: `prize claim is ${pc.status}` };
    }
    const bounty = await getBountyById(pc.bounty_id, tx);
    if (!bounty) return { ok: false, code: "NOT_FOUND", message: "bounty not found" };
    const siblings = await listPrizeClaimsForBounty(pc.bounty_id, tx);
    const sharing = pc.tie_group
      ? siblings.filter((s) => s.tie_group === pc.tie_group && (SHARING_STATUSES as readonly string[]).includes(s.status)).length
      : 1;
    const gross =
      pc.status === "defect_award_pending"
        ? Math.max(0, pc.defect_award_micro_usd ?? 0)
        : tieGroupShare(bounty.amount_micro_usd, sharing);
    if (gross <= 0) return { ok: false, code: "NOT_PAYABLE", message: "nothing is owed" };
    const payee = pc.payee!;
    const withholding = withholdingMicroUsd(gross, {
      usPerson: !!payee.us_person,
      hasTin: !!payee.has_tin,
      treatyPosition: !!payee.treaty_position,
    });
    const net = gross - withholding;
    const schedule = trancheSchedule(pc.id, net, now, config.prizeOwlTrancheUsd);
    const first = schedule[0];

    const [payout] = await tx.query<{ id: string }>(
      `INSERT INTO prize_payouts
         (prize_claim_id, kind, amount_micro_usd, withholding_micro_usd, currency, payee_country,
          tax_form_kind, screening_result, provider, idempotency_key, status, paid_at)
       VALUES ($1, 'owls', $2, $3, 'usd', $4, $5, $6, 'internal', $7, $8, now())
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [pc.id, gross, withholding, payee.country ?? null, payee.tax_form_kind ?? null, payee.screening_result ?? null,
       trancheKey(pc.id, 0), schedule.length > 1 ? "sent" : "paid"]
    );
    if (!payout) {
      return { ok: false, code: "ALREADY_PAID", message: "a payout row already carries this prize claim's key" };
    }
    let granted = 0;
    if (first && first.amount_micro_usd > 0) {
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, contribution_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [pc.claimant_id, first.amount_micro_usd, OWL_REASONS.prizeAward, pc.claim_id, pc.contribution_id, first.idempotency_key]
      );
      if (inserted.length > 0) granted = first.amount_micro_usd;
    }
    if (granted > 0) {
      await tx.query(
        `UPDATE contributors SET owls_prized_micro_usd = owls_prized_micro_usd + $1 WHERE id = $2`,
        [granted, pc.claimant_id]
      );
    }
    if (pc.status === "defect_award_pending") {
      await postDefectAward(
        { poolId: bounty.pool_id, amountMicroUsd: gross, bountyId: bounty.id, prizeClaimId: pc.id, idempotencyKey: `defect_award:${pc.id}` },
        tx
      );
    } else {
      if (net > 0) {
        await postOwlPrizeDebit(
          { poolId: bounty.pool_id, amountMicroUsd: net, bountyId: bounty.id, prizeClaimId: pc.id, idempotencyKey: `owl_prize:${pc.id}` },
          tx
        );
      }
      if (withholding > 0) {
        await postWithholdingRemitted(
          { poolId: bounty.pool_id, amountMicroUsd: withholding, bountyId: bounty.id, prizeClaimId: pc.id, idempotencyKey: `withholding:${pc.id}` },
          tx
        );
      }
    }
    const moved = await transitionPrizeClaim(tx, pc.id, pc.status, "paid", {
      actor,
      reason: `${formatUsd(gross)} paid in owls (${formatUsd(net)} net of ${formatUsd(withholding)} withholding) in ${schedule.length} tranche(s)`,
    });
    if (!moved) return { ok: false, code: "NOT_PAYABLE", message: "the prize claim moved while being paid" };

    let superseded: string[] = [];
    let bountyStatus = bounty.status;
    if (pc.status === "payable") {
      const after = await listPrizeClaimsForBounty(pc.bounty_id, tx);
      const me = { id: pc.id, status: "paid" as const, tie_group: pc.tie_group };
      superseded = claimsToSupersede(after, me);
      for (const id of superseded) {
        const target = after.find((s) => s.id === id)!;
        await transitionPrizeClaim(tx, id, target.status, "superseded", {
          actor,
          reason: "an earlier submission was accepted and paid; this submission is credited on the claim page and no prize is owed",
        });
        await tx.query(`UPDATE contributions SET review_status = 'rejected' WHERE id = $1 AND review_status IN ('checking', 'pending')`, [target.contribution_id]);
      }
      const settled = tieGroupSettled(await listPrizeClaimsForBounty(pc.bounty_id, tx), me);
      if (settled) {
        await closeBounty(bounty.id, "paid", `settled by a checked proof submitted by ${pc.credit_name ?? "a contributor"}; prize of ${formatUsd(gross)} paid`, tx);
        bountyStatus = "paid";
      } else {
        await setBountyStatus(tx, bounty.id, ["open", "claim_pending"], "claim_pending", "a tie-group member was paid; the bounty closes when every member is terminal");
        bountyStatus = "claim_pending";
      }
    } else {
      // A defect award: the bounty is rebinding (or otherwise live); it stays.
      bountyStatus = (await getBountyById(bounty.id, tx))?.status ?? bountyStatus;
    }
    return {
      ok: true,
      prize_claim_id: pc.id,
      payout_id: payout.id,
      gross_micro_usd: gross,
      withholding_micro_usd: withholding,
      net_micro_usd: net,
      first_tranche_micro_usd: granted,
      tranches: schedule.length,
      bounty_status: bountyStatus,
      superseded,
      duplicate: false,
    };
  });
}

/**
 * The tranche sweep: write every tranche whose day has come and whose key
 * has not landed; mark the payout `paid` once the last has. Idempotent by
 * construction (keys), so a re-run never double-grants.
 */
export async function sweepPrizeTranches(now = new Date(), config: Config = loadConfig()): Promise<number> {
  const rows = await rawQuery<{
    id: string;
    prize_claim_id: string;
    amount_micro_usd: string;
    withholding_micro_usd: string;
    paid_at: Date;
    claimant_id: string;
    claim_id: string;
    contribution_id: string;
  }>(
    `SELECT pp.id, pp.prize_claim_id, pp.amount_micro_usd, pp.withholding_micro_usd, pp.paid_at,
            pc.claimant_id, pc.claim_id, pc.contribution_id
       FROM prize_payouts pp JOIN prize_claims pc ON pc.id = pp.prize_claim_id
      WHERE pp.kind = 'owls' AND pp.status = 'sent'`
  );
  let written = 0;
  for (const row of rows) {
    const net = Number(row.amount_micro_usd) - Number(row.withholding_micro_usd);
    const schedule = trancheSchedule(row.prize_claim_id, net, new Date(row.paid_at), config.prizeOwlTrancheUsd);
    let allLanded = true;
    for (const t of schedule) {
      if (new Date(t.due_at).getTime() > now.getTime()) {
        allLanded = false;
        continue;
      }
      const inserted = await rawQuery<{ id: string }>(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, contribution_id, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
        [row.claimant_id, t.amount_micro_usd, OWL_REASONS.prizeAward, row.claim_id, row.contribution_id, t.idempotency_key]
      );
      if (inserted.length > 0) {
        written++;
        await rawQuery(`UPDATE contributors SET owls_prized_micro_usd = owls_prized_micro_usd + $1 WHERE id = $2`, [t.amount_micro_usd, row.claimant_id]);
      }
    }
    if (allLanded) {
      await rawQuery(`UPDATE prize_payouts SET status = 'paid', updated_at = now() WHERE id = $1 AND status = 'sent'`, [row.id]);
    }
  }
  return written;
}

/**
 * Reversal (§8.7): a post-payout voiding after fraud. The payout row is
 * marked reversed and the prize owls are clawed back with negative
 * prize_award rows mirroring clawbackContributionOwls; the balance may go
 * negative. Unwritten tranches never land (the payout is no longer `sent`).
 */
export async function clawbackPrizeOwls(input: {
  prizeClaimId: string;
  actor: string;
  reason: string;
}): Promise<{ reversed_micro_usd: number }> {
  return withTransaction(async (tx) => {
    const pc = await getPrizeClaimById(input.prizeClaimId, tx);
    if (!pc) return { reversed_micro_usd: 0 };
    const [granted] = await tx.query<{ total: string }>(
      `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total FROM owl_ledger
        WHERE user_id = $1 AND contribution_id = $2 AND reason = $3`,
      [pc.claimant_id, pc.contribution_id, OWL_REASONS.prizeAward]
    );
    const total = Number(granted?.total ?? 0);
    await tx.query(
      `UPDATE prize_payouts SET status = 'reversed', reversed_at = now(), updated_at = now()
        WHERE prize_claim_id = $1 AND status IN ('sent', 'paid')`,
      [pc.id]
    );
    if (total <= 0) return { reversed_micro_usd: 0 };
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, contribution_id, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
      [pc.claimant_id, -total, OWL_REASONS.prizeAward, pc.claim_id, pc.contribution_id, `prize:${pc.id}:clawback`]
    );
    if (inserted.length === 0) return { reversed_micro_usd: 0 };
    await tx.query(`UPDATE contributors SET owls_prized_micro_usd = owls_prized_micro_usd - $1 WHERE id = $2`, [total, pc.claimant_id]);
    await tx.query(
      `INSERT INTO audit_log (claim_id, action, reasoning, created_by) VALUES ($1, 'prize_claim:clawback', $2, $3)`,
      [pc.claim_id, `prize claim ${pc.id}: ${formatUsd(total)} of prize owls reversed: ${input.reason}`, input.actor]
    );
    return { reversed_micro_usd: total };
  });
}

/** Prize owls for one contributor, from the ledger (the denormalized column mirrors it). */
export async function prizedMicroUsd(userId: string, tx?: Runner | TxQuery): Promise<number> {
  const [row] = await asRunner(tx).query<{ total: string }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total FROM owl_ledger WHERE user_id = $1 AND reason = $2`,
    [userId, OWL_REASONS.prizeAward]
  );
  return Number(row?.total ?? 0);
}
