/**
 * The action ledger — the mechanical layer of the allocation engine.
 *
 * One row per potential action (src/db/schema.ts `actions`). Alternative
 * ways of doing the same thing share an exclusion_group; at most one
 * sibling runs. Everything here is MECHANISM — pure functions of the
 * ledger and the allocations on it. Judgment (what is valuable, which
 * variant to back, how much) lives upstream in mandate_valuations and in
 * each mandate's allocator.
 *
 * The rules, in full:
 *  - coverage(action) = SUM(unspent, unreleased allocations on its group
 *    that are unpinned or pinned to it) ≥ cost_est → the action is
 *    RUNNABLE.
 *  - Among runnable siblings, the most-backed wins (tie → cheapest).
 *  - When a winner finishes: it is `done`; its siblings are `superseded`;
 *    pinned allocations on losers are RELEASED back to their funders (a
 *    vote for a losing way of doing it is returned, not spent); the
 *    metered cost is consumed pro rata from the winner's covering
 *    allocations.
 */
import { rawQuery, withTransaction } from "../db/client.js";
import { loadConfig } from "../config.js";
import { stewardTierCostEstimates } from "./cost-estimate-service.js";
import { capMicroUsd } from "./owl.js";

export type ActionKind =
  | "assess"
  | "reassess"
  | "ingest"
  | "grant_planning"
  // A mandate's periodic review pass: its Grantmaker acting with the
  // discretion of anyone entrusted with a mandate — surveying its
  // territory (the graph and the open web), valuing the open ledger,
  // growing its own plan, and moving money (regrants). Bounded by its
  // metered cap and the mandate's escrow, never by narrowed affordances.
  | "mandate_review";

export const ASSESS_GROUP = (claimId: string) => `assess:${claimId}`;
export const PLANNING_GROUP = (grantId: string) => `plan:${grantId}`;
export const INGEST_GROUP = (url: string) => `ingest:${url}`;
export const REVIEW_GROUP = (grantId: string) => `review:${grantId}`;

/** How often a mandate's Grantmaker takes a review pass. */
const REVIEW_CADENCE_HOURS = 24;

/** Coverage subquery for one actions row `a` (SQL fragment). */
export const COVERAGE_SQL = `
  COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
              FROM action_allocations al
             WHERE al.exclusion_group = a.exclusion_group
               AND al.released_at IS NULL
               AND (al.action_id IS NULL OR al.action_id = a.id)), 0)`;

// ---------------------------------------------------------------------------
// Producers: keep the ledger's open rows in sync with the graph's state.
// Idempotent upserts, called from enqueue paths and the scheduler sweep.
// ---------------------------------------------------------------------------

/**
 * Ensure the assess/reassess exclusion group for one claim exists with a
 * row per variant (standard always; strong when a strong model is
 * configured). Kind is 'assess' for a first pass, 'reassess' when a
 * current assessment exists. Refreshes cost estimates on existing rows.
 */
export async function ensureAssessActions(claimId: string): Promise<void> {
  const config = loadConfig();
  const tiers = await stewardTierCostEstimates();
  const [claim] = await rawQuery<{ text: string; assessed: boolean }>(
    `SELECT c.text,
            EXISTS (SELECT 1 FROM assessments x
                     WHERE x.claim_id = c.id AND x.is_current = true)
              AS assessed
       FROM claims c
      WHERE c.id = $1 AND c.state = 'active'`,
    [claimId]
  );
  if (!claim) return;
  const kind = claim.assessed ? "reassess" : "assess";
  const group = ASSESS_GROUP(claimId);
  const label = claim.text.slice(0, 300);
  const variants: Array<[string, number]> = [
    ["standard", tiers.standardMicroUsd],
  ];
  if (config.stewardStrongModel) {
    variants.push(["strong", tiers.strongMicroUsd]);
  }
  for (const [variant, cost] of variants) {
    await rawQuery(
      `INSERT INTO actions
         (kind, exclusion_group, variant, claim_id, label, cost_est_micro_usd)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (exclusion_group, variant) DO UPDATE
         SET cost_est_micro_usd = EXCLUDED.cost_est_micro_usd,
             kind = EXCLUDED.kind,
             -- One row per (group, variant), holding the claim's CURRENT
             -- potential action: a done/superseded/cancelled row reopens
             -- when fresh work is wanted (the next pass), a running row is
             -- left alone. History lives in assessments and llm_usage.
             status = CASE WHEN actions.status = 'running'
                           THEN actions.status ELSE 'open' END,
             updated_at = now()`,
      [kind, group, variant, claimId, label, Math.round(cost)]
    );
  }
}

/**
 * Sweep the whole ledger into sync:
 *  - open assess/reassess groups for every pending claim;
 *  - open ingest actions for unexecuted grant-plan ingest items, and
 *    advance plan cursors past ingest items whose action is done;
 *  - open grant_planning actions for grants awaiting their planning run;
 *  - open valuation actions for mandates whose Grantmaker is due to
 *    re-judge the open ledger (VALUATION_CADENCE_HOURS);
 *  - cancel assess groups whose claim is no longer pending/active;
 *  - release actions stuck 'running' by a crashed worker.
 * Bounded work per sweep; returns counts for the scheduler's log line.
 */
export async function reconcileActions(): Promise<{
  assessEnsured: number;
  cancelled: number;
}> {
  const pending = await rawQuery<{ id: string }>(
    `SELECT c.id FROM claims c
      WHERE c.state = 'active' AND c.steward_state = 'pending'
        AND NOT EXISTS (SELECT 1 FROM actions a
                         WHERE a.exclusion_group = 'assess:' || c.id::text
                           AND a.status IN ('open', 'running'))
      LIMIT 500`
  );
  for (const row of pending) {
    await ensureAssessActions(row.id);
  }

  // Ingest + planning + valuation actions from live grants.
  const grants = await rawQuery<{
    id: string;
    name: string;
    status: string;
    policy: string;
    plan: { items?: Array<{ action: string; url?: string }> } | null;
    plan_cursor: number;
  }>(
    `SELECT id, name, status, policy, plan, plan_cursor FROM grants
      WHERE status IN ('active', 'planning')`
  );
  const ingestCost = capMicroUsd("source_ingest");
  for (const g of grants) {
    if (g.status === "planning") {
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
         VALUES ('grant_planning', $1, 'standard', $2, $3, $4)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = 'open', updated_at = now()
           -- A grant still in 'planning' with a closed planning action
           -- wants a fresh run (a failed write, a pushed-back plan).
           WHERE actions.status NOT IN ('open', 'running')`,
        [
          PLANNING_GROUP(g.id),
          g.id,
          `Planning run for the mandate "${g.name}"`,
          capMicroUsd("assessment"),
        ]
      );
    }

    // The mandate's periodic review pass — its Grantmaker stewarding the
    // mandate with discretion. Every active mandate gets one, the General
    // mandate included: its valuations come from a formula rather than from
    // per-action judgment, but the formula's knobs are exactly the kind of
    // thing a steward should revise as evidence about allocation itself
    // accumulates, and it has the same pacing, regranting and scope
    // decisions to make as any other. Exempting it left the platform's own
    // lane as the one mandate no agent was ever asked to think about.
    if (g.status === "active") {
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
         VALUES ('mandate_review', $1, 'standard', $2, $3, $4)
         ON CONFLICT (exclusion_group, variant) DO UPDATE
           SET status = 'open', updated_at = now()
           WHERE actions.status IN ('done', 'superseded', 'cancelled')
             AND actions.updated_at < now() - make_interval(hours => ${REVIEW_CADENCE_HOURS})`,
        [
          REVIEW_GROUP(g.id),
          g.id,
          `Mandate review for "${g.name}"`,
          capMicroUsd("assessment"),
        ]
      );
    }

    // Plan cursor bookkeeping + ingest rows. An ingest item whose ledger
    // action is DONE is finished work: the cursor moves past it. An
    // unexecuted one gets (or keeps) its open row, funded by the grant's
    // own escrow (fundGrantSelfActions).
    const items = g.plan?.items ?? [];
    let cursor = g.plan_cursor;
    while (cursor < items.length) {
      const item = items[cursor]!;
      if (item.action !== "ingest" || !item.url) break;
      // Done AND cancelled both move the cursor: a cancelled ingest (a
      // poison URL the executor retired) must not wedge the plan forever
      // behind it. A group with only open/running rows still blocks.
      const [closed] = await rawQuery<{ id: string }>(
        `SELECT id FROM actions
          WHERE exclusion_group = $1 AND status IN ('done', 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM actions o
                             WHERE o.exclusion_group = $1
                               AND o.status IN ('open', 'running'))
          LIMIT 1`,
        [INGEST_GROUP(item.url)]
      );
      if (!closed) break;
      cursor++;
    }
    if (cursor !== g.plan_cursor) {
      await rawQuery(
        `UPDATE grants SET plan_cursor = $2, updated_at = now()
          WHERE id = $1 AND plan_cursor = $3`,
        [g.id, cursor, g.plan_cursor]
      );
    }
    for (let i = cursor; i < items.length; i++) {
      const item = items[i]!;
      if (item.action !== "ingest" || !item.url) continue;
      await rawQuery(
        `INSERT INTO actions
           (kind, exclusion_group, variant, target_ref, label, cost_est_micro_usd)
         VALUES ('ingest', $1, 'standard', $2, $3, $4)
         ON CONFLICT (exclusion_group, variant) DO NOTHING`,
        [INGEST_GROUP(item.url), item.url, `Ingest ${item.url}`, ingestCost]
      );
    }
  }

  // Close groups whose claim left the candidate set (assessed elsewhere,
  // archived, or mid-run on the express lane long enough to have finished).
  const cancelled = await rawQuery<{ id: string }>(
    `UPDATE actions a SET status = 'cancelled', updated_at = now()
      WHERE a.status = 'open' AND a.kind IN ('assess', 'reassess')
        AND NOT EXISTS (SELECT 1 FROM claims c
                         WHERE c.id = a.claim_id AND c.state = 'active'
                           AND c.steward_state IN ('pending', 'running'))
      RETURNING a.id`
  );

  // A worker that died mid-run leaves its action 'running' forever;
  // return it to open so coverage can send it again. Generous window —
  // real runs (a deep steward pass) can be long. Ingest actions get a much
  // longer window: they legitimately stay 'running' while the async
  // extraction worker holds them (which completes or cancels them itself),
  // and reopening one early re-submits the source — a second metered
  // extraction charged to the same funders.
  await rawQuery(
    `UPDATE actions SET status = 'open', updated_at = now()
      WHERE status = 'running'
        AND ((kind <> 'ingest' AND updated_at < now() - interval '60 minutes')
             OR (kind = 'ingest' AND updated_at < now() - interval '24 hours'))`
  );

  return { assessEnsured: pending.length, cancelled: cancelled.length };
}

// ---------------------------------------------------------------------------
// Resolution and execution bookkeeping.
// ---------------------------------------------------------------------------

export interface RunnableAction {
  id: string;
  kind: ActionKind;
  exclusion_group: string;
  variant: string;
  claim_id: string | null;
  target_ref: string | null;
  cost_est_micro_usd: number;
  coverage_micro_usd: number;
  updated_at: Date;
}

/**
 * The next action the mechanism says to run, for the given kinds: among
 * covered open actions, resolve each exclusion group to its winner (most
 * backing, tie → cheapest), then take the winner with the most backing
 * overall. Pure function of allocations; no valuations involved.
 */
export async function nextRunnableAction(
  kinds: ActionKind[]
): Promise<RunnableAction | null> {
  const rows = await rawQuery<RunnableAction>(
    `SELECT a.id, a.kind, a.exclusion_group, a.variant, a.claim_id,
            a.target_ref, a.cost_est_micro_usd, a.updated_at,
            ${COVERAGE_SQL} AS coverage_micro_usd
       FROM actions a
      WHERE a.status = 'open' AND a.kind = ANY($1)
        AND ${COVERAGE_SQL} >= a.cost_est_micro_usd
      ORDER BY coverage_micro_usd DESC, a.updated_at ASC
      LIMIT 20`,
    [kinds]
  );
  if (rows.length === 0) return null;
  // Resolve groups: one winner per group, most backing then cheapest.
  const byGroup = new Map<string, RunnableAction[]>();
  for (const row of rows) {
    const list = byGroup.get(row.exclusion_group) ?? [];
    list.push(row);
    byGroup.set(row.exclusion_group, list);
  }
  const winners: RunnableAction[] = [];
  for (const siblings of byGroup.values()) {
    siblings.sort(
      (x, y) =>
        Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
        Number(x.cost_est_micro_usd) - Number(y.cost_est_micro_usd)
    );
    winners.push(siblings[0]!);
  }
  // Most backing first; coverage ties go to the STALEST action, so a
  // freshly reopened row (a chaining review pass) queues behind work that
  // hasn't had a turn — no starvation by enthusiasm.
  winners.sort(
    (x, y) =>
      Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd) ||
      new Date(x.updated_at).getTime() - new Date(y.updated_at).getTime()
  );
  return winners[0]!;
}

/** Atomically move an open action to running. False if someone else won. */
export async function claimAction(actionId: string): Promise<boolean> {
  const rows = await rawQuery<{ id: string }>(
    `UPDATE actions SET status = 'running', updated_at = now()
      WHERE id = $1 AND status = 'open'
      RETURNING id`,
    [actionId]
  );
  return rows.length > 0;
}

/** Return a running action to open (transient failure; not its fault). */
export async function releaseAction(actionId: string): Promise<void> {
  await rawQuery(
    `UPDATE actions SET status = 'open', updated_at = now()
      WHERE id = $1 AND status = 'running'`,
    [actionId]
  );
}

/**
 * Complete a run: the winner is done with its metered cost recorded, its
 * siblings are superseded, losing pinned allocations are released back to
 * their funders (users get a ledger credit; mandate exposure simply
 * drops), the metered cost is consumed pro rata from the winner's
 * covering allocations — and the covering allocations then SETTLE: their
 * unspent remainders release too, exactly like a cap-charge settling to
 * the metered actual. Cost estimates deliberately run high, so without
 * settlement every completed action would strand (estimate − actual) as
 * outstanding exposure forever, silently eating its funders' headroom.
 * Returns the consumed total.
 *
 * The whole close runs in ONE transaction: the done-transition is guarded
 * (a second completer for the same action is a no-op, so two settlements
 * can never both consume the same unspent coverage), and the covering
 * allocations are locked with a held `FOR UPDATE` until commit.
 * `meteredJobId` records which budget job the run's llm_usage metering was
 * attributed to, so escrow accounting can de-duplicate the pro-rata shares
 * against that job's metered total (regrant-service.grantEscrowSpend).
 */
export async function completeAction(
  actionId: string,
  meteredMicroUsd: number,
  opts: { meteredJobId?: string | null } = {}
): Promise<number> {
  return withTransaction(async (tx) => {
    // Guarded transition: only a live (running, or reconcile-reopened)
    // action completes; a done/superseded/cancelled row is already closed
    // and its coverage already consumed — return 0 and touch nothing.
    const [action] = await tx.query<{
      id: string;
      exclusion_group: string;
    }>(
      `UPDATE actions SET status = 'done', metered_cost_micro_usd = $2,
              metered_job_id = $3, updated_at = now()
        WHERE id = $1 AND status IN ('running', 'open')
        RETURNING id, exclusion_group`,
      [actionId, Math.round(meteredMicroUsd), opts.meteredJobId ?? null]
    );
    if (!action) return 0;

    await tx.query(
      `UPDATE actions SET status = 'superseded', updated_at = now()
        WHERE exclusion_group = $1 AND id <> $2 AND status IN ('open', 'running')`,
      [action.exclusion_group, actionId]
    );

    // Lock every live allocation on the group for the duration of the
    // close (plain FOR UPDATE: wait, don't skip — a skipped row would be
    // silently exempted from consumption).
    const allocations = await tx.query<{
      id: string;
      grant_id: string | null;
      user_id: string | null;
      claim_id: string | null;
      action_id: string | null;
      amount: number;
      unspent: number;
    }>(
      `SELECT id, grant_id, user_id, claim_id, action_id,
              amount_micro_usd::bigint AS amount,
              (amount_micro_usd - spent_micro_usd)::bigint AS unspent
         FROM action_allocations
        WHERE exclusion_group = $1 AND released_at IS NULL
          AND spent_micro_usd < amount_micro_usd
        ORDER BY created_at ASC
        FOR UPDATE`,
      [action.exclusion_group]
    );

    const refundUser = async (r: {
      id: string;
      user_id: string | null;
      claim_id: string | null;
      unspent: number;
      key: string;
    }) => {
      if (r.user_id && Number(r.unspent) > 0) {
        await tx.query(
          `INSERT INTO owl_ledger
             (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
           VALUES ($1, $2, 'refund', $3, $4)
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [r.user_id, Number(r.unspent), r.claim_id, r.key]
        );
      }
    };

    // Release losing pinned allocations: returned, not spent. User-funded
    // ones get their unspent remainder back on the owl ledger.
    const losers = allocations.filter(
      (a) => a.action_id !== null && a.action_id !== actionId
    );
    for (const r of losers) {
      await tx.query(
        `UPDATE action_allocations SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `release:${r.id}` });
    }

    // Consume the metered cost pro rata from the winner's covering
    // allocations (pinned to it, or unpinned on the group).
    const covering = allocations.filter(
      (a) => a.action_id === null || a.action_id === actionId
    );
    let consumed = 0;
    if (meteredMicroUsd > 0) {
      const totalUnspent = covering.reduce((s, r) => s + Number(r.unspent), 0);
      const toConsume = Math.min(Math.round(meteredMicroUsd), totalUnspent);
      for (const [i, row] of covering.entries()) {
        const share =
          i === covering.length - 1
            ? toConsume - consumed
            : Math.floor((toConsume * Number(row.unspent)) / totalUnspent);
        const take = Math.min(Number(row.unspent), Math.max(0, share));
        if (take <= 0) continue;
        await tx.query(
          `UPDATE action_allocations
              SET spent_micro_usd = spent_micro_usd + $2
            WHERE id = $1`,
          [row.id, take]
        );
        consumed += take;
        row.unspent = Number(row.unspent) - take;
      }
    }

    // OVERAGE: the run cost more than its funders had promised. The money is
    // already gone — the LLM calls happened and are metered against the
    // funder's job — so the only question is whether the ledger admits it.
    //
    // It used to not. Consumption is clamped at `totalUnspent` above, so a run
    // metering 5.76 owls against a 1.93 allocation recorded 1.93 and the rest
    // vanished: absent from allocation shares, and cancelled out of the
    // non-ledger term (which subtracts actions.metered_cost, so the very row
    // recording the overspend erased it). Measured on the General mandate's
    // first epoch: 23.57 owls of real spend counted in NO term of
    // grantCommittedMicroUsd, which is why the escrow read 112 owls left when
    // 79 was the truth. An escrow that cannot see a third of its own spend is
    // not the hard ceiling the design leans on.
    //
    // So a MANDATE's overage is recorded as what it actually is: an
    // allocation, already spent. A settled row (spent = amount) sits outside
    // the live-placement unique index, so this never collides with a future
    // placement on the same group. Two things follow for free — the escrow's
    // committed total includes it, and because day room sums the amounts
    // placed today, an expensive run draws down TODAY's room by its own
    // overspend rather than leaving the pace target to describe fiction.
    //
    // A USER's overage stays absorbed by the platform: their cap is a promise
    // ("the ceiling was theirs to rely on"), and a buyer must never be billed
    // past the number on the button. Only grant-funded allocations are
    // extended, and when a group has none, the shortfall stays off-ledger —
    // where the corrected non-ledger term now counts it instead of hiding it.
    const shortfall = Math.round(meteredMicroUsd) - consumed;
    if (shortfall > 0) {
      const byGrant = new Map<string, number>();
      for (const r of covering) {
        if (!r.grant_id) continue;
        byGrant.set(r.grant_id, (byGrant.get(r.grant_id) ?? 0) + Number(r.amount));
      }
      const totalWeight = [...byGrant.values()].reduce((s, n) => s + n, 0);
      if (totalWeight > 0) {
        // Pro rata by what each mandate had promised: the funder that backed
        // most of the work carries most of the overspend.
        const entries = [...byGrant.entries()];
        let assigned = 0;
        for (const [i, [grantId, weight]] of entries.entries()) {
          const share =
            i === entries.length - 1
              ? shortfall - assigned
              : Math.floor((shortfall * weight) / totalWeight);
          if (share <= 0) continue;
          const claimId =
            covering.find((r) => r.grant_id === grantId)?.claim_id ?? null;
          await tx.query(
            `INSERT INTO action_allocations
               (exclusion_group, action_id, claim_id, grant_id,
                amount_micro_usd, spent_micro_usd, released_at)
             VALUES ($1, $2, $3, $4, $5, $5, now())`,
            [action.exclusion_group, actionId, claimId, grantId, share]
          );
          assigned += share;
          consumed += share;
        }
      }
    }

    // SETTLEMENT: whatever the covering allocations still hold beyond the
    // metered cost releases back to its funders — a mandate's headroom
    // returns, a person's owls return to their balance. The ceiling was
    // theirs to rely on; the meter is what they pay.
    for (const r of covering) {
      if (Number(r.unspent) <= 0) continue;
      await tx.query(
        `UPDATE action_allocations SET released_at = now() WHERE id = $1`,
        [r.id]
      );
      await refundUser({ ...r, key: `settle:${r.id}` });
    }
    return consumed;
  });
}

/**
 * Metering attribution for a covered run: the largest covering allocator.
 * A mandate yields its budget-job id (which also stamps the funding
 * disclosure); a person yields their user id.
 */
export async function largestActionFunder(
  actionId: string
): Promise<{ jobId?: string; userId?: string; grantId?: string }> {
  const [row] = await rawQuery<{
    grant_id: string | null;
    user_id: string | null;
    budget_job_id: string | null;
  }>(
    `SELECT al.grant_id, al.user_id, g.budget_job_id
       FROM action_allocations al
       JOIN actions a ON a.id = $1
       LEFT JOIN grants g ON g.id = al.grant_id
      WHERE al.exclusion_group = a.exclusion_group
        AND al.released_at IS NULL
        AND (al.action_id IS NULL OR al.action_id = a.id)
      GROUP BY al.grant_id, al.user_id, g.budget_job_id
      ORDER BY SUM(al.amount_micro_usd - al.spent_micro_usd) DESC
      LIMIT 1`,
    [actionId]
  );
  if (!row) return {};
  if (row.budget_job_id) {
    return { jobId: row.budget_job_id, grantId: row.grant_id ?? undefined };
  }
  if (row.user_id) return { userId: row.user_id };
  return {};
}
