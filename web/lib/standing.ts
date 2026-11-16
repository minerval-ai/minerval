import "server-only";
import { cache } from "react";
import { fetchMyPermissions, type MyPermissions } from "./account-api";
import { membersOnly } from "./members";

// What the person looking at a page of a members-only deployment holds
// there: read once for each page render, however many parts of the page ask
// (the gate, the links their permissions open, the page itself).
//
// On the public graph nobody holds anything and nothing is read: the answer
// is "open" without the session being looked at, so a page that could be
// served from a cache still can be.

export type Standing =
  | { state: "open" }
  | { state: "anonymous" }
  // Signed in, and the API could not say what the account holds.
  | { state: "unavailable"; externalId: string }
  | { state: "signed_in"; externalId: string; mine: MyPermissions };

export const loadStanding = cache(async (): Promise<Standing> => {
  if (!membersOnly()) return { state: "open" };
  // auth.ts is loaded when first needed and not at the top, as in
  // lib/viewer.ts: it reaches the API through a module that imports this one.
  const { auth } = await import("../auth");
  const session = await auth();
  const externalId = session?.externalId;
  if (!externalId) return { state: "anonymous" };
  try {
    return { state: "signed_in", externalId, mine: await fetchMyPermissions(externalId) };
  } catch (err) {
    console.error("[minerval] could not read the signed-in account's permissions:", err);
    return { state: "unavailable", externalId };
  }
});

/** Whether the person holds a permission, at any label or for any party. */
export function holds(standing: Standing, permission: string): boolean {
  return standing.state === "signed_in" && standing.mine.permissions.includes(permission);
}
