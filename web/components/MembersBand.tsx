import Link from "next/link";
import type { MyPermissions } from "../lib/account-api";

// A line above every page of a members-only deployment, for a member whose
// permissions open pages the public site does not have: adding a source for
// whoever holds the permission to direct, and the administration pages for
// whoever holds the permission to administer. A member who holds neither is
// shown no line at all.
//
// The gate places it (components/MembersGate.tsx), so it exists only where
// the gate has let a member through: the public graph's pages are rendered
// exactly as they were, with nothing added around them. It is a line of its
// own and not two more entries in the masthead because the masthead's phone
// row is one line and stays one (app/layout.tsx).
export function MembersBand({ mine }: { mine: MyPermissions }) {
  const direct = mine.permissions.includes("direct");
  const administer = mine.permissions.includes("administer");
  if (!direct && !administer) return null;
  return (
    <nav className="members-band" aria-label="This deployment">
      {direct && <Link href="/sources/new">Add a source</Link>}
      {administer && <Link href="/admin">Administration</Link>}
    </nav>
  );
}
