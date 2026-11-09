/**
 * Commissions: paying for a run whole, at a budget the payer chooses.
 *
 * Every piece of graph work is an agent run, and a run happens when someone
 * commissions it: decides it is worth doing, sets the budget it should have
 * to be done properly (at the high end of what the costing skill says such
 * work costs), and pays that budget in full. The row runs as soon as it has
 * the commission, its agent is told the budget, and whatever the run does not
 * spend goes back to whoever paid when it settles (action-service.ts,
 * completeAction).
 *
 * A commission is an allocation (action_allocations) with commissioned_by
 * set, pinned to the tier its payer chose. So the money paths the ledger
 * already enforces (escrow headroom, metered consumption, overage, refunds
 * of unspent budget, a person's balance guard) hold for commissions too.
 *
 * Three kinds of payer:
 *  - a mandate: its money, within its daily rate (counted as what is spent
 *    or still held by running work, allocationDayUseSql) and its escrow;
 *  - a person: their owls, debited behind the balance guard;
 *  - a running agent, paying from its own budget: the amount moves from the
 *    allocations paying for that run onto the new one, so the money keeps its
 *    payer (a mandate's stays the mandate's, a person's the person's) and
 *    parent_action_id records the chain a petition is later routed along.
 */
import { rawQuery, withTransaction, type TxQuery } from "../db/client.js";
import { ASSESS_GROUP, ensureAssessActions } from "./action-service.js";
import { allocationDayUseSql } from "./day-use.js";
import { grantCommittedMicroUsd } from "./regrant-service.js";
import { enqueueSteward, type StewardMessage } from "./queue-service.js";
import type { MessageSender } from "./inbox-service.js";
import { microUsdToOwls } from "./owl.js";

export type CommissionPayer =
  | { kind: "grant"; grantId: string }
  | { kind: "user"; userId: string }
  /** A running agent paying from its own budget: the action it is running. */
  | { kind: "run"; actionId: string };

export type CommissionTier = "standard" | "strong";

export interface CommissionInput {
  payer: CommissionPayer;
  /** The node whose Steward pass to pay for. */
  claimId: string;
  budgetMicroUsd: number;
  tier?: CommissionTier;
  /** What the run's agent reads: the question to look at, not the answer wanted. */
  brief: string;
  /** Why it is worth the money, for the public record. */
  reason?: string;
  /** Who commissioned it: an agent role, or 'person'. */
  commissionedBy: string;
  /** How the brief reaches the node's inbox. */
  message?: { trigger: StewardMessage["trigger"]; sender?: MessageSender };
}

export type CommissionResult =
  | {
      ok: true;
      status: "commissioned";
      allocationId: string;
      actionId: string;
      budgetMicroUsd: number;
      tier: CommissionTier;
    }
  | {
      ok: true;
      /** The node already has a pass commissioned or running: the brief went to its inbox, at no cost. */
      status: "already_commissioned";
      actionId: string;
      ageMinutes: number;
    }
  | {
      ok: false;
      code:
        | "BAD_AMOUNT"
        | "NOT_FOUND"
        | "OVER_DAILY_RATE"
        | "OVER_ESCROW"
        | "INSUFFICIENT_OWLS"
        | "OVER_RUN_BUDGET"
        | "PAYER_INACTIVE";
      message: string;
    };

/** A mandate's day so far: what is spent or held by running work today. */
export async function grantDayUseMicroUsd(grantId: string, tx?: TxQuery): Promise<number> {
  const q = <T,>(text: string, params: unknown[]) => (tx ? tx.query<T>(text, params) : rawQuery<T>(text, params));
  const [row] = await q<{ used: number }>(
    `SELECT COALESCE(SUM(${allocationDayUseSql()}), 0)::bigint AS used
       FROM action_allocations
      WHERE grant_id = $1
        AND created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [grantId]
  );
  return Number(row?.used ?? 0);
}

interface LiveRow {
  action_id: string;
  status: string;
  commissioned_at: string | null;
}

/** An open or running pass on the node that already has money behind it. */
async function liveCommission(claimId: string): Promise<LiveRow | null> {
  const [row] = await rawQuery<LiveRow>(
    `SELECT a.id AS action_id, a.status,
            (SELECT MAX(al.created_at) FROM action_allocations al
              WHERE al.exclusion_group = a.exclusion_group
                AND al.released_at IS NULL
                AND al.spent_micro_usd < al.amount_micro_usd
                AND (al.action_id IS NULL OR al.action_id = a.id)) AS commissioned_at
       FROM actions a
      WHERE a.exclusion_group = $1 AND a.status IN ('open', 'running')
        AND (a.status = 'running'
             OR EXISTS (SELECT 1 FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL
                           AND al.commissioned_by IS NOT NULL
                           AND al.spent_micro_usd < al.amount_micro_usd
                           AND (al.action_id IS NULL OR al.action_id = a.id)))
      ORDER BY (a.status = 'running') DESC
      LIMIT 1`,
    [ASSESS_GROUP(claimId)]
  );
  return row ?? null;
}

/** The variant row a commission pins to. */
async function variantRow(claimId: string, tier: CommissionTier): Promise<{ id: string; variant: CommissionTier } | null> {
  const rows = await rawQuery<{ id: string; variant: string }>(
    `SELECT id, variant FROM actions
      WHERE exclusion_group = $1 AND status = 'open' AND variant IN ('standard', 'strong')`,
    [ASSESS_GROUP(claimId)]
  );
  const want = rows.find((r) => r.variant === tier) ?? rows.find((r) => r.variant === "standard");
  return want ? { id: want.id, variant: want.variant as CommissionTier } : null;
}

/**
 * Pay for one node's Steward pass whole. When the node already has a pass
 * commissioned or running, nothing is charged: the brief joins its inbox and
 * the result says so.
 */
export async function commissionNodePass(input: CommissionInput): Promise<CommissionResult> {
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) {
    return { ok: false, code: "BAD_AMOUNT", message: "A commission needs a budget above zero." };
  }
  const [claim] = await rawQuery<{ id: string }>(
    `SELECT id FROM claims WHERE id = $1 AND state = 'active'`,
    [input.claimId]
  );
  if (!claim) return { ok: false, code: "NOT_FOUND", message: "No active node has that id." };

  const message = input.message ?? { trigger: "mandate_plan" as const };

  const live = await liveCommission(input.claimId);
  if (live) {
    await enqueueSteward({
      claimId: input.claimId,
      trigger: message.trigger,
      context: input.brief,
      sender: message.sender,
    });
    const age = live.commissioned_at
      ? Math.max(0, Math.round((Date.now() - new Date(live.commissioned_at).getTime()) / 60_000))
      : 0;
    return { ok: true, status: "already_commissioned", actionId: live.action_id, ageMinutes: age };
  }

  await ensureAssessActions(input.claimId);
  const row = await variantRow(input.claimId, input.tier ?? "standard");
  if (!row) return { ok: false, code: "NOT_FOUND", message: "The node has no open pass to commission." };

  const placed = await placeCommission({
    group: ASSESS_GROUP(input.claimId),
    actionId: row.id,
    claimId: input.claimId,
    payer: input.payer,
    budget,
    commissionedBy: input.commissionedBy,
    brief: input.brief,
    reason: input.reason ?? null,
  });
  if (!placed.ok) return placed;

  // The brief is the pass's message, marked paid, and the node becomes a
  // candidate the executor will run now that it is commissioned.
  await enqueueSteward({
    claimId: input.claimId,
    trigger: message.trigger,
    context: input.brief,
    sender: message.sender,
    paid: true,
  });
  return {
    ok: true,
    status: "commissioned",
    allocationId: placed.allocationId,
    actionId: row.id,
    budgetMicroUsd: budget,
    tier: row.variant,
  };
}

/**
 * Pay for any open row on the ledger whole: an ingest, a curation, an audit,
 * work on a request, a formalization. A row already paid for or running is
 * left as it is.
 */
export async function commissionAction(input: {
  payer: CommissionPayer;
  actionId: string;
  budgetMicroUsd: number;
  brief?: string | null;
  reason?: string | null;
  commissionedBy: string;
}): Promise<
  | { ok: true; status: "commissioned"; allocationId: string; kind: string }
  | { ok: true; status: "already_commissioned"; kind: string }
  | Extract<CommissionResult, { ok: false }>
> {
  const budget = Math.round(input.budgetMicroUsd);
  if (!(budget > 0)) return { ok: false, code: "BAD_AMOUNT", message: "A commission needs a budget above zero." };
  const [row] = await rawQuery<{ id: string; kind: string; exclusion_group: string; claim_id: string | null; status: string; commissioned: boolean }>(
    `SELECT a.id, a.kind, a.exclusion_group, a.claim_id, a.status,
            EXISTS (SELECT 1 FROM action_allocations al
                     WHERE al.exclusion_group = a.exclusion_group AND al.released_at IS NULL
                       AND al.commissioned_by IS NOT NULL AND al.spent_micro_usd < al.amount_micro_usd
                       AND (al.action_id IS NULL OR al.action_id = a.id)) AS commissioned
       FROM actions a WHERE a.id = $1`,
    [input.actionId]
  );
  if (!row) return { ok: false, code: "NOT_FOUND", message: "No ledger row has that id." };
  if (row.status === "running" || row.commissioned) return { ok: true, status: "already_commissioned", kind: row.kind };
  if (row.status !== "open") {
    return { ok: false, code: "NOT_FOUND", message: `That row is ${row.status}; only open work can be commissioned.` };
  }
  const placed = await placeCommission({
    group: row.exclusion_group,
    actionId: row.id,
    claimId: row.claim_id,
    payer: input.payer,
    budget,
    commissionedBy: input.commissionedBy,
    brief: input.brief ?? null,
    reason: input.reason ?? null,
  });
  if (!placed.ok) return placed;
  return { ok: true, status: "commissioned", allocationId: placed.allocationId, kind: row.kind };
}

type Placed = { ok: true; allocationId: string } | Extract<CommissionResult, { ok: false }>;

/**
 * Place one commission on a ledger row, behind the payer's own guard: a
 * mandate's per-mandate lock (the allocator's), a person's balance lock, or
 * the paying run's allocations held FOR UPDATE.
 */
export async function placeCommission(input: {
  group: string;
  actionId: string;
  claimId: string | null;
  payer: CommissionPayer;
  budget: number;
  commissionedBy: string;
  brief: string | null;
  reason: string | null;
}): Promise<Placed> {
  const { payer, budget } = input;
  const owls = (micro: number) => microUsdToOwls(micro);

  if (payer.kind === "grant") {
    return withTransaction(async (tx) => {
      await tx.query(
        `SELECT pg_advisory_xact_lock(hashtextextended('mandate-allocator:' || $1, 0))`,
        [payer.grantId]
      );
      const [g] = await tx.query<{ budget_job_id: string; daily: number; escrow: number; status: string; job_status: string }>(
        `SELECT g.budget_job_id, g.daily_budget_micro_usd AS daily, j.budget_micro_usd AS escrow,
                g.status, j.status AS job_status
           FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
          WHERE g.id = $1`,
        [payer.grantId]
      );
      if (!g || g.status !== "active" || g.job_status !== "running") {
        return { ok: false, code: "PAYER_INACTIVE", message: "The paying mandate is not active." } as const;
      }
      const daily = Number(g.daily);
      if (daily > 0) {
        const used = await grantDayUseMicroUsd(payer.grantId, tx);
        if (used + budget > daily) {
          return {
            ok: false,
            code: "OVER_DAILY_RATE",
            message:
              `A budget of ${owls(budget)} owls is more than today's rate has left ` +
              `(${owls(Math.max(0, daily - used))} of ${owls(daily)} owls). Running work frees ` +
              `its unspent budget as it finishes.`,
          } as const;
        }
      }
      const committed = await grantCommittedMicroUsd({ id: payer.grantId, budgetJobId: g.budget_job_id }, tx);
      if (committed + budget > Number(g.escrow)) {
        return {
          ok: false,
          code: "OVER_ESCROW",
          message: `A budget of ${owls(budget)} owls is more than the escrow holds uncommitted (${owls(Math.max(0, Number(g.escrow) - committed))} owls).`,
        } as const;
      }
      const [row] = await tx.query<{ id: string }>(
        // A mandate holds one live placement per row (uq_action_allocations_
        // live_placement): more money from it on the same row, a granted
        // petition's top-up, adds to that placement.
        `INSERT INTO action_allocations
           (exclusion_group, action_id, claim_id, grant_id, amount_micro_usd,
            commissioned_by, brief, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (grant_id, exclusion_group, (COALESCE(action_id::text, '')))
           WHERE released_at IS NULL AND grant_id IS NOT NULL AND spent_micro_usd < amount_micro_usd
         DO UPDATE SET amount_micro_usd = action_allocations.amount_micro_usd + EXCLUDED.amount_micro_usd
         RETURNING id`,
        [input.group, input.actionId, input.claimId, payer.grantId, budget, input.commissionedBy, input.brief, input.reason]
      );
      return { ok: true, allocationId: row!.id } as const;
    });
  }

  if (payer.kind === "user") {
    const { withOwlBalanceLock } = await import("./owl-ledger-service.js");
    const id = await withOwlBalanceLock(payer.userId, async (tx) => {
      const debit = await tx.query<{ id: string }>(
        `INSERT INTO owl_ledger (user_id, amount_micro_usd, reason, claim_id)
         SELECT $1, $2, 'claim_contribution', $3
          WHERE (SELECT COALESCE(SUM(amount_micro_usd), 0) FROM owl_ledger WHERE user_id = $1) >= $4
         RETURNING id`,
        [payer.userId, -budget, input.claimId, budget]
      );
      if (debit.length === 0) return null;
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO action_allocations
           (exclusion_group, action_id, claim_id, user_id, amount_micro_usd,
            commissioned_by, brief, reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
        [input.group, input.actionId, input.claimId, payer.userId, budget, input.commissionedBy, input.brief, input.reason]
      );
      return row!.id;
    });
    if (!id) {
      return { ok: false, code: "INSUFFICIENT_OWLS", message: `A budget of ${owls(budget)} owls is more than your balance.` };
    }
    return { ok: true, allocationId: id };
  }

  // A running agent paying from its own budget: move the amount from the
  // allocations paying for that run onto the new one, payer by payer.
  return withTransaction(async (tx) => {
    const sources = await tx.query<{ id: string; grant_id: string | null; user_id: string | null; unspent: number }>(
      `SELECT al.id, al.grant_id, al.user_id,
              (al.amount_micro_usd - al.spent_micro_usd)::bigint AS unspent
         FROM action_allocations al
         JOIN actions a ON a.id = $1
        WHERE al.exclusion_group = a.exclusion_group
          AND al.released_at IS NULL
          AND (al.action_id IS NULL OR al.action_id = a.id)
          AND al.spent_micro_usd < al.amount_micro_usd
        ORDER BY al.created_at
        FOR UPDATE OF al`,
      [payer.actionId]
    );
    const available = sources.reduce((s, r) => s + Number(r.unspent), 0);
    if (available < budget) {
      return {
        ok: false,
        code: "OVER_RUN_BUDGET",
        message: `A budget of ${owls(budget)} owls is more than the paying run holds (${owls(available)} owls).`,
      } as const;
    }
    let left = budget;
    let first: string | null = null;
    for (const src of sources) {
      if (left <= 0) break;
      const take = Math.min(left, Number(src.unspent));
      if (take <= 0) continue;
      // A source moved whole is released (nothing of it is left to cover the
      // paying run, and its money now sits on the new row); a partial move
      // lowers its amount. Either way the payer's committed total is unchanged.
      if (take === Number(src.unspent)) {
        await tx.query(
          `UPDATE action_allocations
              SET amount_micro_usd = CASE WHEN spent_micro_usd > 0 THEN spent_micro_usd ELSE amount_micro_usd END,
                  released_at = now()
            WHERE id = $1`,
          [src.id]
        );
      } else {
        await tx.query(
          `UPDATE action_allocations SET amount_micro_usd = amount_micro_usd - $2 WHERE id = $1`,
          [src.id, take]
        );
      }
      const [row] = await tx.query<{ id: string }>(
        `INSERT INTO action_allocations
           (exclusion_group, action_id, claim_id, grant_id, user_id, amount_micro_usd,
            commissioned_by, brief, reason, parent_action_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (grant_id, exclusion_group, (COALESCE(action_id::text, '')))
           WHERE released_at IS NULL AND grant_id IS NOT NULL AND spent_micro_usd < amount_micro_usd
         DO UPDATE SET amount_micro_usd = action_allocations.amount_micro_usd + EXCLUDED.amount_micro_usd
         RETURNING id`,
        [input.group, input.actionId, input.claimId, src.grant_id, src.user_id, take,
         input.commissionedBy, input.brief, input.reason, payer.actionId]
      );
      first ??= row!.id;
      left -= take;
    }
    return { ok: true, allocationId: first! } as const;
  });
}
