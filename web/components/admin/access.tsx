import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { MyPermissions } from "../../lib/account-api";
import { needsPermission } from "../../lib/admin-words";
import { loadStanding } from "../../lib/standing";
import { PageHead } from "../PageHead";

// Who is looking at an administration page, and whether they may.
//
// The API decides what a person may do; a page asks first so that it can say
// which permission it needs instead of showing a refused read. A person who
// lacks a permission is shown no control that needs it, and a page reached
// directly says which one it needs and who grants it.

export interface Viewer {
  externalId: string;
  mine: MyPermissions;
}

/** The signed-in member looking at the page, or null where the gate is already standing in for it. */
export async function viewer(): Promise<Viewer | null> {
  const standing = await loadStanding();
  // These pages are part of a members-only build. Started as anything else,
  // it has no such page.
  if (standing.state === "open") notFound();
  if (standing.state !== "signed_in" || !standing.mine.member) return null;
  return { externalId: standing.externalId, mine: standing.mine };
}

export function can(viewer: Viewer, permission: string): boolean {
  return viewer.mine.permissions.includes(permission);
}

/** What a page shows a member who reached it without the permission it needs. */
export function NeedsPermission({ title, permission }: { title: string; permission: string }) {
  return (
    <div className="col">
      <PageHead title={title} lede={needsPermission(permission)} />
      <p>
        What you hold in this deployment, and who granted what to whom, is on{" "}
        <Link href="/admin/people">People and permissions</Link>, which every member may read.
      </p>
    </div>
  );
}

const PAGES: Array<{ href: string; name: string }> = [
  { href: "/admin", name: "Setup" },
  { href: "/admin/people", name: "People and permissions" },
  { href: "/admin/labels", name: "Labels and parties" },
  { href: "/admin/connections", name: "Connections" },
  { href: "/admin/owls", name: "Owls" },
  { href: "/admin/usage-report", name: "Usage report" },
];

/** The administration pages, as a line of links with the current one marked. For administrators. */
export function AdminNav({ current }: { current: string }) {
  return (
    <nav className="acct-nav admin-nav" aria-label="Administration">
      {PAGES.map((page) =>
        page.href === current ? (
          <span key={page.href} aria-current="page">
            {page.name}
          </span>
        ) : (
          <Link key={page.href} href={page.href}>
            {page.name}
          </Link>
        )
      )}
    </nav>
  );
}

/** A date and time as the log writes them: the day, the minute, and that it is UTC. */
export function when(iso: string | null | undefined): string {
  if (!iso) return "";
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

export function Notice({ children }: { children: ReactNode }) {
  return <p className="admin-notice">{children}</p>;
}
