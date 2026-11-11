/**
 * How people and mandates pay for work on the ledger, and what a mandate
 * pays for its own work.
 *
 * Every payment for work is a commission (commission-service.ts): the
 * payer chooses the budget, pays it whole, the run starts at once, and what
 * it does not spend comes back. This module keeps the entry points the
 * routes and tools call (a reader commissioning a claim's next assessment or
 * the work on a request, a Grantmaker commissioning a request), a mandate's
 * exposure for its accounts, and fundGrantSelfActions: a mandate paying for
 * its own planning, review passes, lookouts, correspondents and planned
 * ingests, and the General mandate for the consistency sweeps.
 *
 * There is no formula and no allocation pass: what a mandate pays for
 * beyond its own upkeep, its agents commission under its written operating
 * policy (program-officer.ts). Money never touches claims.importance or any
 * judgment of a claim; it buys attention, never conclusions.
 */
import { rawQuery } from "../db/client.js";
import { allocationDayUseSql } from "./day-use.js";
import { loadConfig } from "../config.js";
import { microUsdToOwls, owlsToMicroUsd } from "./owl.js";
import { REQUEST_GROUP, ensureRequestActions } from "./action-service.js";
import { commissionAction, commissionNodePass } from "./commission-service.js";
import {
  POLICY_BOUNDS,
  getEffectiveAllocationPolicy,
  getGeneralMandate,
} from "./allocation-policy-service.js";
import { sweepYieldByVariant } from "./consistency-service.js";
import { prizeCommitmentSql } from "./prize-commitment.js";

export type AllocateResult =
  | {
      ok: true;
      /** The budget commissioned, in owls. */
      allocatedOwls: number;
      /** The budget the pass runs with; what it does not spend comes back. */
      unspentOwls: number;
      /** Always true now: a commission is whole, so the pass runs. */
      covered: boolean;
      actionId: string;
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
 * A person commissions a claim's next assessment whole, at the budget they
 * choose (commission-service.ts): their owls are the pass's budget, the pass
 * runs at once, and whatever it does not spend comes back when it settles.
 * There is no pot to wait on and no splitting among funders. When the claim
 * already has a pass commissioned or running, nothing is charged.
 */
export async function allocateToClaimAssessment(input: {
  userId: string;
  claimId: string;
  owls: number;
}): Promise<AllocateResult> {
  if (!(input.owls > 0)) {
    return { ok: false, code: "BAD_AMOUNT", message: "Commission it with a positive number of owls" };
  }
  const budget = owlsToMicroUsd(input.owls);
  const result = await commissionNodePass({
    payer: { kind: "user", userId: input.userId },
    claimId: input.claimId,
    budgetMicroUsd: budget,
    brief:
      "A reader commissioned this claim's assessment. Assess it under the ordinary " +
      "standards; funding buys attention, never conclusions.",
    reason: "A reader commissioned it.",
    commissionedBy: "person",
    message: { trigger: "user_order" },
  });
  if (!result.ok) {
    const code =
      result.code === "NOT_FOUND"
        ? ("CLAIM_NOT_FOUND" as const)
        : result.code === "INSUFFICIENT_OWLS"
          ? ("INSUFFICIENT_OWLS" as const)
          : ("BAD_AMOUNT" as const);
    return { ok: false, code, message: result.message };
  }
  if (result.status === "already_commissioned") {
    return {
      ok: false,
      code: "COVERED",
      message:
        "This claim's next assessment is already commissioned or underway; nothing was charged",
    };
  }
  return {
    ok: true,
    allocatedOwls: microUsdToOwls(budget),
    unspentOwls: microUsdToOwls(budget),
    covered: true,
    actionId: result.actionId,
  };
}

/** A request's quote and what a payer of its full work is told about it (#885). */
export type RequestQuoteStanding = { quoteMicroUsd: number; underQuote: boolean; note: string };

export type RequestAllocateResult =
  | {
      ok: true;
      allocatedOwls: number;
      backingOwls: number;
      /** The row commissioned: the scoping pass, or the full work. */
      variant: "scope" | "full";
      /** Always true now: a commission is whole, so the work runs. */
      covered: boolean;
      /** For the full work: its quote and what the payer is told of it. */
      quote?: RequestQuoteStanding;
    }
  | {
      ok: false;
      code: "REQUEST_NOT_FOUND" | "CLOSED" | "COVERED" | "INSUFFICIENT_OWLS" | "BAD_AMOUNT";
      message: string;
    };

/** The open row of a request's work, opened now if the request predates the ledger. */
async function openRequestRow(requestId: string): Promise<{ id: string; variant: "scope" | "full" } | null> {
  const find = async () =>
    (
      await rawQuery<{ id: string; variant: "scope" | "full" }>(
        `SELECT id, variant FROM actions
          WHERE exclusion_group = $1 AND status = 'open'
          ORDER BY variant = 'full' DESC LIMIT 1`,
        [REQUEST_GROUP(requestId)]
      )
    )[0] ?? null;
  const row = await find();
  if (row) return row;
  return (await ensureRequestActions(requestId)) ? find() : null;
}

async function requestState(requestId: string): Promise<{ ok: true } | { ok: false; code: "REQUEST_NOT_FOUND" | "CLOSED"; message: string }> {
  const [req] = await rawQuery<{ state: string }>(`SELECT state FROM requests WHERE id = $1`, [requestId]);
  if (!req) return { ok: false, code: "REQUEST_NOT_FOUND", message: `No request ${requestId} exists` };
  if (["met", "declined", "withdrawn", "moot"].includes(req.state)) {
    return { ok: false, code: "CLOSED", message: `This request is ${req.state}; it takes no more work` };
  }
  return { ok: true };
}

/**
 * A person commissions the work on a request whole (its scoping pass while
 * it has no budget, else the full work), at the budget they choose. It runs
 * at once; unspent budget comes back when it settles, and all of it should
 * the request close first (closeRequestActions).
 */
export async function allocateToRequest(input: {
  userId: string;
  requestId: string;
  owls: number;
}): Promise<RequestAllocateResult> {
  if (!(input.owls > 0)) {
    return { ok: false, code: "BAD_AMOUNT", message: "Commission it with a positive number of owls" };
  }
  const state = await requestState(input.requestId);
  if (!state.ok) return state;
  const row = await openRequestRow(input.requestId);
  if (!row) {
    return { ok: false, code: "COVERED", message: "Work on this request is already underway; nothing is open to commission" };
  }
  const budget = owlsToMicroUsd(input.owls);
  const result = await commissionAction({
    payer: { kind: "user", userId: input.userId },
    actionId: row.id,
    budgetMicroUsd: budget,
    reason: "A reader commissioned it.",
    commissionedBy: "person",
  });
  if (!result.ok) {
    const code = result.code === "INSUFFICIENT_OWLS" ? ("INSUFFICIENT_OWLS" as const) : ("BAD_AMOUNT" as const);
    return { ok: false, code, message: result.message };
  }
  if (result.status === "already_commissioned") {
    return { ok: false, code: "COVERED", message: "This request's next piece of work is already commissioned; nothing was charged" };
  }
  return {
    ok: true,
    allocatedOwls: microUsdToOwls(budget),
    backingOwls: microUsdToOwls(budget),
    variant: row.variant,
    covered: true,
    ...(result.quote ? { quote: result.quote } : {}),
  };
}

export type MandateRequestAllocateResult =
  | {
      ok: true;
      placedMicroUsd: number;
      variant: "scope" | "full";
      status: "commissioned" | "already_commissioned";
      /** For the full work: its quote and what the payer is told of it (#885). */
      quote?: RequestQuoteStanding;
    }
  | { ok: false; code: "REQUEST_NOT_FOUND" | "CLOSED" | "COVERED" | "NO_ROOM" | "BAD_AMOUNT"; message: string };

/**
 * A mandate commissions the work on a request whole, by its Grantmaker's
 * decision (fund_request), within its daily rate and escrow like any of its
 * commissions.
 */
export async function allocateMandateToRequest(input: {
  grantId: string;
  requestId: string;
  microUsd: number;
}): Promise<MandateRequestAllocateResult> {
  if (!(input.microUsd > 0)) return { ok: false, code: "BAD_AMOUNT", message: "Commission it with a positive budget" };
  const state = await requestState(input.requestId);
  if (!state.ok) return state;
  const row = await openRequestRow(input.requestId);
  if (!row) return { ok: false, code: "COVERED", message: "Work on this request is underway; nothing is open to commission" };
  const result = await commissionAction({
    payer: { kind: "grant", grantId: input.grantId },
    actionId: row.id,
    budgetMicroUsd: Math.round(input.microUsd),
    reason: "The mandate's Grantmaker commissioned it.",
    commissionedBy: "grantmaker",
  });
  if (!result.ok) {
    return { ok: false, code: result.code === "BAD_AMOUNT" ? "BAD_AMOUNT" : "NO_ROOM", message: result.message };
  }
  return {
    ok: true,
    placedMicroUsd: result.status === "commissioned" ? Math.round(input.microUsd) : 0,
    variant: row.variant,
    status: result.status,
    ...(result.status === "commissioned" && result.quote ? { quote: result.quote } : {}),
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

/**
 * Which variant of a consistency sweep the General mandate buys (#756),
 * given the two prices of one partition's rows. A sweep has no value
 * estimate of its own to set against the day's bar, so the marginal-return
 * rule compares the upgrade with the sweep itself: the strong variant is
 * expected to find `expectedGain` times what the standard finds, and is
 * bought when that is at least as much per owl (expectedGain × standard
 * price ≥ strong price). Otherwise more partitions read on the cheap tier
 * return more than fewer read on the strong one. Both prices scale with
 * the partition's size, so the choice is made per partition: where a cap
 * binds, the ratio between them is not the ratio of their per-node costs.
 * fundGrantSelfActions makes the same comparison in SQL; this is its
 * statement.
 */
export function consistencySweepVariant(
  expectedGain: number,
  standardMicroUsd: number,
  strongMicroUsd: number
): "standard" | "strong" {
  return expectedGain * standardMicroUsd >= strongMicroUsd ? "strong" : "standard";
}

/** How far back the variants' yields are read, and how many sweeps of each the evidence needs. */
export const CONSISTENCY_EVIDENCE = { windowDays: 60, minSweepsPerVariant: 10 } as const;

export interface StrongExpectedGain {
  gain: number;
  /** override: the General mandate's own policy sets it; evidence: the variants' upheld flags; default: the policy default. */
  source: "override" | "evidence" | "default";
}

/**
 * How much more a strong sweep is expected to find than a standard one
 * (#756), in order:
 *
 *   1. override: the General mandate's allocation policy sets
 *      `consistency_strong_expected_gain` itself (its Grantmaker's
 *      judgment, for instance from the corpus consistency eval's recall on
 *      each tier, scripts/corpus/consistency.ts);
 *   2. evidence: once each variant has CONSISTENCY_EVIDENCE.minSweepsPerVariant
 *      completed sweeps in the window, the ratio of their upheld flags (a
 *      flag whose pass moved the judgment) per node read, each count
 *      smoothed by one so a variant with none yet is not read as zero,
 *      held to the policy's bounds;
 *   3. default: the shipped policy default.
 */
export async function consistencyStrongExpectedGain(): Promise<StrongExpectedGain> {
  const mandate = await getGeneralMandate();
  const own = mandate?.allocationPolicy?.consistency_strong_expected_gain;
  const bounds = POLICY_BOUNDS.consistency_strong_expected_gain;
  if (typeof own === "number" && Number.isFinite(own)) {
    return { gain: Math.min(bounds.max, Math.max(bounds.min, own)), source: "override" };
  }
  const yields = await sweepYieldByVariant(CONSISTENCY_EVIDENCE.windowDays).catch(() => []);
  const standard = yields.find((y) => y.variant === "standard");
  const strong = yields.find((y) => y.variant === "strong");
  if (
    standard && strong &&
    standard.sweeps >= CONSISTENCY_EVIDENCE.minSweepsPerVariant &&
    strong.sweeps >= CONSISTENCY_EVIDENCE.minSweepsPerVariant &&
    standard.nodes > 0 && strong.nodes > 0
  ) {
    const ratio = ((strong.upheld + 1) / strong.nodes) / ((standard.upheld + 1) / standard.nodes);
    return { gain: Math.min(bounds.max, Math.max(bounds.min, ratio)), source: "evidence" };
  }
  return { gain: (await getEffectiveAllocationPolicy()).consistency_strong_expected_gain, source: "default" };
}

/**
 * The variant of sweep row `a`'s partition the marginal-return rule buys
 * (consistencySweepVariant in SQL): strong when the strong read's expected
 * gain ($4) times the standard price covers the strong one. One text, read
 * by the General mandate's lane and by a mandate's sweep item that names
 * no variant.
 */
const SWEEP_RULE_VARIANT_SQL = `(
              SELECT CASE WHEN $4::real * std.cost_est_micro_usd >= strong.cost_est_micro_usd
                          THEN 'strong' ELSE 'standard' END
                FROM actions std
                JOIN actions strong ON strong.exclusion_group = std.exclusion_group
                                   AND strong.variant = 'strong'
               WHERE std.exclusion_group = a.exclusion_group AND std.variant = 'standard')`;

/**
 * Grants fund their OWN work through the same ledger as everything else:
 * a planning grant covers its grant_planning action, an active mandate
 * covers its review passes and the runs of the lookouts and correspondents
 * it stands up, an agent-policy mandate covers its plan's unexecuted ingest
 * items and the sweeps its sweep items name, and the General mandate covers
 * the platform's consistency sweeps. All from
 * the mandate's escrow, all fully (the money is the grant's own; there is
 * nothing to co-fund). The engine executor then runs whatever is covered.
 *
 * Deliberation pays its own way: these allocations come out of the same
 * daily rate as everything else the mandate commissions, so thinking about
 * the work competes with the work. Bounded by escrow headroom too
 * (committed money includes these allocations and any regrants out).
 */
export async function fundGrantSelfActions(): Promise<number> {
  const rows = await rawQuery<{
    exclusion_group: string;
    action_id: string;
    claim_id: string | null;
    grant_id: string;
    kind: string;
    needed: number;
    headroom: number;
    /** Null when the mandate has no daily rate: unpaced, escrow-bounded only. */
    day_room: number | null;
  }>(
    `SELECT a.exclusion_group, a.id AS action_id, a.claim_id, g.id AS grant_id, a.kind,
            -- What this row still needs: its cost less what already backs
            -- it (an allocation placed on its group as a whole, or on this
            -- row). A sibling variant's allocation is not this row's (#756).
            GREATEST(0, a.cost_est_micro_usd -
              COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                          FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL
                           AND (al.action_id IS NULL OR al.action_id = a.id)), 0))::bigint AS needed,
            -- Same accounting as grantCommittedMicroUsd: consumed pro-rata
            -- shares + outstanding allocations + NON-LEDGER metered spend
            -- (llm_usage minus what allocation SHARES already account for, so
            -- a self-funded run isn't counted twice — and so a run that cost
            -- more than it was allocated has its overage counted here rather
            -- than cancelled out, which is what subtracting the full
            -- actions.metered_cost used to do) + regrants + the prize term
            -- (bounties held against the escrow, prizes paid, the review
            -- reserve; prize-commitment.ts).
            (j.budget_micro_usd
              - COALESCE((SELECT SUM(al.spent_micro_usd)
                            FROM action_allocations al
                           WHERE al.grant_id = g.id), 0)
              - COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                            FROM action_allocations al
                           WHERE al.grant_id = g.id
                             AND al.released_at IS NULL), 0)
              - GREATEST(0,
                  COALESCE((SELECT SUM(u.cost_micro_usd) FROM llm_usage u
                             WHERE u.job_id = g.budget_job_id), 0)
                  - COALESCE((SELECT SUM(al.spent_micro_usd)
                                FROM action_allocations al
                               WHERE al.grant_id = g.id), 0))
              - COALESCE((SELECT SUM(r.amount_micro_usd - r.refunded_micro_usd)
                            FROM regrants r
                           WHERE r.from_grant_id = g.id), 0)
              - ${prizeCommitmentSql("g.id")})::bigint
              AS headroom,
            -- The day's remaining room under the mandate's rate, counted the
            -- same way a commission counts it (grantDayUseMicroUsd). A rate
            -- of 0 means unpaced.
            (CASE WHEN g.daily_budget_micro_usd > 0
                  THEN GREATEST(0, g.daily_budget_micro_usd
                    - COALESCE((SELECT SUM(${allocationDayUseSql("al")})
                                  FROM action_allocations al
                                 WHERE al.grant_id = g.id
                                   AND al.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'), 0))
                  ELSE NULL END)::bigint AS day_room
       FROM actions a
       JOIN grants g
         ON (a.kind IN ('grant_planning', 'mandate_review') AND a.target_ref = g.id::text)
         -- A lookout run is the funding mandate's own work too: the row
         -- names the lookout, the lookout names its mandate.
         OR (a.kind = 'lookout_run' AND EXISTS (
              SELECT 1 FROM lookouts l
               WHERE l.id::text = a.target_ref AND l.grant_id = g.id
                 AND l.status = 'active'))
         -- So is a Correspondent's run (#563), by the same rule.
         OR (a.kind = 'correspondent_run' AND EXISTS (
              SELECT 1 FROM correspondents c
               WHERE c.id::text = a.target_ref AND c.grant_id = g.id
                 AND c.status = 'active'))
         -- A consistency sweep (#330) is the platform's own work: the
         -- General mandate funds it, as the formula mandate whose scope
         -- is the whole graph. Of a partition's two variants it buys the
         -- one the marginal-return rule picks from that partition's two
         -- prices (consistencySweepVariant, with the strong read's
         -- expected gain as $4, #756), and never both.
         OR (a.kind = 'consistency_sweep' AND a.variant = ${SWEEP_RULE_VARIANT_SQL}
             AND g.id = (
              SELECT gg.id FROM grants gg
               WHERE gg.is_platform = true AND gg.policy = 'general' AND gg.status = 'active'
               ORDER BY gg.created_at ASC LIMIT 1))
         -- A mandate's own sweep item (#831): the row the item opened,
         -- while the item waits for its sweep, at the variant it named or,
         -- naming none, the same rule. Out of the mandate's escrow and day
         -- like an ingest item.
         OR (a.kind = 'consistency_sweep' AND g.status = 'active' AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) item
               WHERE item->>'action' = 'sweep'
                 AND item->'ledger'->>'exclusion_group' = a.exclusion_group
                 AND item->'ledger'->>'status' = 'open'
                 AND (item->>'variant' = a.variant
                      OR (COALESCE(item->>'variant', '') NOT IN ('standard', 'strong')
                          AND a.variant = ${SWEEP_RULE_VARIANT_SQL}))))
         -- Any open ingest row a plan item names, wherever the cursor
         -- stands: the direct steward lane can move the cursor past an
         -- ingest item before its row ran (#427), and an open row is by
         -- definition unexecuted (nothing reopens a closed ingest row).
         OR (a.kind = 'ingest' AND EXISTS (
              SELECT 1
                FROM jsonb_array_elements(COALESCE(g.plan->'items', '[]'::jsonb)) item
               WHERE item->>'action' = 'ingest'
                 AND item->>'url' = a.target_ref))
       JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE a.status = 'open'
        AND a.kind IN ('grant_planning', 'mandate_review', 'lookout_run', 'correspondent_run', 'ingest', 'consistency_sweep')
        AND g.status IN ('planning', 'active')
        AND j.status = 'running'
        -- Review passes and lookout runs have no count of their own: each
        -- is funded out of the mandate's day like any of its work, so a
        -- mandate that chains passes or keeps a busy watch spends its own
        -- day's room doing so, and its Grantmaker sees that room in the
        -- review briefing. A burst of queued lookout events is still read
        -- by one run, since a run reads everything waiting. The two
        -- switches are deployment off-switches only.
        AND (a.kind <> 'mandate_review' OR $2::boolean)
        AND (a.kind <> 'lookout_run' OR $3::boolean)
        AND (a.kind <> 'correspondent_run' OR $5::boolean)
        -- Consistency sweeps have no count either (#749): the General
        -- mandate funds them from its day like any of its work, the
        -- re-sweep interval keeps a partition to one a day on its lane, a
        -- mandate's sweep items are its own day's, and the switch is a
        -- deployment off-switch. Which variant each funder buys is in the
        -- join above.
        AND (a.kind <> 'consistency_sweep' OR $1::boolean)
        -- Only rows that still need money. A covered row waits for the
        -- executor, and without this it took one of the 100 places below
        -- on every pass, so enough covered rows starved a new one (#838).
        AND a.cost_est_micro_usd >
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND (al.action_id IS NULL OR al.action_id = a.id)), 0)
      ORDER BY a.created_at ASC
      LIMIT 100`,
    [
      loadConfig().consistencySweepsEnabled === true,
      loadConfig().mandateReviewEnabled !== false,
      loadConfig().lookoutRunsEnabled !== false,
      loadConfig().consistencySweepsEnabled === true
        ? (await consistencyStrongExpectedGain()).gain
        : 0,
      loadConfig().correspondentRunsEnabled !== false,
    ]
  );
  let placed = 0;
  // Both rooms are a snapshot from one query, so a call that funds several
  // self-actions on the same grant has to draw them down itself — otherwise
  // each row sees the full room and together they overcommit.
  const spentThisPass = new Map<string, number>();
  // So does a group two funders reach in one pass: a partition the General
  // mandate's lane and a mandate's sweep item both name (#831). Each row's
  // need is a snapshot too, so without this both would cover it in full.
  const coveredThisPass = new Set<string>();
  for (const row of rows) {
    const needed = Number(row.needed);
    if (needed <= 0) continue;
    if (coveredThisPass.has(row.exclusion_group)) continue;
    const drawn = spentThisPass.get(row.grant_id) ?? 0;
    if (needed > Number(row.headroom) - drawn) continue;
    const dayRoom =
      row.day_room === null
        ? Number.POSITIVE_INFINITY
        : Number(row.day_room) - drawn;
    if (needed > dayRoom) continue;
    const inserted = await rawQuery<{ id: string }>(
      `INSERT INTO action_allocations
         (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [row.exclusion_group, row.action_id, row.claim_id, row.grant_id, needed]
    );
    if (inserted.length === 0) continue;
    placed++;
    spentThisPass.set(row.grant_id, drawn + needed);
    coveredThisPass.add(row.exclusion_group);
  }
  return placed;
}
