import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { membersOnly } from "./members";
import type { MemberPermission } from "./organization-permissions";

// Who the signed-in person is acting as on minerval.ai: themselves, or one of
// their organizations (docs/organizations.md, "Acting as the organization").
//
// The choice is a cookie holding the organization's id, set by the switch
// (app/api/acting/route.ts) and never by an address, so a link cannot switch
// anyone. It is read again on every request against the person's
// organizations as they stand, so leaving one, or losing every permission in
// it, puts them back to acting as themselves at once. The API checks the
// same on every request it is sent (src/server/organization-routes.ts).
//
// A members-only deployment is an organization's own and has no switch.

export const ACTING_COOKIE = "minerval_acting_as";

export interface ActingOrganization {
  id: string;
  name: string;
  role: "admin" | "member";
  /** What the person may do as it: every member permission for an admin. */
  permissions: MemberPermission[];
}

/** The organization id the switch names, unchecked. */
export async function chosenOrganizationId(): Promise<string | null> {
  if (membersOnly()) return null;
  try {
    const value = (await cookies()).get(ACTING_COOKIE)?.value;
    return value && /^[0-9a-f-]{36}$/i.test(value) ? value : null;
  } catch {
    // Outside a request (sign-in's provisioning, a build): nobody is acting.
    return null;
  }
}

/**
 * The organization the signed-in person is acting as, checked against their
 * organizations now, or null where they act as themselves. Read once per
 * request.
 */
export const actingOrganization = cache(async (): Promise<ActingOrganization | null> => {
  const id = await chosenOrganizationId();
  if (!id) return null;
  const { auth } = await import("../auth");
  const session = await auth();
  if (!session?.externalId) return null;
  const { listMyOrganizations } = await import("./organizations-api");
  try {
    const mine = await listMyOrganizations(session.externalId);
    const org = mine.find((o) => o.id === id);
    if (!org || !org.role) return null;
    const permissions = (org.permissions ?? []) as MemberPermission[];
    if (org.role !== "admin" && permissions.length === 0) return null;
    return { id: org.id, name: org.name, role: org.role, permissions };
  } catch {
    return null;
  }
});
