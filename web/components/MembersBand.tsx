import type { MyPermissions } from "../lib/account-api";
import { workSections } from "../lib/work-sections";
import { MembersBandLinks } from "./MembersBandLinks";

// A line above every page of a members-only deployment, for a member whose
// permissions open pages the public site does not have. It names the
// sections of those pages (components/inside/nav.tsx), each linking to its
// first page, and marks the one the reader is in; the pages of that section
// are the column down the left side of the page. A member who is shown no
// section is shown no line at all.
//
// The gate places it (components/MembersGate.tsx), so it exists only where
// the gate has let a member through: the public graph's pages are rendered
// exactly as they were, with nothing added around them. It is a line of its
// own and not more entries in the masthead because the masthead's phone
// row is one line and stays one (app/layout.tsx).
export function MembersBand({ mine }: { mine: MyPermissions }) {
  const sections = workSections(mine).map((s) => ({
    name: s.name,
    href: s.pages[0].href,
    pages: s.pages.map((p) => ({ href: p.href })),
  }));
  if (sections.length === 0) return null;
  return <MembersBandLinks sections={sections} />;
}
