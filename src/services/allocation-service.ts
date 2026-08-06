/**
 * The allocation engine — one mechanism for everyone's money.
 *
 * An ALLOCATION is funds a funder has put toward one specific action
 * (assessing one claim, today's only action kind). Funders are mandates
 * (grant_id, drawing on their escrow) or people directly (user_id,
 * debited from their owl balance). The rule, uniform for all:
 *
 *   An action runs exactly when the total unspent allocations on it
 *   cover its expected cost. Until then it waits, however many funders
 *   have partially backed it. When it runs, the metered cost is split
 *   across the allocations PRO RATA: each funder pays their
 *   proportional share, never more.
 *
 * Minerval's own General assessment mandate spends through this same
 * engine (dogfooding, not a privileged lane): its allocator walks the
 * candidates by expected value per dollar of remaining cost, best first,
 * and allocates until its daily rate is committed. The threshold this
 * implies — the value-per-dollar of the last action funded — is the
 * day's effective bar: most actions whose value exceeds their cost still
 * fall below it, which is exactly how a bounded budget should behave.
 * The bar is emergent from the budget, not a hand-set constant.
 *
 * Allocations never touch claims.importance and never enter the value
 * estimate; money is cost-side only, always.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { estimateStewardRunCostMicroUsd } from "./cost-estimate-service.js";
import { refreshQueuePriority } from "./priority-service.js";
import { enqueueSteward } from "./queue-service.js";
import {
  getGeneralMandate,
  type GeneralMandate,
} from "./allocation-policy-service.js";

/** A claim's assess-action backing: total and unspent allocation. */
export async function getActionBackingMicroUsd(
  claimId: string
): Promise<{ totalMicroUsd: number; unspentMicroUsd: number }> {
  const [row] = await rawQuery<{ total: number; unspent: number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS total,
            COALESCE(SUM(amount_micro_usd - spent_micro_usd), 0)::bigint AS unspent
       FROM action_allocations
      WHERE claim_id = $1 AND action = 'assess'`,
    [claimId]
  );
  return {
    totalMicroUsd: Number(row?.total ?? 0),
    unspentMicroUsd: Number(row?.unspent ?? 0),
  };
}

export type AllocateResult =
  | {
      ok: true;
      allocatedOwls: number;
      unspentOwls: number;
      /** True when this allocation completed the pot: the action will run. */
      covered: boolean;
    }
  | {
      ok: false;
      code:
        | "CLAIM_NOT_FOUND"
        | "COVERED"
        | "INSUFFICIENT_OWLS"
        | "BAD_AMOUNT";
      message: string;
    };

/**
 * A person puts owls toward a claim's next assessment. The amount is
 * clipped so the unspent pot never exceeds the expected cost of the pass
 * (an allocation should not exceed, in expectation, the action it funds;
 * broader ambitions belong in a mandate). When the pot reaches cost, the
 * claim is (re)enqueued and the engine will run it.
 */
export async function allocateToClaimAssessment(input: {
  userId: string;
  claimId: string;
  owls: number;
}): Promise<AllocateResult> {
  if (!(input.owls > 0)) {
    return {
      ok: false,
      code: "BAD_AMOUNT",
      message: "Allocate a positive number of owls",
    };
  }
  const config = loadConfig();
  const [claim] = await rawQuery<{ id: string; steward_state: string }>(
    `SELECT id, steward_state FROM claims WHERE id = $1 AND state = 'active'`,
    [input.claimId]
  );
  if (!claim) {
    return {
      ok: false,
      code: "CLAIM_NOT_FOUND",
      message: "Claim not found or not active",
    };
  }

  const passCostMicro = await estimateStewardRunCostMicroUsd(
    config.stewardStrongModel || config.stewardModel
  );
  const { unspentMicroUsd } = await getActionBackingMicroUsd(input.claimId);
  const room = Math.max(0, passCostMicro - unspentMicroUsd);
  if (room <= 0) {
    return {
      ok: false,
      code: "COVERED",
      message:
        "This claim's next assessment is already fully funded; it will run shortly",
    };
  }
  const amountMicro = Math.min(owlsToMicroUsd(input.owls), room);

  // Debit behind the balance guard (same single-statement posture as a
  // charge), then record the allocation.
  const debited = await rawQuery<{ id: string }>(
    `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id)
     SELECT $1, $2, 'claim_contribution', $3
      WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0)
               FROM owl_ledger WHERE user_id = $1) >= $4
     RETURNING id`,
    [input.userId, -amountMicro, input.claimId, amountMicro]
  );
  if (debited.length === 0) {
    return {
      ok: false,
      code: "INSUFFICIENT_OWLS",
      message: `Allocating ${microUsdToOwls(amountMicro)} owls exceeds your balance`,
    };
  }
  await rawQuery(
    `INSERT INTO action_allocations (claim_id, user_id, amount_micro_usd)
     VALUES ($1, $2, $3)`,
    [input.claimId, input.userId, amountMicro]
  );

  const covered = unspentMicroUsd + amountMicro >= passCostMicro;
  if (
    covered &&
    claim.steward_state !== "pending" &&
    claim.steward_state !== "running"
  ) {
    // A deferred stub or an already-assessed claim: the pot buys its next
    // pass, so make it a candidate the engine can run.
    await enqueueSteward({
      claimId: input.claimId,
      trigger: "user_order",
      context:
        "Readers funded this claim's assessment. Assess it under the " +
        "ordinary standards; funding buys attention, never conclusions.",
    });
  }
  await refreshQueuePriority(input.claimId).catch(() => {});

  return {
    ok: true,
    allocatedOwls: microUsdToOwls(amountMicro),
    unspentOwls: microUsdToOwls(unspentMicroUsd + amountMicro),
    covered,
  };
}

/**
 * Split a finished run's metered cost across the action's allocations,
 * PRO RATA by unspent amount (each funder pays their proportional share).
 * Returns how much was consumed; cost beyond the pot is absorbed by the
 * platform (estimates were low — the funders' ceiling holds).
 */
export async function consumeAllocations(
  claimId: string,
  meteredMicroUsd: number
): Promise<number> {
  if (meteredMicroUsd <= 0) return 0;
  const rows = await rawQuery<{ id: string; unspent: number }>(
    `SELECT id, (amount_micro_usd - spent_micro_usd)::bigint AS unspent
       FROM action_allocations
      WHERE claim_id = $1 AND action = 'assess'
        AND spent_micro_usd < amount_micro_usd
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED`,
    [claimId]
  );
  const totalUnspent = rows.reduce((s, r) => s + Number(r.unspent), 0);
  if (totalUnspent <= 0) return 0;
  const toConsume = Math.min(meteredMicroUsd, totalUnspent);
  let consumed = 0;
  for (const [i, row] of rows.entries()) {
    // Pro-rata share, with the last row absorbing rounding.
    const share =
      i === rows.length - 1
        ? toConsume - consumed
        : Math.floor((toConsume * Number(row.unspent)) / totalUnspent);
    const take = Math.min(Number(row.unspent), Math.max(0, share));
    if (take <= 0) continue;
    await rawQuery(
      `UPDATE action_allocations
          SET spent_micro_usd = spent_micro_usd + $2
        WHERE id = $1`,
      [row.id, take]
    );
    consumed += take;
  }
  return consumed;
}

/**
 * Metering attribution for a covered run: the largest allocator. A mandate
 * yields its budget-job id (which also stamps the funding disclosure); a
 * person yields their user id.
 */
export async function largestAllocator(
  claimId: string
): Promise<{ jobId?: string; userId?: string }> {
  const [row] = await rawQuery<{
    grant_id: string | null;
    user_id: string | null;
    budget_job_id: string | null;
  }>(
    `SELECT a.grant_id, a.user_id, g.budget_job_id
       FROM action_allocations a
       LEFT JOIN grants g ON g.id = a.grant_id
      WHERE a.claim_id = $1 AND a.action = 'assess'
      GROUP BY a.grant_id, a.user_id, g.budget_job_id
      ORDER BY SUM(a.amount_micro_usd - a.spent_micro_usd) DESC
      LIMIT 1`,
    [claimId]
  );
  if (!row) return {};
  if (row.budget_job_id) return { jobId: row.budget_job_id };
  if (row.user_id) return { userId: row.user_id };
  return {};
}

/** A mandate's committed money: consumed shares + outstanding allocations. */
export async function grantAllocationExposureMicroUsd(
  grantId: string
): Promise<{ spentMicroUsd: number; outstandingMicroUsd: number }> {
  const [row] = await rawQuery<{ spent: number; outstanding: number }>(
    `SELECT COALESCE(SUM(spent_micro_usd), 0)::bigint AS spent,
            COALESCE(SUM(amount_micro_usd - spent_micro_usd), 0)::bigint
              AS outstanding
       FROM action_allocations WHERE grant_id = $1`,
    [grantId]
  );
  return {
    spentMicroUsd: Number(row?.spent ?? 0),
    outstandingMicroUsd: Number(row?.outstanding ?? 0),
  };
}

export interface GeneralAllocationResult {
  allocated: number;
  allocatedMicroUsd: number;
  /** The value-per-dollar of the last action funded: the day's emergent bar. */
  thresholdRatio: number | null;
}

/**
 * The General mandate's allocator: walk the pending candidates by expected
 * value per dollar of REMAINING cost (what other funders haven't covered),
 * best first, and allocate the remainder for each until the day's rate is
 * committed or the escrow's uncommitted headroom runs out. The engine then
 * runs whatever became covered. Idempotent within a day: it only commits
 * what the rate still allows, counting allocations already placed today.
 */
export async function allocateGeneralMandateDaily(input: {
  mandate: GeneralMandate;
  standardCostMicroUsd: number;
  strongCostMicroUsd: number;
  strongMinValue: number;
}): Promise<GeneralAllocationResult> {
  const { mandate } = input;
  const result: GeneralAllocationResult = {
    allocated: 0,
    allocatedMicroUsd: 0,
    thresholdRatio: null,
  };
  if (mandate.jobStatus !== "running") return result;

  // The day's remaining allocation room under the mandate's rate.
  const [today] = await rawQuery<{ placed: number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS placed
       FROM action_allocations
      WHERE grant_id = $1 AND created_at >= date_trunc('day', now())`,
    [mandate.grantId]
  );
  const placedToday = Number(today?.placed ?? 0);
  let dayRoom =
    mandate.dailyBudgetMicroUsd > 0
      ? Math.max(0, mandate.dailyBudgetMicroUsd - placedToday)
      : Number.POSITIVE_INFINITY;
  if (dayRoom <= 0) return result;

  // Escrow headroom: never promise money the escrow doesn't hold.
  const exposure = await grantAllocationExposureMicroUsd(mandate.grantId);
  let escrowRoom = Math.max(
    0,
    mandate.budgetMicroUsd -
      exposure.spentMicroUsd -
      exposure.outstandingMicroUsd
  );
  if (escrowRoom <= 0) return result;

  // Candidates by value per dollar of remaining cost, best first.
  const candidates = await rawQuery<{
    id: string;
    queue_priority: number;
    needed: number;
    ratio: number;
  }>(
    `SELECT c.id, c.queue_priority,
            GREATEST(0,
              (CASE WHEN $1::real > 0 AND c.queue_priority >= $2::real
                    THEN $1::real ELSE $3::real END)
              - COALESCE((SELECT SUM(a.amount_micro_usd - a.spent_micro_usd)
                            FROM action_allocations a
                           WHERE a.claim_id = c.id AND a.action = 'assess'), 0)
            )::bigint AS needed,
            c.queue_priority / GREATEST(1000,
              (CASE WHEN $1::real > 0 AND c.queue_priority >= $2::real
                    THEN $1::real ELSE $3::real END)) AS ratio
       FROM claims c
      WHERE c.state = 'active' AND c.steward_state = 'pending'
      ORDER BY ratio DESC
      LIMIT 200`,
    [
      input.strongCostMicroUsd > 0 ? input.strongCostMicroUsd : 0,
      input.strongMinValue,
      input.standardCostMicroUsd,
    ]
  );

  for (const cand of candidates) {
    const needed = Number(cand.needed);
    if (needed <= 0) continue; // already covered by other funders
    if (needed > dayRoom || needed > escrowRoom) continue;
    await rawQuery(
      `INSERT INTO action_allocations (claim_id, grant_id, amount_micro_usd)
       VALUES ($1, $2, $3)`,
      [cand.id, mandate.grantId, needed]
    );
    dayRoom -= needed;
    escrowRoom -= needed;
    result.allocated++;
    result.allocatedMicroUsd += needed;
    result.thresholdRatio = Number(cand.ratio);
    if (dayRoom <= 0 || escrowRoom <= 0) break;
  }
  return result;
}

/**
 * Run the General mandate's allocator with the current policy and cost
 * estimates. The drain calls this when nothing is covered; the scheduler
 * calls it on its sweep.
 */
export async function runGeneralAllocator(): Promise<GeneralAllocationResult | null> {
  const mandate = await getGeneralMandate();
  if (!mandate) return null;
  const config = loadConfig();
  const { getEffectiveAllocationPolicy } = await import(
    "./allocation-policy-service.js"
  );
  const { stewardTierCostEstimates } = await import(
    "./cost-estimate-service.js"
  );
  const policy = await getEffectiveAllocationPolicy();
  const tiers = await stewardTierCostEstimates();
  return allocateGeneralMandateDaily({
    mandate,
    standardCostMicroUsd: tiers.standardMicroUsd,
    strongCostMicroUsd: config.stewardStrongModel ? tiers.strongMicroUsd : 0,
    strongMinValue: policy.strong_min_value,
  });
}
