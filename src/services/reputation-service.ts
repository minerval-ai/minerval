/**
 * Reputation service (#71) — makes `contributors.reputation_score`
 * load-bearing.
 *
 * Principles (from the issue):
 *  - Good-faith contribution is always free — a sincere contribution rejected
 *    on the merits costs a little reputation, never money.
 *  - Bad faith has a credible cost: ONE suspected-bad-faith flag flips the
 *    contributor into 'must_pay' standing (contributing requires a deposit —
 *    the payment seam; no payment rail exists yet, so POST /contributions
 *    returns 402 DEPOSIT_REQUIRED until the flag is overturned on appeal).
 *  - Reputation gates privileges: low scores auto-suspend, and low-reputation
 *    or brand-new accounts are rate-limited to blunt sybil floods.
 *  - Every change is an append-only reputation_events row, so standing is
 *    auditable and reversible: appeal overturns insert compensating events
 *    instead of editing history.
 *
 * All writes go through rawQuery so the review pipeline (reviewer/arbitrator
 * tools) has one testable seam, matching the existing counter-update pattern.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import {
  awardContributionOwls,
  clawbackContributionOwls,
  owlsForImportance,
  awardPointsForImportance,
  SURVIVED_APPEAL_BONUS_POINTS,
} from "./contribution-award-service.js";
import { refundChargeForContribution } from "./owl-ledger-service.js";

// ---------------------------------------------------------------------------
// Rules (pure, exported for tests and prompts)
// ---------------------------------------------------------------------------

export const REPUTATION_RULES = {
  min: 0,
  max: 100,
  /** Accepted good-faith contribution. */
  accepted: 2,
  /** Rejected on the merits — sincere but wrong stays cheap. */
  rejected: -1,
  /** Escalation is not a judgment; no reputation change. */
  escalated: 0,
  /** Suspected bad faith — one flag also flips standing to 'must_pay'. */
  badFaithFlag: -15,
  /**
   * Auto-suspension threshold: dropping below this suspends the account.
   * From the default 50, that is ~3 bad-faith flags but ~41 sincere
   * rejections — abuse escalates fast, sincerity never suspends by accident.
   */
  suspendBelow: 10,
} as const;

export const BAD_FAITH_CATEGORIES = [
  "spam",
  "vandalism",
  "sybil",
  "misinformation",
] as const;
export type BadFaithCategory = (typeof BAD_FAITH_CATEGORIES)[number];

export const REPUTATION_REASONS = {
  accepted: "contribution_accepted",
  rejected: "contribution_rejected",
  badFaith: "bad_faith_flag",
  overturned: "appeal_overturned",
  /** Audit Agent adjustment (#180) — contribution_id/review_id are null. */
  auditAdjustment: "audit_adjustment",
  /** Compensation when an audit re-review supersedes a decision (#180). */
  superseded: "review_superseded",
} as const;

/** Marks suspensions this service imposed, so appeals can lift exactly those. */
export const AUTO_SUSPENSION_PREFIX = "reputation:";

/**
 * Marks deliberate Audit Agent suspensions (#180): "audit:<finding_id> …".
 * These are judgment calls, so no mechanical path lifts them — only the
 * audit function itself or the Dispute Arbitrator adjudicating an appeal.
 */
export const AUDIT_SUSPENSION_PREFIX = "audit:";

export function clampScore(score: number): number {
  return Math.min(REPUTATION_RULES.max, Math.max(REPUTATION_RULES.min, score));
}

/**
 * The events belonging to a contribution's LIVE decision: everything after
 * the last 'review_superseded' compensation (#180). Earlier segments were
 * already zeroed by their supersession and must not be reversed again.
 */
function liveSegment<T extends { reason: string }>(events: T[]): T[] {
  const last = events
    .map((e) => e.reason)
    .lastIndexOf(REPUTATION_REASONS.superseded);
  return events.slice(last + 1);
}

export function reputationDeltaFor(
  decision: "accept" | "reject" | "escalate"
): number {
  switch (decision) {
    case "accept":
      return REPUTATION_RULES.accepted;
    case "reject":
      return REPUTATION_RULES.rejected;
    case "escalate":
      return REPUTATION_RULES.escalated;
  }
}

/**
 * Trust level from score — the thresholds the Contribution Reviewer already
 * reasons with (single definition; governance tools import this).
 */
export function trustLevelFor(score: number, isSuspended: boolean): string {
  if (isSuspended) return "suspended";
  if (score >= 80) return "trusted";
  if (score >= 50) return "standard";
  if (score >= 20) return "probationary";
  return "restricted";
}

// ---------------------------------------------------------------------------
// Review outcome → reputation / standing / owl awards
// ---------------------------------------------------------------------------

export interface ReviewOutcomeInput {
  contributionId: string;
  reviewId?: string | null;
  decision: "accept" | "reject" | "escalate";
  suspectedBadFaith?: boolean;
  badFaithCategory?: string | null;
}

export interface ReviewOutcomeSummary {
  contributorId: string;
  previousScore: number;
  newScore: number;
  standing: string;
  suspended: boolean;
  owlsAwarded: number;
}

/**
 * Apply the full consequences of a review decision: contribution counters,
 * reputation events + score, bad-faith standing, auto-suspension, and owl
 * awards for acceptances. Called by the reviewer tool after the review row
 * is written (and by nothing else — one write path).
 */
export async function applyReviewOutcome(
  input: ReviewOutcomeInput
): Promise<ReviewOutcomeSummary | null> {
  // LEFT JOIN, not JOIN (#179): intake contributions can carry no claim_id
  // (a rejected propose_claim never materializes; propose_source never gets
  // one), and reputation, standing, and the bad-faith defense (#157) must
  // apply to them all the same. A claim-less acceptance earns the minimum
  // award via importance 0.
  const [contribution] = await rawQuery<{
    contributor_id: string;
    importance: number;
  }>(
    `SELECT c.contributor_id, COALESCE(cl.importance, 0) AS importance
     FROM contributions c
     LEFT JOIN claims cl ON cl.id = c.claim_id
     WHERE c.id = $1`,
    [input.contributionId]
  );
  if (!contribution) return null;

  const [contributor] = await rawQuery<{
    reputation_score: number;
    bad_faith_flags: number;
    contribution_standing: string;
    is_suspended: boolean;
  }>(
    `SELECT reputation_score, bad_faith_flags, contribution_standing, is_suspended
     FROM contributors WHERE id = $1`,
    [contribution.contributor_id]
  );
  if (!contributor) return null;

  // Bad faith is only meaningful on a rejection (a sincere-but-wrong reject
  // must never carry the flag's consequences).
  const badFaith = input.suspectedBadFaith === true && input.decision === "reject";

  const baseDelta = reputationDeltaFor(input.decision);
  const totalDelta = baseDelta + (badFaith ? REPUTATION_RULES.badFaithFlag : 0);
  const previousScore = contributor.reputation_score;
  const newScore = clampScore(previousScore + totalDelta);

  const counterColumn =
    input.decision === "accept"
      ? "contributions_accepted"
      : input.decision === "reject"
        ? "contributions_rejected"
        : "contributions_escalated";

  const suspend =
    !contributor.is_suspended && newScore < REPUTATION_RULES.suspendBelow;
  const standing = badFaith ? "must_pay" : contributor.contribution_standing;

  await rawQuery(
    `UPDATE contributors SET
       ${counterColumn} = ${counterColumn} + 1,
       reputation_score = $1,
       contribution_standing = $2,
       bad_faith_flags = bad_faith_flags + $3,
       is_suspended = is_suspended OR $4,
       suspension_reason = CASE WHEN $4 THEN $5 ELSE suspension_reason END,
       suspended_at = CASE WHEN $4 THEN now() ELSE suspended_at END,
       last_active_at = now()
     WHERE id = $6`,
    [
      newScore,
      standing,
      badFaith ? 1 : 0,
      suspend,
      `${AUTO_SUSPENSION_PREFIX} score fell below ${REPUTATION_RULES.suspendBelow} after ${
        badFaith ? "a suspected bad-faith contribution" : "repeated rejections"
      }`,
      contribution.contributor_id,
    ]
  );

  // Ledger: one event per cause, so an appeal can reverse exactly what
  // happened (a bad-faith rejection is two events: the rejection + the flag).
  const events: Array<{ delta: number; reason: string }> = [];
  if (input.decision === "accept") {
    events.push({ delta: baseDelta, reason: REPUTATION_REASONS.accepted });
  } else if (input.decision === "reject") {
    events.push({ delta: baseDelta, reason: REPUTATION_REASONS.rejected });
    if (badFaith) {
      events.push({
        delta: REPUTATION_RULES.badFaithFlag,
        reason: REPUTATION_REASONS.badFaith,
      });
    }
  }
  let running = previousScore;
  for (const event of events) {
    running = clampScore(running + event.delta);
    await rawQuery(
      `INSERT INTO reputation_events
         (contributor_id, contribution_id, review_id, delta, score_after, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        contribution.contributor_id,
        input.contributionId,
        input.reviewId ?? null,
        event.delta,
        running,
        event.reason,
      ]
    );
  }

  // Recognition: accepted contributions earn spendable owls scaled by how
  // load-bearing the target claim is. A rejection refunds any proposal
  // charge linked to this contribution — good-faith submission that didn't
  // pass costs nothing (#71).
  let owlsAwarded = 0;
  if (input.decision === "accept") {
    owlsAwarded = await awardContributionOwls({
      contributorId: contribution.contributor_id,
      contributionId: input.contributionId,
      owls: owlsForImportance(contribution.importance),
    });
  } else if (input.decision === "reject") {
    await refundChargeForContribution(input.contributionId);
  }

  return {
    contributorId: contribution.contributor_id,
    previousScore,
    newScore,
    standing,
    suspended: contributor.is_suspended || suspend,
    owlsAwarded,
  };
}

// ---------------------------------------------------------------------------
// Escalation resolution → final outcome
// ---------------------------------------------------------------------------

/**
 * Apply the final outcome of an arbitrated escalation (#179). An 'escalate'
 * review is not a judgment and writes no reputation events, so when the
 * Arbitrator later decides the merits the contributor has been neither
 * credited nor penalized; without this path an escalated-then-accepted
 * contribution earned nothing, unlike a direct accept. This applies the
 * consequences the original review would have carried: the reputation event,
 * counters (resolving the escalated counter into the final disposition), and
 * owls on acceptance. When the Arbitrator's rejection carries a bad-faith
 * finding (#213), the flag's consequences ride along exactly as they would
 * have on a flagged review: the second ledger event, the flag count,
 * must-pay standing, and the auto-suspension check. reverseReviewOutcome
 * already reverses the rejection+flag event pair on a later appeal.
 *
 * No-op (null) when the contribution already carries any reputation event: a
 * decided outcome was applied at review time (undoing it is
 * reverseReviewOutcome's job), or this resolution already ran. That check is
 * what makes the call idempotent and safe to attempt on every uphold or
 * overturn — and it is why a bad-faith finding only takes effect on the
 * escalation path: an appealed rejection already applied its outcome, and
 * this path will not stack a late flag on top of it.
 */
export async function applyArbitrationOutcome(input: {
  contributionId: string;
  finalDecision: "accept" | "reject";
  suspectedBadFaith?: boolean;
}): Promise<ReviewOutcomeSummary | null> {
  const priorEvents = await rawQuery<{ reason: string }>(
    `SELECT reason FROM reputation_events
     WHERE contribution_id = $1
     ORDER BY created_at`,
    [input.contributionId]
  );
  // Only the live segment counts (#180): events from a decision an audit
  // re-review superseded were compensated to zero, so they must not block
  // applying the outcome of the fresh escalation.
  if (liveSegment(priorEvents).length > 0) return null;

  const [contribution] = await rawQuery<{
    contributor_id: string;
    importance: number;
  }>(
    `SELECT c.contributor_id, COALESCE(cl.importance, 0) AS importance
     FROM contributions c
     LEFT JOIN claims cl ON cl.id = c.claim_id
     WHERE c.id = $1`,
    [input.contributionId]
  );
  if (!contribution) return null;

  const [contributor] = await rawQuery<{
    reputation_score: number;
    contribution_standing: string;
    is_suspended: boolean;
  }>(
    `SELECT reputation_score, contribution_standing, is_suspended
     FROM contributors WHERE id = $1`,
    [contribution.contributor_id]
  );
  if (!contributor) return null;

  // Same guard as applyReviewOutcome: the flag is only coherent on a
  // rejection, so it can never fire alongside an acceptance by accident.
  const badFaith =
    input.suspectedBadFaith === true && input.finalDecision === "reject";

  const delta = reputationDeltaFor(input.finalDecision);
  const totalDelta = delta + (badFaith ? REPUTATION_RULES.badFaithFlag : 0);
  const previousScore = contributor.reputation_score;
  const newScore = clampScore(previousScore + totalDelta);
  const suspend =
    !contributor.is_suspended && newScore < REPUTATION_RULES.suspendBelow;
  const standing = badFaith ? "must_pay" : contributor.contribution_standing;

  // The escalated counter resolves into the final disposition, but only when
  // the escalation was recorded as a review — the counter's only source.
  const [escalationReview] = await rawQuery<{ id: string }>(
    `SELECT id FROM contribution_reviews
     WHERE contribution_id = $1 AND decision = 'escalate'
     LIMIT 1`,
    [input.contributionId]
  );
  const finalCounter =
    input.finalDecision === "accept"
      ? "contributions_accepted"
      : "contributions_rejected";

  await rawQuery(
    `UPDATE contributors SET
       ${
         escalationReview
           ? "contributions_escalated = GREATEST(0, contributions_escalated - 1),"
           : ""
       }
       ${finalCounter} = ${finalCounter} + 1,
       reputation_score = $1,
       contribution_standing = $2,
       bad_faith_flags = bad_faith_flags + $3,
       is_suspended = is_suspended OR $4,
       suspension_reason = CASE WHEN $4 THEN $5 ELSE suspension_reason END,
       suspended_at = CASE WHEN $4 THEN now() ELSE suspended_at END,
       last_active_at = now()
     WHERE id = $6`,
    [
      newScore,
      standing,
      badFaith ? 1 : 0,
      suspend,
      `${AUTO_SUSPENSION_PREFIX} score fell below ${REPUTATION_RULES.suspendBelow} after ${
        badFaith ? "a suspected bad-faith contribution" : "repeated rejections"
      }`,
      contribution.contributor_id,
    ]
  );

  // One event per cause, exactly as applyReviewOutcome writes them, so a
  // later appeal reverses an arbitrated flag the same way as a reviewed one.
  const events: Array<{ delta: number; reason: string }> = [
    {
      delta,
      reason:
        input.finalDecision === "accept"
          ? REPUTATION_REASONS.accepted
          : REPUTATION_REASONS.rejected,
    },
  ];
  if (badFaith) {
    events.push({
      delta: REPUTATION_RULES.badFaithFlag,
      reason: REPUTATION_REASONS.badFaith,
    });
  }
  let running = previousScore;
  for (const event of events) {
    running = clampScore(running + event.delta);
    await rawQuery(
      `INSERT INTO reputation_events
         (contributor_id, contribution_id, review_id, delta, score_after, reason)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [
        contribution.contributor_id,
        input.contributionId,
        event.delta,
        running,
        event.reason,
      ]
    );
  }

  let owlsAwarded = 0;
  if (input.finalDecision === "accept") {
    owlsAwarded = await awardContributionOwls({
      contributorId: contribution.contributor_id,
      contributionId: input.contributionId,
      owls: owlsForImportance(contribution.importance),
    });
  } else {
    await refundChargeForContribution(input.contributionId);
  }

  return {
    contributorId: contribution.contributor_id,
    previousScore,
    newScore,
    standing,
    suspended: contributor.is_suspended || suspend,
    owlsAwarded,
  };
}

// ---------------------------------------------------------------------------
// Appeal overturn → restore
// ---------------------------------------------------------------------------

export interface ReversalSummary {
  contributorId: string;
  previousScore: number;
  newScore: number;
  standingRestored: boolean;
  unsuspended: boolean;
  owlsAwarded: number;
}

/**
 * Reverse the consequences of a rejection that arbitration overturned:
 * compensate the reputation ledger, move the rejected counter to accepted,
 * clear the bad-faith flag (restoring 'good' standing when it was the only
 * one), lift a reputation-imposed suspension, and award the accepted +
 * survived-appeal owls. Idempotent per contribution.
 */
export async function reverseReviewOutcome(input: {
  contributionId: string;
}): Promise<ReversalSummary | null> {
  // LEFT JOIN for the same reason as applyReviewOutcome (#179): an
  // overturned intake rejection may have no claim yet at reversal time.
  const [contribution] = await rawQuery<{
    contributor_id: string;
    importance: number;
  }>(
    `SELECT c.contributor_id, COALESCE(cl.importance, 0) AS importance
     FROM contributions c
     LEFT JOIN claims cl ON cl.id = c.claim_id
     WHERE c.id = $1`,
    [input.contributionId]
  );
  if (!contribution) return null;

  const allEvents = await rawQuery<{ delta: number; reason: string }>(
    `SELECT delta, reason FROM reputation_events
     WHERE contribution_id = $1
     ORDER BY created_at`,
    [input.contributionId]
  );
  // Only the live segment is reversible: an audit re-review compensates
  // everything before its 'review_superseded' marker (#180), so events from
  // superseded decisions must not be reversed a second time.
  const events = liveSegment(allEvents);
  // Nothing to reverse (never penalized), or already reversed.
  const penalties = events.filter(
    (e) =>
      e.reason === REPUTATION_REASONS.rejected ||
      e.reason === REPUTATION_REASONS.badFaith
  );
  if (penalties.length === 0) return null;
  if (events.some((e) => e.reason === REPUTATION_REASONS.overturned)) {
    return null;
  }

  const [contributor] = await rawQuery<{
    reputation_score: number;
    bad_faith_flags: number;
    contribution_standing: string;
    is_suspended: boolean;
    suspension_reason: string | null;
  }>(
    `SELECT reputation_score, bad_faith_flags, contribution_standing,
            is_suspended, suspension_reason
     FROM contributors WHERE id = $1`,
    [contribution.contributor_id]
  );
  if (!contributor) return null;

  const hadBadFaithFlag = penalties.some(
    (e) => e.reason === REPUTATION_REASONS.badFaith
  );
  const penaltySum = penalties.reduce((sum, e) => sum + e.delta, 0);
  // Undo the penalties, then credit the acceptance the contribution deserved.
  const reversalDelta = -penaltySum + REPUTATION_RULES.accepted;
  const previousScore = contributor.reputation_score;
  const newScore = clampScore(previousScore + reversalDelta);

  const remainingFlags = hadBadFaithFlag
    ? Math.max(0, contributor.bad_faith_flags - 1)
    : contributor.bad_faith_flags;
  const standingRestored =
    contributor.contribution_standing === "must_pay" && remainingFlags === 0;

  // Lift a suspension only if this service imposed it and the restored score
  // clears the threshold — a manual suspension stays a human call.
  const unsuspend =
    contributor.is_suspended &&
    (contributor.suspension_reason ?? "").startsWith(AUTO_SUSPENSION_PREFIX) &&
    newScore >= REPUTATION_RULES.suspendBelow;

  await rawQuery(
    `UPDATE contributors SET
       contributions_rejected = GREATEST(0, contributions_rejected - 1),
       contributions_accepted = contributions_accepted + 1,
       reputation_score = $1,
       bad_faith_flags = $2,
       contribution_standing = $3,
       is_suspended = CASE WHEN $4 THEN false ELSE is_suspended END,
       suspension_reason = CASE WHEN $4 THEN NULL ELSE suspension_reason END,
       suspended_at = CASE WHEN $4 THEN NULL ELSE suspended_at END
     WHERE id = $5`,
    [
      newScore,
      remainingFlags,
      standingRestored ? "good" : contributor.contribution_standing,
      unsuspend,
      contribution.contributor_id,
    ]
  );

  await rawQuery(
    `INSERT INTO reputation_events
       (contributor_id, contribution_id, review_id, delta, score_after, reason)
     VALUES ($1, $2, NULL, $3, $4, $5)`,
    [
      contribution.contributor_id,
      input.contributionId,
      reversalDelta,
      newScore,
      REPUTATION_REASONS.overturned,
    ]
  );

  // The contribution is now accepted AND survived scrutiny: the importance
  // award plus the survived-appeal bonus, in owls.
  const config = loadConfig();
  const owlsAwarded = await awardContributionOwls({
    contributorId: contribution.contributor_id,
    contributionId: input.contributionId,
    owls:
      (awardPointsForImportance(contribution.importance) +
        SURVIVED_APPEAL_BONUS_POINTS) *
      config.contributionAwardOwlPerPoint,
  });

  return {
    contributorId: contribution.contributor_id,
    previousScore,
    newScore,
    standingRestored,
    unsuspended: unsuspend,
    owlsAwarded,
  };
}

// ---------------------------------------------------------------------------
// Audit re-review → neutralize, then judge afresh
// ---------------------------------------------------------------------------

export interface NeutralizationSummary {
  contributorId: string;
  supersededReviewId: string;
  previousScore: number;
  newScore: number;
  badFaithFlagCleared: boolean;
  owlsReversed: number;
  unsuspended: boolean;
}

/**
 * Undo the standing consequences of a contribution's live review so an audit
 * re-review can judge it afresh (#180). Without this, a re-review would call
 * applyReviewOutcome a second time and stack a second set of reputation
 * events, counters, and owl awards on top of the first.
 *
 * Marks the review row(s) superseded (history stays; get_recent_decisions
 * shows only live decisions), inserts one compensating reputation event that
 * zeroes the contribution's net ledger effect, decrements the counter the
 * original decision incremented, clears a still-active bad-faith flag, claws
 * back the awarded owls, and lifts a reputation-imposed suspension when the restored
 * score clears the threshold (same rule as an appeal overturn). Idempotent:
 * once no live review remains there is nothing to neutralize.
 */
export async function neutralizeReviewOutcome(input: {
  contributionId: string;
}): Promise<NeutralizationSummary | null> {
  const [contribution] = await rawQuery<{
    contributor_id: string;
    review_status: string;
  }>(
    `SELECT contributor_id, review_status FROM contributions WHERE id = $1`,
    [input.contributionId]
  );
  if (!contribution) return null;

  const [liveReview] = await rawQuery<{
    id: string;
    decision: string;
    suspected_bad_faith: boolean;
  }>(
    `SELECT id, decision, suspected_bad_faith
     FROM contribution_reviews
     WHERE contribution_id = $1 AND superseded = false
     ORDER BY reviewed_at DESC LIMIT 1`,
    [input.contributionId]
  );
  if (!liveReview) return null;

  await rawQuery(
    `UPDATE contribution_reviews SET superseded = true WHERE contribution_id = $1`,
    [input.contributionId]
  );

  const [contributor] = await rawQuery<{
    reputation_score: number;
    bad_faith_flags: number;
    contribution_standing: string;
    is_suspended: boolean;
    suspension_reason: string | null;
  }>(
    `SELECT reputation_score, bad_faith_flags, contribution_standing,
            is_suspended, suspension_reason
     FROM contributors WHERE id = $1`,
    [contribution.contributor_id]
  );
  if (!contributor) return null;

  const events = await rawQuery<{ delta: number; reason: string }>(
    `SELECT delta, reason FROM reputation_events
     WHERE contribution_id = $1
     ORDER BY created_at`,
    [input.contributionId]
  );
  // The overturn marker only matters if it belongs to the live decision;
  // one from an earlier, already-superseded cycle says nothing about the
  // current flag. The net delta, by contrast, sums the whole history: the
  // compensation must zero the contribution's total ledger effect.
  const overturned = liveSegment(events).some(
    (e) => e.reason === REPUTATION_REASONS.overturned
  );
  const netDelta = events.reduce((sum, e) => sum + e.delta, 0);

  // The flag is still standing only if the live review carried it and no
  // overturn already cleared it.
  const clearFlag = liveReview.suspected_bad_faith && !overturned;
  const remainingFlags = clearFlag
    ? Math.max(0, contributor.bad_faith_flags - 1)
    : contributor.bad_faith_flags;
  const standingRestored =
    clearFlag &&
    contributor.contribution_standing === "must_pay" &&
    remainingFlags === 0;

  // The contribution's current status names the counter holding it: an
  // overturn moved rejected→accepted, and an arbitrated escalation resolved
  // the escalated counter into the final disposition (#179) — the review
  // row's own decision no longer says where the count sits.
  const counterColumn =
    contribution.review_status === "accepted"
      ? "contributions_accepted"
      : contribution.review_status === "rejected"
        ? "contributions_rejected"
        : "contributions_escalated";

  const previousScore = contributor.reputation_score;
  const newScore = clampScore(previousScore - netDelta);

  const unsuspend =
    contributor.is_suspended &&
    (contributor.suspension_reason ?? "").startsWith(AUTO_SUSPENSION_PREFIX) &&
    newScore >= REPUTATION_RULES.suspendBelow;

  await rawQuery(
    `UPDATE contributors SET
       ${counterColumn} = GREATEST(0, ${counterColumn} - 1),
       reputation_score = $1,
       bad_faith_flags = $2,
       contribution_standing = $3,
       is_suspended = CASE WHEN $4 THEN false ELSE is_suspended END,
       suspension_reason = CASE WHEN $4 THEN NULL ELSE suspension_reason END,
       suspended_at = CASE WHEN $4 THEN NULL ELSE suspended_at END
     WHERE id = $5`,
    [
      newScore,
      remainingFlags,
      standingRestored ? "good" : contributor.contribution_standing,
      unsuspend,
      contribution.contributor_id,
    ]
  );

  if (netDelta !== 0) {
    await rawQuery(
      `INSERT INTO reputation_events
         (contributor_id, contribution_id, review_id, delta, score_after, reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        contribution.contributor_id,
        input.contributionId,
        liveReview.id,
        -netDelta,
        newScore,
        REPUTATION_REASONS.superseded,
      ]
    );
  }

  // Claw back the owls this contribution earned (acceptance and any
  // survived-appeal bonus) with a compensating negative award, so a
  // re-accepted contribution earns once, not twice.
  const owlsReversed = await clawbackContributionOwls({
    contributorId: contribution.contributor_id,
    contributionId: input.contributionId,
  });

  return {
    contributorId: contribution.contributor_id,
    supersededReviewId: liveReview.id,
    previousScore,
    newScore,
    badFaithFlagCleared: clearFlag,
    owlsReversed,
    unsuspended: unsuspend,
  };
}

// ---------------------------------------------------------------------------
// Audit adjustment → ledger
// ---------------------------------------------------------------------------

export interface AdjustmentSummary {
  contributorId: string;
  previousScore: number;
  newScore: number;
  suspended: boolean;
}

/**
 * Apply an Audit Agent reputation adjustment through the ledger (#180): the
 * single write path for audit deltas, so every change stays reconstructible
 * from reputation_events and visible to appeal reversal. Dropping below the
 * threshold auto-suspends with the same 'reputation:' reason the review path
 * uses, so the appeal machinery can lift it like any other score-based
 * suspension. Raising a score never auto-unsuspends: lifting is a judgment
 * (the audit's unsuspend tool, or arbitration).
 */
export async function adjustReputation(input: {
  contributorId: string;
  delta: number;
}): Promise<AdjustmentSummary | null> {
  const [contributor] = await rawQuery<{
    reputation_score: number;
    is_suspended: boolean;
  }>(
    `SELECT reputation_score, is_suspended FROM contributors WHERE id = $1`,
    [input.contributorId]
  );
  if (!contributor) return null;

  const previousScore = contributor.reputation_score;
  const newScore = clampScore(previousScore + input.delta);
  const suspend =
    !contributor.is_suspended && newScore < REPUTATION_RULES.suspendBelow;

  await rawQuery(
    `UPDATE contributors SET
       reputation_score = $1,
       is_suspended = is_suspended OR $2,
       suspension_reason = CASE WHEN $2 THEN $3 ELSE suspension_reason END,
       suspended_at = CASE WHEN $2 THEN now() ELSE suspended_at END
     WHERE id = $4`,
    [
      newScore,
      suspend,
      `${AUTO_SUSPENSION_PREFIX} score fell below ${REPUTATION_RULES.suspendBelow} after an audit adjustment`,
      input.contributorId,
    ]
  );

  await rawQuery(
    `INSERT INTO reputation_events
       (contributor_id, contribution_id, review_id, delta, score_after, reason)
     VALUES ($1, NULL, NULL, $2, $3, $4)`,
    [
      input.contributorId,
      input.delta,
      newScore,
      REPUTATION_REASONS.auditAdjustment,
    ]
  );

  return {
    contributorId: input.contributorId,
    previousScore,
    newScore,
    suspended: contributor.is_suspended || suspend,
  };
}

// ---------------------------------------------------------------------------
// Sybil / flood sandbox: contribution rate limiting
// ---------------------------------------------------------------------------

// contributorId → timestamps (ms) of contributions within the last hour.
// In-memory sliding window, same construction as the agentic rate limit —
// a blunt backstop, not an accounting system.
const windows = new Map<string, number[]>();

/** Test hook. */
export function resetContributionRateLimiter(): void {
  windows.clear();
}

const NEW_ACCOUNT_WINDOW_MS = 24 * 3_600_000;

export interface ContributionRateCheck {
  limited: boolean;
  limitPerHour: number;
  sandboxed: boolean;
}

/**
 * Per-contributor hourly cap on contributions. Low-reputation (< 50) and
 * brand-new (< 24h) accounts get the tighter sandbox limit so a sybil flood
 * of fresh accounts can't overwhelm review. 0 disables a limit.
 */
export function checkContributionRateLimit(contributor: {
  id: string;
  reputationScore: number;
  createdAt: Date;
}): ContributionRateCheck {
  const config = loadConfig();
  const isNew =
    Date.now() - contributor.createdAt.getTime() < NEW_ACCOUNT_WINDOW_MS;
  const sandboxed = contributor.reputationScore < 50 || isNew;
  const limitPerHour = sandboxed
    ? config.newContributorRateLimitPerHour
    : config.contributionRateLimitPerHour;

  if (limitPerHour <= 0) return { limited: false, limitPerHour, sandboxed };

  const now = Date.now();
  const cutoff = now - 3_600_000;
  const hits = (windows.get(contributor.id) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limitPerHour) {
    windows.set(contributor.id, hits);
    return { limited: true, limitPerHour, sandboxed };
  }
  hits.push(now);
  windows.set(contributor.id, hits);
  return { limited: false, limitPerHour, sandboxed };
}
