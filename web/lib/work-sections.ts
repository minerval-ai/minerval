import type { MyPermissions } from "./account-api";

// The sections of the pages a member works in (components/inside/nav.tsx has
// what they are for). Kept apart from the components so that what decides
// where a page belongs needs nothing of Next's.

export type Mine = Pick<MyPermissions, "permissions" | "clearance">;

export interface WorkPage {
  href: string;
  name: string;
  shown?: (m: Mine) => boolean;
}

export interface WorkSection {
  name: string;
  pages: WorkPage[];
}

const has = (m: Mine, ...ps: string[]) => ps.some((p) => m.permissions.includes(p));
// Where the deployment holds material at more than one label, pages are shown
// from one label to another, and every member may read the showings their labels reach.
const readsShowings = (m: Mine) => m.clearance.some((label) => label !== "public") || has(m, "release", "direct");

export const WORK_SECTIONS: WorkSection[] = [
  {
    name: "Showings",
    pages: [
      { href: "/showings", name: "Showings", shown: readsShowings },
      // How much waits at each gate is for every member it concerns; its settings are an administrator's and a release holder's.
      {
        href: "/gates",
        name: "Gates",
        shown: (m) => readsShowings(m) || has(m, "administer"),
      },
      { href: "/gate", name: "At the gate", shown: (m) => has(m, "release") },
      // Read by every member; an administrator who reads the label the pages are written at saves a version.
      {
        href: "/redaction-policies",
        name: "Redaction policies",
        shown: (m) => readsShowings(m) || has(m, "administer"),
      },
    ],
  },
  {
    name: "Material",
    pages: [
      {
        href: "/sources/new",
        name: "Add a source",
        shown: (m) => has(m, "direct"),
      },
      // Administrators register directories.
      {
        href: "/file-sets",
        name: "File sets",
        shown: (m) => has(m, "direct", "administer"),
      },
    ],
  },
  {
    // Everything that passes between this deployment and the public graph (docs/outward-acts.md).
    name: "The public graph",
    pages: [
      {
        href: "/admin/outside",
        name: "Overview",
        shown: (m) => has(m, "direct", "release"),
      },
      // Pages leave in signed packages, listed here.
      {
        href: "/outbound",
        name: "Pages sent outside",
        shown: (m) => has(m, "direct"),
      },
      {
        href: "/admin/outside/requests",
        name: "Public requests",
        shown: (m) => has(m, "direct", "release"),
      },
      {
        href: "/admin/outside/said-back",
        name: "What readers said back",
        shown: (m) => has(m, "direct", "release"),
      },
      {
        href: "/admin/outside/reports",
        name: "Agents' reports",
        shown: (m) => has(m, "direct", "release"),
      },
    ],
  },
  {
    name: "Administration",
    pages: [
      { href: "/admin", name: "Setup" },
      { href: "/admin/people", name: "People and permissions" },
      { href: "/admin/labels", name: "Labels and parties" },
      { href: "/admin/connections", name: "Connections" },
      { href: "/admin/owls", name: "Owls" },
      { href: "/admin/usage-report", name: "Usage report" },
    ].map((p) => ({ ...p, shown: (m: Mine) => has(m, "administer") })),
  },
];

/** The sections and pages this person is shown. */
export function workSections(mine: Mine): WorkSection[] {
  return WORK_SECTIONS.map((s) => ({
    ...s,
    pages: s.pages.filter((p) => !p.shown || p.shown(mine)),
  })).filter((s) => s.pages.length > 0);
}

/** The page a path belongs to: the listed page whose address is the longest leading part of it. */
export function pageOf(sections: Array<{ pages: Array<{ href: string }> }>, path: string): string | null {
  let best: string | null = null;
  for (const s of sections)
    for (const p of s.pages)
      if ((path === p.href || path.startsWith(`${p.href}/`)) && (!best || p.href.length > best.length)) best = p.href;
  return best;
}
