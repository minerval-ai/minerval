/**
 * Grant worker — executes grantmaker mandates one unit per tick.
 *
 * Two phases:
 *
 *  PLANNING (policy 'agent'): run the Grantor agent over the scope, store
 *  its proposed allocation plan on the grant, and move to pending_approval.
 *  The planning run itself is metered to the grant's budget; nothing else
 *  is spent until the funder approves.
 *
 *  EXECUTION (status 'active'): pick the next target under the mandate's
 *  policy and steward it, metered to the grant's budget job — so funded
 *  assessments carry the grant's funding disclosure (funded_by_job_id) —
 *  and record a claim_stakes row (source 'grant') for attribution and
 *  background-priority subsidy. Targets per policy:
 *
 *    deepen   — pending/deferred claims in scope, highest priority first
 *               (the funder is buying the depth the brake held out);
 *    cover    — claims in scope with no current assessment, breadth first;
 *    maintain — claims in scope whose assessment is older than the grant
 *               cadence, stalest first;
 *    agent    — the approved plan's items, in order ('deepen' items also
 *               promote the claim's own pending/deferred subclaims while
 *               budget allows, via the deepen selector rooted there).
 *
 *  At the budget floor the underlying job pauses (top-up resumes, same as
 *  any budget job); when no targets remain the grant completes and the
 *  unspent budget refunds.
 */
import { rawQuery } from "../db/client.js";
import { runClaimSteward } from "../llm/agents/claim-steward.js";
import { runGrantor } from "../llm/agents/grantor.js";
import { runWithUsageContext } from "../llm/usage-context.js";
import { loadConfig } from "../config.js";
import { checkBudget } from "../llm/budget-tracker.js";
import { LlmBudgetExceededError, isTransientApiError } from "../llm/errors.js";
import {
  getJobSpentMicroUsd,
  refundUnspentBudget,
} from "../services/budget-job-service.js";
import { submitSource } from "../services/source-service.js";
import { capMicroUsd } from "../services/owl.js";
import { refreshQueuePriority } from "../services/priority-service.js";
import type { PlanItem } from "../services/grant-service.js";

export type GrantDrainStatus =
  | "processed"
  | "planned"
  | "empty"
  | "budget"
  | "transient"
  | "paused"
  | "completed";

export interface GrantProcessResult {
  status: GrantDrainStatus;
  grantId?: string;
  claimId?: string;
  ok?: boolean;
  error?: string;
}

interface GrantRow {
  id: string;
  funder_user_id: string;
  budget_job_id: string;
  name: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  policy: string;
  status: string;
  plan: { strategy?: string; items?: PlanItem[] } | null;
  plan_cursor: number;
  budget_micro_usd: number;
  job_status: string;
}

/** The scope CTE shared by every selector: subtree and/or text match. */
const SCOPE_SQL = `
  WITH RECURSIVE subtree AS (
    SELECT id FROM claims WHERE id = $1
    UNION
    SELECT cr.child_claim_id
      FROM claim_relationships cr JOIN subtree s ON cr.parent_claim_id = s.id
  ),
  scope AS (
    SELECT c.id FROM claims c
     WHERE c.state = 'active'
       AND (($1::uuid IS NOT NULL AND c.id IN (SELECT id FROM subtree))
            OR ($2::text IS NOT NULL
                AND c.text_search @@ websearch_to_tsquery('english', $2)))
  )`;

interface TargetRow {
  id: string;
  prior_state: string;
  decomposition_status: string;
  steward_trigger: string | null;
  steward_context: string | null;
}

/** Atomically claim the next target for a policy, or null when exhausted. */
async function claimNextGrantTarget(
  grant: GrantRow
): Promise<{ target: TargetRow | null; ingestedUrl?: string }> {
  const config = loadConfig();

  if (grant.policy === "agent") {
    const items = grant.plan?.items ?? [];
    // Walk the plan from the cursor; skip items whose claim is gone/busy.
    for (let i = grant.plan_cursor; i < items.length; i++) {
      const item = items[i]!;
      // An 'ingest' item is the ingestion-pipeline primitive: enqueue the
      // source for extraction + matching, metered to the grant's escrow.
      // One enqueue is the item's whole unit of work; the extraction runs
      // asynchronously and any claims it mints join the graph normally.
      if (item.action === "ingest") {
        await setPlanCursor(grant.id, i + 1);
        if (!item.url) continue;
        await submitSource(
          { url: item.url },
          {
            userId: grant.funder_user_id,
            meterJobId: grant.budget_job_id,
          }
        );
        return { target: null, ingestedUrl: item.url };
      }
      if (!item.claim_id) {
        await setPlanCursor(grant.id, i + 1);
        continue;
      }
      // A 'deepen' item first drains its claim's own pending/deferred
      // subtree; when that is exhausted (or for 'assess'/'reassess'), the
      // claim itself.
      if (item.action === "deepen") {
        const sub = await claimDeepenTarget(item.claim_id, null);
        if (sub) {
          await advancePlanCursorIfNeeded(grant.id, i);
          return { target: sub };
        }
      }
      const own = await claimSpecificTarget(item.claim_id);
      if (own) {
        // The claim itself is the item's last unit: cursor moves past it.
        await setPlanCursor(grant.id, i + 1);
        return { target: own };
      }
      // Item fully handled (claim already assessed since planning, or
      // missing): move on.
      await setPlanCursor(grant.id, i + 1);
    }
    return { target: null };
  }

  if (grant.policy === "deepen") {
    return {
      target: await claimDeepenTarget(grant.scope_claim_id, grant.scope_query),
    };
  }

  if (grant.policy === "cover") {
    const rows = await rawQuery<TargetRow>(
      `${SCOPE_SQL},
       target AS (
         SELECT c.id, c.steward_state AS prior_state
           FROM claims c JOIN scope ON scope.id = c.id
          WHERE c.steward_state IN ('pending', 'deferred')
            AND NOT EXISTS (SELECT 1 FROM assessments a
                             WHERE a.claim_id = c.id AND a.is_current = true)
          ORDER BY c.queue_priority DESC
          LIMIT 1
          FOR UPDATE OF c SKIP LOCKED
       )
       UPDATE claims c SET steward_state = 'running', stewarded_at = now()
         FROM target WHERE c.id = target.id
       RETURNING c.id, target.prior_state, c.decomposition_status,
                 c.steward_trigger, c.steward_context`,
      [grant.scope_claim_id, grant.scope_query]
    );
    return { target: rows[0] ?? null };
  }

  // maintain: stalest current assessment past the cadence.
  const rows = await rawQuery<TargetRow>(
    `${SCOPE_SQL},
     target AS (
       SELECT c.id, c.steward_state AS prior_state
         FROM claims c
         JOIN scope ON scope.id = c.id
         JOIN assessments a ON a.claim_id = c.id AND a.is_current = true
        WHERE c.steward_state = 'done'
          AND a.assessed_at < now() - make_interval(days => $3::int)
        ORDER BY a.assessed_at ASC
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE claims c SET steward_state = 'running', stewarded_at = now()
       FROM target WHERE c.id = target.id
     RETURNING c.id, target.prior_state, c.decomposition_status,
               c.steward_trigger, c.steward_context`,
    [grant.scope_claim_id, grant.scope_query, config.grantMaintainCadenceDays]
  );
  return { target: rows[0] ?? null };
}

/** Deepen selector: pending/deferred within a subtree (and/or query scope). */
async function claimDeepenTarget(
  scopeClaimId: string | null,
  scopeQuery: string | null
): Promise<TargetRow | null> {
  const rows = await rawQuery<TargetRow>(
    `${SCOPE_SQL},
     target AS (
       SELECT c.id, c.steward_state AS prior_state
         FROM claims c JOIN scope ON scope.id = c.id
        WHERE c.steward_state IN ('pending', 'deferred')
        ORDER BY (c.steward_state = 'pending') DESC, c.importance DESC
        LIMIT 1
        FOR UPDATE OF c SKIP LOCKED
     )
     UPDATE claims c SET steward_state = 'running', stewarded_at = now()
       FROM target WHERE c.id = target.id
     RETURNING c.id, target.prior_state, c.decomposition_status,
               c.steward_trigger, c.steward_context`,
    [scopeClaimId, scopeQuery]
  );
  return rows[0] ?? null;
}

/** Claim one specific plan claim if it still needs a pass. */
async function claimSpecificTarget(claimId: string): Promise<TargetRow | null> {
  const rows = await rawQuery<TargetRow>(
    `UPDATE claims c
        SET steward_state = 'running', stewarded_at = now()
       FROM (SELECT id, steward_state AS prior_state FROM claims
              WHERE id = $1) prior
      WHERE c.id = prior.id AND c.state = 'active'
        AND c.steward_state IN ('pending', 'deferred', 'done', 'error')
        AND (c.steward_state <> 'running'
             OR c.stewarded_at < now() - interval '15 minutes')
      RETURNING c.id, prior.prior_state, c.decomposition_status,
                c.steward_trigger, c.steward_context`,
    [claimId]
  );
  return rows[0] ?? null;
}

async function setPlanCursor(grantId: string, cursor: number): Promise<void> {
  await rawQuery(
    `UPDATE grants SET plan_cursor = GREATEST(plan_cursor, $2), updated_at = now()
      WHERE id = $1`,
    [grantId, cursor]
  );
}

async function advancePlanCursorIfNeeded(
  grantId: string,
  cursor: number
): Promise<void> {
  await setPlanCursor(grantId, cursor);
}

async function releaseClaim(claimId: string, state: string): Promise<void> {
  await rawQuery(
    `UPDATE claims
        SET steward_state = CASE WHEN steward_state = 'running' THEN $2
                                 ELSE steward_state END,
            updated_at = now()
      WHERE id = $1`,
    [claimId, state]
  );
}

/** Advance one grant by one unit of work (a plan, or one Steward run). */
export async function processNextGrantTask(
  opts: { model?: string } = {}
): Promise<GrantProcessResult> {
  const config = loadConfig();

  try {
    checkBudget();
  } catch {
    return { status: "budget" };
  }

  const grantRows = await rawQuery<GrantRow>(
    `SELECT g.id, g.funder_user_id, g.budget_job_id, g.name, g.scope_claim_id,
            g.scope_query, g.policy, g.status, g.plan, g.plan_cursor,
            j.budget_micro_usd, j.status AS job_status
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE (g.status = 'planning' OR g.status = 'active')
        AND j.status = 'running'
      ORDER BY g.updated_at ASC
      LIMIT 1
      FOR UPDATE OF g SKIP LOCKED`
  );
  if (grantRows.length === 0) return { status: "empty" };
  const grant = grantRows[0]!;

  const spent = await getJobSpentMicroUsd(grant.budget_job_id);
  if (spent >= Number(grant.budget_micro_usd)) {
    await rawQuery(
      `UPDATE budget_jobs SET status = 'paused_budget', updated_at = now()
        WHERE id = $1`,
      [grant.budget_job_id]
    );
    await rawQuery(`UPDATE grants SET updated_at = now() WHERE id = $1`, [
      grant.id,
    ]);
    return { status: "paused", grantId: grant.id };
  }

  // PLANNING: run the Grantor agent, store the plan, wait for approval.
  if (grant.status === "planning") {
    try {
      const plan = await runWithUsageContext(
        { userId: grant.funder_user_id, jobId: grant.budget_job_id },
        () =>
          runGrantor({
            grantName: grant.name,
            scopeClaimId: grant.scope_claim_id,
            scopeQuery: grant.scope_query,
            budgetOwls: Math.floor(
              Number(grant.budget_micro_usd) / config.owlPriceMicroUsd
            ),
            model: opts.model,
          })
      );
      await rawQuery(
        `UPDATE grants
            SET plan = $2::jsonb, status = 'pending_approval',
                plan_cursor = 0, updated_at = now()
          WHERE id = $1`,
        [grant.id, JSON.stringify(plan)]
      );
      return { status: "planned", grantId: grant.id, ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof LlmBudgetExceededError || isTransientApiError(err)) {
        await rawQuery(`UPDATE grants SET updated_at = now() WHERE id = $1`, [
          grant.id,
        ]);
        return {
          status: err instanceof LlmBudgetExceededError ? "budget" : "transient",
          grantId: grant.id,
          error: msg,
        };
      }
      // A genuine planning failure surfaces on the grant for the funder.
      await rawQuery(
        `UPDATE grants SET updated_at = now() WHERE id = $1`,
        [grant.id]
      );
      await rawQuery(
        `UPDATE budget_jobs SET error = $2, updated_at = now() WHERE id = $1`,
        [grant.budget_job_id, msg]
      );
      return { status: "processed", grantId: grant.id, ok: false, error: msg };
    }
  }

  // EXECUTION: one target under the policy.
  const { target, ingestedUrl } = await claimNextGrantTarget(grant);
  if (ingestedUrl) {
    // The unit of work was enqueuing a funded ingestion; the extraction
    // meters to the grant's escrow as it runs.
    await rawQuery(`UPDATE grants SET updated_at = now() WHERE id = $1`, [
      grant.id,
    ]);
    return { status: "processed", grantId: grant.id, ok: true };
  }
  if (!target) {
    await refundUnspentBudget({
      id: grant.budget_job_id,
      userId: grant.funder_user_id,
      budgetMicroUsd: Number(grant.budget_micro_usd),
    });
    await rawQuery(
      `UPDATE budget_jobs SET status = 'completed', completed_at = now(),
              updated_at = now() WHERE id = $1`,
      [grant.budget_job_id]
    );
    await rawQuery(
      `UPDATE grants SET status = 'completed', updated_at = now() WHERE id = $1`,
      [grant.id]
    );
    return { status: "completed", grantId: grant.id };
  }

  // The grant's stake on this claim: attribution + background-priority
  // subsidy (once per grant × claim).
  await rawQuery(
    `INSERT INTO claim_stakes (claim_id, user_id, amount_micro_usd, source)
     SELECT $1, $2, $3, 'grant'
      WHERE NOT EXISTS (SELECT 1 FROM claim_stakes
                         WHERE claim_id = $1 AND user_id = $2 AND source = 'grant')`,
    [target.id, grant.funder_user_id, capMicroUsd("assessment")]
  );
  await refreshQueuePriority(target.id).catch(() => {});

  const virgin = target.decomposition_status === "pending";
  const trigger = virgin
    ? "structure_and_assess"
    : (target.steward_trigger ?? "user_order");
  // The funder's chosen name stays out of the run context on purpose: the
  // Steward must never see funder wording that could color its work, and
  // nothing funder-authored may reach reader surfaces (§12).
  const context =
    (target.steward_context ? `${target.steward_context}\n\n` : "") +
    `This run is scheduled under a funded mandate (policy: ${grant.policy}). ` +
    `Steward this claim now under the ordinary standards — funding buys ` +
    `attention, never conclusions.`;
  const model =
    opts.model ?? (config.stewardStrongModel || config.stewardModel);

  try {
    await runWithUsageContext(
      { userId: grant.funder_user_id, jobId: grant.budget_job_id },
      () => runClaimSteward({ trigger, claimId: target.id, context, model })
    );
    await rawQuery(
      `UPDATE claims
          SET steward_state = CASE WHEN steward_state = 'running' THEN 'done'
                                   ELSE steward_state END,
              steward_error = NULL, steward_attempts = 0
        WHERE id = $1`,
      [target.id]
    );
    await rawQuery(`UPDATE grants SET updated_at = now() WHERE id = $1`, [
      grant.id,
    ]);
    return { status: "processed", grantId: grant.id, claimId: target.id, ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await releaseClaim(target.id, target.prior_state);
    if (err instanceof LlmBudgetExceededError || isTransientApiError(err)) {
      return {
        status: err instanceof LlmBudgetExceededError ? "budget" : "transient",
        grantId: grant.id,
        claimId: target.id,
        error: msg,
      };
    }
    // Genuine failure on one target: record it and let the grant continue
    // with the next target next tick (poison claims stay the background
    // drain's attempt accounting's problem).
    await rawQuery(
      `UPDATE budget_jobs SET error = $2, updated_at = now() WHERE id = $1`,
      [grant.budget_job_id, msg]
    );
    await rawQuery(`UPDATE grants SET updated_at = now() WHERE id = $1`, [
      grant.id,
    ]);
    return {
      status: "processed",
      grantId: grant.id,
      claimId: target.id,
      ok: false,
      error: msg,
    };
  }
}

/** Are any grants currently runnable (planning or active with budget)? */
export async function runnableGrantCount(): Promise<number> {
  const [row] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.status IN ('planning', 'active') AND j.status = 'running'`
  );
  return row?.n ?? 0;
}
