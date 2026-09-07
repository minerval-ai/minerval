/**
 * Bounties (docs/mathematics.md §8.1, §8.3, §8.5, §8.6): a public offer
 * bound to one published formal statement, denominated in owls, posted by
 * a mandate's Grantmaker in two passes and, at or above the autonomy
 * threshold, confirmed by a person, and held against that mandate's escrow
 * from the moment it opens until it resolves.
 *
 * There is no prize fund. A bounty's amount is a term in the posting
 * mandate's committed money (prize-commitment.ts), beside allocation
 * shares, non-ledger metered spend, and regrants out; the allocator, the
 * regrant path, and the mandate's closing settlement read that one number,
 * so a mandate never promises the same owl to an attempt and to a prize.
 * A posting is bounded by the mandate's headroom (budget less committed)
 * and by per-pass and per-day fractions of its escrow budget, and it takes
 * the mandate's allocator lock, so a posting and an allocation pass
 * serialize on the same headroom. When the prize is paid the payout row is
 * the record and the hold becomes consumption; when the bounty expires, is
 * withdrawn, or is settled by the platform's own solver, the hold lapses.
 * Nothing is posted when a bounty opens or closes.
 *
 * Lifecycle: requested → confirm_pending → open → claim_pending → paid |
 * resolved_unpaid | open again; open → house_result_pending →
 * resolved_internally | open | rebinding; open → expired | withdrawn |
 * rebinding. `expires_at` and `withdraw_effective_at` are suspended while
 * any prize claim on the bounty is non-terminal, so a live claim never
 * loses its hold.
 *
 * The prize-review reserve (§8.6) is minted here when a bounty opens: owls
 * worth PRIZE_REVIEW_RESERVE_FRACTION of the amount, minted by the platform
 * at cost into a platform-owned budget job held for prize_review actions
 * on this bounty's claims, released when the bounty closes, and counted
 * against the posting mandate through the same prize term.
 */
import { createHash } from "node:crypto";
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { getOrCreateContributor } from "./contributor-service.js";
import { requestAudit } from "./queue-service.js";
import { emitClaimEvent } from "./claim-events-service.js";
import { checkedKindSql } from "./formalization-service.js";
import { owlCostMicroUsd, owlsToMicroUsd } from "./owl.js";
import { grantCommittedMicroUsd } from "./regrant-service.js";
import { asRunner, type Runner } from "./query-runner.js";
import {
  HOLDING_BOUNTY_STATUSES,
  PRIZE_RESERVE_JOB_KIND,
  isHoldingBountyStatus,
  prizeCommitmentBreakdown,
} from "./prize-commitment.js";
import type { BountyStatus, BountySummary, AttemptOutcome } from "./claim-extras-types.js";

export { HOLDING_BOUNTY_STATUSES, PRIZE_RESERVE_JOB_KIND, isHoldingBountyStatus };

// ---------------------------------------------------------------------------
// Rules version and money units
// ---------------------------------------------------------------------------

/** The official-rules version in force (§8.10); every bounty and claim records it. */
export const PRIZE_RULES_VERSION = "2026-09-04";

/** The rules text the API serves at GET /prizes/rules, in the graph's voice. */
export const PRIZE_RULES_TEXT = `Minerval prize rules, version ${PRIZE_RULES_VERSION}

1. Sponsor. Minerval is the sole obligor of every prize offered on the site. No other person holds funds for a claimant or owes a claimant anything.
2. What is offered. A prize, in the amount shown on the claim page, for the first eligible submission that the checker accepts as a proof or disproof of the formal statement identified on that page by its version, pin, and hashes, and that the claim's steward accepts as faithful to the claim, after the challenge window closes without a successful challenge.
3. The formal statement is the contract. What counts as a solution is the statement as published, under the named Lean toolchain and Mathlib revision, with the allowed axioms propext, Classical.choice, and Quot.sound only (Lean's standard classical foundation), and with the static policy published with these rules. If the statement is found not to say what the claim says, the prize is not owed for proving it; a claimant whose submission exposes the defect receives the defect award of ten percent of the prize, at most 500 owls, drawn from the prize; a person who exposes a defect during the statement's public review period, before any prize is offered, receives a fixed review award of 100 owls; and the prize re-binds to the corrected statement after fourteen days' notice and the corrected statement's own review period, less any defect award paid.
4. Eligibility. Natural persons aged 18 or over; one payee per submission; not Minerval, its contractors on this program, or a person who funded the mandate that posted the prize; not residents of jurisdictions where the prize cannot lawfully be paid, including comprehensively sanctioned jurisdictions and, for now, Italy and Brazil. Entry is free. Purchasing anything from Minerval confers no advantage.
5. Submissions. Through the claim page's form, with a Lean file, a written account, a tools disclosure, and the declarations. AI assistance is permitted and must be disclosed. A submission is confidential to Minerval and its agents until it is accepted or the prize closes, and is then dedicated to the public domain under CC0 1.0. A submission that reproduces a proof Minerval's own solver produced is not eligible.
6. Priority. The first submission by time of receipt that passes the checker and the steward's review wins. Submissions with identical receipt times that both pass share the prize equally. Once a submission has passed the checker, no further submissions are accepted for that prize unless it is later rejected. There is no random selection at any stage.
7. Review. The checker's verdict is mechanical and public. The steward judges only whether the statement proved is the statement posted. An accepted submission is announced on the claim page and becomes payable after a challenge window of fourteen days (thirty for prizes of 1,000 owls or more), extended while an admitted challenge is open, up to twice the window. Challenges may be filed only on the listed grounds, with evidence. Every acceptance is audited. Prizes of 1,000 owls or more, and prizes on claims of high importance, require a named person's sign-off.
8. Payment. Prizes are stated and paid in owls. Owls are credit for metered work on the site, valued at one dollar of metered cost each; they do not expire, cannot be transferred, and are never redeemable for cash. Payment requires identity verification, a tax form, and sanctions screening first, to be completed within ninety days of the prize becoming payable, after which the prize lapses; the amount may be reduced by required withholding.
9. Taxes. Prizes are income to the winner. Minerval reports and withholds as United States law requires.
10. Withdrawal and change. Minerval may withdraw or amend a prize with thirty days' notice on the claim page and the prize listing; submissions received before the effective time are judged under the prior terms. A prize closes without payment if Minerval's own solver produces a checked proof first, in which case the proof is published, or if the only passing submission came from a person who was not eligible.
11. Publicity. The winner's chosen credit name, the proof, and the checker record are published as a matter of record.
12. Versions. These rules are versioned; each prize names the version in force when it was posted, and each submission records the version it was made under.
`;

export function prizeRulesContentHash(): string {
  return createHash("sha256").update(PRIZE_RULES_TEXT).digest("hex");
}

/** Owls to micro-USD at cost: one owl is one dollar of metered work. */
export function owlsToMicro(owls: number): number {
  return owlsToMicroUsd(owls);
}

/** Micro-USD at cost to owls, at full precision. */
export function microToOwls(micro: number): number {
  return micro / owlCostMicroUsd();
}

/**
 * Every prize amount renders through this one helper, as owls and never as
 * dollars (§8.1, §11.1): "1,000 owls", "250 owls", "12.5 owls" only when
 * the amount is fractional.
 */
export function formatOwls(micro: number): string {
  const owls = microToOwls(micro);
  const rounded = Math.round(owls * 100) / 100;
  const body = rounded.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return rounded === 1 ? `${body} owl` : `${body} owls`;
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
  condition_type: string;
  resolution: "proof" | "disproof" | "either";
  /** Owls at cost (micro-USD). */
  amount_micro_usd: number;
  status: BountyStatus;
  rules_version: string;
  /** The mandate whose escrow the bounty holds against. */
  posted_by_grant_id: string;
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

const BOUNTY_COLS = `id, claim_id, formalization_id, condition_type, resolution,
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

/** What a bounty transition leaves the bounty in, from the action logged. */
export function bountyStatusAfter(action: string, current?: string | null): string {
  if (action === "opened" || action === "rebound") return "open";
  if (
    (LIVE_BOUNTY_STATUSES as readonly string[]).includes(action) ||
    (TERMINAL_BOUNTY_STATUSES as readonly string[]).includes(action)
  ) {
    return action;
  }
  // A notice of withdrawal or any other bookkeeping action leaves the
  // status where it was.
  return current ?? action;
}

/** The event subtype the read model uses for a bounty in this status. */
export function bountyEventSubtype(status: string): "bounty_requested" | "bounty_opened" | "bounty_resolved" {
  if (status === "requested" || status === "confirm_pending") return "bounty_requested";
  if ((TERMINAL_BOUNTY_STATUSES as readonly string[]).includes(status)) return "bounty_resolved";
  return "bounty_opened";
}

/** The bounty fields a transition can carry into its event; the rest are null. */
export interface BountyEventSubject {
  id: string;
  claim_id: string;
  status?: string | null;
  formalization_id?: string | null;
  amount_micro_usd?: number | string | null;
  rules_version?: string | null;
}

/**
 * Every transition writes the claim's audit trail (§8.4) and emits a
 * `prize` claim event carrying the bounty id and the status it now holds,
 * so the live feed sees a bounty move as the read model would derive it.
 * The event is best-effort: a listener's failure never fails the transition.
 */
export async function logBountyEvent(
  r: Runner,
  bounty: BountyEventSubject,
  action: string,
  reasoning: string,
  createdBy = "prize_service"
): Promise<void> {
  await r.query(
    `INSERT INTO audit_log (claim_id, action, reasoning, created_by)
     VALUES ($1, $2, $3, $4)`,
    [bounty.claim_id, `bounty:${action}`, `bounty ${bounty.id}: ${reasoning}`, createdBy]
  );
  const status = bountyStatusAfter(action, bounty.status);
  const subtype = bountyEventSubtype(status);
  await emitClaimEvent({
    kind: "prize",
    id: `prize:bounty:${bounty.id}:${subtype}:${status}`,
    at: new Date().toISOString(),
    actor: createdBy,
    claim_id: bounty.claim_id,
    subtype,
    bounty_id: bounty.id,
    prize_claim_id: null,
    formalization_id: bounty.formalization_id ?? null,
    amount_micro_usd:
      bounty.amount_micro_usd === null || bounty.amount_micro_usd === undefined
        ? null
        : Number(bounty.amount_micro_usd),
    status,
    direction: null,
    credit_name: null,
    rules_version: bounty.rules_version ?? null,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// The two-pass request and open (§8.1, §10.4)
// ---------------------------------------------------------------------------

export type BountyRefusalCode =
  | "CLAIM_NOT_FOUND"
  | "NO_PUBLISHED_STATEMENT"
  | "REVIEW_PERIOD_OPEN"
  | "NO_CLOSED_ATTEMPT"
  | "MANDATE_NOT_ACTIVE"
  | "AMOUNT_OUT_OF_BOUNDS"
  | "PASS_FRACTION_EXCEEDED"
  | "DAY_FRACTION_EXCEEDED"
  | "INSUFFICIENT_ESCROW"
  | "LIVE_BOUNTY_EXISTS"
  | "BOUNTY_NOT_FOUND"
  | "BAD_STATE";

export interface BountyBoundsInput {
  amountMicroUsd: number;
  minOwls: number;
  maxOwls: number;
  /** The posting mandate's escrow budget (budget_jobs.budget_micro_usd). */
  escrowMicroUsd: number;
  /** Budget less committed money, with this bounty's own prior hold excluded. */
  headroomMicroUsd: number;
  committedThisPassMicroUsd: number;
  committedTodayMicroUsd: number;
  fractionPerPass: number;
  fractionPerDay: number;
}

/**
 * The mechanical money bounds on a posting, as a pure function so the
 * request and the open apply the same rule and the tests can pin it:
 * per-claim bounds, the per-pass and per-day fractions of the mandate's
 * escrow budget, and the mandate's headroom covering the amount.
 */
export function checkBountyBounds(
  input: BountyBoundsInput
): { ok: true } | { ok: false; code: BountyRefusalCode; message: string } {
  const amount = Math.round(input.amountMicroUsd);
  const min = owlsToMicro(input.minOwls);
  const max = owlsToMicro(input.maxOwls);
  if (!(amount >= min && amount <= max)) {
    return {
      ok: false,
      code: "AMOUNT_OUT_OF_BOUNDS",
      message: `a bounty is between ${formatOwls(min)} and ${formatOwls(max)} per claim; ${formatOwls(amount)} was asked`,
    };
  }
  const passCap = Math.floor(input.escrowMicroUsd * input.fractionPerPass);
  if (input.committedThisPassMicroUsd + amount > passCap) {
    return {
      ok: false,
      code: "PASS_FRACTION_EXCEEDED",
      message: `a review pass may commit at most ${formatOwls(passCap)} of the mandate's escrow to bounties; ${formatOwls(input.committedThisPassMicroUsd)} already committed this pass`,
    };
  }
  const dayCap = Math.floor(input.escrowMicroUsd * input.fractionPerDay);
  if (input.committedTodayMicroUsd + amount > dayCap) {
    return {
      ok: false,
      code: "DAY_FRACTION_EXCEEDED",
      message: `bounties opened today may total at most ${formatOwls(dayCap)} of the mandate's escrow; ${formatOwls(input.committedTodayMicroUsd)} already committed today`,
    };
  }
  if (amount > input.headroomMicroUsd) {
    return {
      ok: false,
      code: "INSUFFICIENT_ESCROW",
      message: `the mandate's escrow headroom is ${formatOwls(Math.max(0, input.headroomMicroUsd))} (budget less committed money); ${formatOwls(amount)} cannot be held against it`,
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
  grantId: string,
  passStartedAt: Date | null
): Promise<{ thisPass: number; today: number }> {
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

interface PostingMandate {
  id: string;
  budget_job_id: string;
  budget_micro_usd: number;
}

/**
 * The posting mandate, locked for the posting: the same advisory lock the
 * allocator takes (runMandateAllocator), so a posting and an allocation
 * pass serialize on the mandate's headroom, plus a row lock on the grant.
 * The mandate must be active with its escrow job running; a paused or
 * closed mandate posts nothing.
 */
async function lockPostingMandate(
  tx: TxQuery,
  grantId: string
): Promise<PostingMandate | { ok: false; code: BountyRefusalCode; message: string }> {
  await tx.query(
    `SELECT pg_advisory_xact_lock(hashtextextended('mandate-allocator:' || $1, 0))`,
    [grantId]
  );
  await tx.query(`SELECT id FROM grants WHERE id = $1 FOR UPDATE`, [grantId]);
  const [grant] = await tx.query<{
    id: string;
    budget_job_id: string;
    budget_micro_usd: string | number;
    job_status: string;
    status: string;
  }>(
    `SELECT g.id, g.budget_job_id, j.budget_micro_usd, j.status AS job_status, g.status
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1`,
    [grantId]
  );
  if (!grant || grant.status !== "active" || grant.job_status !== "running") {
    return {
      ok: false,
      code: "MANDATE_NOT_ACTIVE",
      message: grant
        ? `the posting mandate is ${grant.status} with its escrow ${grant.job_status}; only an active mandate with a running escrow posts a bounty`
        : "the posting mandate was not found",
    };
  }
  return {
    id: grant.id,
    budget_job_id: grant.budget_job_id,
    budget_micro_usd: Number(grant.budget_micro_usd),
  };
}

/**
 * The mandate's escrow headroom for a posting: budget less committed money
 * (grantCommittedMicroUsd, the prize term included), with this bounty's own
 * hold excluded when it already holds (a confirm_pending bounty being
 * opened), so it is not counted against itself.
 */
async function postingHeadroom(
  tx: TxQuery,
  mandate: PostingMandate,
  own: { status: string; amount_micro_usd: number } | null
): Promise<number> {
  const committed = await grantCommittedMicroUsd(
    { id: mandate.id, budgetJobId: mandate.budget_job_id },
    tx
  );
  const ownHold = own && isHoldingBountyStatus(own.status) ? own.amount_micro_usd : 0;
  return mandate.budget_micro_usd - (committed - ownHold);
}

export interface RequestBountyInput {
  claimId: string;
  /** The amount, in owls. */
  owls: number;
  expiresInDays?: number | null;
  rationale: string;
  /** The mandate whose escrow the bounty holds against. */
  grantId: string;
  /** The review pass this call belongs to (two-pass anchoring). */
  passStartedAt?: Date | null;
}

export type RequestBountyResult =
  | { ok: true; bounty_id: string; status: BountyStatus; opened: false }
  | { ok: false; code: BountyRefusalCode; message: string };

/**
 * The first pass: record the intent as a `requested` bounty. Every
 * mechanical bound is applied here too, so a request that could never open
 * is refused with the reason rather than parked. A requested bounty holds
 * nothing against the escrow yet.
 */
export async function requestBounty(input: RequestBountyInput): Promise<RequestBountyResult> {
  const config = loadConfig();
  const amount = owlsToMicro(Number(input.owls) || 0);
  const rationale = String(input.rationale ?? "").trim();
  return withTransaction(async (tx) => {
    const mandate = await lockPostingMandate(tx, input.grantId);
    if ("ok" in mandate) return mandate;
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
    const committed = await grantCommitments(tx, mandate.id, input.passStartedAt ?? null);
    // A re-request of the same claim replaces the pending one; its own
    // amount must not count against itself.
    const priorAmount = live?.status === "requested" ? live.amount_micro_usd : 0;
    const bounds = checkBountyBounds({
      amountMicroUsd: amount,
      minOwls: config.minBountyPerClaimOwls,
      maxOwls: config.maxBountyPerClaimOwls,
      escrowMicroUsd: mandate.budget_micro_usd,
      headroomMicroUsd: await postingHeadroom(tx, mandate, live),
      committedThisPassMicroUsd: Math.max(0, committed.thisPass - priorAmount),
      committedTodayMicroUsd: Math.max(0, committed.today - priorAmount),
      fractionPerPass: config.bountyEscrowFractionPerPass,
      fractionPerDay: config.bountyEscrowFractionPerDay,
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
                posted_by_grant_id = $5, resolution_note = $6, requested_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [live.id, amount, rationale, bindable.formalizationId, mandate.id, `expires_in_days:${expiresIn}`]
      );
      await logBountyEvent(tx, live, "requested", `re-requested at ${formatOwls(amount)}: ${rationale}`);
      return { ok: true, bounty_id: live.id, status: "requested", opened: false };
    }
    const [row] = await tx.query<{ id: string }>(
      `INSERT INTO bounties
         (claim_id, formalization_id, amount_micro_usd, status,
          rules_version, posted_by_grant_id, rationale, resolution_note)
       VALUES ($1, $2, $3, 'requested', $4, $5, $6, $7)
       RETURNING id`,
      [
        input.claimId,
        bindable.formalizationId,
        amount,
        PRIZE_RULES_VERSION,
        mandate.id,
        rationale,
        `expires_in_days:${expiresIn}`,
      ]
    );
    await logBountyEvent(
      tx,
      {
        id: row!.id,
        claim_id: input.claimId,
        status: "requested",
        formalization_id: bindable.formalizationId,
        amount_micro_usd: amount,
        rules_version: PRIZE_RULES_VERSION,
      },
      "requested",
      `${formatOwls(amount)} requested by the Grantmaker: ${rationale}`
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
 * under the mandate's allocator lock, so a bounty never opens beyond the
 * mandate's headroom. A confirm_pending bounty already holds; opening it
 * changes nothing in the escrow's arithmetic.
 */
export async function openBounty(input: {
  bountyId: string;
  passStartedAt?: Date | null;
  /** A human confirmation (operator key or the founder in chat). */
  confirmedBy?: string | null;
}): Promise<OpenBountyResult> {
  const config = loadConfig();
  const result = await withTransaction(async (tx): Promise<OpenBountyResult> => {
    const pre = await getBountyById(input.bountyId, tx);
    if (!pre) return { ok: false, code: "BOUNTY_NOT_FOUND", message: "bounty not found" };
    const mandate = await lockPostingMandate(tx, pre.posted_by_grant_id);
    if ("ok" in mandate) return mandate;
    await tx.query(`SELECT id FROM bounties WHERE id = $1 FOR UPDATE`, [pre.id]);
    const bounty = (await getBountyById(pre.id, tx))!;
    if (bounty.status !== "requested" && bounty.status !== "confirm_pending") {
      return {
        ok: false,
        code: "BAD_STATE",
        message: `bounty is ${bounty.status}; only a requested or confirm_pending bounty opens`,
      };
    }
    const bindable = await bindableFormalization(bounty.claim_id, tx);
    if (!bindable.ok) return bindable;
    const committed = await grantCommitments(tx, mandate.id, input.passStartedAt ?? null);
    const bounds = checkBountyBounds({
      amountMicroUsd: bounty.amount_micro_usd,
      minOwls: config.minBountyPerClaimOwls,
      maxOwls: config.maxBountyPerClaimOwls,
      escrowMicroUsd: mandate.budget_micro_usd,
      headroomMicroUsd: await postingHeadroom(tx, mandate, bounty),
      committedThisPassMicroUsd: Math.max(0, committed.thisPass - bounty.amount_micro_usd),
      committedTodayMicroUsd: Math.max(0, committed.today - bounty.amount_micro_usd),
      fractionPerPass: config.bountyEscrowFractionPerPass,
      fractionPerDay: config.bountyEscrowFractionPerDay,
    });
    if (!bounds.ok) return bounds;

    const needsHuman =
      bounty.amount_micro_usd >= owlsToMicro(config.bountyAutonomyThresholdOwls) &&
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
          `${formatOwls(bounty.amount_micro_usd)} is at or above the autonomy threshold; held against the mandate's escrow while waiting for a person's confirmation`
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
      `${formatOwls(bounty.amount_micro_usd)} offered for a proof or disproof of the formal statement, held against the mandate's escrow` +
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

/** Every opened bounty at or above PRIZE_HUMAN_SIGNOFF_OWLS triggers an audit (§8.1). */
async function auditOpenedBounty(bountyId: string): Promise<void> {
  const config = loadConfig();
  const bounty = await getBountyById(bountyId);
  if (!bounty || bounty.amount_micro_usd < owlsToMicro(config.prizeHumanSignoffOwls)) return;
  await requestAudit({
    auditType: "decision_audit",
    triggeredBy: "bounty_posted",
    context:
      `Bounty ${bounty.id} of ${formatOwls(bounty.amount_micro_usd)} opened on claim ` +
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
 * A terminal transition: the hold lapses by the status change alone
 * (nothing is posted; a paid bounty stays counted through its payout row),
 * and the prize-review reserve returns.
 */
export async function closeBounty(
  bountyId: string,
  status: "paid" | "resolved_internally" | "resolved_unpaid" | "expired" | "withdrawn",
  note: string,
  tx?: TxQuery
): Promise<boolean> {
  const run = async (r: Runner): Promise<boolean> => {
    const [row] = await r.query<BountyEventSubject>(
      `UPDATE bounties
          SET status = $2, resolved_at = now(), resolution_note = $3, updated_at = now()
        WHERE id = $1 AND status = ANY($4)
        RETURNING id, claim_id, status, formalization_id,
                  amount_micro_usd::bigint AS amount_micro_usd, rules_version`,
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
  const [row] = await r.query<BountyEventSubject>(
    `UPDATE bounties SET status = $2, updated_at = now()
      WHERE id = $1 AND status = ANY($3)
      RETURNING id, claim_id, status, formalization_id,
                amount_micro_usd::bigint AS amount_micro_usd, rules_version`,
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
        ? "withdrawn after the notice period; the hold on the mandate's escrow lapses"
        : "expired; the hold on the mandate's escrow lapses"
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
            COALESCE((SELECT SUM(pp.amount_micro_usd)
                        FROM prize_claims pc JOIN prize_payouts pp ON pp.prize_claim_id = pc.id
                       WHERE pc.bounty_id = b.id AND pc.result_category = 'statement_defect'
                         AND pp.status <> 'reversed'), 0)::bigint AS defect_paid
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
      const [updated] = await tx.query<BountyEventSubject>(
        `UPDATE bounties
            SET status = 'open', formalization_id = $2, amount_micro_usd = $3,
                opened_at = now(), updated_at = now()
          WHERE id = $1 AND status = 'rebinding'
          RETURNING id, claim_id, status, formalization_id,
                    amount_micro_usd::bigint AS amount_micro_usd, rules_version`,
        [row.id, row.new_formalization_id, amount]
      );
      if (!updated) return;
      await logBountyEvent(
        tx,
        updated,
        "rebound",
        `re-bound to the corrected statement ${row.new_formalization_id} at ${formatOwls(amount)}`
      );
      rebound++;
    });
  }
  return rebound;
}

// ---------------------------------------------------------------------------
// The prize-review reserve (§8.6)
// ---------------------------------------------------------------------------

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
 * held for this bounty, because a mandate's own escrow can be paused,
 * exhausted, or closing while a claim waits and a filed claim must be
 * reviewed whatever the mandate is doing. The job's budget counts against
 * the posting mandate through the prize term (prize-commitment.ts).
 * Idempotent per bounty.
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
        ? `Settled by a checked proof submitted by ${input.awarded.credit_name} on ${dateWords(input.awarded.paid_at)}; prize of ${formatOwls(input.awarded.amount_micro_usd)} paid.`
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

/**
 * One row of GET /prizes: an open bounty with the claim it is pinned to,
 * carrying what a browse card needs beside the amount: the claim's kind,
 * its current assessment, its importance, and whether a published formal
 * statement is already machine-checked (and which way).
 */
export interface OpenBountyListing {
  claim_id: string;
  text: string;
  claim_type: string;
  assessment_status: string | null;
  importance: number;
  checked: "proof" | "disproof" | null;
  bounty: BountySummary;
}

/** BOUNTY_COLS qualified with a table alias, for joins. */
function bountyColsFor(alias: string): string {
  return BOUNTY_COLS.split(",")
    .map((col) => `${alias}.${col.trim()}`)
    .join(", ");
}

/** GET /prizes — open bounties across the graph, largest first, paged. */
export async function listOpenBounties(opts: {
  limit?: number;
  offset?: number;
} = {}): Promise<{ items: OpenBountyListing[]; total: number }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 20));
  const offset = Math.max(0, opts.offset ?? 0);
  const rows = await rawQuery<
    BountyRow & {
      text: string;
      claim_type: string;
      importance: number | string | null;
      assessment_status: string | null;
      checked: "proof" | "disproof" | null;
    }
  >(
    `SELECT ${bountyColsFor("b")},
            c.text AS text, c.claim_type, c.importance,
            a.status AS assessment_status,
            ${checkedKindSql("c.id")} AS checked
       FROM bounties b
       JOIN claims c ON c.id = b.claim_id
       LEFT JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
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
    const { text, claim_type, importance, assessment_status, checked, ...bounty } = row;
    items.push({
      claim_id: row.claim_id,
      text,
      claim_type,
      assessment_status: assessment_status ?? null,
      importance: Number(importance ?? 0),
      checked: checked ?? null,
      bounty: await bountySummary(normalize(bounty)),
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
        `    <title>${xmlEscape(`${formatOwls(i.bounty.amount_micro_usd)} for a proof or disproof: ${i.text}`)}</title>\n` +
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
  /** The mandate's escrow budget (budget_jobs.budget_micro_usd). */
  escrow_micro_usd: number;
  /** Held in bounties in a holding status. */
  held_micro_usd: number;
  /** Gross payouts on the mandate's bounties. */
  paid_micro_usd: number;
  /** The prize-review reserve: running budgets, and placed spend once released. */
  review_reserve_micro_usd: number;
  /** Budget less committed money, every term included; never below zero. */
  headroom_micro_usd: number;
  bounties_posted: number;
  bounties_total_micro_usd: number;
  prizes_paid: number;
  /** Owls granted to winners, net of withholding. */
  owls_paid: number;
  bounties: Array<{
    id: string;
    claim_id: string;
    text: string;
    amount_micro_usd: number;
    status: BountyStatus;
    opened_at: string | null;
    submissions: number;
    outcome: string;
    reserve_micro_usd: number;
    reserve_spent_micro_usd: number;
  }>;
}

/**
 * The mandate's prize numbers (§8.1), all derived and none stored: the
 * escrow, what is held in open bounties, what was paid, the review
 * reserve, and the headroom that remains after every hold. The prize
 * term is read through the same SQL the escrow's arithmetic uses.
 */
export async function mandatePrizeNumbers(grantId: string): Promise<{
  escrow_micro_usd: number;
  held_micro_usd: number;
  paid_micro_usd: number;
  review_reserve_micro_usd: number;
  headroom_micro_usd: number;
} | null> {
  const [grant] = await rawQuery<{ budget_job_id: string; budget_micro_usd: string | number }>(
    `SELECT g.budget_job_id, j.budget_micro_usd
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1`,
    [grantId]
  );
  if (!grant) return null;
  const budget = Number(grant.budget_micro_usd);
  const [breakdown, committed] = await Promise.all([
    prizeCommitmentBreakdown(grantId),
    grantCommittedMicroUsd({ id: grantId, budgetJobId: grant.budget_job_id }),
  ]);
  return {
    escrow_micro_usd: budget,
    held_micro_usd: breakdown.held_micro_usd,
    paid_micro_usd: breakdown.paid_micro_usd,
    review_reserve_micro_usd: breakdown.review_reserve_micro_usd,
    headroom_micro_usd: Math.max(0, budget - committed),
  };
}

/** The mandate page's Prizes section (§8.3): tiles and the bounty table. */
export async function mandatePrizesBlock(grantId: string): Promise<MandatePrizesBlock> {
  const rows = await rawQuery<{
    id: string;
    claim_id: string;
    text: string;
    amount_micro_usd: string | number;
    status: BountyStatus;
    opened_at: Date | null;
    resolution_note: string | null;
    submissions: string | number;
    reserve: string | number;
    reserve_spent: string | number;
  }>(
    `SELECT b.id, b.claim_id, c.text AS text, b.amount_micro_usd, b.status,
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
  const numbers = (await mandatePrizeNumbers(grantId)) ?? {
    escrow_micro_usd: 0,
    held_micro_usd: 0,
    paid_micro_usd: 0,
    review_reserve_micro_usd: 0,
    headroom_micro_usd: 0,
  };
  const posted = rows.filter((r) => !["requested", "confirm_pending"].includes(r.status));
  return {
    ...numbers,
    bounties_posted: posted.length,
    bounties_total_micro_usd: posted.reduce((s, r) => s + Number(r.amount_micro_usd), 0),
    prizes_paid: Number(paid?.n ?? 0),
    owls_paid: microToOwls(Number(paid?.owls ?? 0)),
    bounties: rows.map((r) => ({
      id: r.id,
      claim_id: r.claim_id,
      text: r.text,
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

/** One mandate's prize numbers on the prize listing (GET /prizes). */
export interface PrizeMandateNumbers {
  grant_id: string;
  title: string;
  escrow_micro_usd: number;
  held_micro_usd: number;
  paid_micro_usd: number;
  review_reserve_micro_usd: number;
  headroom_micro_usd: number;
  open_bounties: number;
}

/**
 * Every mandate with a live or paid bounty, with its prize numbers in
 * owls at cost (§8.1): the listing's account of where prizes come from.
 */
export async function prizeMandateNumbers(): Promise<PrizeMandateNumbers[]> {
  const mandates = await rawQuery<{ id: string; title: string; open_bounties: string | number }>(
    `SELECT g.id, COALESCE(g.mandate->>'title', g.name) AS title,
            (SELECT COUNT(*) FROM bounties b
              WHERE b.posted_by_grant_id = g.id AND b.status IN ('open', 'claim_pending'))::int AS open_bounties
       FROM grants g
      WHERE EXISTS (SELECT 1 FROM bounties b
                     WHERE b.posted_by_grant_id = g.id
                       AND b.status IN ('confirm_pending', 'open', 'claim_pending', 'house_result_pending', 'rebinding', 'paid'))
      ORDER BY g.is_platform DESC, g.created_at ASC`
  );
  const out: PrizeMandateNumbers[] = [];
  for (const m of mandates) {
    const numbers = await mandatePrizeNumbers(m.id);
    if (!numbers) continue;
    out.push({ grant_id: m.id, title: m.title, ...numbers, open_bounties: Number(m.open_bounties) });
  }
  return out;
}

/**
 * What stands between a mandate and closure (§8.1): bounties in a holding
 * status, and bounties with a non-terminal prize claim. A mandate with any
 * cannot complete, because the escrow that backs the prize must never be
 * refunded from under it; the Grantmaker withdraws them first
 * (withdraw_bounty, thirty days' notice) and the mandate closes once none
 * is live.
 */
export async function mandateClosureBlockers(grantId: string): Promise<{
  live_bounties: number;
  bounty_ids: string[];
}> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT b.id FROM bounties b
      WHERE b.posted_by_grant_id = $1
        AND (b.status = ANY($2)
             OR EXISTS (SELECT 1 FROM prize_claims pc
                         WHERE pc.bounty_id = b.id AND pc.status = ANY($3)))
      ORDER BY b.requested_at ASC`,
    [grantId, [...HOLDING_BOUNTY_STATUSES], [...NON_TERMINAL_PRIZE_CLAIM_STATUSES]]
  );
  return { live_bounties: rows.length, bounty_ids: rows.map((r) => r.id) };
}

/** The refusal a closure gets while bounties stand, in the Grantmaker's tool result. */
export function closureBlockedMessage(liveBounties: number): string {
  return (
    `The mandate has ${liveBounties} live ${liveBounties === 1 ? "bounty" : "bounties"} held against its escrow; ` +
    `withdraw them first (withdraw_bounty gives thirty days' notice) and the mandate closes once none is live.`
  );
}
