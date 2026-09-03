/**
 * Bounties (docs/mathematics.md §8.1, §8.3, §8.5, §8.6): a public offer
 * bound to one published formal statement, drawn from the domain's prize
 * fund, posted by a mandate's Grantmaker in two passes and, at or above the
 * autonomy threshold, confirmed by a person.
 *
 * Lifecycle: requested → confirm_pending → open → claim_pending → paid |
 * resolved_unpaid | open again; open → house_result_pending →
 * resolved_internally | open | rebinding; open → expired | withdrawn |
 * rebinding. `expires_at` and `withdraw_effective_at` are suspended while
 * any prize claim on the bounty is non-terminal, so a live claim never
 * loses its reservation. Nothing is posted to the fund when a bounty opens
 * or closes: the reservation is derived from the live statuses.
 *
 * The prize-review reserve (§8.6) is minted here when a bounty opens: owls
 * worth PRIZE_REVIEW_RESERVE_FRACTION of the amount, minted by the platform
 * at cost (an admin_adjust like the seed's, never a draw on the fund) into a
 * platform-owned budget job held for prize_review actions on this bounty's
 * claims, and released when the bounty closes.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getOrCreateContributor } from "./contributor-service.js";
import { requestAudit } from "./queue-service.js";
import type { BountyStatus, BountySummary, AttemptOutcome } from "./claim-extras-types.js";
import {
  asRunner,
  getOrCreatePool,
  poolNumbers,
  PRIZE_DOMAIN_MATHEMATICS,
  type Runner,
} from "./prize-pool-service.js";

// ---------------------------------------------------------------------------
// Rules version and money units
// ---------------------------------------------------------------------------

/** The official-rules version in force (§8.10); every bounty and claim records it. */
export const PRIZE_RULES_VERSION = "2026-09-01";

/** The rules text the API serves at GET /prizes/rules, in the graph's voice. */
export const PRIZE_RULES_TEXT = `Minerval prize rules, version ${PRIZE_RULES_VERSION}

1. Sponsor. Minerval is the sole obligor of every prize offered on the site. No other person holds funds for a claimant or owes a claimant anything.
2. What is offered. A prize, in the amount shown on the claim page, for the first eligible submission that the checker accepts as a proof or disproof of the formal statement identified on that page by its version, pin, and hashes, and that the claim's steward accepts as faithful to the claim, after the challenge window closes without a successful challenge.
3. The formal statement is the contract. What counts as a solution is the statement as published, under the named Lean toolchain and Mathlib revision, with the allowed axioms propext, Classical.choice, and Quot.sound only, and with the static policy published with these rules. If the statement is found not to say what the claim says, the prize is not owed for proving it; a claimant whose submission exposes the defect receives the defect award of ten percent of the prize, at most $500, drawn from the prize; and the prize re-binds to the corrected statement after fourteen days' notice and the corrected statement's own review period, less any defect award paid.
4. Eligibility. Natural persons aged 18 or over; one payee per submission; not Minerval, its contractors on this program, or funders of the Mathematics mandate; not residents of jurisdictions where the prize cannot lawfully be paid, including comprehensively sanctioned jurisdictions and, for now, Italy and Brazil. Entry is free. Purchasing anything from Minerval confers no advantage.
5. Submissions. Through the claim page's form, with a Lean file, a written account, a tools disclosure, and the declarations. AI assistance is permitted and must be disclosed. A submission is confidential to Minerval and its agents until it is accepted or the prize closes, and is then dedicated to the public domain under CC0 1.0. A submission that reproduces a proof Minerval's own solver produced is not eligible.
6. Priority. The first submission by time of receipt that passes the checker and the steward's review wins. Submissions with identical receipt times that both pass share the prize equally. Once a submission has passed the checker, no further submissions are accepted for that prize unless it is later rejected. There is no random selection at any stage.
7. Review. The checker's verdict is mechanical and public. The steward judges only whether the statement proved is the statement posted. An accepted submission is announced on the claim page and becomes payable after a challenge window of fourteen days (thirty for prizes of $1,000 or more), extended while an admitted challenge is open, up to twice the window. Every acceptance is audited. Prizes of $1,000 or more, and prizes on claims of high importance, require a named person's sign-off.
8. Payment. Prizes are paid in owls, one owl per dollar of the prize. Owls are credit for metered work on the site; they do not expire, cannot be transferred, and are never redeemable for cash. Payment requires identity verification, a tax form, and sanctions screening first, to be completed within ninety days of the prize becoming payable, after which the prize lapses; the amount may be reduced by required withholding.
9. Taxes. Prizes are income to the winner. Minerval reports and withholds as United States law requires.
10. Withdrawal and change. Minerval may withdraw or amend a prize with thirty days' notice on the claim page and the prize listing; submissions received before the effective time are judged under the prior terms. A prize closes without payment if Minerval's own solver produces a checked proof first, in which case the proof is published, or if the only passing submission came from a person who was not eligible.
11. Publicity. The winner's chosen credit name, the proof, and the checker record are published as a matter of record.
12. Versions. These rules are versioned; each prize names the version in force when it was posted, and each submission records the version it was made under.
`;

export function prizeRulesContentHash(): string {
  return createHash("sha256").update(PRIZE_RULES_TEXT).digest("hex");
}

export function usdToMicro(usd: number): number {
  return Math.round(usd * 1_000_000);
}

export function microToUsd(micro: number): number {
  return micro / 1_000_000;
}

/** Amounts render through one helper and never with owl marks (§11.1). */
export function formatUsd(micro: number): string {
  const usd = micro / 1_000_000;
  const whole = Math.floor(usd);
  const cents = Math.round((usd - whole) * 100);
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return cents === 0 ? `$${grouped}` : `$${grouped}.${String(cents).padStart(2, "0")}`;
}

export const PLATFORM_EXTERNAL_ID = "platform:minerval";

/** The platform account (the seed's `platform:minerval`), created on first use. */
export async function getPlatformAccountId(): Promise<string> {
  const row = await getOrCreateContributor({
    externalId: PLATFORM_EXTERNAL_ID,
    displayName: "Minerval",
  });
  return row.id;
}

// ---------------------------------------------------------------------------
// Rows and reads
// ---------------------------------------------------------------------------

export interface BountyRow {
  id: string;
  claim_id: string;
  formalization_id: string;
  pool_id: string;
  condition_type: string;
  resolution: "proof" | "disproof" | "either";
  amount_micro_usd: number;
  status: BountyStatus;
  rules_version: string;
  posted_by_grant_id: string | null;
  rationale: string;
  requested_at: Date;
  opened_at: Date | null;
  expires_at: Date | null;
  human_confirmed_at: Date | null;
  human_confirmed_by: string | null;
  withdraw_effective_at: Date | null;
  resolved_at: Date | null;
  resolution_note: string | null;
}

const BOUNTY_COLS = `id, claim_id, formalization_id, pool_id, condition_type, resolution,
  amount_micro_usd::bigint AS amount_micro_usd, status, rules_version,
  posted_by_grant_id, rationale, requested_at, opened_at, expires_at,
  human_confirmed_at, human_confirmed_by, withdraw_effective_at, resolved_at,
  resolution_note`;

function normalize(row: BountyRow): BountyRow {
  return { ...row, amount_micro_usd: Number(row.amount_micro_usd) };
}

export async function getBountyById(id: string, tx?: Runner): Promise<BountyRow | null> {
  const [row] = await asRunner(tx).query<BountyRow>(
    `SELECT ${BOUNTY_COLS} FROM bounties WHERE id = $1`,
    [id]
  );
  return row ? normalize(row) : null;
}

export const LIVE_BOUNTY_STATUSES: readonly BountyStatus[] = [
  "requested",
  "confirm_pending",
  "open",
  "claim_pending",
  "house_result_pending",
  "rebinding",
];

export const TERMINAL_BOUNTY_STATUSES: readonly BountyStatus[] = [
  "paid",
  "resolved_internally",
  "resolved_unpaid",
  "expired",
  "withdrawn",
];

export function isLiveBountyStatus(status: string): boolean {
  return (LIVE_BOUNTY_STATUSES as readonly string[]).includes(status);
}

/** The one live bounty on a claim, if any (uq_bounty_live_per_claim). */
export async function getLiveBountyForClaim(
  claimId: string,
  tx?: Runner
): Promise<BountyRow | null> {
  const [row] = await asRunner(tx).query<BountyRow>(
    `SELECT ${BOUNTY_COLS} FROM bounties
      WHERE claim_id = $1 AND status = ANY($2)
      ORDER BY requested_at DESC LIMIT 1`,
    [claimId, [...LIVE_BOUNTY_STATUSES]]
  );
  return row ? normalize(row) : null;
}

/** The claim's latest bounty of any status, for the page after a close. */
export async function getLatestBountyForClaim(claimId: string): Promise<BountyRow | null> {
  const live = await getLiveBountyForClaim(claimId);
  if (live) return live;
  const [row] = await rawQuery<BountyRow>(
    `SELECT ${BOUNTY_COLS} FROM bounties WHERE claim_id = $1
      ORDER BY requested_at DESC LIMIT 1`,
    [claimId]
  );
  return row ? normalize(row) : null;
}

/** Prize-claim statuses that keep a bounty's clocks suspended. */
export const NON_TERMINAL_PRIZE_CLAIM_STATUSES = [
  "queued",
  "checking",
  "check_error",
  "checked",
  "in_review",
  "in_challenge_window",
  "payable",
  "defect_award_pending",
] as const;

export async function bountyHasNonTerminalClaim(
  bountyId: string,
  tx?: Runner
): Promise<boolean> {
  const [row] = await asRunner(tx).query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM prize_claims
      WHERE bounty_id = $1 AND status = ANY($2)`,
    [bountyId, [...NON_TERMINAL_PRIZE_CLAIM_STATUSES]]
  );
  return Number(row?.n ?? 0) > 0;
}

/** Every transition writes the claim's audit trail (§8.4). */
export async function logBountyEvent(
  r: Runner,
  bounty: { id: string; claim_id: string },
  action: string,
  reasoning: string,
  createdBy = "prize_service"
): Promise<void> {
  await r.query(
    `INSERT INTO audit_log (claim_id, action, reasoning, created_by)
     VALUES ($1, $2, $3, $4)`,
    [bounty.claim_id, `bounty:${action}`, `bounty ${bounty.id}: ${reasoning}`, createdBy]
  );
  // TODO(formalization slice): emit a `prize` claim event through
  // claim-events-service once it exports the prize event kind.
}

// ---------------------------------------------------------------------------
// The two-pass request and open (§8.1, §10.4)
// ---------------------------------------------------------------------------

export type BountyRefusalCode =
  | "CLAIM_NOT_FOUND"
  | "NO_PUBLISHED_STATEMENT"
  | "REVIEW_PERIOD_OPEN"
  | "NO_CLOSED_ATTEMPT"
  | "AMOUNT_OUT_OF_BOUNDS"
  | "PASS_FRACTION_EXCEEDED"
  | "DAY_FRACTION_EXCEEDED"
  | "INSUFFICIENT_AVAILABLE"
  | "LIVE_BOUNTY_EXISTS"
  | "BOUNTY_NOT_FOUND"
  | "BAD_STATE";

export interface BountyBoundsInput {
  amountMicroUsd: number;
  minUsd: number;
  maxUsd: number;
  balanceMicroUsd: number;
  availableMicroUsd: number;
  committedThisPassMicroUsd: number;
  committedTodayMicroUsd: number;
  fractionPerPass: number;
  fractionPerDay: number;
}

/**
 * The mechanical money bounds on a posting, as a pure function so the
 * request and the open apply the same rule and the tests can pin it:
 * per-claim bounds, the per-pass and per-day fractions of the fund's
 * balance, and `available` covering the amount.
 */
export function checkBountyBounds(
  input: BountyBoundsInput
): { ok: true } | { ok: false; code: BountyRefusalCode; message: string } {
  const amount = Math.round(input.amountMicroUsd);
  const min = usdToMicro(input.minUsd);
  const max = usdToMicro(input.maxUsd);
  if (!(amount >= min && amount <= max)) {
    return {
      ok: false,
      code: "AMOUNT_OUT_OF_BOUNDS",
      message: `a bounty is between ${formatUsd(min)} and ${formatUsd(max)} per claim; ${formatUsd(amount)} was asked`,
    };
  }
  const passCap = Math.floor(input.balanceMicroUsd * input.fractionPerPass);
  if (input.committedThisPassMicroUsd + amount > passCap) {
    return {
      ok: false,
      code: "PASS_FRACTION_EXCEEDED",
      message: `a review pass may commit at most ${formatUsd(passCap)} of the fund; ${formatUsd(input.committedThisPassMicroUsd)} already committed this pass`,
    };
  }
  const dayCap = Math.floor(input.balanceMicroUsd * input.fractionPerDay);
  if (input.committedTodayMicroUsd + amount > dayCap) {
    return {
      ok: false,
      code: "DAY_FRACTION_EXCEEDED",
      message: `bounties opened today may total at most ${formatUsd(dayCap)} of the fund; ${formatUsd(input.committedTodayMicroUsd)} already committed today`,
    };
  }
  if (amount > input.availableMicroUsd) {
    return {
      ok: false,
      code: "INSUFFICIENT_AVAILABLE",
      message: `the fund's available balance is ${formatUsd(input.availableMicroUsd)} (balance less reservations); ${formatUsd(amount)} cannot be reserved`,
    };
  }
  return { ok: true };
}

/** Terminal attempt statuses: a closed attempt (§7.9). */
const TERMINAL_ATTEMPT_STATUSES = [
  "completed",
  "failed",
  "cancelled",
  "refused",
  "budget",
  "orphaned",
  "stale_formalization",
];

/**
 * The statement a bounty may bind to: the claim's published formalization,
 * past its review period, with a closed attempt that produced no accepted
 * check (the solver attempted it without settling it, §10.4).
 */
export async function bindableFormalization(
  claimId: string,
  r: Runner = asRunner()
): Promise<
  | { ok: true; formalizationId: string }
  | { ok: false; code: BountyRefusalCode; message: string }
> {
  const [claim] = await r.query<{ id: string; state: string }>(
    `SELECT id, state FROM claims WHERE id = $1`,
    [claimId]
  );
  if (!claim || claim.state !== "active") {
    return { ok: false, code: "CLAIM_NOT_FOUND", message: "claim not found or not active" };
  }
  const [f] = await r.query<{ id: string; review_period_ends_at: Date | null }>(
    `SELECT id, review_period_ends_at FROM claim_formalizations
      WHERE claim_id = $1 AND status = 'published' LIMIT 1`,
    [claimId]
  );
  if (!f) {
    return {
      ok: false,
      code: "NO_PUBLISHED_STATEMENT",
      message: "the claim carries no published formal statement",
    };
  }
  if (!f.review_period_ends_at || new Date(f.review_period_ends_at).getTime() > Date.now()) {
    return {
      ok: false,
      code: "REVIEW_PERIOD_OPEN",
      message: "the statement's public review period has not ended",
    };
  }
  const [attempt] = await r.query<{ id: string }>(
    `SELECT pa.id FROM proof_attempts pa
      WHERE pa.formalization_id = $1
        AND pa.status = ANY($2)
        AND pa.is_calibration = false
        AND NOT EXISTS (SELECT 1 FROM lean_checks lc
                         WHERE lc.id = pa.lean_check_id AND lc.verdict = 'accepted')
      LIMIT 1`,
    [f.id, TERMINAL_ATTEMPT_STATUSES]
  );
  if (!attempt) {
    return {
      ok: false,
      code: "NO_CLOSED_ATTEMPT",
      message: "the platform's solver has not attempted this statement without settling it",
    };
  }
  return { ok: true, formalizationId: f.id };
}

/** What a mandate has committed to bounties in this pass and today (UTC). */
async function grantCommitments(
  r: Runner,
  grantId: string | null,
  passStartedAt: Date | null
): Promise<{ thisPass: number; today: number }> {
  if (!grantId) return { thisPass: 0, today: 0 };
  const [row] = await r.query<{ pass: string | number; today: string | number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN $2::timestamptz IS NOT NULL
                          AND (opened_at >= $2 OR (status IN ('requested', 'confirm_pending') AND requested_at >= $2))
                         THEN amount_micro_usd ELSE 0 END), 0)::bigint AS pass,
       COALESCE(SUM(CASE WHEN opened_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                          OR (status IN ('requested', 'confirm_pending')
                              AND requested_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')
                         THEN amount_micro_usd ELSE 0 END), 0)::bigint AS today
       FROM bounties
      WHERE posted_by_grant_id = $1
        AND status NOT IN ('expired', 'withdrawn')`,
    [grantId, passStartedAt]
  );
  return { thisPass: Number(row?.pass ?? 0), today: Number(row?.today ?? 0) };
}

export interface RequestBountyInput {
  claimId: string;
  cashUsd: number;
  expiresInDays?: number | null;
  rationale: string;
  grantId: string | null;
  /** The review pass this call belongs to (two-pass anchoring). */
  passStartedAt?: Date | null;
  domain?: string;
}

export type RequestBountyResult =
  | { ok: true; bounty_id: string; status: BountyStatus; opened: false }
  | { ok: false; code: BountyRefusalCode; message: string };

/**
 * The first pass: record the intent as a `requested` bounty. Every
 * mechanical bound is applied here too, so a request that could never open
 * is refused with the reason rather than parked.
 */
export async function requestBounty(input: RequestBountyInput): Promise<RequestBountyResult> {
  const config = loadConfig();
  const domain = input.domain ?? PRIZE_DOMAIN_MATHEMATICS;
  const amount = usdToMicro(Number(input.cashUsd) || 0);
  const rationale = String(input.rationale ?? "").trim();
  return withTransaction(async (tx) => {
    const pool = await getOrCreatePool(domain, tx);
    await tx.query(`SELECT id FROM prize_pools WHERE id = $1 FOR UPDATE`, [pool.id]);
    const bindable = await bindableFormalization(input.claimId, tx);
    if (!bindable.ok) return bindable;
    const live = await getLiveBountyForClaim(input.claimId, tx);
    if (live && live.status !== "requested") {
      return {
        ok: false,
        code: "LIVE_BOUNTY_EXISTS",
        message: `the claim already carries a live bounty (${live.id}, ${live.status})`,
      };
    }
    const numbers = await poolNumbers(pool.id, tx);
    const committed = await grantCommitments(tx, input.grantId, input.passStartedAt ?? null);
    // A re-request of the same claim replaces the pending one; its own
    // amount must not count against itself.
    const priorAmount = live?.status === "requested" ? live.amount_micro_usd : 0;
    const bounds = checkBountyBounds({
      amountMicroUsd: amount,
      minUsd: config.minBountyPerClaimUsd,
      maxUsd: config.maxBountyPerClaimUsd,
      balanceMicroUsd: numbers.balance_micro_usd,
      availableMicroUsd: numbers.available_micro_usd,
      committedThisPassMicroUsd: Math.max(0, committed.thisPass - priorAmount),
      committedTodayMicroUsd: Math.max(0, committed.today - priorAmount),
      fractionPerPass: config.bountyPoolFractionPerPass,
      fractionPerDay: config.bountyPoolFractionPerDay,
    });
    if (!bounds.ok) return bounds;
    const expiresIn = Math.max(
      1,
      Math.min(Number(input.expiresInDays) || config.bountyDefaultExpiryDays, 3650)
    );
    if (live?.status === "requested") {
      await tx.query(
        `UPDATE bounties
            SET amount_micro_usd = $2, rationale = $3, formalization_id = $4,
                resolution_note = $5, requested_at = now(), updated_at = now()
          WHERE id = $1`,
        [live.id, amount, rationale, bindable.formalizationId, `expires_in_days:${expiresIn}`]
      );
      await logBountyEvent(tx, live, "requested", `re-requested at ${formatUsd(amount)}: ${rationale}`);
      return { ok: true, bounty_id: live.id, status: "requested", opened: false };
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO bounties
         (claim_id, formalization_id, pool_id, amount_micro_usd, status,
          rules_version, posted_by_grant_id, rationale, resolution_note)
       VALUES ($1, $2, $3, $4, 'requested', $5, $6, $7, $8)
       RETURNING id`,
      [
        input.claimId,
        bindable.formalizationId,
        pool.id,
        amount,
        PRIZE_RULES_VERSION,
        input.grantId,
        rationale,
        `expires_in_days:${expiresIn}`,
      ]
    );
    await logBountyEvent(
      tx,
      { id: row!.id, claim_id: input.claimId },
      "requested",
      `${formatUsd(amount)} requested by the Grantmaker: ${rationale}`
    );
    return { ok: true, bounty_id: row!.id, status: "requested", opened: false };
  });
}

export type OpenBountyResult =
  | { ok: true; bounty_id: string; status: "open" | "confirm_pending"; opened: boolean }
  | { ok: false; code: BountyRefusalCode; message: string };

/**
 * The second pass (a fresh context re-judging the mission) or the human
 * confirmation: open the bounty, or park it at confirm_pending when the
 * amount is at or above the autonomy threshold. Re-applies every bound
 * under the pool's row lock, so a bounty never opens beyond `available`.
 */
export async function openBounty(input: {
  bountyId: string;
  passStartedAt?: Date | null;
  /** A human confirmation (operator key or the founder in chat). */
  confirmedBy?: string | null;
}): Promise<OpenBountyResult> {
  const config = loadConfig();
  const result = await withTransaction(async (tx): Promise<OpenBountyResult> => {
    const bounty = await getBountyById(input.bountyId, tx);
    if (!bounty) return { ok: false, code: "BOUNTY_NOT_FOUND", message: "bounty not found" };
    if (bounty.status !== "requested" && bounty.status !== "confirm_pending") {
      return {
        ok: false,
        code: "BAD_STATE",
        message: `bounty is ${bounty.status}; only a requested or confirm_pending bounty opens`,
      };
    }
    await tx.query(`SELECT id FROM prize_pools WHERE id = $1 FOR UPDATE`, [bounty.pool_id]);
    await tx.query(`SELECT id FROM bounties WHERE id = $1 FOR UPDATE`, [bounty.id]);
    const bindable = await bindableFormalization(bounty.claim_id, tx);
    if (!bindable.ok) return bindable;
    const numbers = await poolNumbers(bounty.pool_id, tx);
    const committed = await grantCommitments(tx, bounty.posted_by_grant_id, input.passStartedAt ?? null);
    const bounds = checkBountyBounds({
      amountMicroUsd: bounty.amount_micro_usd,
      minUsd: config.minBountyPerClaimUsd,
      maxUsd: config.maxBountyPerClaimUsd,
      balanceMicroUsd: numbers.balance_micro_usd,
      availableMicroUsd: numbers.available_micro_usd,
      committedThisPassMicroUsd: Math.max(0, committed.thisPass - bounty.amount_micro_usd),
      committedTodayMicroUsd: Math.max(0, committed.today - bounty.amount_micro_usd),
      fractionPerPass: config.bountyPoolFractionPerPass,
      fractionPerDay: config.bountyPoolFractionPerDay,
    });
    if (!bounds.ok) return bounds;

    const needsHuman =
      bounty.amount_micro_usd >= usdToMicro(config.bountyAutonomyThresholdUsd) &&
      !input.confirmedBy;
    if (needsHuman) {
      if (bounty.status !== "confirm_pending") {
        await tx.query(
          `UPDATE bounties SET status = 'confirm_pending', updated_at = now() WHERE id = $1`,
          [bounty.id]
        );
        await logBountyEvent(
          tx,
          bounty,
          "confirm_pending",
          `${formatUsd(bounty.amount_micro_usd)} is at or above the autonomy threshold; waiting for a person's confirmation`
        );
      }
      return { ok: true, bounty_id: bounty.id, status: "confirm_pending", opened: false };
    }
    const expiresIn = expiresInDaysOf(bounty.resolution_note, config.bountyDefaultExpiryDays);
    await tx.query(
      `UPDATE bounties
          SET status = 'open', formalization_id = $2, opened_at = now(),
              expires_at = now() + ($3 || ' days')::interval,
              human_confirmed_at = CASE WHEN $4::text IS NULL THEN human_confirmed_at ELSE now() END,
              human_confirmed_by = COALESCE($4, human_confirmed_by),
              resolution_note = NULL, updated_at = now()
        WHERE id = $1`,
      [bounty.id, bindable.formalizationId, String(expiresIn), input.confirmedBy ?? null]
    );
    await logBountyEvent(
      tx,
      bounty,
      "opened",
      `${formatUsd(bounty.amount_micro_usd)} offered for a proof or disproof of the formal statement` +
        (input.confirmedBy ? ` (confirmed by ${input.confirmedBy})` : "")
    );
    await mintPrizeReviewReserve(bounty, tx);
    return { ok: true, bounty_id: bounty.id, status: "open", opened: true };
  });
  if (result.ok && result.opened) {
    await auditOpenedBounty(input.bountyId).catch((err) =>
      console.error(
        "[prize] bounty audit request failed:",
        err instanceof Error ? err.message : err
      )
    );
  }
  return result;
}

function expiresInDaysOf(note: string | null, fallback: number): number {
  const m = /^expires_in_days:(\d+)$/.exec(note ?? "");
  const n = m ? Number(m[1]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Every opened bounty at or above PRIZE_HUMAN_SIGNOFF_USD triggers an audit (§8.1). */
async function auditOpenedBounty(bountyId: string): Promise<void> {
  const config = loadConfig();
  const bounty = await getBountyById(bountyId);
  if (!bounty || bounty.amount_micro_usd < usdToMicro(config.prizeHumanSignoffUsd)) return;
  await requestAudit({
    auditType: "decision_audit",
    triggeredBy: "bounty_posted",
    context:
      `Bounty ${bounty.id} of ${formatUsd(bounty.amount_micro_usd)} opened on claim ` +
      `${bounty.claim_id} (formal statement ${bounty.formalization_id}). Audit the posting: ` +
      `does the statement say what the claim says, has the review period ended, did the ` +
      `solver attempt it without settling it, and is the amount within the mandate's policy? ` +
      `An adverse finding withdraws it before any claim can be filed.`,
    dedupeKey: `bounty_posted:${bounty.id}`,
  });
}

/** POST /bounties/:id/confirm — the human confirmation (operator key). */
export async function confirmBounty(input: {
  bountyId: string;
  confirmedBy: string;
}): Promise<OpenBountyResult> {
  return openBounty({ bountyId: input.bountyId, confirmedBy: input.confirmedBy || "operator" });
}

// ---------------------------------------------------------------------------
// Closing, withdrawal, expiry, rebinding
// ---------------------------------------------------------------------------

/**
 * A terminal transition: the reservation is released by the status change
 * alone (nothing is posted), and the prize-review reserve returns.
 */
export async function closeBounty(
  bountyId: string,
  status: "paid" | "resolved_internally" | "resolved_unpaid" | "expired" | "withdrawn",
  note: string,
  tx?: TxQuery
): Promise<boolean> {
  const run = async (r: Runner): Promise<boolean> => {
    const [row] = await r.query<{ id: string; claim_id: string; status: string }>(
      `UPDATE bounties
          SET status = $2, resolved_at = now(), resolution_note = $3, updated_at = now()
        WHERE id = $1 AND status = ANY($4)
        RETURNING id, claim_id, status`,
      [bountyId, status, note, [...LIVE_BOUNTY_STATUSES]]
    );
    if (!row) return false;
    await logBountyEvent(r, row, status, note);
    await releasePrizeReviewReserve(bountyId, r);
    return true;
  };
  return tx ? run(tx) : withTransaction(run);
}

export async function setBountyStatus(
  r: Runner,
  bountyId: string,
  from: BountyStatus | BountyStatus[],
  to: BountyStatus,
  note: string
): Promise<boolean> {
  const froms = Array.isArray(from) ? from : [from];
  const [row] = await r.query<{ id: string; claim_id: string }>(
    `UPDATE bounties SET status = $2, updated_at = now()
      WHERE id = $1 AND status = ANY($3)
      RETURNING id, claim_id`,
    [bountyId, to, froms]
  );
  if (!row) return false;
  await logBountyEvent(r, row, to, note);
  return true;
}

/**
 * Withdrawal is prospective only (§8.1, §9.1): `withdraw_effective_at` is
 * set to now + BOUNTY_NOTICE_DAYS and the closer applies it once no claim is
 * live. A bounty not yet open withdraws at once, since no offer was made.
 */
export async function withdrawBounty(input: {
  bountyId: string;
  rationale: string;
  actor: string;
}): Promise<
  | { ok: true; status: BountyStatus; effective_at: string | null }
  | { ok: false; code: BountyRefusalCode; message: string }
> {
  const config = loadConfig();
  return withTransaction(async (tx) => {
    const bounty = await getBountyById(input.bountyId, tx);
    if (!bounty) return { ok: false, code: "BOUNTY_NOT_FOUND", message: "bounty not found" };
    if (bounty.status === "requested" || bounty.status === "confirm_pending") {
      await closeBounty(bounty.id, "withdrawn", `withdrawn before opening by ${input.actor}: ${input.rationale}`, tx);
      return { ok: true, status: "withdrawn", effective_at: null };
    }
    if (!isLiveBountyStatus(bounty.status)) {
      return { ok: false, code: "BAD_STATE", message: `bounty is already ${bounty.status}` };
    }
    const [row] = await tx.query<{ withdraw_effective_at: Date }>(
      `UPDATE bounties
          SET withdraw_effective_at = COALESCE(withdraw_effective_at, now() + ($2 || ' days')::interval),
              updated_at = now()
        WHERE id = $1 RETURNING withdraw_effective_at`,
      [bounty.id, String(config.bountyNoticeDays)]
    );
    await logBountyEvent(
      tx,
      bounty,
      "withdrawal_noticed",
      `withdrawal by ${input.actor} with ${config.bountyNoticeDays} days' notice: ${input.rationale}`
    );
    return {
      ok: true,
      status: bounty.status,
      effective_at: new Date(row!.withdraw_effective_at).toISOString(),
    };
  });
}

/**
 * The closer's pass over dated bounties: expiry and withdrawal apply only
 * when their dates have passed and no prize claim is non-terminal.
 */
export async function expireAndWithdrawDueBounties(): Promise<{ expired: number; withdrawn: number }> {
  const due = await rawQuery<{ id: string; kind: "withdrawn" | "expired" }>(
    `SELECT b.id,
            CASE WHEN b.withdraw_effective_at IS NOT NULL AND b.withdraw_effective_at <= now()
                 THEN 'withdrawn' ELSE 'expired' END AS kind
       FROM bounties b
      WHERE b.status IN ('open', 'rebinding', 'claim_pending', 'house_result_pending')
        AND ((b.withdraw_effective_at IS NOT NULL AND b.withdraw_effective_at <= now())
             OR (b.expires_at IS NOT NULL AND b.expires_at <= now()))
        AND NOT EXISTS (SELECT 1 FROM prize_claims pc
                         WHERE pc.bounty_id = b.id AND pc.status = ANY($1))`,
    [[...NON_TERMINAL_PRIZE_CLAIM_STATUSES]]
  );
  let expired = 0;
  let withdrawn = 0;
  for (const row of due) {
    const closed = await closeBounty(
      row.id,
      row.kind,
      row.kind === "withdrawn"
        ? "withdrawn after the notice period; the reservation returns to the fund"
        : "expired; the reservation returns to the fund"
    );
    if (!closed) continue;
    if (row.kind === "withdrawn") withdrawn++;
    else expired++;
  }
  return { expired, withdrawn };
}

/**
 * Re-bind `rebinding` bounties (§8.5) to the claim's corrected statement
 * mechanically, at the later of a 14-day notice from retirement and the
 * corrected statement's review period end, at the amount less any defect
 * award already paid. Nothing rebinds while a withdrawal notice stands.
 */
export async function rebindDueBounties(): Promise<number> {
  const rows = await rawQuery<{
    id: string;
    claim_id: string;
    amount_micro_usd: string | number;
    new_formalization_id: string;
    defect_paid: string | number;
  }>(
    `SELECT b.id, b.claim_id, b.amount_micro_usd, f.id AS new_formalization_id,
            COALESCE((SELECT -SUM(e.amount_micro_usd) FROM prize_pool_entries e
                       WHERE e.bounty_id = b.id AND e.reason = 'defect_award'), 0)::bigint AS defect_paid
       FROM bounties b
       JOIN claim_formalizations f
         ON f.claim_id = b.claim_id AND f.status = 'published'
        AND f.id <> b.formalization_id
        AND f.review_period_ends_at IS NOT NULL AND f.review_period_ends_at <= now()
       JOIN claim_formalizations old ON old.id = b.formalization_id
      WHERE b.status = 'rebinding'
        AND b.withdraw_effective_at IS NULL
        AND COALESCE(old.retired_at, b.updated_at) + interval '14 days' <= now()
        AND NOT EXISTS (SELECT 1 FROM prize_claims pc
                         WHERE pc.bounty_id = b.id AND pc.status = ANY($1))`,
    [[...NON_TERMINAL_PRIZE_CLAIM_STATUSES]]
  );
  let rebound = 0;
  for (const row of rows) {
    const amount = Number(row.amount_micro_usd) - Number(row.defect_paid);
    if (amount <= 0) {
      await closeBounty(row.id, "resolved_unpaid", "the defect award consumed the whole bounty; nothing remains to rebind");
      continue;
    }
    await withTransaction(async (tx) => {
      const [updated] = await tx.query<{ id: string; claim_id: string }>(
        `UPDATE bounties
            SET status = 'open', formalization_id = $2, amount_micro_usd = $3,
                opened_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'rebinding'
          RETURNING id, claim_id`,
        [row.id, row.new_formalization_id, amount]
      );
      if (!updated) return;
      await logBountyEvent(
        tx,
        updated,
        "rebound",
        `re-bound to the corrected statement ${row.new_formalization_id} at ${formatUsd(amount)}`
      );
      rebound++;
    });
  }
  return rebound;
}

// ---------------------------------------------------------------------------
// The prize-review reserve (§8.6)
// ---------------------------------------------------------------------------

export const PRIZE_RESERVE_JOB_KIND = "prize_review_reserve";

export function reserveMicroUsdFor(amountMicroUsd: number, fraction: number): number {
  return Math.floor(Math.round(amountMicroUsd) * fraction);
}

export interface ReserveJob {
  id: string;
  user_id: string;
  budget_micro_usd: number;
  status: string;
}

export async function getReserveJob(bountyId: string, tx?: Runner): Promise<ReserveJob | null> {
  const [row] = await asRunner(tx).query<ReserveJob>(
    `SELECT id, user_id, budget_micro_usd::bigint AS budget_micro_usd, status
       FROM budget_jobs
      WHERE kind = $1 AND checkpoint->>'bounty_id' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [PRIZE_RESERVE_JOB_KIND, bountyId]
  );
  return row ? { ...row, budget_micro_usd: Number(row.budget_micro_usd) } : null;
}

/**
 * Mint the reserve: owls worth the fraction of the bounty, minted by the
 * platform at cost (admin_adjust) and escrowed into a platform-owned job
 * held for this bounty. Idempotent per bounty; the fund is never touched.
 */
export async function mintPrizeReviewReserve(
  bounty: { id: string; claim_id: string; amount_micro_usd: number },
  tx?: Runner
): Promise<ReserveJob | null> {
  const config = loadConfig();
  const r = asRunner(tx);
  const reserve = reserveMicroUsdFor(bounty.amount_micro_usd, config.prizeReviewReserveFraction);
  if (reserve <= 0) return null;
  const existing = await getReserveJob(bounty.id, r);
  if (existing) return existing;
  const platformId = await getPlatformAccountId();
  await r.query(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
     VALUES ($1, $2, 'admin_adjust', $3, $4)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [platformId, reserve, bounty.claim_id, `prize_reserve_mint:${bounty.id}`]
  );
  const [job] = await r.query<{ id: string }>(
    `INSERT INTO budget_jobs (user_id, kind, claim_id, budget_micro_usd, status, checkpoint)
     VALUES ($1, $2, $3, $4, 'running', $5::jsonb)
     RETURNING id`,
    [
      platformId,
      PRIZE_RESERVE_JOB_KIND,
      bounty.claim_id,
      reserve,
      JSON.stringify({ bounty_id: bounty.id, note: "prize-review reserve" }),
    ]
  );
  await r.query(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, job_id, idempotency_key)
     VALUES ($1, $2, 'escrow_hold', $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [platformId, -reserve, bounty.claim_id, job!.id, `prize_reserve_hold:${bounty.id}`]
  );
  return { id: job!.id, user_id: platformId, budget_micro_usd: reserve, status: "running" };
}

/**
 * Release the reserve when the bounty closes: live allocations on this
 * bounty's prize_review actions release (their unspent part returns through
 * the ordinary settlement rows), open actions cancel, and the part of the
 * hold that was never placed on an action returns as an escrow_refund. What
 * the platform gets back is the reserve less what the reviews actually
 * cost. Idempotent per bounty.
 */
export async function releasePrizeReviewReserve(
  bountyId: string,
  tx?: Runner
): Promise<number> {
  const r = asRunner(tx);
  const job = await getReserveJob(bountyId, r);
  if (!job || job.status !== "running") return 0;
  const live = await r.query<{ id: string; user_id: string | null; claim_id: string | null; unspent: string | number }>(
    `SELECT al.id, al.user_id, al.claim_id,
            (al.amount_micro_usd - al.spent_micro_usd)::bigint AS unspent
       FROM action_allocations al
       JOIN actions a ON a.id = al.action_id
       JOIN prize_claims pc ON pc.id::text = a.target_ref
      WHERE a.kind = 'prize_review' AND pc.bounty_id = $1 AND al.released_at IS NULL`,
    [bountyId]
  );
  for (const al of live) {
    await r.query(`UPDATE action_allocations SET released_at = now() WHERE id = $1`, [al.id]);
    if (al.user_id && Number(al.unspent) > 0) {
      await r.query(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
         VALUES ($1, $2, 'refund', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [al.user_id, Number(al.unspent), al.claim_id, `release:${al.id}`]
      );
    }
  }
  await r.query(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.kind = 'prize_review' AND a.status IN ('open', 'running')
        AND EXISTS (SELECT 1 FROM prize_claims pc WHERE pc.id::text = a.target_ref AND pc.bounty_id = $1)`,
    [bountyId]
  );
  const [placed] = await r.query<{ total: string | number }>(
    `SELECT COALESCE(SUM(al.amount_micro_usd), 0)::bigint AS total
       FROM action_allocations al
       JOIN actions a ON a.id = al.action_id
       JOIN prize_claims pc ON pc.id::text = a.target_ref
      WHERE a.kind = 'prize_review' AND pc.bounty_id = $1 AND al.user_id = $2`,
    [bountyId, job.user_id]
  );
  const remainder = Math.max(0, job.budget_micro_usd - Number(placed?.total ?? 0));
  if (remainder > 0) {
    await r.query(
      `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, job_id, idempotency_key)
       VALUES ($1, $2, 'escrow_refund', $3, $4)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [job.user_id, remainder, job.id, `prize_reserve_release:${bountyId}`]
    );
  }
  await r.query(
    `UPDATE budget_jobs SET status = 'completed', completed_at = now(), updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [job.id]
  );
  return remainder;
}

/** What the reserve has left to place on a new prize_review action. */
export async function reserveRoomMicroUsd(bountyId: string, tx?: Runner): Promise<{ job: ReserveJob | null; room: number }> {
  const r = asRunner(tx);
  const job = await getReserveJob(bountyId, r);
  if (!job) return { job: null, room: 0 };
  const [placed] = await r.query<{ total: string | number }>(
    `SELECT COALESCE(SUM(al.amount_micro_usd), 0)::bigint AS total
       FROM action_allocations al
       JOIN actions a ON a.id = al.action_id
       JOIN prize_claims pc ON pc.id::text = a.target_ref
      WHERE a.kind = 'prize_review' AND pc.bounty_id = $1 AND al.user_id = $2`,
    [bountyId, job.user_id]
  );
  return { job, room: Math.max(0, job.budget_micro_usd - Number(placed?.total ?? 0)) };
}

// ---------------------------------------------------------------------------
// Read models (§8.3, §11.1)
// ---------------------------------------------------------------------------

export interface StateSentenceInput {
  status: BountyStatus;
  amountMicroUsd: number;
  openedAt: Date | null;
  withdrawEffectiveAt: Date | null;
  liveClaim: { status: string; credit_name: string | null; window_ends_at: Date | null; accepted_at: Date | null } | null;
  awarded: { credit_name: string; paid_at: Date; amount_micro_usd: number } | null;
}

function dateWords(d: Date | string | null): string {
  if (!d) return "an unrecorded date";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** The state sentence beneath the button, in the graph's voice (§8.3). */
export function bountyStateSentence(input: StateSentenceInput): string {
  const c = input.liveClaim;
  switch (input.status) {
    case "requested":
    case "confirm_pending":
      return "A prize has been proposed for this statement and is not yet open.";
    case "open": {
      const base = `Open since ${dateWords(input.openedAt)}.`;
      if (c?.status === "queued" || c?.status === "checking" || c?.status === "check_error") {
        return "A submission is being checked.";
      }
      return input.withdrawEffectiveAt
        ? `${base} Minerval has given notice that this prize is withdrawn from ${dateWords(input.withdrawEffectiveAt)}; submissions received before then are judged under the prior terms.`
        : base;
    }
    case "claim_pending": {
      if (c?.status === "checked" || c?.status === "in_review") {
        return "A submission passed the checker and awaits review.";
      }
      if (c?.status === "in_challenge_window") {
        return `Accepted on ${dateWords(c.accepted_at)} and payable after ${dateWords(c.window_ends_at)} unless a challenge succeeds.`;
      }
      if (c?.status === "payable" || c?.status === "defect_award_pending") {
        return "Accepted; the prize is being paid.";
      }
      return "A submission is being checked.";
    }
    case "house_result_pending":
      return "Minerval's own solver produced a checked proof; the prize is held while submissions received earlier are judged.";
    case "rebinding":
      return "The formal statement was revised after this prize was posted and the prize is held until the revised statement is confirmed.";
    case "paid":
      return input.awarded
        ? `Settled by a checked proof submitted by ${input.awarded.credit_name} on ${dateWords(input.awarded.paid_at)}; prize of ${formatUsd(input.awarded.amount_micro_usd)} paid.`
        : "Settled by a checked proof; the prize was paid.";
    case "resolved_internally":
      return "Closed without a payout when Minerval's own solver produced a checked proof.";
    case "resolved_unpaid":
      return "Closed without a payout because no eligible claimant earned it.";
    case "expired":
      return "This prize expired without a qualifying submission.";
    case "withdrawn":
      return "This prize was withdrawn after public notice.";
    default:
      return "";
  }
}

export async function bountySummary(bounty: BountyRow): Promise<BountySummary> {
  const [f] = await rawQuery<{ source_hash: string; expr_hash: string; pin_id: string }>(
    `SELECT source_hash, expr_hash, pin_id FROM claim_formalizations WHERE id = $1`,
    [bounty.formalization_id]
  );
  const [subs] = await rawQuery<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM prize_claims WHERE bounty_id = $1`,
    [bounty.id]
  );
  const attempts = await rawQuery<{
    id: string;
    finished_at: Date;
    variant: "standard" | "max";
    spent_micro_usd: string | number;
    outcome: AttemptOutcome | null;
  }>(
    `SELECT id, finished_at, variant, spent_micro_usd, outcome
       FROM proof_attempts
      WHERE formalization_id = $1 AND finished_at IS NOT NULL AND is_calibration = false
      ORDER BY finished_at DESC LIMIT 10`,
    [bounty.formalization_id]
  );
  const [live] = await rawQuery<{
    status: string;
    credit_name: string | null;
    window_ends_at: Date | null;
    accepted_at: string | null;
  }>(
    `SELECT status, credit_name, window_ends_at, steward_decision->>'at' AS accepted_at
       FROM prize_claims
      WHERE bounty_id = $1 AND status = ANY($2)
      ORDER BY submitted_at ASC, id ASC LIMIT 1`,
    [bounty.id, [...NON_TERMINAL_PRIZE_CLAIM_STATUSES]]
  );
  const [paid] = await rawQuery<{ credit_name: string | null; paid_at: Date; amount_micro_usd: string | number }>(
    `SELECT pc.credit_name, pp.paid_at, pp.amount_micro_usd
       FROM prize_claims pc JOIN prize_payouts pp ON pp.prize_claim_id = pc.id
      WHERE pc.bounty_id = $1 AND pc.status = 'paid' AND pp.paid_at IS NOT NULL
      ORDER BY pp.paid_at ASC LIMIT 1`,
    [bounty.id]
  );
  const awarded = paid
    ? {
        credit_name: paid.credit_name ?? "a contributor",
        paid_at: new Date(paid.paid_at),
        amount_micro_usd: Number(paid.amount_micro_usd),
      }
    : null;
  return {
    id: bounty.id,
    amount_micro_usd: bounty.amount_micro_usd,
    status: bounty.status,
    resolution: bounty.resolution,
    formalization_id: bounty.formalization_id,
    source_hash: f?.source_hash ?? "",
    expr_hash: f?.expr_hash ?? "",
    pin_id: f?.pin_id ?? "",
    opened_at: bounty.opened_at ? new Date(bounty.opened_at).toISOString() : null,
    expires_at: bounty.expires_at ? new Date(bounty.expires_at).toISOString() : null,
    withdraw_effective_at: bounty.withdraw_effective_at
      ? new Date(bounty.withdraw_effective_at).toISOString()
      : null,
    rules_version: bounty.rules_version,
    submissions: Number(subs?.n ?? 0),
    attempts: attempts.map((a) => ({
      id: a.id,
      finished_at: new Date(a.finished_at).toISOString(),
      variant: a.variant,
      cost_micro_usd: Number(a.spent_micro_usd),
      outcome: a.outcome ?? "none",
    })),
    awarded: awarded
      ? { ...awarded, paid_at: awarded.paid_at.toISOString() }
      : null,
    state_sentence: bountyStateSentence({
      status: bounty.status,
      amountMicroUsd: bounty.amount_micro_usd,
      openedAt: bounty.opened_at ? new Date(bounty.opened_at) : null,
      withdrawEffectiveAt: bounty.withdraw_effective_at ? new Date(bounty.withdraw_effective_at) : null,
      liveClaim: live
        ? {
            status: live.status,
            credit_name: live.credit_name,
            window_ends_at: live.window_ends_at ? new Date(live.window_ends_at) : null,
            accepted_at: live.accepted_at ? new Date(live.accepted_at) : null,
          }
        : null,
      awarded,
    }),
    terms_url: `/prizes/rules/${bounty.rules_version}`,
  };
}

/** The `terms` object an outside solver needs (GET /claims/:id/bounty). */
export function bountyTerms(bounty: BountyRow, summary: BountySummary) {
  return {
    allowed_axioms: ["propext", "Classical.choice", "Quot.sound"],
    static_policy:
      "No sorry, admit, axiom, native_decide, import, unsafe, or partial declarations; the submission proves or disproves the published statement under the pinned toolchain and Mathlib revision.",
    resolution: bounty.resolution,
    statement: {
      formalization_id: bounty.formalization_id,
      source_hash: summary.source_hash,
      expr_hash: summary.expr_hash,
      pin_id: summary.pin_id,
      statement_url: `/claims/${bounty.claim_id}/formalization.lean`,
    },
    window: {
      state: summary.state_sentence,
      rules_version: bounty.rules_version,
      rules_url: summary.terms_url,
    },
  };
}

export interface OpenBountyListing {
  claim_id: string;
  claim_text: string;
  bounty: BountySummary;
}

/** GET /prizes — open bounties across the graph, largest first, paged. */
export async function listOpenBounties(opts: {
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: OpenBountyListing[]; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await rawQuery<BountyRow & { claim_text: string }>(
    `SELECT ${BOUNTY_COLS.replace(/(^|,\s*)id,/, "$1b.id,").replace(/\b(claim_id|formalization_id|pool_id|condition_type|resolution|status|rules_version|posted_by_grant_id|rationale|requested_at|opened_at|expires_at|human_confirmed_at|human_confirmed_by|withdraw_effective_at|resolved_at|resolution_note)\b/g, "b.$1").replace("amount_micro_usd::bigint", "b.amount_micro_usd::bigint")},
            c.text AS claim_text
       FROM bounties b JOIN claims c ON c.id = b.claim_id
      WHERE b.status IN ('open', 'claim_pending')
      ORDER BY b.amount_micro_usd DESC, b.opened_at ASC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const [count] = await rawQuery<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM bounties WHERE status IN ('open', 'claim_pending')`
  );
  const items: OpenBountyListing[] = [];
  for (const row of rows) {
    items.push({
      claim_id: row.claim_id,
      claim_text: row.claim_text,
      bounty: await bountySummary(normalize(row)),
    });
  }
  return { items, total: Number(count?.n ?? 0) };
}

function xmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (ch) =>
    ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === "&" ? "&amp;" : ch === "'" ? "&apos;" : "&quot;"
  );
}

/** GET /prizes.atom — the same listing as an Atom feed. */
export function openBountiesAtom(items: OpenBountyListing[], baseUrl = ""): string {
  const updated = items
    .map((i) => i.bounty.opened_at ?? "")
    .filter(Boolean)
    .sort()
    .at(-1) ?? new Date().toISOString();
  const entries = items
    .map(
      (i) =>
        `  <entry>\n` +
        `    <id>urn:minerval:bounty:${i.bounty.id}</id>\n` +
        `    <title>${xmlEscape(`${formatUsd(i.bounty.amount_micro_usd)} for a proof or disproof: ${i.claim_text}`)}</title>\n` +
        `    <link href="${xmlEscape(`${baseUrl}/claims/${i.claim_id}`)}"/>\n` +
        `    <updated>${i.bounty.opened_at ?? updated}</updated>\n` +
        `    <summary>${xmlEscape(i.bounty.state_sentence)}</summary>\n` +
        `  </entry>`
    )
    .join("\n");
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<feed xmlns="http://www.w3.org/2005/Atom">\n` +
    `  <title>Minerval open prizes</title>\n` +
    `  <id>urn:minerval:prizes</id>\n` +
    `  <link href="${xmlEscape(`${baseUrl}/prizes`)}"/>\n` +
    `  <updated>${updated}</updated>\n` +
    `${entries}\n</feed>\n`
  );
}

export interface MandatePrizesBlock {
  pool_balance_micro_usd: number;
  reserved_micro_usd: number;
  bounties_posted: number;
  bounties_total_micro_usd: number;
  prizes_paid: number;
  owls_paid: number;
  bounties: Array<{
    id: string;
    claim_id: string;
    claim_text: string;
    amount_micro_usd: number;
    status: BountyStatus;
    opened_at: string | null;
    submissions: number;
    outcome: string;
    reserve_micro_usd: number;
    reserve_spent_micro_usd: number;
  }>;
}

/** The mandate page's Prizes section (§8.3): tiles and the bounty table. */
export async function mandatePrizesBlock(grantId: string): Promise<MandatePrizesBlock> {
  const pool = await getOrCreatePool(PRIZE_DOMAIN_MATHEMATICS);
  const numbers = await poolNumbers(pool.id);
  const rows = await rawQuery<{
    id: string;
    claim_id: string;
    claim_text: string;
    amount_micro_usd: string | number;
    status: BountyStatus;
    opened_at: Date | null;
    resolution_note: string | null;
    submissions: string | number;
    reserve: string | number;
    reserve_spent: string | number;
  }>(
    `SELECT b.id, b.claim_id, c.text AS claim_text, b.amount_micro_usd, b.status,
            b.opened_at, b.resolution_note,
            (SELECT COUNT(*) FROM prize_claims pc WHERE pc.bounty_id = b.id)::int AS submissions,
            COALESCE((SELECT j.budget_micro_usd FROM budget_jobs j
                       WHERE j.kind = $2 AND j.checkpoint->>'bounty_id' = b.id::text
                       ORDER BY j.created_at DESC LIMIT 1), 0)::bigint AS reserve,
            COALESCE((SELECT SUM(u.cost_micro_usd) FROM llm_usage u
                       JOIN budget_jobs j ON j.id = u.job_id
                      WHERE j.kind = $2 AND j.checkpoint->>'bounty_id' = b.id::text), 0)::bigint AS reserve_spent
       FROM bounties b JOIN claims c ON c.id = b.claim_id
      WHERE b.posted_by_grant_id = $1
      ORDER BY b.requested_at DESC`,
    [grantId, PRIZE_RESERVE_JOB_KIND]
  );
  const [paid] = await rawQuery<{ n: string; owls: string | number }>(
    `SELECT COUNT(DISTINCT pc.id)::int AS n,
            COALESCE(SUM(pp.amount_micro_usd - pp.withholding_micro_usd), 0)::bigint AS owls
       FROM prize_claims pc
       JOIN bounties b ON b.id = pc.bounty_id
       JOIN prize_payouts pp ON pp.prize_claim_id = pc.id AND pp.kind = 'owls'
      WHERE b.posted_by_grant_id = $1 AND pc.status = 'paid'`,
    [grantId]
  );
  const posted = rows.filter((r) => !["requested", "confirm_pending"].includes(r.status));
  return {
    pool_balance_micro_usd: numbers.balance_micro_usd,
    reserved_micro_usd: numbers.reserved_micro_usd,
    bounties_posted: posted.length,
    bounties_total_micro_usd: posted.reduce((s, r) => s + Number(r.amount_micro_usd), 0),
    prizes_paid: Number(paid?.n ?? 0),
    owls_paid: Number(paid?.owls ?? 0) / 1_000_000,
    bounties: rows.map((r) => ({
      id: r.id,
      claim_id: r.claim_id,
      claim_text: r.claim_text,
      amount_micro_usd: Number(r.amount_micro_usd),
      status: r.status,
      opened_at: r.opened_at ? new Date(r.opened_at).toISOString() : null,
      submissions: Number(r.submissions),
      outcome: (TERMINAL_BOUNTY_STATUSES as readonly string[]).includes(r.status)
        ? (r.resolution_note ?? r.status)
        : r.status,
      reserve_micro_usd: Number(r.reserve),
      reserve_spent_micro_usd: Number(r.reserve_spent),
    })),
  };
}
