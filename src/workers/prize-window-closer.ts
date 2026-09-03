/**
 * The window closer (docs/mathematics.md §8.5, §8.7): the worker lane that
 * promotes in_challenge_window claims whose window (plus pauses) has
 * elapsed, once the audit outcome is recorded without a send-back and the
 * sign-off is recorded where required, invoking the Steward directly on
 * `prize_window_closed`; voids claims whose admitted challenge the
 * Arbitrator upheld (`prize_claim_voided`); forfeits payable claims past
 * PRIZE_PAYEE_STEPS_DAYS; expires and withdraws bounties whose dates have
 * passed with no non-terminal claim; re-binds rebinding bounties on their
 * date; writes due prize tranches; and surfaces what the operator must see.
 */
import { rawQuery } from "../db/client.js";
import { invokeStewardDirect } from "./steward-direct.js";
import {
  challengePauseState,
  forfeitOverduePrizeClaims,
  getPrizeClaimById,
  promotePayable,
  voidPrizeClaim,
} from "../services/prize-claim-service.js";
import { expireAndWithdrawDueBounties, rebindDueBounties, getReserveJob, getPlatformAccountId } from "../services/bounty-service.js";
import { sweepPrizeTranches } from "../services/prize-payout-service.js";

export interface WindowCloserStats {
  promoted: number;
  voided: number;
  forfeited: number;
  expired: number;
  withdrawn: number;
  rebound: number;
  tranches: number;
  stewardRuns: number;
}

async function stewardContext(prizeClaimId: string): Promise<{ jobId?: string; userId: string; claimId: string } | null> {
  const pc = await getPrizeClaimById(prizeClaimId);
  if (!pc) return null;
  const job = await getReserveJob(pc.bounty_id);
  return { ...(job ? { jobId: job.id } : {}), userId: await getPlatformAccountId(), claimId: pc.claim_id };
}

/** Promote every window that has elapsed and is otherwise ready. */
export async function promoteElapsedWindows(opts: { model?: string } = {}): Promise<{ promoted: number; stewardRuns: number }> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM prize_claims WHERE status = 'in_challenge_window' AND window_ends_at IS NOT NULL AND window_ends_at <= now()
      ORDER BY window_ends_at ASC`
  );
  let promoted = 0;
  let stewardRuns = 0;
  for (const row of rows) {
    const { promoted: ok } = await promotePayable(row.id);
    if (!ok) continue;
    promoted++;
    const ctx = await stewardContext(row.id);
    if (!ctx) continue;
    try {
      await invokeStewardDirect({
        trigger: "prize_window_closed",
        claimId: ctx.claimId,
        context: `prize claim ${row.id}: the challenge window closed without a successful challenge; confirm the assessment that was provisional (get_prize_claim).`,
        jobId: ctx.jobId,
        userId: ctx.userId,
        ...(opts.model ? { model: opts.model } : {}),
      });
      stewardRuns++;
    } catch (err) {
      console.error("[prize-window] steward invocation failed:", err instanceof Error ? err.message : err);
    }
  }
  return { promoted, stewardRuns };
}

/**
 * A challenge the Arbitrator upheld (`overturn` on the challenge contribution)
 * voids the prize claim with the challenge's ground (§8.5). The Arbitrator's
 * tools are not this slice's; the closer applies the consequence.
 */
export async function voidUpheldChallenges(opts: { model?: string } = {}): Promise<{ voided: number; stewardRuns: number }> {
  const rows = await rawQuery<{ prize_claim_id: string; content: string; contribution_id: string }>(
    `SELECT c.challenged_prize_claim_id AS prize_claim_id, c.content, c.id AS contribution_id
       FROM contributions c
       JOIN prize_claims pc ON pc.id = c.challenged_prize_claim_id
      WHERE c.contribution_type = 'challenge'
        AND pc.status IN ('in_challenge_window', 'payable')
        AND EXISTS (SELECT 1 FROM arbitration_results ar WHERE ar.contribution_id = c.id AND ar.outcome = 'overturn')`
  );
  let voided = 0;
  let stewardRuns = 0;
  for (const row of rows) {
    const pause = await challengePauseState(row.prize_claim_id);
    if (!pause.overturned) continue;
    const ground = (/\[ground: ([a-z_]+)\]/.exec(row.content)?.[1] ?? "operator") as Parameters<typeof voidPrizeClaim>[0]["ground"];
    const res = await voidPrizeClaim({
      prizeClaimId: row.prize_claim_id,
      ground,
      note: `challenge ${row.contribution_id} upheld by the Dispute Arbitrator`,
      actor: "dispute_arbitrator",
    });
    if (!res.ok) continue;
    voided++;
    const ctx = await stewardContext(row.prize_claim_id);
    if (!ctx) continue;
    try {
      await invokeStewardDirect({
        trigger: "prize_claim_voided",
        claimId: ctx.claimId,
        context: `prize claim ${row.prize_claim_id}: voided after an upheld challenge (${ground}); reassess without the provisional acceptance (get_prize_claim).`,
        jobId: ctx.jobId,
        userId: ctx.userId,
        ...(opts.model ? { model: opts.model } : {}),
      });
      stewardRuns++;
    } catch (err) {
      console.error("[prize-window] steward invocation failed:", err instanceof Error ? err.message : err);
    }
  }
  return { voided, stewardRuns };
}

/** One pass of the closer. Each step is independent; a failure in one never stops the rest. */
export async function runPrizeWindowCloser(opts: { model?: string } = {}): Promise<WindowCloserStats> {
  const stats: WindowCloserStats = { promoted: 0, voided: 0, forfeited: 0, expired: 0, withdrawn: 0, rebound: 0, tranches: 0, stewardRuns: 0 };
  const step = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      console.error(`[prize-window] ${name} failed:`, err instanceof Error ? err.message : err);
    }
  };
  await step("void upheld challenges", async () => {
    const r = await voidUpheldChallenges(opts);
    stats.voided += r.voided;
    stats.stewardRuns += r.stewardRuns;
  });
  await step("promote elapsed windows", async () => {
    const r = await promoteElapsedWindows(opts);
    stats.promoted += r.promoted;
    stats.stewardRuns += r.stewardRuns;
  });
  await step("forfeit overdue claims", async () => {
    stats.forfeited += (await forfeitOverduePrizeClaims()).length;
  });
  await step("expire and withdraw bounties", async () => {
    const r = await expireAndWithdrawDueBounties();
    stats.expired += r.expired;
    stats.withdrawn += r.withdrawn;
  });
  await step("rebind bounties", async () => {
    stats.rebound += await rebindDueBounties();
  });
  await step("prize tranches", async () => {
    stats.tranches += await sweepPrizeTranches();
  });
  return stats;
}
