import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import type { MyPermissions } from "../../lib/account-api";
import { permissionPhrase } from "../../lib/admin-words";
import { loadStanding } from "../../lib/standing";
import { Empty, WorkHead, WorkPage } from "../work/ui";

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
    <WorkPage>
      <WorkHead title={title} />
      <div className="w-card">
        <Empty>
          <p style={{ margin: "0 0 6px", color: "var(--w-ink)", fontWeight: 500 }}>
            You need the permission to {permissionPhrase(permission)}.
          </p>
          <p style={{ margin: 0 }}>
            An administrator grants it. <Link href="/admin/people">See your access</Link>
          </p>
        </Empty>
      </div>
    </WorkPage>
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
