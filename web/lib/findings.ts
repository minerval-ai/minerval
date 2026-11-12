// The findings pages' own logic, kept apart from their markup so it can be
// tested: what the index's URL says, how a filter changes it, which agents
// are one role, and how an account's links are numbered for the margin.

import { parseProse, recordHref, type ProseSegment } from "./claim-links";

// ---------------------------------------------------------------------------
// Who noted it. A role has had more than one name on the record (a Steward's
// runs are "steward" or "claim_steward"); a reader filters by the role.
// ---------------------------------------------------------------------------

const AGENT_LABELS: Record<string, string> = {
  steward: "Claim Steward",
  claim_steward: "Claim Steward",
  curator: "Curator",
  grantmaker: "Grantmaker",
  mandate_review: "Grantmaker",
  contribution_reviewer: "Contribution Reviewer",
  reviewer: "Contribution Reviewer",
  dispute_arbitrator: "Dispute Arbitrator",
  arbitrator: "Dispute Arbitrator",
  audit_agent: "Audit Agent",
  audit: "Audit Agent",
};

export function agentLabel(agent: string): string {
  return AGENT_LABELS[agent] ?? agent.replace(/_/g, " ");
}

export interface Role {
  /** What the URL carries: the label in lower case with hyphens. */
  slug: string;
  label: string;
  /** The names on the record that are this role. */
  agents: string[];
  count: number;
}

export function roleSlug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** The agents of a facet gathered into roles, the busiest first. */
export function rolesOf(agents: Array<{ agent: string; count: number }>): Role[] {
  const roles = new Map<string, Role>();
  for (const a of agents) {
    const label = agentLabel(a.agent);
    const slug = roleSlug(label);
    const role = roles.get(slug) ?? { slug, label, agents: [], count: 0 };
    role.agents.push(a.agent);
    role.count += a.count;
    roles.set(slug, role);
  }
  return [...roles.values()].sort((x, y) => y.count - x.count || x.label.localeCompare(y.label));
}

/** Every name on the record known to be the role a slug names. */
export function agentsOfRole(slug: string): string[] {
  const known = Object.keys(AGENT_LABELS).filter((a) => roleSlug(AGENT_LABELS[a]!) === slug);
  // A role with no entry in the table is an agent shown under its own name.
  return known.length > 0 ? known : [slug.replace(/-/g, "_")];
}

// ---------------------------------------------------------------------------
// The index's view, as its URL says it
// ---------------------------------------------------------------------------

export type FindingsOrder = "recent" | "importance" | "relevance";

export interface FindingsView {
  q: string | null;
  tag: string | null;
  /** The least importance shown, 1 to 10. */
  min: number | null;
  /** A role's slug (roleSlug). */
  by: string | null;
  /** Where the claim stands: an assessment status. */
  stands: string | null;
  /** Noted within this many days: 7 or 30. */
  days: 7 | 30 | null;
  /** Null is the default: closest first under a search, newest otherwise. */
  order: FindingsOrder | null;
  page: number;
}

export const FINDINGS_PER_PAGE = 50;

type Params = Record<string, string | string[] | undefined>;

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  const t = s?.trim();
  return t ? t : null;
}

export function parseFindingsView(sp: Params): FindingsView {
  const min = Number(one(sp.min));
  const days = Number(one(sp.days));
  const page = Number(one(sp.page));
  const order = one(sp.order);
  return {
    q: one(sp.q)?.slice(0, 300) ?? null,
    tag: one(sp.tag),
    min: Number.isInteger(min) && min >= 1 && min <= 10 ? min : null,
    by: one(sp.by),
    stands: one(sp.stands),
    days: days === 7 || days === 30 ? days : null,
    order: order === "recent" || order === "importance" || order === "relevance" ? order : null,
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

/** The order in force: what was asked for, else the default for the view. */
export function orderInForce(view: FindingsView): FindingsOrder {
  if (view.order === "relevance" && !view.q) return "recent";
  return view.order ?? (view.q ? "relevance" : "recent");
}

/**
 * The URL of the view with something changed. Changing a filter goes back to
 * the first page; a value of null removes it.
 */
export function findingsHref(view: FindingsView, change: Partial<FindingsView> = {}): string {
  const next = { ...view, ...change };
  if (!("page" in change)) next.page = 1;
  const p = new URLSearchParams();
  if (next.q) p.set("q", next.q);
  if (next.tag) p.set("tag", next.tag);
  if (next.min) p.set("min", String(next.min));
  if (next.by) p.set("by", next.by);
  if (next.stands) p.set("stands", next.stands);
  if (next.days) p.set("days", String(next.days));
  // The default order is left out of the URL, so a plain link stays plain.
  if (next.order && next.order !== (next.q ? "relevance" : "recent")) p.set("order", next.order);
  if (next.page > 1) p.set("page", String(next.page));
  const q = p.toString();
  return q ? `/findings?${q}` : "/findings";
}

export function hasFilters(view: FindingsView): boolean {
  return Boolean(view.q || view.tag || view.min || view.by || view.stands || view.days);
}

// ---------------------------------------------------------------------------
// An account, with its links numbered for the margin
// ---------------------------------------------------------------------------

/** The opening of an account: its first paragraph, which the index shows. */
export function firstParagraph(account: string): string {
  return account.split(/\n{2,}/)[0]?.trim() ?? "";
}

/** A record an account links to, as its margin card is keyed. */
export type LinkTarget =
  | { kind: "claim"; id: string }
  | { kind: "argument"; id: string }
  | { kind: "source"; id: string };

export type NumberedSegment =
  | { kind: "text"; text: string }
  | { kind: "url"; href: string }
  | { kind: "ref"; n: number; target: LinkTarget; href: string; display: string | null };

export interface NumberedParagraph {
  segments: NumberedSegment[];
  /** The numbers first used in this paragraph: its margin cards, in order. */
  notes: number[];
}

/**
 * Split an account into paragraphs and number what it links to, in the order
 * of first mention. A record linked twice keeps its first number and has one
 * card, beside the paragraph that first links it.
 */
export function numberAccount(account: string): {
  paragraphs: NumberedParagraph[];
  targets: LinkTarget[];
} {
  const targets: LinkTarget[] = [];
  const numbers = new Map<string, number>();
  const paragraphs = account
    .split(/\n{2,}/)
    .filter((p) => p.trim() !== "")
    .map((para) => {
      const notes: number[] = [];
      const segments = parseProse(para).map((seg: ProseSegment): NumberedSegment => {
        if (seg.kind === "text" || seg.kind === "url") return seg;
        const target: LinkTarget =
          seg.kind === "link"
            ? { kind: "claim", id: seg.claimId.trim() }
            : { kind: seg.record, id: seg.id };
        const key = `${target.kind}:${target.id}`;
        let n = numbers.get(key);
        if (n === undefined) {
          targets.push(target);
          n = targets.length;
          numbers.set(key, n);
          notes.push(n);
        }
        const href =
          target.kind === "claim" ? `/claims/${target.id}` : recordHref(target.kind, target.id);
        return { kind: "ref", n, target, href, display: seg.display };
      });
      return { segments, notes };
    });
  return { paragraphs, targets };
}
