"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { createContext, useContext, useEffect, useState, useTransition, type ReactNode } from "react";
import { switchActingAction } from "@/app/account/acting-actions";
import { PERMISSION_WORDS, type MemberPermission } from "@/lib/organization-permissions";

// Who the signed-in person is acting as, for the header and for every form on
// the public site (docs/organizations.md, "Acting as the organization").
//
// Public pages are drawn once for every reader, so who is acting is asked
// after the page has drawn, and only when the switch's cookie is there: a
// reader who has never switched makes no request for it. The answer is the
// server's (app/api/acting/route.ts), checked against the person's
// organizations now; the cookie alone is never believed.

const COOKIE = "minerval_acting_as";

export interface ActingOrganization {
  id: string;
  name: string;
  role: "admin" | "member";
  permissions: MemberPermission[];
}

const ActingContext = createContext<ActingOrganization | null>(null);

export function ActingAsProvider({ children }: { children: ReactNode }) {
  const [acting, setActing] = useState<ActingOrganization | null>(null);
  // The switch is a server action and a redirect, which does not draw the
  // root layout again, so the cookie is looked at again now and then and the
  // server asked only when it has changed. Looking costs nothing.
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => {
    const read = () => {
      const cookie = document.cookie.split("; ").find((c) => c.startsWith(`${COOKIE}=`));
      setChosen(cookie ? cookie.slice(COOKIE.length + 1) : null);
    };
    read();
    const every = window.setInterval(read, 1000);
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(every);
      window.removeEventListener("focus", read);
    };
  }, []);
  useEffect(() => {
    if (!chosen) {
      setActing(null);
      return;
    }
    let live = true;
    fetch("/api/acting", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { acting: ActingOrganization | null } | null) => live && setActing(body?.acting ?? null))
      .catch(() => live && setActing(null));
    return () => {
      live = false;
    };
  }, [chosen]);
  return <ActingContext.Provider value={acting}>{children}</ActingContext.Provider>;
}

/** The organization the person is acting as, or null where they act as themselves. */
export function useActing(): ActingOrganization | null {
  return useContext(ActingContext);
}

/** Whether a form needing this permission is closed to the person as they are acting now. */
export function useActingBlocked(permission: MemberPermission | null): boolean {
  const acting = useActing();
  if (!acting || !permission) return false;
  return acting.role !== "admin" && !acting.permissions.includes(permission);
}

/**
 * Back to acting as yourself, from wherever you are. A button that calls the
 * switch itself, not a form, since it sits inside the forms whose line it is.
 */
function BackToSelf({ label }: { label: string }) {
  const here = usePathname() ?? "/";
  const [busy, startTransition] = useTransition();
  const back = () => {
    const form = new FormData();
    form.set("organization_id", "");
    form.set("return_to", `${here}${window.location.search}`);
    startTransition(() => switchActingAction(form));
  };
  return (
    <button type="button" className="linklike" title="Act as yourself again" onClick={back} disabled={busy}>
      {label}
    </button>
  );
}

/**
 * The header's sign that the person is acting as an organization: its name,
 * on every page, in a colour of its own, with the way back beside it.
 */
export function ActingChip() {
  const acting = useActing();
  if (!acting) return null;
  return (
    <span className="acting-chip" role="status">
      <span>
        as <Link href={`/account/organizations/${acting.id}`}>{acting.name}</Link>
      </span>
      <BackToSelf label="×" />
    </span>
  );
}

/**
 * The line above a form's button on the public site: who it is sent as, and,
 * where the person acts as an organization without the permission the form
 * needs, what is missing and who grants it. Nothing is shown to someone acting
 * as themselves. `permission` null marks a form that is always the person's
 * own (filing a prize, the Assistant): it says it goes as them.
 */
export function ActingLine({ permission, ownWhy }: { permission: MemberPermission | null; ownWhy?: string }) {
  const acting = useActing();
  const blocked = useActingBlocked(permission);
  if (!acting) return null;
  if (permission === null) {
    return (
      <p className="acting-line">
        Sent as you, not as {acting.name}{ownWhy ? `: ${ownWhy}` : "."}
      </p>
    );
  }
  if (blocked) {
    return (
      <p className="acting-line acting-blocked" role="note">
        Acting as {acting.name}, this needs <code title={PERMISSION_WORDS[permission]}>{permission}</code>. An admin of {acting.name} grants it on its{" "}
        <Link href={`/account/organizations/${acting.id}?tab=members`}>Members</Link> tab. <BackToSelf label="Act as yourself instead" />
      </p>
    );
  }
  return <p className="acting-line">Sent as {acting.name}.</p>;
}
