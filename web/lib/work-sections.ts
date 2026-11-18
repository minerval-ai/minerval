import type { MyPermissions } from "./account-api";

// The sidebar of a members-only deployment: every page a member works in,
// in sections, with the graph's own reading pages among them. One list feeds
// the sidebar (components/work/Sidebar.tsx) and anything that asks which
// section a page is in, so the two cannot disagree. Kept apart from the
// components so that what decides where a page belongs needs nothing of
// Next's (tests/unit/web/work-nav.test.ts).
//
// A person is shown what they can use: a page whose `shown` says no is not
// listed, and a section with no page left is not named. The API still decides
// every read and every act; a page reached by its address says which
// permission it needs.

export type Mine = Pick<MyPermissions, "permissions" | "clearance">;

/** The icon a sidebar entry carries (components/work/icons.tsx). */
export type WorkIcon =
  | "inbox" | "review" | "ask" | "claims" | "mandates" | "findings" | "requests" | "docs"
  | "releases" | "boundaries" | "sources" | "file-sets" | "connections"
  | "globe" | "public-requests" | "replies" | "outbox"
  | "health" | "people" | "labels" | "parties" | "budget" | "log";

/** What the sidebar shows beside an entry once the counts are read (app/api/work/counts). */
export type WorkSignal = "inbox" | "review" | "public_requests" | "replies" | "health" | "connections";

export interface WorkPage {
  href: string;
  name: string;
  icon: WorkIcon;
  /** Other addresses that are this page (a page it replaced, a page under it that is not listed). */
  also?: string[];
  signal?: WorkSignal;
  shown?: (m: Mine) => boolean;
}

export interface WorkSection {
  /** Null for the first section, which has no heading. */
  name: string | null;
  pages: WorkPage[];
}

const has = (m: Mine, ...ps: string[]) => ps.some((p) => m.permissions.includes(p));
// Where the deployment holds material at more than one label, pages are released
// from one label to another, and every member may read the releases their labels reach.
// The permission to consent for a party is `consent` (docs/releasing-a-page.md).
const readsReleases = (m: Mine) => m.clearance.some((label) => label !== "public") || has(m, "consent", "direct");
const administers = (m: Mine) => has(m, "administer");

export const WORK_SECTIONS: WorkSection[] = [
  {
    name: null,
    pages: [
      // What waits on the person, from every part of the deployment.
      { href: "/inbox", name: "Inbox", icon: "inbox", signal: "inbox" },
      // The queue of what waits at a gate on the decision of someone who consents for a party.
      { href: "/gate", name: "Review", icon: "review", signal: "review", shown: (m) => has(m, "consent") },
    ],
  },
  {
    name: "Graph",
    pages: [
      { href: "/ask", name: "Ask", icon: "ask" },
      { href: "/claims", name: "Claims", icon: "claims", also: ["/arguments", "/contributions"] },
      { href: "/mandates", name: "Mandates", icon: "mandates" },
      { href: "/findings", name: "Findings", icon: "findings", also: ["/tags"] },
      { href: "/requests", name: "Requests", icon: "requests" },
      { href: "/docs", name: "Docs", icon: "docs" },
    ],
  },
  {
    // Pages released from one label to another, or outside, and the boundaries they cross.
    name: "Sharing",
    pages: [
      { href: "/releases", name: "Releases", icon: "releases", also: ["/showings"], shown: readsReleases },
      {
        // A boundary is one gate and one redaction policy.
        href: "/gates",
        name: "Boundaries",
        icon: "boundaries",
        also: ["/redaction-policies"],
        shown: (m) => readsReleases(m) || administers(m),
      },
    ],
  },
  {
    // What the agents read: sources, sets of files, and the organisation's own systems.
    name: "Material",
    pages: [
      { href: "/sources", name: "Sources", icon: "sources", shown: (m) => has(m, "direct", "administer") },
      { href: "/file-sets", name: "File sets", icon: "file-sets", shown: (m) => has(m, "direct", "administer") },
      { href: "/admin/connections", name: "Connections", icon: "connections", signal: "connections", shown: administers },
    ],
  },
  {
    // Everything that passes between this deployment and the public graph (docs/outward-acts.md).
    name: "Public graph",
    pages: [
      { href: "/admin/outside", name: "Overview", icon: "globe", shown: (m) => has(m, "direct", "consent") },
      {
        href: "/admin/outside/requests",
        name: "Requests",
        icon: "public-requests",
        signal: "public_requests",
        shown: (m) => has(m, "direct", "consent"),
      },
      {
        href: "/admin/outside/said-back",
        name: "Replies",
        icon: "replies",
        signal: "replies",
        shown: (m) => has(m, "direct", "consent"),
      },
      {
        // Pages sent outside, and agents' reports to Minerval's maintainers.
        href: "/outbound",
        name: "Outbox",
        icon: "outbox",
        also: ["/admin/outside/reports"],
        shown: (m) => has(m, "direct", "consent"),
      },
    ],
  },
  {
    // Every member reads who holds what and the log of every administrative
    // act (the deployment keeps both open to its members); the rest is an
    // administrator's.
    name: "Admin",
    pages: [
      { href: "/admin", name: "Health", icon: "health", signal: "health", shown: administers },
      { href: "/admin/people", name: "People", icon: "people" },
      { href: "/admin/labels", name: "Labels", icon: "labels", shown: administers },
      { href: "/admin/parties", name: "Parties", icon: "parties", shown: administers },
      { href: "/admin/budget", name: "Budget", icon: "budget", also: ["/admin/owls", "/admin/usage-report"], shown: administers },
      { href: "/admin/activity", name: "Activity log", icon: "log" },
    ],
  },
];

/** The sections and pages this person is shown. */
export function workSections(mine: Mine): WorkSection[] {
  return WORK_SECTIONS.map((s) => ({
    ...s,
    pages: s.pages.filter((p) => !p.shown || p.shown(mine)),
  })).filter((s) => s.pages.length > 0);
}

const under = (path: string, href: string) =>
  href.endsWith("/") ? path.startsWith(href) : path === href || path.startsWith(`${href}/`);

/**
 * The page a path belongs to: the listed page whose address, or one of its
 * other addresses, is the longest leading part of it.
 */
export function pageOf(
  sections: Array<{ pages: Array<{ href: string; also?: string[] }> }>,
  path: string,
): string | null {
  let best: { href: string; length: number } | null = null;
  for (const s of sections)
    for (const p of s.pages)
      for (const a of [p.href, ...(p.also ?? [])])
        if (under(path, a) && (!best || a.length > best.length)) best = { href: p.href, length: a.length };
  return best?.href ?? null;
}
