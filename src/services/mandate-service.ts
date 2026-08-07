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
import { rawQuery } from "../db/client.js";
import { microUsdToOwls } from "./owl.js";
import {
  contributeToBudgetJob,
  getJobContributions,
  getJobSpentMicroUsd,
} from "./budget-job-service.js";
import { grantAllocationExposureMicroUsd } from "./allocation-service.js";
import type { GrantMandate } from "../llm/agents/grantmaker.js";
import type { PlanItem } from "./grant-service.js";

export interface MandateSummary {
  id: string;
  title: string;
  objective: string | null;
  is_platform: boolean;
  status: string;
  manager: string;
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
  created_at: Date | null;
}

const GRANT_SELECT = `
  SELECT g.id, g.name, g.status, g.is_platform, g.scope_claim_id,
         g.scope_query, g.plan, g.plan_cursor, g.mandate, g.budget_job_id,
         g.funder_user_id, g.created_at,
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

async function summarize(row: GrantRow): Promise<MandateSummary> {
  // A mandate's spend is what its runs metered directly to its job PLUS
  // its consumed shares of co-funded actions (the allocation engine).
  const [jobSpent, exposure, contributions] = await Promise.all([
    getJobSpentMicroUsd(row.budget_job_id),
    grantAllocationExposureMicroUsd(row.id),
    getJobContributions(row.budget_job_id),
  ]);
  const spent = jobSpent + exposure.spentMicroUsd;
  return {
    id: row.id,
    title: row.mandate?.title ?? row.name,
    objective: row.mandate?.objective ?? null,
    is_platform: row.is_platform,
    status: row.status,
    manager: row.is_platform ? "Minerval" : row.manager_name,
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
       LEFT JOIN claim_instances ci ON ci.source_id = gs.source_id
       LEFT JOIN claims cl ON cl.id = ci.claim_id AND cl.state = 'active'
       LEFT JOIN assessments a
         ON a.claim_id = ci.claim_id AND a.is_current = true
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

export interface MandateDetail extends MandateSummary {
  strategy: string | null;
  notes: string | null;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_status: string;
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
  plan_items: Array<PlanItem & { state: "done" | "current" | "queued" }>;
  contributors: Array<{ name: string; owls: number; is_manager: boolean }>;
  funded_assessments: Array<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: string | null;
  }>;
  /** Non-empty exactly when the mandate ingests: the pipeline view. */
  pipeline: SourcePipelineRow[];
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
  if (!["active", "completed", "cancelled"].includes(row.status)) return null;

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

  const items = (row.plan?.items ?? []).map((item, i) => ({
    ...item,
    state: (i < row.plan_cursor
      ? "done"
      : i === row.plan_cursor
        ? "current"
        : "queued") as "done" | "current" | "queued",
  }));

  const hasIngest = items.some((i) => i.action === "ingest");
  const pipeline = hasIngest ? await getMandatePipeline(row.id) : [];

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
    notes: row.mandate?.notes ?? null,
    scope_claim_id: row.scope_claim_id,
    scope_query: row.scope_query,
    budget_status: row.job_status,
    funded_by_mandates: edges.fundedBy,
    regrants_out: edges.fundsOut,
    last_review: lastReview ?? null,
    plan_items: items,
    contributors: contributions.map((c) => ({
      name:
        row.is_platform && c.userId === row.funder_user_id
          ? "Minerval"
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
    ...(isManager
      ? { is_manager: true, ...(conversationId ? { conversation_id: conversationId } : {}) }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// The allocation view — how THIS mandate is judging and funding the open
// actions. The EV/EC computation belongs to the mandates, so this renders
// on their pages: the General assessment mandate's view is the canonical
// global one, and every scoped mandate gets the identical section over its
// scope. Aggregation first (kind tiles, a value-per-owl histogram with the
// day's bar marked), drill-down on demand (top actions per kind, paged),
// tail summarized, never enumerated — transparency through navigability.
// ---------------------------------------------------------------------------

export interface AllocationKindTile {
  kind: string;
  /** Open exclusion groups of this kind (each = one thing that could happen). */
  candidates: number;
  /** Groups this mandate has valued (its judgment layer knows them). */
  valued: number;
  /** Groups whose allocations already cover some variant: they will run. */
  covered: number;
  /** This mandate's outstanding (unspent, unreleased) allocations, owls. */
  allocated_owls: number;
  /** Sum of each group's cheapest-variant cost: the price of doing it all. */
  est_total_cost_owls: number;
}

export interface AllocationActionRow {
  action_id: string;
  kind: string;
  variant: string;
  claim_id: string | null;
  label: string;
  value_est: number;
  cost_owls: number;
  value_per_owl: number;
  backing_owls: number;
  covered: boolean;
  my_allocation_owls: number;
  /** For a dearer variant: the marginal ratio Δvalue/Δcost vs. the
   * cheapest sibling — the number that decides whether the upgrade is
   * worth buying. Null on the cheapest variant. */
  marginal_ratio: number | null;
}

export interface MandateAllocationView {
  grant_id: string;
  title: string;
  policy: Record<string, number>;
  budget: {
    escrow_owls: number;
    spent_owls: number;
    daily_rate_owls: number;
    allocated_today_owls: number;
    /** Value-per-owl of the weakest increment funded today: the emergent bar. */
    today_bar: number | null;
  };
  kinds: AllocationKindTile[];
  /** Value-per-owl distribution over the mandate's valued actions. */
  histogram: Array<{ min: number; max: number; count: number }>;
  top: AllocationActionRow[];
  /** Valued actions not shown in `top` (the tail is summarized, not listed). */
  more: number;
}

const HISTOGRAM_BUCKETS = 8;

/**
 * Assemble one mandate's allocation view. `kind` filters the drill-down
 * list (tiles always cover every kind); `offset`/`limit` page it.
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
    daily_budget_micro_usd: number;
    budget_micro_usd: number;
  }>(
    `SELECT g.id, g.name, g.mandate->>'title' AS title, g.budget_job_id,
            g.daily_budget_micro_usd, j.budget_micro_usd
       FROM grants g JOIN budget_jobs j ON j.id = g.budget_job_id
      WHERE g.id = $1 AND g.status = 'active'`,
    [grantId]
  );
  if (!grant) return null;

  const { getMandateAllocationPolicy } = await import(
    "./allocation-policy-service.js"
  );
  const policy = await getMandateAllocationPolicy(grantId);

  // Spend + today's placements + the day's emergent bar.
  const [jobSpent, exposure] = await Promise.all([
    getJobSpentMicroUsd(grant.budget_job_id),
    grantAllocationExposureMicroUsd(grantId),
  ]);
  const [today] = await rawQuery<{ placed: number; bar: number | null }>(
    `SELECT COALESCE(SUM(al.amount_micro_usd), 0)::bigint AS placed,
            MIN(mv.value_est /
                GREATEST(0.001, a.cost_est_micro_usd / 1000000.0)) AS bar
       FROM action_allocations al
       LEFT JOIN actions a ON a.exclusion_group = al.exclusion_group
        AND (al.action_id = a.id OR (al.action_id IS NULL
             AND a.cost_est_micro_usd = (SELECT MIN(x.cost_est_micro_usd)
                                           FROM actions x
                                          WHERE x.exclusion_group = a.exclusion_group
                                            AND x.status = 'open')))
       LEFT JOIN mandate_valuations mv
         ON mv.action_id = a.id AND mv.grant_id = al.grant_id
      WHERE al.grant_id = $1
        AND al.created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
    [grantId]
  );

  // Kind tiles over the whole open ledger, with this mandate's judgment
  // and money joined in.
  const tiles = await rawQuery<{
    kind: string;
    candidates: number;
    valued: number;
    covered: number;
    my_micro: number;
    est_total_micro: number;
  }>(
    `WITH acts AS (
       SELECT a.id, a.kind, a.exclusion_group, a.cost_est_micro_usd,
              COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                          FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL
                           AND (al.action_id IS NULL OR al.action_id = a.id)),
                       0) AS coverage,
              COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                          FROM action_allocations al
                         WHERE al.exclusion_group = a.exclusion_group
                           AND al.released_at IS NULL AND al.grant_id = $1
                           AND (al.action_id IS NULL OR al.action_id = a.id)),
                       0) AS mine,
              (mv.action_id IS NOT NULL) AS valued
         FROM actions a
         LEFT JOIN mandate_valuations mv
           ON mv.action_id = a.id AND mv.grant_id = $1
        WHERE a.status = 'open'
     ),
     grps AS (
       SELECT kind, exclusion_group,
              MIN(cost_est_micro_usd) AS min_cost,
              BOOL_OR(coverage >= cost_est_micro_usd) AS covered,
              BOOL_OR(valued) AS valued,
              MAX(mine) AS mine
         FROM acts GROUP BY kind, exclusion_group
     )
     SELECT kind, COUNT(*)::int AS candidates,
            COUNT(*) FILTER (WHERE valued)::int AS valued,
            COUNT(*) FILTER (WHERE covered)::int AS covered,
            COALESCE(SUM(mine), 0)::bigint AS my_micro,
            COALESCE(SUM(min_cost), 0)::bigint AS est_total_micro
       FROM grps GROUP BY kind ORDER BY candidates DESC`,
    [grantId]
  );

  // Value-per-owl histogram over the valued actions (cheapest variant per
  // group, so an action counts once).
  const hist = await rawQuery<{ bucket: number; count: number }>(
    `WITH ratios AS (
       SELECT mv.value_est /
              GREATEST(0.001, a.cost_est_micro_usd / 1000000.0) AS ratio
         FROM mandate_valuations mv
         JOIN actions a ON a.id = mv.action_id AND a.status = 'open'
        WHERE mv.grant_id = $1
          AND a.cost_est_micro_usd = (SELECT MIN(x.cost_est_micro_usd)
                                        FROM actions x
                                       WHERE x.exclusion_group = a.exclusion_group
                                         AND x.status = 'open')
     ),
     bounds AS (SELECT GREATEST(0.01, MAX(ratio)) AS max_ratio FROM ratios)
     SELECT width_bucket(r.ratio, 0, b.max_ratio * 1.0001, $2::int) AS bucket,
            COUNT(*)::int AS count
       FROM ratios r, bounds b
      GROUP BY bucket ORDER BY bucket`,
    [grantId, HISTOGRAM_BUCKETS]
  );
  const [{ max_ratio: maxRatio } = { max_ratio: 0 }] = await rawQuery<{
    max_ratio: number;
  }>(
    `SELECT COALESCE(MAX(mv.value_est /
              GREATEST(0.001, a.cost_est_micro_usd / 1000000.0)), 0)
              AS max_ratio
       FROM mandate_valuations mv
       JOIN actions a ON a.id = mv.action_id AND a.status = 'open'
      WHERE mv.grant_id = $1`,
    [grantId]
  );
  const bucketWidth = Math.max(0.01, Number(maxRatio)) / HISTOGRAM_BUCKETS;
  const histogram = Array.from({ length: HISTOGRAM_BUCKETS }, (_, i) => ({
    min: Math.round(i * bucketWidth * 100) / 100,
    max: Math.round((i + 1) * bucketWidth * 100) / 100,
    count: 0,
  }));
  for (const row of hist) {
    const i = Math.min(HISTOGRAM_BUCKETS, Math.max(1, Number(row.bucket))) - 1;
    histogram[i]!.count += Number(row.count);
  }

  // Drill-down: this mandate's best-ranked actions, paged, tail counted.
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const kindFilter = opts.kind ? `AND a.kind = $4` : "";
  const params: unknown[] = [grantId, limit, offset];
  if (opts.kind) params.push(opts.kind);
  const top = await rawQuery<{
    action_id: string;
    kind: string;
    variant: string;
    claim_id: string | null;
    label: string;
    value_est: number;
    cost_est_micro_usd: number;
    coverage: number;
    mine: number;
    base_value: number;
    base_cost: number;
    total: number;
  }>(
    `SELECT a.id AS action_id, a.kind, a.variant, a.claim_id, a.label,
            mv.value_est, a.cost_est_micro_usd,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL
                         AND (al.action_id IS NULL OR al.action_id = a.id)),
                     0)::bigint AS coverage,
            COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                        FROM action_allocations al
                       WHERE al.exclusion_group = a.exclusion_group
                         AND al.released_at IS NULL AND al.grant_id = $1
                         AND (al.action_id IS NULL OR al.action_id = a.id)),
                     0)::bigint AS mine,
            (SELECT mv2.value_est FROM mandate_valuations mv2
               JOIN actions x ON x.id = mv2.action_id
              WHERE mv2.grant_id = $1
                AND x.exclusion_group = a.exclusion_group
              ORDER BY x.cost_est_micro_usd ASC LIMIT 1) AS base_value,
            (SELECT x.cost_est_micro_usd FROM actions x
              WHERE x.exclusion_group = a.exclusion_group
                AND x.status = 'open'
              ORDER BY x.cost_est_micro_usd ASC LIMIT 1) AS base_cost,
            COUNT(*) OVER ()::int AS total
       FROM mandate_valuations mv
       JOIN actions a ON a.id = mv.action_id
      WHERE mv.grant_id = $1 AND a.status = 'open' ${kindFilter}
      ORDER BY mv.value_est / GREATEST(1000, a.cost_est_micro_usd) DESC
      LIMIT $2 OFFSET $3`,
    params
  );
  const total = Number(top[0]?.total ?? 0);
  const topRows: AllocationActionRow[] = top.map((r) => {
    const costOwls = microUsdToOwls(Number(r.cost_est_micro_usd));
    const isBase = Number(r.cost_est_micro_usd) <= Number(r.base_cost ?? 0);
    const dCost = Number(r.cost_est_micro_usd) - Number(r.base_cost ?? 0);
    const dValue = Number(r.value_est) - Number(r.base_value ?? 0);
    return {
      action_id: r.action_id,
      kind: r.kind,
      variant: r.variant,
      claim_id: r.claim_id,
      label: r.label,
      value_est: Math.round(Number(r.value_est) * 1000) / 1000,
      cost_owls: costOwls,
      value_per_owl:
        costOwls > 0
          ? Math.round((Number(r.value_est) / costOwls) * 100) / 100
          : 0,
      backing_owls: microUsdToOwls(Number(r.coverage)),
      covered: Number(r.coverage) >= Number(r.cost_est_micro_usd),
      my_allocation_owls: microUsdToOwls(Number(r.mine)),
      marginal_ratio:
        !isBase && dCost > 0
          ? Math.round((dValue / microUsdToOwls(dCost)) * 100) / 100
          : null,
    };
  });

  const escrow = Number(grant.budget_micro_usd);
  const spent = jobSpent + exposure.spentMicroUsd;
  return {
    grant_id: grantId,
    title: grant.title ?? grant.name,
    policy: policy as unknown as Record<string, number>,
    budget: {
      escrow_owls: microUsdToOwls(escrow),
      spent_owls: microUsdToOwls(Math.min(spent, escrow)),
      daily_rate_owls: microUsdToOwls(Number(grant.daily_budget_micro_usd)),
      allocated_today_owls: microUsdToOwls(Number(today?.placed ?? 0)),
      today_bar:
        today?.bar != null ? Math.round(Number(today.bar) * 100) / 100 : null,
    },
    kinds: tiles.map((t) => ({
      kind: t.kind,
      candidates: Number(t.candidates),
      valued: Number(t.valued),
      covered: Number(t.covered),
      allocated_owls: microUsdToOwls(Number(t.my_micro)),
      est_total_cost_owls: microUsdToOwls(Number(t.est_total_micro)),
    })),
    histogram,
    top: topRows,
    more: Math.max(0, total - offset - topRows.length),
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
