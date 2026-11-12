import "server-only";
import { membersOnly } from "./members";

// Who is reading, for a members-only deployment (lib/members.ts).
//
// There the API serves a read only to a signed-in member, so every read the
// web app makes says who it is for: the session's sign-in identity, sent as
// x-acting-user beside the service key. On the public graph a read is for
// anybody, nobody is named, and this returns null without looking at the
// session, so a page that reads the graph stays as cacheable as it was.
//
// auth.ts is loaded when first needed and not at the top, because auth.ts
// itself reaches the API (to provision an account at sign-in) through the
// module that calls this.
export async function viewerExternalId(): Promise<string | null> {
  if (!membersOnly()) return null;
  const { auth } = await import("../auth");
  const session = await auth();
  return session?.externalId ?? null;
}

// The API's refusals in a members-only deployment (its
// server/plugins/members-only.ts and server/require-permission.ts). A read
// refused with one of these is never answered from the design fixtures,
// whatever this web app believes about the deployment: if the two tiers
// were ever set differently, the reader must see nothing, not a demo.
const MEMBERS_ONLY_REFUSALS = new Set(["SIGN_IN_REQUIRED", "NOT_A_MEMBER", "PERMISSION_REQUIRED"]);

export function refusedByMembersOnly(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && MEMBERS_ONLY_REFUSALS.has(code);
}
