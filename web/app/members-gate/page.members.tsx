import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { loadStanding } from "../../lib/standing";

// The page the gate of a members-only build answers with, in place of
// whatever was asked for, when the visitor is not a signed-in member
// (proxy.members.ts). It shows nothing of its own: the gate in the root
// layout (components/MembersGate.tsx) stands in for every page until the
// visitor is a member, this one included, and says what to do. It exists so
// that the page a visitor asked for is never the one rendered.
export const metadata: Metadata = { title: "Sign in · Minerval" };

export default async function MembersGatePage() {
  // A member who comes to this address by hand has nothing to do here.
  const standing = await loadStanding();
  if (standing.state === "signed_in" && standing.mine.member) redirect("/");
  return null;
}
