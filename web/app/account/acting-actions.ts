"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "../../auth";
import { ACTING_COOKIE } from "../../lib/acting-as";
import { listMyOrganizations } from "../../lib/organizations-api";
import { membersOnly } from "../../lib/members";
import { isSafeRelativePath } from "../../lib/safe-redirect";

// The switch (docs/organizations.md, "Acting as the organization";
// lib/acting-as.ts): act as yourself, or as an organization you may act for.
// It is a form post, never a link, so an address cannot switch anyone. The
// organization is checked here, and again on every request the API is sent.

const YEAR = 60 * 60 * 24 * 365;

export async function switchActingAction(form: FormData): Promise<void> {
  const back = String(form.get("return_to") ?? "");
  const to = isSafeRelativePath(back) ? back : "/account";
  const session = await auth();
  if (!session?.externalId || membersOnly()) redirect(to);
  const id = String(form.get("organization_id") ?? "");
  const jar = await cookies();
  if (!id) {
    jar.delete(ACTING_COOKIE);
    redirect(to);
  }
  const mine = await listMyOrganizations(session.externalId).catch(() => []);
  const org = mine.find((o) => o.id === id);
  if (org && (org.role === "admin" || (org.permissions ?? []).length > 0)) {
    jar.set(ACTING_COOKIE, org.id, {
      path: "/",
      sameSite: "lax",
      // Readable by the page's own scripts, which ask who is acting only when it is set
      // (components/account/ActingAs.tsx). It holds an id and nothing secret.
      httpOnly: false,
      secure: process.env.NODE_ENV === "production",
      maxAge: YEAR,
    });
  }
  redirect(to);
}
