import Link from "next/link";
import type { MyPermissions } from "../../lib/account-api";

// The pages a member works in, beyond the public graph's own, in four
// sections. The band under the masthead (components/MembersBand.tsx) names
// the sections and marks the one the reader is in; the column down the left
// side of a page lists the pages of that section alone, with the current one
// marked. One list feeds both, so the two can neither repeat each other nor
// disagree about where a page belongs.
//
// A person is shown what they can do: a page whose `shown` says no is not
// listed, and a section with no page left is not named.

type Mine = Pick<MyPermissions, "permissions" | "clearance">;

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

/**
 * The pages of the section `current` is in, down the left side of the page
 * (as a line of links above it on a phone). `current` is the page's own
 * address; a page under a listed one (a showing, a file set) marks its parent.
 */
export function WorkNav({ who, current }: { who: { mine: Mine }; current: string }) {
  const sections = workSections(who.mine);
  const here = pageOf(sections, current);
  const section = sections.find((s) => s.pages.some((p) => p.href === here));
  // A section of one page has nothing to move between.
  if (!section || section.pages.length < 2) return null;
  return (
    <nav className="acct-nav admin-nav" aria-label={section.name}>
      {section.pages.map((page) =>
        page.href === current ? (
          <span key={page.href} aria-current="page">
            {page.name}
          </span>
        ) : (
          <Link key={page.href} href={page.href} aria-current={page.href === here ? "true" : undefined}>
            {page.name}
          </Link>
        ),
      )}
    </nav>
  );
}

/** A day as these pages write it: 4 November 2026. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "a date not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "a date not recorded"
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
}

/** How long something has waited, in whole hours up to two days and whole days after. */
export function waited(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "a time not recorded";
  const hours = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/** A hash as a page shows it: the first sixteen characters, with the whole in the title. */
export function Hash({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="acct-detail">not recorded</span>;
  return (
    <code title={value} className="inside-hash">
      {value.slice(0, 16)}
    </code>
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}
