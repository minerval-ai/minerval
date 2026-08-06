/**
 * Contribution awards (#71, owl economy) — recognition of *helpful*
 * contributions, paid in the spendable currency.
 *
 * Accepted contributions earn owls on the owl ledger (reason
 * 'contribution_award'), scaled by the target claim's importance. This is
 * deliberately ONE currency with purchases and grants: the contributors who
 * improve the graph gain real say over what gets assessed next. Recognition
 * still can't be bought — the leaderboard ranks lifetime owls EARNED from
 * contributions (contributors.owls_earned_micro_usd, a denormalized sum of
 * award rows), which purchases never touch and spending never lowers.
 *
 * Assignment is deterministic ("system"): an importance-scaled point scale
 * (1–5, the old kudos rule) times a configured owl rate, plus a bonus for
 * acceptances that survived appeal scrutiny. Deterministic rules are harder
 * to game than an LLM judgment and need no extra model spend; abuse rides
 * the existing gates (reviewer acceptance, reputation, rate limits).
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { owlsToMicroUsd, microUsdToOwls } from "./owl.js";
import { OWL_REASONS } from "./owl-ledger-service.js";

/** Extra award points for an acceptance won through arbitration. */
export const SURVIVED_APPEAL_BONUS_POINTS = 2;

/**
 * Award points for an accepted contribution, scaled by how load-bearing the
 * target claim is (claims.importance, 0..1): 1 point for a peripheral claim
 * up to 5 for a maximally important one. Points × contributionAwardOwlPerPoint
 * = owls earned.
 */
export function awardPointsForImportance(importance: number): number {
  const clamped = Math.min(1, Math.max(0, importance));
  return 1 + Math.round(clamped * 4);
}

/** Owls earned for an accepted contribution on a claim of this importance. */
export function owlsForImportance(importance: number): number {
  return (
    awardPointsForImportance(importance) *
    loadConfig().contributionAwardOwlPerPoint
  );
}

export interface ContributionAward {
  contributorId: string;
  contributionId?: string | null;
  owls: number;
  /** Unique key making the award idempotent (a retried decision path — an
   * LLM re-issuing the review tool call — must award exactly once). */
  awardKey?: string | null;
}

/**
 * Append an award to the owl ledger and keep the denormalized lifetime-earned
 * total in sync. Returns the owls actually awarded (0 when the awardKey
 * already landed).
 */
export async function awardContributionOwls(
  input: ContributionAward
): Promise<number> {
  if (input.owls <= 0) return 0;
  const amountMicro = owlsToMicroUsd(input.owls);
  const inserted = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger
       (user_id, amount_micro_usd, reason, contribution_id, idempotency_key)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [
      input.contributorId,
      amountMicro,
      OWL_REASONS.contributionAward,
      input.contributionId ?? null,
      input.awardKey ?? null,
    ]
  );
  if (inserted.length === 0) return 0;
  await rawQuery(
    `UPDATE contributors
        SET owls_earned_micro_usd = owls_earned_micro_usd + $1
      WHERE id = $2`,
    [amountMicro, input.contributorId]
  );
  return input.owls;
}

/**
 * Claw back everything a contribution earned (acceptance and any
 * survived-appeal bonus) with a compensating negative award row, so a
 * re-accepted contribution earns once, not twice. Returns owls reversed.
 * The clawback CAN push a spent balance negative — the contributor already
 * spent value they no longer deserve; the next earn or purchase repays it.
 */
export async function clawbackContributionOwls(input: {
  contributorId: string;
  contributionId: string;
}): Promise<number> {
  const [row] = await rawQuery<{ total: number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total
       FROM owl_ledger
      WHERE contribution_id = $1 AND reason = $2`,
    [input.contributionId, OWL_REASONS.contributionAward]
  );
  const earnedMicro = Number(row?.total ?? 0);
  if (earnedMicro <= 0) return 0;
  await rawQuery(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, contribution_id)
     VALUES ($1, $2, $3, $4)`,
    [
      input.contributorId,
      -earnedMicro,
      OWL_REASONS.contributionAward,
      input.contributionId,
    ]
  );
  await rawQuery(
    `UPDATE contributors
        SET owls_earned_micro_usd = owls_earned_micro_usd - $1
      WHERE id = $2`,
    [earnedMicro, input.contributorId]
  );
  return microUsdToOwls(earnedMicro);
}

export interface LeaderboardEntry {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  owlsEarned: number;
  reputationScore: number;
  contributionsAccepted: number;
  createdAt: Date;
}

/** Top contributors by lifetime owls earned. Suspended accounts excluded. */
export async function getLeaderboard(limit = 20): Promise<LeaderboardEntry[]> {
  const rows = await rawQuery<{
    id: string;
    display_name: string;
    avatar_url: string | null;
    owls_earned_micro_usd: number;
    reputation_score: number;
    contributions_accepted: number;
    created_at: Date;
  }>(
    `SELECT id, display_name, avatar_url, owls_earned_micro_usd,
            reputation_score, contributions_accepted, created_at
     FROM contributors
     WHERE owls_earned_micro_usd > 0 AND is_suspended = false
     ORDER BY owls_earned_micro_usd DESC, contributions_accepted DESC,
              created_at ASC
     LIMIT $1`,
    [limit]
  );
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    avatarUrl: r.avatar_url,
    owlsEarned: microUsdToOwls(Number(r.owls_earned_micro_usd)),
    reputationScore: r.reputation_score,
    contributionsAccepted: r.contributions_accepted,
    createdAt: r.created_at,
  }));
}

export interface AwardEventRow {
  id: string;
  contributionId: string | null;
  owls: number;
  createdAt: Date;
}

/** Recent contribution awards for a contributor (public profile detail). */
export async function listRecentAwards(
  contributorId: string,
  limit = 20
): Promise<AwardEventRow[]> {
  const rows = await rawQuery<{
    id: string;
    contribution_id: string | null;
    amount_micro_usd: number;
    created_at: Date;
  }>(
    `SELECT id, contribution_id, amount_micro_usd, created_at
     FROM owl_ledger
     WHERE user_id = $1 AND reason = $2
     ORDER BY created_at DESC
     LIMIT $3`,
    [contributorId, OWL_REASONS.contributionAward, limit]
  );
  return rows.map((r) => ({
    id: r.id,
    contributionId: r.contribution_id,
    owls: microUsdToOwls(Number(r.amount_micro_usd)),
    createdAt: r.created_at,
  }));
}
