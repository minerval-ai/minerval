import Link from "next/link";
import type { MyPermissions } from "../lib/account-api";

// A line above every page of a members-only deployment, for a member whose
// permissions open pages the public site does not have: showings for a
// member who reads at a label besides `public` or acts on showings, the
// gate for whoever holds release for a party, file sets and adding
// a source for whoever holds the permission to direct, and the
// administration pages for whoever holds the permission to administer. A
// member who holds none of these is shown no line at all.
//
// The gate places it (components/MembersGate.tsx), so it exists only where
// the gate has let a member through: the public graph's pages are rendered
// exactly as they were, with nothing added around them. It is a line of its
// own and not two more entries in the masthead because the masthead's phone
// row is one line and stays one (app/layout.tsx).
export function MembersBand({ mine }: { mine: MyPermissions }) {
  const direct = mine.permissions.includes("direct");
  const administer = mine.permissions.includes("administer");
  const release = mine.permissions.includes("release");
  // Where the deployment holds material at more than one label, pages are
  // shown from one label to another, and every member may read the showings
  // their labels reach (components/inside/nav.tsx has the pages' own links).
  const showings = mine.clearance.some((label) => label !== "public") || release || direct;
  if (!direct && !administer && !showings) return null;
  return (
    <nav className="members-band" aria-label="This deployment">
      {showings && <Link href="/showings">Showings</Link>}
      {/* How much waits at each gate is for every member it concerns; its settings are an administrator's and a release holder's. */}
      {(showings || administer) && <Link href="/gates">Gates</Link>}
      {release && <Link href="/gate">At the gate</Link>}
      {(direct || administer) && <Link href="/file-sets">File sets</Link>}
      {direct && <Link href="/sources/new">Add a source</Link>}
      {/* The pages about the public graph are read by every member; the link is shown to those who can act there. */}
      {(direct || release) && <Link href="/admin/outside">The public graph</Link>}
      {administer && <Link href="/admin">Administration</Link>}
    </nav>
  );
}
