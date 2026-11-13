/**
 * Public mandates — the outward face of grants.
 *
 * A mandate is managed by one user (or by the platform itself) but is a
 * PUBLIC thing: anyone can read its dashboard and put their own owls
 * behind it. The dashboard payload scales with what the mandate actually
 * does: every mandate reports budget, spend, contributors, and funded
 * assessments; mandates with ingestion additionally report their pipeline
 * (each source brought in, where its claims went, and importance and
 * contestation statistics per source), which is also exactly the data the
 * Grantmaker's analytics tools read when the manager asks questions.
 *
 * Discovery (/mandates) gives pride of place to the largest mandates and
 * to the platform's own (Mathematics, AI Economics to start).
 */
import { correspondentPublic, listCorrespondents, type CorrespondentPublic } from "./correspondent-service.js";
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import { membersOnly } from "../permissions.js";
import {
  contributeToBudgetJob,
  getJobContributions,
} from "./budget-job-service.js";
import { grantEscrowBreakdown } from "./regrant-service.js";
import { serializeAttemptSummary, type AttemptRow } from "./attempt-service.js";
import { LIVE_BOUNTY_STATUSES } from "./bounty-service.js";
import type { AttemptSummary } from "./claim-extras-types.js";
import type { GrantMandate } from "../llm/agents/grantmaker.js";
import type { PlanItem } from "./grant-service.js";
import type { PlanItemLedger } from "./action-service.js";
import { describePlanItems, type PlanItemState } from "./plan-state.js";
import { summarizeLookouts, type LookoutSummary } from "./lookout-service.js";
import type { PlatformApproval } from "./platform-mandate-service.js";

export interface MandateSummary {
  id: string;
  title: string;
  objective: string | null;
  is_platform: boolean;
  status: string;
  /** Who funds it, as its page shows them (see funderDisclosure). */
  manager: string;
  /**
   * The funder's disclosure (docs/allocation.md, "Who funds a mandate"):
   * whether they are named, and the stake they declared in its subject.
   * `declared` is false for a mandate funded before funders were asked.
   */
  funder: { shown_as: string; named: boolean; declared: boolean; stake: string | null };
  budget_owls: number;
  spent_owls: number;
  contributor_count: number;
  action_mix: Record<string, number>;
  created_at: string | null;
}

interface GrantRow {
  id: string;
  name: string;
  status: string;
  is_platform: boolean;
  scope_claim_id: string | null;
  scope_query: string | null;
  plan: { strategy?: string; items?: PlanItem[] } | null;
  plan_cursor: number;
  mandate: GrantMandate | null;
  budget_job_id: string;
  budget_micro_usd: number;
  job_status: string;
  funder_user_id: string;
  manager_name: string;
  skills: string[] | null;
  platform_approval: PlatformApproval | null;
  created_at: Date | null;
}

const GRANT_SELECT = `
  SELECT g.id, g.name, g.status, g.is_platform, g.scope_claim_id,
         g.scope_query, g.plan, g.plan_cursor, g.mandate, g.budget_job_id,
         g.funder_user_id, g.skills, g.platform_approval, g.created_at,
         j.budget_micro_usd, j.status AS job_status,
         COALESCE(c.display_name, 'a Minerval user') AS manager_name
    FROM grants g
    JOIN budget_jobs j ON j.id = g.budget_job_id
    LEFT JOIN contributors c ON c.id = g.funder_user_id`;

function actionMix(plan: GrantRow["plan"]): Record<string, number> {
  const mix: Record<string, number> = {};
  for (const item of plan?.items ?? []) {
    mix[item.action] = (mix[item.action] ?? 0) + 1;
  }
  return mix;
}

/**
 * How a mandate's funder is shown. The platform is Minerval, except in a
 * members-only deployment, where the standing mandates are the
 * organization's own and are shown under the name its own account carries
 * (owl-creation-service.ts, deploymentOwnAccountId). A funder who
 * chose not to be named is "an anonymous funder", or "a reader" for a
 * decomposition (one reader buying depth on one claim); their stake, if
 * they declared one, is shown either way. A mandate funded before funders
 * were asked shows its funder's display name, as it always did.
 */
export function funderDisclosure(row: {
  is_platform: boolean;
  manager_name: string;
  mandate: GrantMandate | null;
}): MandateSummary["funder"] {
  const m = row.mandate;
  const declared = m?.funder_named !== undefined;
  const named = row.is_platform || !declared || m!.funder_named === true;
  const shown_as = row.is_platform
    ? membersOnly()
      ? row.manager_name
      : "Minerval"
    : named
      ? row.manager_name
      : m?.origin === "deep_decomposition"
        ? "a reader"
        : "an anonymous funder";
  const stake = m?.funder_stake?.trim() || null;
  return { shown_as, named, declared, stake };
}

async function summarize(row: GrantRow): Promise<MandateSummary> {
  // A mandate's spend is its consumed allocation shares plus whatever its
  // job metered that no share accounts for (grantEscrowBreakdown): every
  // report of a mandate's money counts it the same way (#849).
  const [escrow, contributions] = await Promise.all([
    grantEscrowBreakdown({ id: row.id, budgetJobId: row.budget_job_id }),
    getJobContributions(row.budget_job_id),
  ]);
  const spent = escrow.spent;
  return {
    id: row.id,
    title: row.mandate?.title ?? row.name,
    objective: row.mandate?.objective ?? null,
    is_platform: row.is_platform,
    status: row.status,
    manager: funderDisclosure(row).shown_as,
    funder: funderDisclosure(row),
    budget_owls: microUsdToOwls(Number(row.budget_micro_usd)),
    spent_owls: microUsdToOwls(
      Math.min(spent, Number(row.budget_micro_usd))
    ),
    contributor_count: contributions.length,
    action_mix: actionMix(row.plan),
    created_at: row.created_at?.toISOString() ?? null,
  };
}

/**
 * The public listing: platform mandates first, then by total budget. Only
 * live mandates (active or budget-paused) are contributable; completed and
 * cancelled ones drop off.
 */
export async function listPublicMandates(limit = 50): Promise<MandateSummary[]> {
  const rows = await rawQuery<GrantRow>(
    `${GRANT_SELECT}
      WHERE g.status = 'active'
      ORDER BY g.is_platform DESC, j.budget_micro_usd DESC, g.created_at ASC
      LIMIT $1`,
    [limit]
  );
  return Promise.all(rows.map(summarize));
}

export interface SourcePipelineRow {
  source_id: string;
  url: string;
  title: string | null;
  ingested_at: string | null;
  extraction_status: string | null;
  claims_linked: number;
  claims_assessed: number;
  avg_importance: number | null;
  max_importance: number | null;
  contested_claims: number;
  importance_histogram: number[];
}

/**
 * The ingestion-pipeline view: one row per source the mandate brought in,
 * with where its claims went and what they look like. The histogram is
 * four importance buckets (0–.25, .25–.5, .5–.75, .75–1).
 */
export async function getMandatePipeline(
  grantId: string
): Promise<SourcePipelineRow[]> {
  const rows = await rawQuery<{
    source_id: string;
    url: string;
    title: string | null;
    ingested_at: Date | null;
    extraction_status: string | null;
    claims_linked: number;
    claims_assessed: number;
    avg_importance: number | null;
    max_importance: number | null;
    contested_claims: number;
    b1: number;
    b2: number;
    b3: number;
    b4: number;
  }>(
    `SELECT gs.source_id, gs.url, s.title, gs.created_at AS ingested_at,
            j.status AS extraction_status,
            COUNT(DISTINCT ci.claim_id)::int AS claims_linked,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE a.id IS NOT NULL)::int AS claims_assessed,
            AVG(cl.importance)::real AS avg_importance,
            MAX(cl.importance)::real AS max_importance,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.contestation >= 0.5)::int AS contested_claims,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.importance < 0.25)::int AS b1,
            COUNT(DISTINCT ci.claim_id) FILTER
              (WHERE cl.importance >= 0.25 AND cl.importance < 0.5)::int AS b2,
            COUNT(DISTINCT ci.claim_id) FILTER
              (WHERE cl.importance >= 0.5 AND cl.importance < 0.75)::int AS b3,
            COUNT(DISTINCT ci.claim_id)
              FILTER (WHERE cl.importance >= 0.75)::int AS b4
       FROM grant_sources gs
       JOIN sources s ON s.id = gs.source_id
       LEFT JOIN jobs j ON j.id = gs.job_id
       LEFT JOIN claim_instances ci ON ci.source_id = gs.source_id AND ci.detached_at IS NULL
       LEFT JOIN claims cl ON cl.id = ci.claim_id AND cl.state = 'active'
       LEFT JOIN assessments_in_force a
         ON a.claim_id = ci.claim_id
      WHERE gs.grant_id = $1
      GROUP BY gs.source_id, gs.url, s.title, gs.created_at, j.status
      ORDER BY gs.created_at ASC`,
    [grantId]
  );
  return rows.map((r) => ({
    source_id: r.source_id,
    url: r.url,
    title: r.title,
    ingested_at: r.ingested_at?.toISOString() ?? null,
    extraction_status: r.extraction_status,
    claims_linked: r.claims_linked,
    claims_assessed: r.claims_assessed,
    avg_importance:
      r.avg_importance != null
        ? Math.round(r.avg_importance * 100) / 100
        : null,
    max_importance:
      r.max_importance != null
        ? Math.round(r.max_importance * 100) / 100
        : null,
    contested_claims: r.contested_claims,
    importance_histogram: [r.b1, r.b2, r.b3, r.b4],
  }));
}

/** The mandate page's longer sections (docs/mathematics.md §10.4): each null when the mandate has none. */
export interface MandateText {
  scope: string | null;
  prize_policy: string | null;
  attempt_policy: string | null;
  refusals: string | null;
  disclosure: string | null;
}

export interface MandateDetail extends MandateSummary {
  strategy: string | null;
  /** The sections beyond objective and strategy, for the page to render in full. */
  text: MandateText;
  notes: string | null;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_status: string;
  /** The public approval behind a platform-funded mandate (#529); null otherwise. */
  platform_approval: PlatformApproval | null;
  /** Peer mandates whose regrants fund this one, and the ones it funds. */
  funded_by_mandates: Array<{
    grant_id: string;
    title: string;
    owls: number;
    note: string | null;
  }>;
  regrants_out: Array<{
    grant_id: string;
    title: string;
    owls: number;
    note: string | null;
  }>;
  /** The Grantmaker's latest autonomous review of this mandate. */
  last_review: { at: string; note: string } | null;
  /**
   * The plan with each item's state and ledger standing (plan-state.ts):
   * `state` is the dashboard word, `ledger` the row or the reason there is
   * none (null before the item's first materialization).
   */
  plan_items: Array<PlanItem & { index: number; state: PlanItemState; ledger: PlanItemLedger | null }>;
  contributors: Array<{ name: string; owls: number; is_manager: boolean }>;
  funded_assessments: Array<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: string | null;
  }>;
  /** Non-empty exactly when the mandate ingests: the pipeline view. */
  pipeline: SourcePipelineRow[];
  /** The standing watches this mandate funds (docs/allocation.md, "Lookouts"). */
  lookouts: LookoutSummary[];
  /** The readers this mandate funds for an audience (#563). */
  correspondents: CorrespondentPublic[];
  /** The domain skills the mandate's Grantmaker carries (skill names). */
  skills: string[];
  /** Set only for the manager: the conversation to keep talking in. */
  conversation_id?: string;
  is_manager?: boolean;
}

export async function getPublicMandate(
  grantId: string,
  viewerUserId?: string | null
): Promise<MandateDetail | null> {
  const [row] = await rawQuery<GrantRow>(
    `${GRANT_SELECT} WHERE g.id = $1`,
    [grantId]
  );
  if (!row) return null;
  // Pre-funding conversations are private; a mandate is public once live.
  // A decomposition is funded the moment it is bought, so it is public
  // while its plan is drafted too.
  const live = ["active", "completed", "cancelled"].includes(row.status) ||
    (row.status === "planning" && row.mandate?.origin === "deep_decomposition");
  if (!live) return null;

  const summary = await summarize(row);
  const contributions = await getJobContributions(row.budget_job_id);
  const contributorNames = await rawQuery<{ id: string; name: string }>(
    `SELECT id, display_name AS name FROM contributors
      WHERE id = ANY($1::uuid[])`,
    [contributions.map((c) => c.userId)]
  );
  const nameOf = new Map(contributorNames.map((c) => [c.id, c.name]));

  const funded = await rawQuery<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: Date | null;
  }>(
    `SELECT a.claim_id, c.text, a.status, a.assessed_at
       FROM assessments a JOIN claims c ON c.id = a.claim_id
      WHERE a.funded_by_job_id = $1
      ORDER BY a.assessed_at DESC
      LIMIT 100`,
    [row.budget_job_id]
  );

  // Each item's standing on the ledger (plan-state.ts), not its position
  // against the cursor: a blocked or waiting item says why (#416).
  const items = describePlanItems(row.plan?.items ?? [], row.plan_cursor);

  const hasIngest = items.some((i) => i.action === "ingest");
  const pipeline = hasIngest ? await getMandatePipeline(row.id) : [];
  const lookouts = await summarizeLookouts(row.id).catch(() => []);
  const correspondents = (await listCorrespondents(row.id).catch(() => [])).map(correspondentPublic);

  const isManager = !!viewerUserId && viewerUserId === row.funder_user_id;
  let conversationId: string | undefined;
  if (isManager) {
    const [convo] = await rawQuery<{ id: string }>(
      `SELECT id FROM grant_conversations WHERE grant_id = $1
        ORDER BY created_at DESC LIMIT 1`,
      [row.id]
    );
    conversationId = convo?.id;
  }

  const { regrantEdges } = await import("./regrant-service.js");
  const edges = await regrantEdges(row.id);
  const lastReview = (
    row.mandate as (GrantMandate & {
      last_review?: { at: string; note: string };
    }) | null
  )?.last_review;

  return {
    ...summary,
    strategy: row.plan?.strategy ?? row.mandate?.plan?.strategy ?? null,
    text: mandateText(row.mandate),
    notes: row.mandate?.notes ?? null,
    scope_claim_id: row.scope_claim_id,
    scope_query: row.scope_query,
    budget_status: row.job_status,
    // The public approval a platform-funded mandate was funded under
    // (#529): the reviewed pull request, who merged it, and the granting
    // conversation, which is public for the platform's mandates.
    platform_approval: row.platform_approval ?? null,
    funded_by_mandates: edges.fundedBy,
    regrants_out: edges.fundsOut,
    last_review: lastReview ?? null,
    plan_items: items,
    contributors: contributions.map((c) => ({
      name:
        c.userId === row.funder_user_id
          ? funderDisclosure(row).shown_as
          : (nameOf.get(c.userId) ?? "a Minerval user"),
      owls: microUsdToOwls(c.heldMicroUsd),
      is_manager: c.userId === row.funder_user_id,
    })),
    funded_assessments: funded.map((f) => ({
      claim_id: f.claim_id,
      text: f.text,
      status: f.status,
      assessed_at: f.assessed_at?.toISOString() ?? null,
    })),
    pipeline,
    lookouts,
    correspondents,
    skills: Array.isArray(row.skills) ? row.skills : [],
    ...(isManager
      ? { is_manager: true, ...(conversationId ? { conversation_id: conversationId } : {}) }
      : {}),
  };
}

/**
 * The house solver's attempts under this mandate (docs/mathematics.md
 * §7, §8.3), newest first, as the mandate page's Prizes section lists
 * them. Each goes through the attempt log's own serializer, so an
 * unpublished attempt on a claim with a live bounty stays opaque here
 * exactly as it does on the claim page.
 */
export async function listMandateAttempts(grantId: string, limit = 100): Promise<AttemptSummary[]> {
  const rows = await rawQuery<AttemptRow & { bounty_bearing: boolean }>(
    `SELECT pa.id, pa.claim_id, pa.formalization_id, pa.action_id, pa.run_id, pa.grant_id,
            pa.job_id, pa.model, pa.variant, pa.effort, pa.status, pa.outcome, pa.report,
            pa.lean_proof, pa.lean_check_id, pa.notebook, pa.is_calibration,
            pa.ceiling_micro_usd::bigint AS ceiling_micro_usd,
            pa.spent_micro_usd::bigint AS spent_micro_usd,
            pa.turns, pa.compactions, pa.served_models, pa.published_at, pa.started_at,
            pa.heartbeat_at, pa.finished_at, pa.error,
            EXISTS (SELECT 1 FROM bounties b
                     WHERE b.claim_id = pa.claim_id AND b.status = ANY($2)) AS bounty_bearing
       FROM proof_attempts pa
      WHERE pa.grant_id = $1
      ORDER BY pa.started_at DESC, pa.id ASC
      LIMIT $3`,
    [grantId, [...LIVE_BOUNTY_STATUSES], limit]
  );
  return rows.map(({ bounty_bearing, ...row }) =>
    serializeAttemptSummary(
      {
        ...row,
        ceiling_micro_usd: Number(row.ceiling_micro_usd),
        spent_micro_usd: Number(row.spent_micro_usd),
        turns: Number(row.turns),
        compactions: Number(row.compactions),
        notebook: (row.notebook ?? {}) as Record<string, string>,
        served_models: Array.isArray(row.served_models) ? row.served_models : null,
        started_at: new Date(row.started_at),
        finished_at: row.finished_at ? new Date(row.finished_at) : null,
        published_at: row.published_at ? new Date(row.published_at) : null,
      },
      { bountyBearing: bounty_bearing === true }
    )
  );
}

// ---------------------------------------------------------------------------
// The operations view — how THIS mandate is spending: the operating policy
// its program officers carry out, its money today, what it has commissioned
// and how those runs used their budgets, the decisions its officers and
// Grantmaker made, and the petitions it heard. Every figure is from the
// ledger and the decision log; there is no formula to show, because there
// is none. Rendered on the mandate page and read by its Grantmaker
// (allocation_report).
// ---------------------------------------------------------------------------

export interface OperationsKindRow {
  kind: string;
  /**
   * How the mandate paid: `commissioned` (an agent, a plan item or the
   * funder chose the run and its budget) or `self_funded` (its own upkeep,
   * covered at the row's estimate: planning and review passes, lookout and
   * correspondent runs, planned ingests and sweeps).
   */
  funding: "commissioned" | "self_funded";
  /** Runs this mandate paid for of this kind, this way, in the window. */
  runs: number;
  /** Of those, the ones still waiting or running. */
  running: number;
  budget_owls: number;
  spent_owls: number;
}

export interface OperationsCommissionRow {
  action_id: string;
  kind: string;
  claim_id: string | null;
  label: string;
  commissioned_by: string;
  budget_owls: number;
  spent_owls: number;
  /** waiting: commissioned, not yet started; running; settled: finished and refunded. */
  state: "waiting" | "running" | "settled";
  reason: string | null;
  created_at: string;
}

export interface OperationsDecisionRow {
  decided_by: string;
  item_kind: string;
  decision: string;
  target: string | null;
  owls: number | null;
  reason: string | null;
  created_at: string;
}

export interface MandateAllocationView {
  grant_id: string;
  title: string;
  /** The operating policy, as the officers and the public read it. */
  operating_policy: string;
  /** The most an officer may commit in one decision, and why. */
  officer_limit: { owls: number; reason: string };
  /** The budget each of the mandate's review passes works to, and why (#820). */
  review_pass: { owls: number; reason: string };
  budget: {
    escrow_owls: number;
    spent_owls: number;
    /**
     * The part of spent_owls metered to the mandate's job outside the
     * ledger, which no row in `kinds` shows and the pace does not
     * bound: the Grantmaker's chat with the funder, and spend past what a
     * run's allocations covered where no allocation of the mandate's
     * recorded it.
     */
    outside_ledger_owls: number;
    /** The mandate's pace (pace-service.ts): as_needed, or steady over a rolling window. */
    pace: import("./pace-service.js").Pace;
    /** Steady only: what the window holds now (spent, or held by running work). */
    pace_window_used_owls: number | null;
    /** Owls only the Grantmaker may commit, and why. */
    reserve_owls: number;
    reserve_reason: string | null;
    /** Where the pace stands, as the mandate's agents read it. */
    pace_sentence: string | null;
    /** Budgets commissioned and not yet settled. */
    held_owls: number;
    /** Regranted to other mandates, net of returned shares. */
    regranted_owls: number;
    /** Bounties held, prizes paid, and the prize-review reserve. */
    prizes_owls: number;
    /** The escrow less spent, held, regranted and prizes: what is free to commit. */
    remaining_owls: number;
  };
  window_days: number;
  kinds: OperationsKindRow[];
  commissions: OperationsCommissionRow[];
  /** Commissions in the window not shown in `commissions` (paged). */
  more: number;
  decisions: OperationsDecisionRow[];
  petitions: { received: number; granted: number; refused: number; follow_up: number; escalated: number; pending: number };
  /** Items waiting for the officers in the mandate's inbox. */
  inbox_waiting: number;
}

const OPERATIONS_WINDOW_DAYS = 30;

/**
 * Assemble one mandate's operations view. `kind` filters the commission
 * list (the kind rows always cover every kind); `offset`/`limit` page it.
 */
export async function getMandateAllocationView(
  grantId: string,
  opts: { kind?: string; offset?: number; limit?: number } = {}
): Promise<MandateAllocationView | null> {
  const [grant] = await rawQuery<{
    id: string;
    name: string;
    title: string | null;
    budget_job_id: string;
    budget_micro_usd: number;
  }>(
    `SELECT g.id, g.name, g.mandate->>'title' AS title, g.budget_job_id,
            j.budget_micro_usd
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [grantId]
  );
  if (!grant) return null;

  const { getOperatingPolicy, renderOperatingPolicy, officerLimit, reviewPassBudget } = await import(
    "./operating-policy-service.js"
  );
  const { paceRoom } = await import("./pace-service.js");
  const policy = await getOperatingPolicy(grantId);
  const limit = officerLimit(policy);
  const reviewPass = reviewPassBudget(policy);

  const [money, pace] = await Promise.all([
    grantEscrowBreakdown({ id: grantId, budgetJobId: grant.budget_job_id }),
    paceRoom(grantId, "delegated"),
  ]);

  const window = `now() - make_interval(days => ${OPERATIONS_WINDOW_DAYS})`;
  // Every allocation of the mandate's in the window, commissioned or
  // self-funded: the table used to show commissions alone, so a mandate's
  // review, lookout, ingest and sweep spend appeared nowhere in it (#849).
  // An overage row (completeAction records a run's spend past its
  // allocations as an allocation already spent and released, created and
  // released in the same instant) adds to the spend of the run it belongs
  // to, and is not a run of its own. A fully spent allocation is settled,
  // though nothing stamps released_at on it.
  const kinds = await rawQuery<{
    kind: string;
    commissioned: boolean;
    runs: number;
    running: number;
    budget: string;
    spent: string;
  }>(
    `SELECT kind, commissioned,
            count(*) FILTER (WHERE NOT overage)::int AS runs,
            count(*) FILTER (WHERE live)::int AS running,
            COALESCE(SUM(amount), 0)::bigint AS budget,
            COALESCE(SUM(spent), 0)::bigint AS spent
       FROM (
         SELECT a.kind, al.amount_micro_usd AS amount, al.spent_micro_usd AS spent,
                (al.released_at IS NULL AND al.spent_micro_usd < al.amount_micro_usd) AS live,
                (al.commissioned_by IS NULL AND al.released_at IS NOT DISTINCT FROM al.created_at
                 AND al.spent_micro_usd = al.amount_micro_usd) AS overage,
                CASE WHEN al.commissioned_by IS NULL AND al.released_at IS NOT DISTINCT FROM al.created_at
                          AND al.spent_micro_usd = al.amount_micro_usd
                     THEN COALESCE((SELECT p.commissioned_by IS NOT NULL AND p.commissioned_by <> 'mandate' FROM minerval_whole.allocation_money p
                                     WHERE p.grant_id = al.grant_id AND p.action_id = al.action_id
                                       AND p.created_at < al.created_at
                                     ORDER BY p.created_at DESC LIMIT 1), false)
                     -- The mandate's own upkeep (commissioned_by 'mandate') is self-funded.
                     ELSE al.commissioned_by IS NOT NULL AND al.commissioned_by <> 'mandate' END AS commissioned
           FROM minerval_whole.allocation_money al JOIN actions a ON a.id = al.action_id
          WHERE al.grant_id = $1 AND al.created_at >= ${window}
       ) x
      GROUP BY kind, commissioned
      ORDER BY SUM(spent) DESC, count(*) DESC, kind, commissioned`,
    [grantId]
  );

  const offset = Math.max(0, opts.offset ?? 0);
  const pageLimit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const params: unknown[] = [grantId, pageLimit, offset];
  if (opts.kind) params.push(opts.kind);
  const commissions = await rawQuery<{
    action_id: string;
    kind: string;
    claim_id: string | null;
    label: string;
    commissioned_by: string;
    amount: string;
    spent: string;
    released: boolean;
    status: string;
    reason: string | null;
    created_at: string;
    total: number;
  }>(
    `SELECT a.id AS action_id, a.kind, a.claim_id, a.label, al.commissioned_by,
            al.amount_micro_usd AS amount, al.spent_micro_usd AS spent,
            (al.released_at IS NOT NULL OR al.spent_micro_usd >= al.amount_micro_usd) AS released, a.status, al.reason,
            al.created_at::text AS created_at, COUNT(*) OVER ()::int AS total
       FROM action_allocations al JOIN actions a ON a.id = al.action_id
      WHERE al.grant_id = $1 AND al.commissioned_by IS NOT NULL AND al.commissioned_by <> 'mandate'
        AND al.created_at >= ${window}
        ${opts.kind ? "AND a.kind = $4" : ""}
      ORDER BY al.created_at DESC
      LIMIT $2 OFFSET $3`,
    params
  );
  const total = Number(commissions[0]?.total ?? 0);

  const decisions = await rawQuery<{
    decided_by: string;
    item_kind: string;
    decision: string;
    target: string | null;
    owls_micro_usd: string | null;
    reason: string | null;
    created_at: string;
  }>(
    `SELECT decided_by, item_kind, decision, target, owls_micro_usd, reason, created_at::text AS created_at
       FROM mandate_decisions WHERE grant_id = $1
      ORDER BY created_at DESC LIMIT 20`,
    [grantId]
  );
  const [pet] = await rawQuery<Record<string, number>>(
    `SELECT count(*)::int AS received,
            count(*) FILTER (WHERE status = 'granted')::int AS granted,
            count(*) FILTER (WHERE status = 'refused')::int AS refused,
            count(*) FILTER (WHERE status = 'follow_up')::int AS follow_up,
            count(*) FILTER (WHERE status = 'escalated')::int AS escalated,
            count(*) FILTER (WHERE status = 'pending')::int AS pending
       FROM petitions WHERE grant_id = $1 AND created_at >= ${window}`,
    [grantId]
  );
  const [inbox] = await rawQuery<{ n: number }>(
    `SELECT count(*)::int AS n FROM mandate_inbox WHERE grant_id = $1 AND handled_at IS NULL`,
    [grantId]
  );

  const escrow = Number(grant.budget_micro_usd);
  return {
    grant_id: grantId,
    title: grant.title ?? grant.name,
    operating_policy: renderOperatingPolicy(policy),
    officer_limit: { owls: microUsdToOwls(limit.microUsd), reason: limit.reason },
    review_pass: { owls: microUsdToOwls(reviewPass.microUsd), reason: reviewPass.reason },
    budget: {
      escrow_owls: microUsdToOwls(escrow),
      spent_owls: microUsdToOwls(Math.min(money.spent, escrow)),
      outside_ledger_owls: microUsdToOwls(Math.min(money.outsideLedger, escrow)),
      pace: pace?.pace ?? { kind: "as_needed" },
      pace_window_used_owls: pace?.windowUsedMicroUsd != null ? microUsdToOwls(pace.windowUsedMicroUsd) : null,
      reserve_owls: microUsdToOwls(pace?.reserveMicroUsd ?? 0),
      reserve_reason: pace?.reserveReason ?? null,
      pace_sentence: pace?.sentence ?? null,
      held_owls: microUsdToOwls(money.held),
      regranted_owls: microUsdToOwls(money.regrants),
      prizes_owls: microUsdToOwls(money.prizes),
      remaining_owls: microUsdToOwls(Math.max(0, escrow - money.committed)),
    },
    window_days: OPERATIONS_WINDOW_DAYS,
    kinds: kinds.map((k) => ({
      kind: k.kind,
      funding: k.commissioned ? ("commissioned" as const) : ("self_funded" as const),
      runs: Number(k.runs),
      running: Number(k.running),
      budget_owls: microUsdToOwls(Number(k.budget)),
      spent_owls: microUsdToOwls(Number(k.spent)),
    })),
    commissions: commissions.map((c) => ({
      action_id: c.action_id,
      kind: c.kind,
      claim_id: c.claim_id,
      label: c.label,
      commissioned_by: c.commissioned_by,
      budget_owls: microUsdToOwls(Number(c.amount)),
      spent_owls: microUsdToOwls(Number(c.spent)),
      state: c.released ? "settled" : c.status === "running" ? "running" : "waiting",
      reason: c.reason,
      created_at: c.created_at,
    })),
    more: Math.max(0, total - offset - commissions.length),
    decisions: decisions.map((d) => ({
      decided_by: d.decided_by,
      item_kind: d.item_kind,
      decision: d.decision,
      target: d.target,
      owls: d.owls_micro_usd == null ? null : microUsdToOwls(Number(d.owls_micro_usd)),
      reason: d.reason,
      created_at: d.created_at,
    })),
    petitions: {
      received: Number(pet?.received ?? 0),
      granted: Number(pet?.granted ?? 0),
      refused: Number(pet?.refused ?? 0),
      follow_up: Number(pet?.follow_up ?? 0),
      escalated: Number(pet?.escalated ?? 0),
      pending: Number(pet?.pending ?? 0),
    },
    inbox_waiting: Number(inbox?.n ?? 0),
  };
}

export type ContributeResult =
  | { ok: true; mandate: MandateDetail }
  | {
      ok: false;
      code: "NOT_FOUND" | "NOT_OPEN" | "INSUFFICIENT_OWLS";
      message: string;
    };

/** Put owls behind a public mandate. Any signed-in user; pro-rata refunds. */
export async function contributeToMandate(input: {
  grantId: string;
  userId: string;
  owls: number;
}): Promise<ContributeResult> {
  const [row] = await rawQuery<GrantRow>(
    `${GRANT_SELECT} WHERE g.id = $1`,
    [input.grantId]
  );
  if (!row || row.status !== "active") {
    return {
      ok: false,
      code: row ? "NOT_OPEN" : "NOT_FOUND",
      message: row
        ? `This mandate is ${row.status} and no longer taking contributions`
        : "Mandate not found",
    };
  }
  const result = await contributeToBudgetJob({
    jobId: row.budget_job_id,
    userId: input.userId,
    owls: input.owls,
  });
  if (!result.ok) {
    return {
      ok: false,
      code: result.code === "INSUFFICIENT_OWLS" ? "INSUFFICIENT_OWLS" : "NOT_OPEN",
      message: result.message,
    };
  }
  const mandate = await getPublicMandate(input.grantId, input.userId);
  return { ok: true, mandate: mandate! };
}

/** Read the page's longer sections off the mandate JSON; only non-empty strings count. */
export function mandateText(mandate: GrantMandate | null): MandateText {
  const m = (mandate ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null => {
    const v = m[key];
    return typeof v === "string" && v.trim().length > 0 ? v : null;
  };
  return {
    scope: str("scope"),
    prize_policy: str("prize_policy"),
    attempt_policy: str("attempt_policy"),
    refusals: str("refusals"),
    disclosure: str("disclosure"),
  };
}

/** What a mandate's officers are told when one of its funders raises a node: fixed words, so the route carries nothing a funder wrote. */
export const FUNDER_RAISE_SUMMARY = "A funder of this mandate asks for a fresh assessment of this node.";

/**
 * A funder puts a node in front of a mandate's officers
 * (docs/outward-acts.md, "Keeping the public version current"; constitution
 * §19: "the work the system puts in front of it"). Money moves between
 * funders and mandates and command never does, so this asks: the officers
 * decide under the operating policy. Only an account with money held in
 * the mandate may ask, and the item is fixed words with the node: nothing
 * the funder wrote reaches the officers this way.
 */
export async function raiseNodeToMandate(input: {
  grantId: string;
  userId: string;
  nodeId: string;
}): Promise<
  | { ok: true; folded: boolean; in_words: string }
  | { ok: false; code: "NOT_FOUND" | "NOT_OPEN" | "NOT_A_FUNDER" | "NODE_NOT_FOUND"; message: string }
> {
  const [row] = await rawQuery<GrantRow>(`${GRANT_SELECT} WHERE g.id = $1`, [input.grantId]);
  if (!row) return { ok: false, code: "NOT_FOUND", message: "Mandate not found" };
  if (row.status !== "active") return { ok: false, code: "NOT_OPEN", message: `This mandate is ${row.status} and takes nothing new` };
  const [held] = await rawQuery<{ held: string | null }>(
    `SELECT -SUM(amount_micro_usd)::bigint AS held FROM owl_ledger WHERE job_id = $1 AND user_id = $2 AND reason = 'escrow_hold'`,
    [row.budget_job_id, input.userId]
  );
  if (!(Number(held?.held ?? 0) > 0)) {
    return {
      ok: false,
      code: "NOT_A_FUNDER",
      message: "Only an account with money in this mandate may put a node in front of its officers. Anyone may fund the node's assessment directly, or contribute to the mandate first.",
    };
  }
  const [node] = await rawQuery<{ id: string }>(`SELECT id FROM claims WHERE id = $1 AND state = 'active'`, [input.nodeId]);
  if (!node) return { ok: false, code: "NODE_NOT_FOUND", message: "No active node has that id." };
  const { ensureAssessActions } = await import("./action-service.js");
  await ensureAssessActions(node.id).catch(() => undefined);
  const [action] = await rawQuery<{ id: string }>(
    `SELECT id FROM actions WHERE claim_id = $1 AND kind IN ('assess', 'reassess') AND status = 'open' ORDER BY created_at DESC LIMIT 1`,
    [node.id]
  );
  const { raiseToMandate } = await import("./mandate-inbox-service.js");
  const raised = await raiseToMandate({
    grantId: input.grantId,
    kind: "raised",
    targetNodeId: node.id,
    source: "a funder of this mandate",
    summary: FUNDER_RAISE_SUMMARY,
    detail: { asked: "a fresh assessment", ...(action ? { action_id: action.id } : {}) },
  });
  if (!raised) return { ok: false, code: "NOT_FOUND", message: "Mandate not found" };
  return {
    ok: true,
    folded: raised.folded,
    in_words: raised.folded
      ? "This node was already waiting in front of the mandate's officers. Nothing new was added."
      : "The node is in front of the mandate's officers, who decide under its operating policy whether its money pays for a fresh assessment. The request and their decision are on the mandate's page.",
  };
}
