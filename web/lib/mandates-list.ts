// What the Mandates list works out from its address: which mandates, in
// which state, in what order, on which page. Pure, so it is tested without
// a page (tests/unit/web/mandates-list.test.ts). account-api is server-only,
// so only its types are imported here.

import type { MandateListRow, MandateListState, MandateOrder, MandateScope } from "./account-api";

export const MANDATES_PER_PAGE = 25;

export interface MandatesView {
  scope: MandateScope;
  state: MandateListState;
  order: MandateOrder | null;
  q: string;
  page: number;
}

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

const STATES: readonly MandateListState[] = ["any", "active", "paused", "finished", "needs_you"];
const ORDERS: readonly MandateOrder[] = ["budget", "recent", "newest", "backers", "needs_you"];

/**
 * The list an address asks for. With no scope named, a signed-in reader who
 * has mandates of their own starts on theirs, and everyone else on
 * everyone's. `needs_you` is the manager's alone.
 */
export function mandatesView(query: Query, signedIn: boolean, ownCount: number | null = null): MandatesView {
  const asked = one(query.show);
  const scope: MandateScope =
    asked === "mine" && signedIn
      ? "mine"
      : asked === "platform" || asked === "all"
        ? asked
        : signedIn && (ownCount ?? 0) > 0
          ? "mine"
          : "all";
  const state = one(query.state) as MandateListState | undefined;
  const order = one(query.order) as MandateOrder | undefined;
  const page = Number(one(query.page));
  return {
    scope,
    state: state && STATES.includes(state) && (state !== "needs_you" || scope === "mine") ? state : "any",
    order: order && ORDERS.includes(order) && (order !== "needs_you" || scope === "mine") ? order : null,
    q: (one(query.q) ?? "").trim().slice(0, 200),
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/**
 * The list's address with `change` applied. The scope is always named, so a
 * link says which list it opens whatever the reader's own default is.
 * Changing which mandates are listed starts again from the first page, and
 * changing whose they are drops a narrowing that may not apply there.
 */
export function mandatesHref(view: MandatesView, change: Partial<MandatesView>): string {
  const next = { ...view, ...change };
  if (!("page" in change)) next.page = 1;
  if ("scope" in change && change.scope !== view.scope) {
    next.state = "any";
    next.order = null;
  }
  const q = new URLSearchParams({ show: next.scope });
  if (next.state !== "any") q.set("state", next.state);
  if (next.q) q.set("q", next.q);
  if (next.order) q.set("order", next.order);
  if (next.page > 1) q.set("page", String(next.page));
  return `/mandates?${q}`;
}

/** The states a scope can be narrowed by, in the order the page offers them. */
export function stateFilters(scope: MandateScope): Array<[MandateListState, string]> {
  return scope === "mine"
    ? [["any", "All"], ["needs_you", "Need you"], ["active", "Active"], ["finished", "Finished"]]
    : [["any", "All"], ["active", "Active"], ["paused", "Paused"], ["finished", "Finished"]];
}

/** The orders a scope offers, its default first. */
export function orderChoices(scope: MandateScope): Array<[MandateOrder, string]> {
  const shared: Array<[MandateOrder, string]> = [
    ["budget", "Largest budget"],
    ["recent", "Last changed"],
    ["newest", "Newest"],
    ["backers", "Most backers"],
  ];
  return scope === "mine" ? [["needs_you", "Needing you first"], ...shared] : shared;
}

/** How a mandate stands, as its chip says it. */
export function rowState(m: Pick<MandateListRow, "status" | "budget_status">): { key: string; label: string } {
  if (m.status === "active" && m.budget_status === "paused_budget") return { key: "paused", label: "paused: budget spent" };
  switch (m.status) {
    case "active":
      return { key: "active", label: "active" };
    case "pending_approval":
      return { key: "pending_approval", label: "plan to approve" };
    case "planning":
      return { key: "planning", label: "being drafted" };
    case "completed":
      return { key: "finished", label: "finished" };
    case "cancelled":
      return { key: "finished", label: "withdrawn" };
    default:
      return { key: m.status, label: m.status.replace(/_/g, " ") };
  }
}

/** Where a row's link leads, and what it says. */
export function rowAction(m: MandateListRow, mine: boolean): { href: string; label: string; urgent: boolean } {
  const page = `/mandates/${m.id}`;
  if (mine) {
    if (m.status === "pending_approval") return { href: page, label: "Read and approve →", urgent: true };
    if (m.status === "active" && m.budget_status === "paused_budget") return { href: page, label: "Top up →", urgent: true };
    if (m.status === "planning") return { href: page, label: "Keep drafting →", urgent: false };
    if (m.status === "active") return { href: `${page}#grantmaker`, label: "Its Grantmaker →", urgent: false };
    return { href: page, label: "Open →", urgent: false };
  }
  if (m.status === "active") return { href: `${page}#spending`, label: "Back it →", urgent: false };
  return { href: page, label: "Open →", urgent: false };
}
