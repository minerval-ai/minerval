/**
 * Allocators — how money reaches the action ledger.
 *
 * The mechanical rule lives in action-service.ts: an action runs exactly
 * when the allocations on its exclusion group cover its expected cost,
 * and the metered cost splits among its funders pro rata. This module is
 * the two ways allocations get PLACED:
 *
 *  1. A person chips in on a claim's next assessment
 *     (allocateToClaimAssessment): an UNPINNED allocation on the assess
 *     group — it funds "assess this claim", not a model choice, so it
 *     counts toward whichever variant wins.
 *
 *  2. A mandate's daily allocator (runMandateAllocator): reads the
 *     mandate's OWN valuations (mandate_valuations — the judgment layer),
 *     ranks the marginal increments by value per dollar of cost, and
 *     backs them best-first until the day's rate is committed or the
 *     escrow runs out. For an exclusion group the increments are:
 *
 *       base    — cover the standard sibling: ratio = value_std/cost_std,
 *                 placed UNPINNED (any sibling may consume it);
 *       upgrade — top up to the strong sibling: ratio = Δvalue/Δcost,
 *                 placed PINNED to the strong action (released back if a
 *                 cheaper sibling wins after all).
 *
 *     The day's bar — the ratio of the last increment funded — is
 *     emergent from the rate: most actions whose value merely exceeds
 *     their cost still fall below it and wait for co-funding or a
 *     cheaper day. Every mandate runs this same allocator over its own
 *     valuations; the General assessment mandate is just the first.
 *
 * Allocations never touch claims.importance and never enter any value
 * estimate; money is cost-side only, always.
 */
import { rawQuery } from "../db/client.js";
import { loadConfig } from "../config.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { ASSESS_GROUP, ensureAssessActions } from "./action-service.js";
import { enqueueSteward } from "./queue-service.js";
import { getGeneralMandate } from "./allocation-policy-service.js";

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
 * A person puts owls toward a claim's next assessment: an unpinned
 * allocation on the claim's assess group. The amount is clipped so the
 * pot never exceeds the cheapest open sibling's cost (an allocation
 * should not exceed, in expectation, the action it funds; broader
 * ambitions belong in a mandate). When the pot covers that cost, the
 * action is runnable and the executor picks it up — nothing to wait for.
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

  // Make sure the action rows exist (a chip-in on a deferred stub is the
  // normal way it becomes a candidate at all).
  await ensureAssessActions(input.claimId);
  const group = ASSESS_GROUP(input.claimId);
  const [target] = await rawQuery<{
    cost: number;
    unpinned: number;
  }>(
    `SELECT MIN(a.cost_est_micro_usd)::bigint AS cost,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = $1
                         AND al.released_at IS NULL
                         AND al.action_id IS NULL), 0)::bigint AS unpinned
       FROM actions a
      WHERE a.exclusion_group = $1 AND a.status = 'open'`,
    [group]
  );
  if (!target || target.cost == null) {
    return {
      ok: false,
      code: "COVERED",
      message:
        "This claim's next assessment is already funded or underway; nothing to contribute to",
    };
  }
  const cheapestCost = Number(target.cost);
  const unpinnedMicroUsd = Number(target.unpinned);
  const room = Math.max(0, cheapestCost - unpinnedMicroUsd);
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
    `INSERT INTO action_allocations
       (exclusion_group, claim_id, user_id, amount_micro_usd)
     VALUES ($1, $2, $3, $4)`,
    [group, input.claimId, input.userId, amountMicro]
  );

  const covered = unpinnedMicroUsd + amountMicro >= cheapestCost;
  if (
    covered &&
    claim.steward_state !== "pending" &&
    claim.steward_state !== "running"
  ) {
    // A deferred stub or an already-assessed claim: the pot buys its next
    // pass, so make it a candidate the executor can run.
    await enqueueSteward({
      claimId: input.claimId,
      trigger: "user_order",
      context:
        "Readers funded this claim's assessment. Assess it under the " +
        "ordinary standards; funding buys attention, never conclusions.",
    });
  }

  return {
    ok: true,
    allocatedOwls: microUsdToOwls(amountMicro),
    unspentOwls: microUsdToOwls(unpinnedMicroUsd + amountMicro),
    covered,
  };
}

/** A mandate's committed money: consumed shares + outstanding (unreleased)
 * allocations. Released remainders returned to the escrow count nowhere. */
export async function grantAllocationExposureMicroUsd(
  grantId: string
): Promise<{ spentMicroUsd: number; outstandingMicroUsd: number }> {
  const [row] = await rawQuery<{ spent: number; outstanding: number }>(
    `SELECT COALESCE(SUM(spent_micro_usd), 0)::bigint AS spent,
            COALESCE(SUM(amount_micro_usd - spent_micro_usd)
              FILTER (WHERE released_at IS NULL), 0)::bigint AS outstanding
       FROM action_allocations WHERE grant_id = $1`,
    [grantId]
  );
  return {
    spentMicroUsd: Number(row?.spent ?? 0),
    outstandingMicroUsd: Number(row?.outstanding ?? 0),
  };
}

export interface MandateAllocationResult {
  /** Increments placed (base coverings + strong upgrades). */
  allocated: number;
  allocatedMicroUsd: number;
  /** Value-per-dollar of the last increment funded: the day's emergent bar. */
  thresholdRatio: number | null;
}

/** One fundable increment, ranked by marginal value per marginal dollar. */
interface Increment {
  group: string;
  claimId: string | null;
  /** Pin: null = unpinned base cover; an action id = the strong upgrade. */
  actionId: string | null;
  neededMicroUsd: number;
  ratio: number;
  isUpgrade: boolean;
}

/**
 * One mandate's daily allocation pass over its own valuations. Idempotent
 * within a day: only commits what the daily rate still allows, counting
 * allocations already placed today, and never promises money the escrow
 * doesn't hold. Co-funds — allocates cost MINUS existing backing — rather
 * than duplicating other funders' money.
 */
export async function runMandateAllocator(
  grantId: string
): Promise<MandateAllocationResult> {
  const result: MandateAllocationResult = {
    allocated: 0,
    allocatedMicroUsd: 0,
    thresholdRatio: null,
  };

  const [grant] = await rawQuery<{
    daily_budget_micro_usd: number;
    budget_micro_usd: number;
    job_status: string;
  }>(
    `SELECT g.daily_budget_micro_usd, j.budget_micro_usd, j.status AS job_status
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [grantId]
  );
  if (!grant || grant.job_status !== "running") return result;

  // The day's remaining room under the mandate's rate.
  const [today] = await rawQuery<{ placed: number }>(
    `SELECT COALESCE(SUM(amount_micro_usd), 0)::bigint AS placed
       FROM action_allocations
      WHERE grant_id = $1 AND created_at >= date_trunc('day', now())`,
    [grantId]
  );
  const dailyRate = Number(grant.daily_budget_micro_usd);
  let dayRoom =
    dailyRate > 0
      ? Math.max(0, dailyRate - Number(today?.placed ?? 0))
      : Number.POSITIVE_INFINITY;
  if (dayRoom <= 0) return result;

  // Escrow headroom: never promise money the escrow doesn't hold.
  const exposure = await grantAllocationExposureMicroUsd(grantId);
  let escrowRoom = Math.max(
    0,
    Number(grant.budget_micro_usd) -
      exposure.spentMicroUsd -
      exposure.outstandingMicroUsd
  );
  if (escrowRoom <= 0) return result;

  // The mandate's valued open actions, with the live backing per action.
  const valued = await rawQuery<{
    action_id: string;
    exclusion_group: string;
    variant: string;
    claim_id: string | null;
    cost_est_micro_usd: number;
    value_est: number;
    pinned: number;
    unpinned: number;
  }>(
    `SELECT a.id AS action_id, a.exclusion_group, a.variant, a.claim_id,
            a.cost_est_micro_usd, mv.value_est,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND al.action_id = a.id), 0)::bigint AS pinned,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND al.action_id IS NULL), 0)::bigint AS unpinned
       FROM mandate_valuations mv
       JOIN actions a ON a.id = mv.action_id
      WHERE mv.grant_id = $1 AND a.status = 'open'
      ORDER BY mv.value_est / GREATEST(1000, a.cost_est_micro_usd) DESC
      LIMIT 500`,
    [grantId]
  );

  // Build the marginal increments per exclusion group.
  const byGroup = new Map<string, typeof valued>();
  for (const row of valued) {
    const list = byGroup.get(row.exclusion_group) ?? [];
    list.push(row);
    byGroup.set(row.exclusion_group, list);
  }
  const increments: Increment[] = [];
  const baseCovered = new Set<string>();
  for (const [group, siblings] of byGroup) {
    siblings.sort(
      (x, y) => Number(x.cost_est_micro_usd) - Number(y.cost_est_micro_usd)
    );
    const base = siblings[0]!;
    const baseCost = Number(base.cost_est_micro_usd);
    const baseBacking = Number(base.unpinned) + Number(base.pinned);
    const baseNeeded = Math.max(0, baseCost - baseBacking);
    if (baseNeeded > 0) {
      increments.push({
        group,
        claimId: base.claim_id,
        actionId: null,
        neededMicroUsd: baseNeeded,
        ratio: Number(base.value_est) / Math.max(1000, baseCost),
        isUpgrade: false,
      });
    } else {
      baseCovered.add(group);
    }
    // The upgrade increment: top the group up from the cheapest sibling to
    // a dearer one, judged by MARGINAL return. Only the best upgrade is
    // offered (multi-step ladders can come later with more variants).
    for (const up of siblings.slice(1)) {
      const dCost = Number(up.cost_est_micro_usd) - baseCost;
      const dValue = Number(up.value_est) - Number(base.value_est);
      if (dCost <= 0 || dValue <= 0) continue;
      const upNeeded = Math.max(0, dCost - Number(up.pinned));
      if (upNeeded <= 0) continue;
      increments.push({
        group,
        claimId: up.claim_id,
        actionId: up.action_id,
        neededMicroUsd: upNeeded,
        ratio: dValue / Math.max(1000, dCost),
        isUpgrade: true,
      });
      break;
    }
  }

  // Fund the increments best-first until the rate or escrow is committed.
  increments.sort((x, y) => y.ratio - x.ratio);
  for (const inc of increments) {
    if (dayRoom <= 0 || escrowRoom <= 0) break;
    // An upgrade only makes sense on top of a covered base.
    if (inc.isUpgrade && !baseCovered.has(inc.group)) continue;
    if (inc.neededMicroUsd > dayRoom || inc.neededMicroUsd > escrowRoom) {
      continue;
    }
    await rawQuery(
      `INSERT INTO action_allocations
         (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [inc.group, inc.actionId, inc.claimId, grantId, inc.neededMicroUsd]
    );
    dayRoom -= inc.neededMicroUsd;
    escrowRoom -= inc.neededMicroUsd;
    result.allocated++;
    result.allocatedMicroUsd += inc.neededMicroUsd;
    result.thresholdRatio = inc.ratio;
    if (!inc.isUpgrade) baseCovered.add(inc.group);
  }
  return result;
}

/**
 * The General mandate's allocation pass — the platform lane. Null when no
 * General mandate is seeded (dev, tests: the drain's fallback governs).
 */
export async function runGeneralAllocator(): Promise<MandateAllocationResult | null> {
  const mandate = await getGeneralMandate();
  if (!mandate) return null;
  return runMandateAllocator(mandate.grantId);
}

/**
 * Grants fund their OWN work through the same ledger as everything else:
 * a planning grant covers its grant_planning action, an active mandate
 * covers its periodic valuation pass, and an agent-policy mandate covers
 * its plan's unexecuted ingest items — all from its escrow, all fully
 * (the money is the grant's own; there is nothing to co-fund). The engine
 * executor then runs whatever is covered. Bounded by escrow headroom
 * (committed money includes these allocations and any regrants out).
 */
export async function fundGrantSelfActions(): Promise<number> {
  const rows = await rawQuery<{
    exclusion_group: string;
    action_id: string;
    claim_id: string | null;
    grant_id: string;
    needed: number;
    headroom: number;
  }>(
    `SELECT a.exclusion_group, a.id AS action_id, a.claim_id, g.id AS grant_id,
            GREATEST(0, a.cost_est_micro_usd -
              COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                          FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL), 0))::bigint AS needed,
            (j.budget_micro_usd
              - COALESCE((SELECT SUM(u.cost_micro_usd) FROM llm_usage u
                           WHERE u.job_id = g.budget_job_id), 0)
              - COALESCE((SELECT SUM(al.amount_micro_usd)
                            FROM action_allocations al
                           WHERE al.grant_id = g.id
                             AND al.released_at IS NULL), 0)
              - COALESCE((SELECT SUM(r.amount_micro_usd - r.refunded_micro_usd)
                            FROM regrants r
                           WHERE r.from_grant_id = g.id), 0))::bigint
              AS headroom
       FROM actions a
       JOIN grants g
         ON (a.kind IN ('grant_planning', 'mandate_review') AND a.target_ref = g.id::text)
         OR (a.kind = 'ingest' AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb))
                     WITH ORDINALITY t(item, i)
               WHERE t.i > g.plan_cursor
                 AND t.item->>'action' = 'ingest'
                 AND t.item->>'url' = a.target_ref))
       JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE a.status = 'open'
        AND a.kind IN ('grant_planning', 'mandate_review', 'ingest')
        AND g.status IN ('planning', 'active')
        AND j.status = 'running'
        -- Review passes are chainable but not unbounded: fund at most the
        -- configured passes per mandate per UTC day (each pass consumes
        -- one allocation on its review group, so counting today's
        -- allocations counts today's funded passes).
        AND (a.kind <> 'mandate_review'
             OR (SELECT COUNT(*) FROM action_allocations al
                  WHERE al.exclusion_group = a.exclusion_group
                    AND al.created_at >= date_trunc('day', now())) < $1)
      LIMIT 100`,
    [loadConfig().mandateReviewMaxPassesPerDay ?? 12]
  );
  let placed = 0;
  for (const row of rows) {
    const needed = Number(row.needed);
    if (needed <= 0 || needed > Number(row.headroom)) continue;
    await rawQuery(
      `INSERT INTO action_allocations
         (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.exclusion_group, row.action_id, row.claim_id, row.grant_id, needed]
    );
    placed++;
  }
  return placed;
}

/**
 * Every active mandate with a daily rate takes its allocation pass — the
 * scheduler's sweep. The same allocator for all of them; the General
 * mandate is just the row whose valuations span the graph.
 */
export async function runDailyAllocators(): Promise<{
  mandates: number;
  allocated: number;
  allocatedMicroUsd: number;
}> {
  const rows = await rawQuery<{ id: string }>(
    `SELECT id FROM grants
      WHERE status = 'active' AND daily_budget_micro_usd > 0
      ORDER BY created_at ASC`
  );
  const totals = { mandates: 0, allocated: 0, allocatedMicroUsd: 0 };
  for (const row of rows) {
    const r = await runMandateAllocator(row.id);
    if (r.allocated > 0) {
      totals.mandates++;
      totals.allocated += r.allocated;
      totals.allocatedMicroUsd += r.allocatedMicroUsd;
    }
  }
  return totals;
}
