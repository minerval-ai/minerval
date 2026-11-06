/**
 * The open ledger as a mandate's Grantmaker sees it.
 *
 * A Grantmaker thinks in territory: these questions, this subtree, this
 * topic. The ledger is rows. This module joins the two:
 *
 *  - openActionsForNodes: the open actions on a set of nodes, so every graph
 *    read a Grantmaker makes (search, a node, a decomposition, dependents, a
 *    survey) can carry, on each node, the work it could fund there and what
 *    is left to fund of it (annotateOpenActions).
 *  - listOpenActions: the whole open ledger, filtered by territory (meaning,
 *    a tag, a subtree, node kind, assessment state) and by money (unfunded
 *    only, a cost ceiling, valued or not by this mandate), in the order a
 *    funder needs (value per owl, the gap left to fund, importance,
 *    contestation, staleness).
 *
 * Every figure is from the ledger and the mandate's own valuations; nothing
 * here values anything.
 */
import { rawQuery } from "../db/client.js";

const owls = (micro: unknown): number => Math.round(Number(micro ?? 0) / 1000) / 1000;

/** What a row's funders have put on it and not yet spent, per action. */
const BACKING_SQL = `COALESCE((SELECT SUM(al.amount_micro_usd - al.spent_micro_usd)
                       FROM action_allocations al
                      WHERE al.exclusion_group = a.exclusion_group
                        AND al.released_at IS NULL
                        AND (al.action_id IS NULL OR al.action_id = a.id)), 0)`;

/** When a node was last assessed, whatever its kind. */
const ASSESSED_AT_SQL = `GREATEST(
   (SELECT MAX(x.assessed_at) FROM assessments x WHERE x.claim_id = c.id AND x.is_current = true),
   (SELECT MAX(q.assessed_at) FROM quantity_estimates q WHERE q.claim_id = c.id AND q.is_current = true),
   (SELECT MAX(qa.assessed_at) FROM question_assessments qa WHERE qa.claim_id = c.id AND qa.is_current = true))`;

export interface NodeOpenAction {
  action_id: string;
  kind: string;
  variant: string;
  cost_owls: number;
  backing_owls: number;
  /** What is left to fund before the row runs. */
  gap_owls: number;
  /** This mandate's valuation, when it holds one. */
  my_value: number | null;
}

/** The open actions on each of these nodes, from this mandate's point of view. */
export async function openActionsForNodes(
  nodeIds: readonly string[],
  grantId: string
): Promise<Map<string, NodeOpenAction[]>> {
  const ids = [...new Set(nodeIds)].filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  const out = new Map<string, NodeOpenAction[]>();
  if (ids.length === 0) return out;
  const rows = await rawQuery<{
    claim_id: string;
    action_id: string;
    kind: string;
    variant: string;
    cost: string;
    backing: string;
    my_value: number | null;
  }>(
    `SELECT a.claim_id, a.id AS action_id, a.kind, a.variant,
            a.cost_est_micro_usd AS cost, ${BACKING_SQL} AS backing,
            mv.value_est AS my_value
       FROM actions a
       LEFT JOIN mandate_valuations mv ON mv.action_id = a.id AND mv.grant_id = $2
      WHERE a.status = 'open' AND a.claim_id = ANY($1::uuid[])
      ORDER BY a.kind, a.variant`,
    [ids, grantId]
  );
  for (const r of rows) {
    const cost = owls(r.cost);
    const backing = owls(r.backing);
    const list = out.get(r.claim_id) ?? [];
    list.push({
      action_id: r.action_id,
      kind: r.kind,
      variant: r.variant,
      cost_owls: cost,
      backing_owls: backing,
      gap_owls: Math.max(0, Math.round((cost - backing) * 1000) / 1000),
      my_value: r.my_value == null ? null : Number(r.my_value),
    });
    out.set(r.claim_id, list);
  }
  return out;
}

type Json = Record<string, unknown>;

/** The node objects in a graph read's result, by tool. */
function nodesIn(tool: string, payload: Json): Json[] {
  const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]).filter((x) => x && typeof x === "object") : []);
  switch (tool) {
    case "search_claims":
      return list(payload.results);
    case "survey_scope":
      return list(payload.claims);
    case "get_claim": {
      const nodes: Json[] = [];
      if (payload.claim && typeof payload.claim === "object") nodes.push(payload.claim as Json);
      // `dependents` is one page of nodes, with `dependents_total` beside it.
      nodes.push(...list(payload.dependents));
      return nodes;
    }
    case "get_decomposition": {
      const nodes: Json[] = [];
      const walk = (n: unknown) => {
        if (!n || typeof n !== "object") return;
        nodes.push(n as Json);
        for (const c of list((n as Json).children)) walk(c);
      };
      walk(payload.tree);
      return nodes;
    }
    case "get_dependents":
      return list(payload.dependents);
    default:
      return [];
  }
}

/**
 * Put each node's open actions on a graph read's result, for a mandate's
 * Grantmaker: the work it could fund there, with what is left to fund. A
 * node with none carries nothing extra. Returns the result unchanged for a
 * tool that reads no nodes, or a result that is not JSON.
 */
export async function annotateOpenActions(tool: string, result: string, grantId: string): Promise<string> {
  let payload: Json;
  try {
    payload = JSON.parse(result) as Json;
  } catch {
    return result;
  }
  const nodes = nodesIn(tool, payload);
  const ids = nodes.map((n) => String(n.id ?? "")).filter(Boolean);
  if (ids.length === 0) return result;
  const actions = await openActionsForNodes(ids, grantId);
  if (actions.size === 0) return result;
  for (const n of nodes) {
    const open = actions.get(String(n.id ?? ""));
    if (open) n.open_actions = open;
  }
  return JSON.stringify(payload);
}

export interface ListOpenActionsInput {
  grantId: string;
  /** Meaning and keyword, over the nodes' text and every row's label. */
  query?: string | null;
  /** A topic tag's slug: only actions on nodes carrying it. */
  tag?: string | null;
  /** A node id: only actions on it and the nodes beneath it. */
  within?: string | null;
  /** How many levels beneath `within` to reach (default 3, at most 6). */
  withinDepth?: number;
  kind?: string | null;
  nodeKind?: "claim" | "quantity" | "question" | null;
  assessed?: "any" | "assessed" | "unassessed";
  /** Only rows whose backing does not yet cover their cost. */
  unfundedOnly?: boolean;
  maxCostOwls?: number | null;
  /** Rows this mandate has valued, or has not. */
  valued?: "any" | "mine" | "not_mine";
  /** Kept for callers of the older signature: the same as valued "mine". */
  valuedOnly?: boolean;
  order?: "my_value" | "value_per_owl" | "gap" | "importance" | "contestation" | "stale" | "relevance";
  offset?: number;
  limit?: number;
}

export interface OpenActionRow {
  action_id: string;
  kind: string;
  variant: string;
  exclusion_group: string;
  label: string;
  claim_id: string | null;
  node_kind: string | null;
  node_text: string | null;
  tags: string[];
  cost_owls: number;
  backing_owls: number;
  gap_owls: number;
  my_value: number | null;
  importance: number | null;
  contestation: number | null;
  days_since_assessed: number | null;
  /** The other ways of doing the same thing (at most one of them runs). */
  alternatives: Array<{ action_id: string; variant: string; cost_owls: number }>;
  /** What a curate, request, or consistency_sweep row is about. */
  about: string | null;
}

/**
 * Browse the open ledger from one mandate's point of view, by territory and
 * by money. `total` counts every row the filters admit.
 */
export async function listOpenActions(
  input: ListOpenActionsInput
): Promise<{ total: number; offset: number; next_offset: number | null; actions: OpenActionRow[]; note?: string }> {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (input.within && !uuid.test(input.within)) {
    return { total: 0, offset: 0, next_offset: null, actions: [], note: "within must be a full node id, as a tool result gave it" };
  }
  const limit = Math.min(50, Math.max(1, Math.floor(Number(input.limit ?? 25)) || 25));
  const offset = Math.max(0, Math.floor(Number(input.offset ?? 0)) || 0);
  const query = input.query?.trim() || null;

  // Meaning: the nodes a hybrid search ranks for the query, in rank order.
  let ranked: string[] | null = null;
  if (query) {
    // Loaded on demand: the valuer re-exports this module, and its importers
    // should not pull the search stack in at load.
    const { hybridSearch } = await import("./search-service.js");
    const { results } = await hybridSearch(query, { limit: 200 }).catch(() => ({ results: [] as { id: string }[] }));
    ranked = results.map((r) => r.id);
  }
  let tagId: string | null = null;
  if (input.tag?.trim()) {
    const { resolveTagBySlug } = await import("./tag-service.js");
    const tag = await resolveTagBySlug(input.tag.trim());
    if (!tag) return { total: 0, offset, next_offset: null, actions: [], note: `no tag "${input.tag}"` };
    tagId = tag.id;
  }
  const valued = input.valued ?? (input.valuedOnly ? "mine" : "any");
  const order = input.order ?? (query ? "relevance" : "my_value");
  const orderBy: Record<NonNullable<ListOpenActionsInput["order"]>, string> = {
    relevance: "rank NULLS LAST, my_value DESC NULLS LAST",
    my_value: "my_value DESC NULLS LAST, importance DESC NULLS LAST",
    value_per_owl: "(COALESCE(my_value, 0) / GREATEST(cost, 1)) DESC, importance DESC NULLS LAST",
    gap: "GREATEST(cost - backing, 0) DESC",
    importance: "importance DESC NULLS LAST, contestation DESC NULLS LAST",
    contestation: "contestation DESC NULLS LAST, importance DESC NULLS LAST",
    stale: "assessed_at ASC NULLS FIRST, importance DESC NULLS LAST",
  };
  const depth = Math.min(6, Math.max(0, Math.floor(Number(input.withinDepth ?? 3)) || 0));

  const rows = await rawQuery<Record<string, unknown> & { total: number }>(
    `WITH RECURSIVE beneath(id, d) AS (
       SELECT $3::uuid, 0 WHERE $3::uuid IS NOT NULL
       UNION
       SELECT cr.child_claim_id, b.d + 1
         FROM claim_relationships cr JOIN beneath b ON cr.parent_claim_id = b.id
        WHERE b.d < $4
     ),
     rows AS (
       SELECT a.id AS action_id, a.kind, a.variant, a.exclusion_group, a.label, a.claim_id,
              a.target_ref,
              c.kind AS node_kind, LEFT(c.text, 280) AS node_text,
              c.importance, c.contestation,
              a.cost_est_micro_usd AS cost,
              ${BACKING_SQL} AS backing,
              mv.value_est AS my_value,
              CASE WHEN c.id IS NULL THEN NULL ELSE ${ASSESSED_AT_SQL} END AS assessed_at,
              array_position($1::uuid[], a.claim_id) AS rank
         FROM actions a
         LEFT JOIN claims c ON c.id = a.claim_id
         LEFT JOIN mandate_valuations mv ON mv.action_id = a.id AND mv.grant_id = $2
        WHERE a.status = 'open'
          AND ($5::text IS NULL OR a.kind = $5)
          AND ($6::text IS NULL OR c.kind = $6)
          AND ($3::uuid IS NULL OR a.claim_id IN (SELECT id FROM beneath))
          AND ($7::uuid IS NULL OR EXISTS (
                SELECT 1 FROM taggings t
                 WHERE t.subject_kind = 'claim' AND t.subject_id = a.claim_id AND t.tag_id = $7)
               -- A sweep of the tag's own partition (#831).
               OR (a.kind = 'consistency_sweep' AND a.target_ref = $7::text))
          AND ($8::text IS NULL
               OR a.claim_id = ANY($1::uuid[])
               OR a.label ILIKE '%' || $8 || '%')
     )
     SELECT r.*, COUNT(*) OVER()::int AS total,
            (SELECT COALESCE(array_agg(tg.slug ORDER BY tg.slug), '{}')
               FROM taggings t JOIN tags tg ON tg.id = t.tag_id
              WHERE t.subject_kind = 'claim' AND t.subject_id = r.claim_id) AS tags,
            (SELECT COALESCE(json_agg(json_build_object(
                      'action_id', o.id, 'variant', o.variant, 'cost', o.cost_est_micro_usd)), '[]'::json)
               FROM actions o
              WHERE o.exclusion_group = r.exclusion_group AND o.id <> r.action_id
                AND o.status = 'open') AS alternatives,
            CASE r.kind
              WHEN 'curate' THEN COALESCE(
                                   (SELECT string_agg(LEFT(q.concern, 200), ' | ')
                                      FROM curation_requests q
                                     WHERE q.anchor_claim_id = r.claim_id AND q.consumed_at IS NULL),
                                   -- A request the Curator keeps (#722).
                                   (SELECT LEFT(rq.ask, 300) FROM requests rq
                                     WHERE r.claim_id IS NULL AND rq.id::text = r.target_ref))
              WHEN 'request' THEN (SELECT LEFT(rq.ask, 300) FROM requests rq
                                    WHERE rq.id::text = r.target_ref)
              -- A sweep (#831): which partition, and when it was last read.
              WHEN 'consistency_sweep' THEN
                'partition ' || COALESCE((SELECT 'tag ' || tg.slug FROM tags tg
                                           WHERE tg.id::text = r.target_ref),
                                         'residual (claims no sweepable tag covers)')
                || COALESCE('; last swept ' || to_char(
                     (SELECT MAX(cs.finished_at) FROM consistency_sweeps cs
                       WHERE cs.status = 'done'
                         AND ((r.target_ref = 'residual' AND cs.partition = 'residual')
                              OR cs.tag_id::text = r.target_ref)),
                     'YYYY-MM-DD'), '; never swept')
              ELSE NULL END AS about
       FROM rows r
      WHERE ($9::text = 'any'
             OR ($9::text = 'assessed' AND r.assessed_at IS NOT NULL)
             OR ($9::text = 'unassessed' AND r.claim_id IS NOT NULL AND r.assessed_at IS NULL))
        AND ($10::boolean IS NOT TRUE OR r.backing < r.cost)
        AND ($11::bigint IS NULL OR r.cost <= $11)
        AND ($12::text = 'any'
             OR ($12::text = 'mine' AND r.my_value IS NOT NULL)
             OR ($12::text = 'not_mine' AND r.my_value IS NULL))
      ORDER BY ${orderBy[order]}, r.action_id
      LIMIT $13 OFFSET $14`,
    [
      ranked ?? [],
      input.grantId,
      input.within || null,
      depth,
      input.kind || null,
      input.nodeKind || null,
      tagId,
      query,
      input.assessed ?? "any",
      input.unfundedOnly === true,
      input.maxCostOwls != null && Number.isFinite(Number(input.maxCostOwls))
        ? Math.round(Number(input.maxCostOwls) * 1_000_000)
        : null,
      valued,
      limit,
      offset,
    ]
  );
  const total = Number(rows[0]?.total ?? 0);
  const actions: OpenActionRow[] = rows.map((r) => {
    const cost = owls(r.cost);
    const backing = owls(r.backing);
    return {
      action_id: String(r.action_id),
      kind: String(r.kind),
      variant: String(r.variant),
      exclusion_group: String(r.exclusion_group),
      label: String(r.label),
      claim_id: (r.claim_id as string | null) ?? null,
      node_kind: (r.node_kind as string | null) ?? null,
      node_text: (r.node_text as string | null) ?? null,
      tags: (r.tags as string[] | null) ?? [],
      cost_owls: cost,
      backing_owls: backing,
      gap_owls: Math.max(0, Math.round((cost - backing) * 1000) / 1000),
      my_value: r.my_value == null ? null : Number(r.my_value),
      importance: r.importance == null ? null : Number(r.importance),
      contestation: r.contestation == null ? null : Number(r.contestation),
      days_since_assessed:
        r.assessed_at == null
          ? null
          : Math.floor((Date.now() - new Date(r.assessed_at as string).getTime()) / 86_400_000),
      alternatives: ((r.alternatives as Array<{ action_id: string; variant: string; cost: number }>) ?? []).map(
        (o) => ({ action_id: o.action_id, variant: o.variant, cost_owls: owls(o.cost) })
      ),
      about: (r.about as string | null) ?? null,
    };
  });
  const next = offset + actions.length < total ? offset + actions.length : null;
  return { total, offset, next_offset: next, actions };
}
