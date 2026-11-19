import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { actingOrganization } from "@/lib/acting-as";
import { listMyOrganizations } from "@/lib/organizations-api";
import { membersOnly } from "@/lib/members";

// Who the signed-in person is acting as on minerval.ai (docs/organizations.md,
// "Acting as the organization"; lib/acting-as.ts).
//
// GET answers the header and the forms, which ask after the page has drawn so
// that no public page waits on the session: the organization chosen, checked
// against the person's organizations now, with what they may do as it, and
// the organizations they could switch to.
//
// Switching is a server action (app/account/acting-actions.ts).

export async function GET() {
  const session = await auth();
  if (!session?.externalId || membersOnly()) {
    return NextResponse.json({ acting: null, choices: [] }, { headers: { "cache-control": "no-store" } });
  }
  const [acting, mine] = await Promise.all([
    actingOrganization(),
    listMyOrganizations(session.externalId).catch(() => []),
  ]);
  const choices = mine
    .filter((o) => o.role === "admin" || (o.permissions ?? []).length > 0)
    .map((o) => ({ id: o.id, name: o.name, role: o.role, permissions: o.permissions ?? [] }));
  return NextResponse.json({ acting, choices }, { headers: { "cache-control": "no-store" } });
}
