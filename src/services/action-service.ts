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
import { rawQuery } from "../db/client.js";
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
    // mandate with discretion. The General mandate is exempt (its
    // valuations are its published formula, refreshed mechanically).
    if (g.status === "active" && g.policy !== "general") {
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
      const [done] = await rawQuery<{ id: string }>(
        `SELECT id FROM actions
          WHERE exclusion_group = $1 AND status = 'done' LIMIT 1`,
        [INGEST_GROUP(item.url)]
      );
      if (!done) break;
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
  // real runs (a deep steward pass, a slow extraction) can be long.
  await rawQuery(
    `UPDATE actions SET status = 'open', updated_at = now()
      WHERE status = 'running'
        AND updated_at < now() - interval '60 minutes'`
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
            a.target_ref, a.cost_est_micro_usd,
            ${COVERAGE_SQL} AS coverage_micro_usd
       FROM actions a
      WHERE a.status = 'open' AND a.kind = ANY($1)
        AND ${COVERAGE_SQL} >= a.cost_est_micro_usd
      ORDER BY coverage_micro_usd DESC, a.created_at ASC
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
  winners.sort(
    (x, y) => Number(y.coverage_micro_usd) - Number(x.coverage_micro_usd)
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
 * drops), and the metered cost is consumed pro rata from the winner's
 * covering allocations. Returns the consumed total.
 */
export async function completeAction(
  actionId: string,
  meteredMicroUsd: number
): Promise<number> {
  const [action] = await rawQuery<{
    id: string;
    exclusion_group: string;
  }>(
    `UPDATE actions SET status = 'done', metered_cost_micro_usd = $2,
            updated_at = now()
      WHERE id = $1
      RETURNING id, exclusion_group`,
    [actionId, Math.round(meteredMicroUsd)]
  );
  if (!action) return 0;

  await rawQuery(
    `UPDATE actions SET status = 'superseded', updated_at = now()
      WHERE exclusion_group = $1 AND id <> $2 AND status IN ('open', 'running')`,
    [action.exclusion_group, actionId]
  );

  // Release losing pinned allocations: returned, not spent. User-funded
  // ones get their unspent remainder back on the owl ledger.
  const released = await rawQuery<{
    id: string;
    user_id: string | null;
    claim_id: string | null;
    remainder: number;
  }>(
    `UPDATE action_allocations al
        SET released_at = now()
      WHERE al.exclusion_group = $1 AND al.released_at IS NULL
        AND al.action_id IS NOT NULL AND al.action_id <> $2
        AND al.spent_micro_usd < al.amount_micro_usd
      RETURNING al.id, al.user_id, al.claim_id,
                (al.amount_micro_usd - al.spent_micro_usd)::bigint AS remainder`,
    [action.exclusion_group, actionId]
  );
  for (const r of released) {
    if (r.user_id && Number(r.remainder) > 0) {
      await rawQuery(
        `INSERT INTO owl_ledger
           (user_id, amount_micro_usd, reason, claim_id, idempotency_key)
         VALUES ($1, $2, 'refund', $3, $4)
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [r.user_id, Number(r.remainder), r.claim_id, `release:${r.id}`]
      );
    }
  }

  // Consume the metered cost pro rata from the winner's covering
  // allocations (pinned to it, or unpinned on the group).
  if (meteredMicroUsd <= 0) return 0;
  const covering = await rawQuery<{ id: string; unspent: number }>(
    `SELECT id, (amount_micro_usd - spent_micro_usd)::bigint AS unspent
       FROM action_allocations
      WHERE exclusion_group = $1 AND released_at IS NULL
        AND (action_id IS NULL OR action_id = $2)
        AND spent_micro_usd < amount_micro_usd
      ORDER BY created_at ASC
      FOR UPDATE SKIP LOCKED`,
    [action.exclusion_group, actionId]
  );
  const totalUnspent = covering.reduce((s, r) => s + Number(r.unspent), 0);
  if (totalUnspent <= 0) return 0;
  const toConsume = Math.min(Math.round(meteredMicroUsd), totalUnspent);
  let consumed = 0;
  for (const [i, row] of covering.entries()) {
    const share =
      i === covering.length - 1
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
