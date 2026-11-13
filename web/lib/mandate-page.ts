// What the mandate page works out from what the API serves: which part of
// its long lists the address asks for, how a plan's actions group and fold,
// and how a standing order's state reads. Pure, so each is tested without a
// page (tests/unit/web/mandate-page.test.ts).

import type { MandateDetailView, MandateWorkCounts, MandateWorkKind } from "./account-api";

// account-api is server-only, so only its types are imported here.
const MANDATE_WORK_KINDS: readonly MandateWorkKind[] = ["assessments", "sources", "requests", "research", "proposals"];

// ---------------------------------------------------------------------------
// The address
// ---------------------------------------------------------------------------

/** Rows of completed work shown before "Show more", and on each page after it. */
export const WORK_FIRST = 25;
export const WORK_PAGE = 100;
/** Plan actions shown before "Show more". */
export const PLAN_FIRST = 12;
/** Agents of one role shown before the rest fold away. */
export const AGENTS_FIRST = 10;

export type PlanTab = "open" | "done" | "cancelled";
export type NodeFilter = "claim" | "question" | "quantity";

/** The part of the page's lists an address asks for. */
export interface MandatePageView {
  work: MandateWorkKind | "regrants";
  node: NodeFilter | null;
  order: "recent" | "importance";
  /** Whether the work list is opened to full pages. */
  full: boolean;
  /** The page of the opened work list, from 1. */
  page: number;
  plan: PlanTab;
  planAll: boolean;
}

type Query = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v);

export function mandatePageView(query: Query): MandatePageView {
  const work = one(query.work);
  const node = one(query.node);
  const plan = one(query.plan);
  const page = Number(one(query.wp));
  return {
    work:
      work === "regrants" || (MANDATE_WORK_KINDS as readonly string[]).includes(work ?? "")
        ? (work as MandatePageView["work"])
        : "assessments",
    node: node === "claim" || node === "question" || node === "quantity" ? node : null,
    order: one(query.order) === "importance" ? "importance" : "recent",
    full: one(query.all) === "1" || page > 1,
    page: Number.isInteger(page) && page > 1 ? page : 1,
    plan: plan === "done" || plan === "cancelled" ? plan : "open",
    planAll: one(query.pall) === "1",
  };
}

/**
 * The address of the page with `change` applied, anchored at a section.
 * Defaults are left out, so the plain page has the plain address. Changing
 * which work is listed starts its list again from the top.
 */
export function mandateHref(
  id: string,
  view: MandatePageView,
  change: Partial<MandatePageView>,
  anchor: string
): string {
  const next = { ...view, ...change };
  if ("work" in change || "node" in change || "order" in change) {
    if (!("page" in change)) next.page = 1;
    if (!("full" in change) && "work" in change) next.full = false;
  }
  if ("work" in change && change.work !== "assessments") next.node = null;
  if ("plan" in change && !("planAll" in change)) next.planAll = false;
  const q = new URLSearchParams();
  if (next.work !== "assessments") q.set("work", next.work);
  if (next.node) q.set("node", next.node);
  if (next.order !== "recent") q.set("order", next.order);
  if (next.page > 1) q.set("wp", String(next.page));
  else if (next.full) q.set("all", "1");
  if (next.plan !== "open") q.set("plan", next.plan);
  if (next.planAll) q.set("pall", "1");
  const qs = q.toString();
  return `/mandates/${id}${qs ? `?${qs}` : ""}#${anchor}`;
}

// ---------------------------------------------------------------------------
// Completed work
// ---------------------------------------------------------------------------

export interface WorkKindTab {
  key: MandatePageView["work"];
  label: string;
  count: number;
}

/**
 * The kinds of completed work, each with its whole count, in the order the
 * page offers them. A kind the mandate has none of is left out, except
 * assessments, which every mandate is expected to have and whose absence is
 * worth saying.
 */
export function workKindTabs(counts: MandateWorkCounts | null | undefined, regrants: number): WorkKindTab[] {
  const c = counts ?? {
    assessments: { nodes: 0, claims: 0, questions: 0, quantities: 0, passes: 0 },
    sources: 0,
    requests: 0,
    research: 0,
    proposals: 0,
    findings: 0,
  };
  const all: WorkKindTab[] = [
    { key: "assessments", label: "Assessments", count: c.assessments.nodes },
    { key: "sources", label: "Sources read", count: c.sources },
    { key: "requests", label: "Requests worked on", count: c.requests },
    { key: "research", label: "Research", count: c.research },
    { key: "proposals", label: "Nodes proposed", count: c.proposals },
    { key: "regrants", label: "Mandates funded", count: regrants },
  ];
  return all.filter((t) => t.key === "assessments" || t.count > 0);
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

type PlanItem = MandateDetailView["plan_items"][number];

/** Which tab an action is under. */
export function planTabOf(item: PlanItem): PlanTab {
  if (item.state === "done") return "done";
  if (item.state === "cancelled") return "cancelled";
  return "open";
}

/** How an action that has not finished stands, as the page's chip says it. */
export type Standing = "running" | "waiting" | "fault" | "blocked" | "planned";

const FAULT = /platform fault/i;

export function standingOf(item: PlanItem): Standing | null {
  switch (item.state) {
    case "current":
      return "running";
    case "blocked":
      return "blocked";
    case "waiting":
      // The ledger says in words why an order waits; one a platform fault
      // stopped is not waiting on the mandate's own money or pace.
      return FAULT.test(item.ledger?.reason ?? "") ? "fault" : "waiting";
    case "queued":
      return "planned";
    default:
      return null;
  }
}

export const STANDING_LABEL: Record<Standing, string> = {
  running: "running",
  waiting: "waiting",
  fault: "platform fault",
  blocked: "blocked",
  planned: "planned",
};

/** The actions that order a pass whole and wait their turn (docs/allocation.md, "Standing orders"). */
export function isStandingOrder(item: PlanItem): boolean {
  return item.action === "assess" || item.action === "reassess" || item.action === "deepen";
}

/** A standing order's tier and budget, as much of them as is known. */
export function orderTerms(item: PlanItem): string | null {
  if (!isStandingOrder(item)) return null;
  const tier = item.ledger?.order?.tier ?? item.variant ?? null;
  const owls = item.ledger?.order?.budget_owls ?? item.budget_owls ?? null;
  const parts = [
    tier ?? (item.state === "blocked" ? "no tier named" : null),
    owls != null ? `up to ${Number(owls.toFixed(2))} owls` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** What an action is aimed at, in words, when it is not a node to link to. */
export function planTarget(item: PlanItem): { text: string; claimId?: string; url?: string } {
  if (item.action === "ingest") return { text: item.url ?? "a source", url: item.url };
  if (item.action === "sweep") {
    return { text: item.partition === "residual" ? "the residual bucket" : `topic ${item.partition}` };
  }
  if (item.action === "propose") {
    return { text: `a new ${item.kind ?? "node"}: “${item.text ?? ""}”`, claimId: item.claim_id };
  }
  if (!item.claim_id) return { text: `the proposed node “${item.claim_ref ?? ""}”` };
  return { text: "", claimId: item.claim_id };
}

export interface PlanRow {
  item: PlanItem;
  /** How many identical actions this row stands for. */
  count: number;
}

/**
 * A tab's actions, with a run of identical ones folded into one row and a
 * count. A plan can hold dozens of the same sweep with the same reason and
 * the same state; twenty-seven identical lines say no more than one line
 * and "27". Only actions with no node of their own fold: two passes on two
 * claims are two things.
 */
export function planRows(items: PlanItem[], tab: PlanTab): PlanRow[] {
  const rows: PlanRow[] = [];
  const seen = new Map<string, PlanRow>();
  for (const item of items) {
    if (planTabOf(item) !== tab) continue;
    const foldable = item.action === "sweep" || item.action === "ingest";
    if (!foldable) {
      rows.push({ item, count: 1 });
      continue;
    }
    const key = [item.action, item.partition ?? "", item.url ?? "", item.rationale, item.state, item.ledger?.reason ?? ""].join("\u0000");
    const row = seen.get(key);
    if (row) row.count += 1;
    else {
      const fresh = { item, count: 1 };
      seen.set(key, fresh);
      rows.push(fresh);
    }
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Prose
// ---------------------------------------------------------------------------

/** Paragraphs of a text written with blank lines between them. */
export function paragraphs(text: string | null | undefined): string[] {
  return (text ?? "")
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** "the last day", "the last week", "the last 36 hours". */
export function windowWords(hours: number): string {
  if (hours === 24) return "the last 24 hours";
  if (hours === 168) return "the last week";
  return `the last ${hours} hours`;
}

/** "60 owls a day", "200 owls a week", "40 owls every 36 hours". */
export function paceWords(owls: number, hours: number): string {
  const n = Number(owls.toFixed(2));
  if (hours === 24) return `${n} owls a day`;
  if (hours === 168) return `${n} owls a week`;
  return `${n} owls every ${hours} hours`;
}
