/**
 * How much of a single object a read carries, for the reads that hold long
 * lists: a mandate (GET /mandates/:id) and a grant (GET /grants/:id). The
 * plan's items are paged and filtered by state; every other list is cut to
 * `list_limit`; `collections` says how long each is whole. `fields` (the
 * partial-response plugin) still prunes whatever comes back.
 */
import { PLAN_ITEM_STATES, type PlanItemCounts, type PlanItemState } from "./plan-state.js";
import type { MandateDetail } from "./mandate-service.js";

/**
 * How much of a single mandate (or grant) a read carries. `summary`, the
 * default, pages the plan's items and cuts every other list to `list_limit`,
 * saying in `collections` how long each is; `full` is everything, as the
 * mandate's page renders it. A mandate with a plan of a hundred items, its
 * pipeline and its lookouts was more than an agent's tool result holds.
 */
export const READ_DETAILS = ["summary", "full"] as const;
export type ReadDetail = (typeof READ_DETAILS)[number];

export interface DetailOptions {
  detail?: ReadDetail;
  /** The first plan item to return (0-based). */
  items_offset?: number;
  /** How many plan items to return. */
  items_limit?: number;
  /** Only plan items in this state. */
  items_state?: PlanItemState;
  /** How many rows of each other list to return. */
  list_limit?: number;
}

export const DEFAULT_ITEMS_LIMIT = 20;
export const MAX_ITEMS_LIMIT = 500;
export const DEFAULT_LIST_LIMIT = 10;
export const MAX_LIST_LIMIT = 200;

/** The querystring a summarized read takes, for a route schema. */
export const DETAIL_QUERY_PROPERTIES = {
  detail: {
    type: "string",
    enum: [...READ_DETAILS],
    default: "summary",
    description:
      "summary (the default): the plan's items a page at a time and every other list cut to " +
      "list_limit, with `collections` giving each list's full length; full: everything, as the " +
      "site renders it.",
  },
  items_offset: { type: "integer", minimum: 0, default: 0, description: "The plan item to start from (0-based)." },
  items_limit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_ITEMS_LIMIT,
    default: DEFAULT_ITEMS_LIMIT,
    description: "How many plan items to return.",
  },
  items_state: {
    type: "string",
    enum: ["done", "current", "queued", "waiting", "blocked", "cancelled"],
    description: "Only plan items in this state (each item's `state`).",
  },
  list_limit: {
    type: "integer",
    minimum: 1,
    maximum: MAX_LIST_LIMIT,
    default: DEFAULT_LIST_LIMIT,
    description: "How many rows of each other list (contributors, funded assessments, pipeline, lookouts…) to return.",
  },
} as const;

/** One list's length, and how much of it the read carries. */
export interface CollectionSize {
  total: number;
  returned: number;
  offset?: number;
}

/**
 * A page of a plan's items, as a summarized read returns it: the page, and
 * how the whole plan stands. Items keep their `index` in the plan.
 */
export function pagePlanItems<T extends { state?: PlanItemState }>(
  items: readonly T[],
  opts: DetailOptions
): { items: T[]; size: CollectionSize } {
  if ((opts.detail ?? "summary") === "full") {
    return { items: [...items], size: { total: items.length, returned: items.length, offset: 0 } };
  }
  const filtered = opts.items_state ? items.filter((i) => i.state === opts.items_state) : items;
  const offset = Math.max(0, opts.items_offset ?? 0);
  const limit = Math.min(MAX_ITEMS_LIMIT, Math.max(1, opts.items_limit ?? DEFAULT_ITEMS_LIMIT));
  const page = filtered.slice(offset, offset + limit);
  return { items: page, size: { total: filtered.length, returned: page.length, offset } };
}

/** The first `list_limit` of a list, or all of it in full detail. */
export function cutList<T>(list: readonly T[], opts: DetailOptions): { list: T[]; size: CollectionSize } {
  if ((opts.detail ?? "summary") === "full") return { list: [...list], size: { total: list.length, returned: list.length } };
  const limit = Math.min(MAX_LIST_LIMIT, Math.max(1, opts.list_limit ?? DEFAULT_LIST_LIMIT));
  const cut = list.slice(0, limit);
  return { list: cut, size: { total: list.length, returned: cut.length } };
}

/** How many described items sit in each state, as countPlanItems counts a raw plan. */
export function countStates(items: ReadonlyArray<{ state: PlanItemState }>): PlanItemCounts {
  const counts = { total: items.length } as PlanItemCounts;
  for (const st of PLAN_ITEM_STATES) counts[st] = 0;
  for (const item of items) counts[item.state]++;
  return counts;
}

/**
 * How much of each mandate a list row carries. A list of fifty mandates with
 * their whole objectives and funder disclosures was more than an agent's
 * tool result holds, and it cut them off; the compact row is what choosing
 * one needs, and get_mandate has the rest.
 */
export const MANDATE_LIST_DETAILS = ["compact", "full"] as const;
export type MandateListDetail = (typeof MANDATE_LIST_DETAILS)[number];

const DETAIL_NOTE =
  "Summary: the plan's items a page at a time (items_offset, items_limit, items_state) and each " +
  "other list cut to list_limit; `collections` gives each list's whole length. detail=full for " +
  "everything. Completed work is paged whole by get_mandate_work.";

/**
 * A mandate's read shaped by `opts`: in summary, its plan items paged and
 * its other lists cut, with `plan_item_counts` and `collections` saying what
 * the whole holds. The lists the route adds (attempts, the prizes'
 * bounties) are cut the same way.
 */
export function shapeMandateDetail<M extends MandateDetail & { attempts?: unknown[]; prizes?: unknown }>(
  mandate: M,
  opts: DetailOptions
): M & { detail: ReadDetail; plan_item_counts: PlanItemCounts; collections: Record<string, CollectionSize>; detail_note?: string } {
  const detail = opts.detail ?? "summary";
  const counts = countStates(mandate.plan_items ?? []);
  const plan = pagePlanItems(mandate.plan_items ?? [], opts);
  const lists = ["contributors", "funded_assessments", "pipeline", "lookouts", "correspondents", "funded_by_mandates", "regrants_out", "attempts"] as const;
  const collections: Record<string, CollectionSize> = { plan_items: plan.size };
  const out = { ...mandate, plan_items: plan.items } as unknown as Record<string, unknown>;
  for (const key of lists) {
    const value = (mandate as Record<string, unknown>)[key];
    if (!Array.isArray(value)) continue;
    const cut = cutList(value, opts);
    out[key] = cut.list;
    collections[key] = cut.size;
  }
  const prizes = mandate.prizes as { bounties?: unknown[] } | null | undefined;
  if (prizes && Array.isArray(prizes.bounties)) {
    const cut = cutList(prizes.bounties, opts);
    out.prizes = { ...prizes, bounties: cut.list };
    collections.bounties = cut.size;
  }
  return {
    ...(out as M),
    detail,
    plan_item_counts: counts,
    collections,
    ...(detail === "summary" ? { detail_note: DETAIL_NOTE } : {}),
  };
}
