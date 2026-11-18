import type { ReactNode } from "react";
import type { MyPermissions } from "../../lib/account-api";
import { workSections } from "../../lib/work-sections";
import { ThemeToggle } from "../ThemeToggle";
import { Sidebar } from "./Sidebar";

// The frame of every page a member of a private deployment sees: the sidebar
// with every page their permissions open, the graph's own among them, beside
// the page. It takes the place of the public site's masthead and footer.
//
// A workspace page draws itself with <WorkPage> (components/work/ui.tsx); a
// page of the graph (a claim, the mandates) keeps its own reading column.

const ROLE_ORDER: Array<[string, string]> = [
  ["administer", "Administrator"],
  ["direct", "Directs the graph"],
  ["release", "Consents for a party"],
  ["fund", "Funds work"],
];

export function roleOf(mine: MyPermissions): string {
  return ROLE_ORDER.find(([p]) => mine.permissions.includes(p))?.[1] ?? "Member";
}

export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  return (words.length === 1 ? words[0].slice(0, 2) : words[0][0] + words[words.length - 1][0]).toUpperCase();
}

export function WorkShell({ mine, children }: { mine: MyPermissions; children: ReactNode }) {
  const sections = workSections(mine).map((s) => ({
    name: s.name,
    pages: s.pages.map(({ href, name, icon, also, signal }) => ({ href, name, icon, also, signal })),
  }));
  const person = mine.account.display_name ?? mine.account.external_id ?? "You";
  return (
    <div className="w-shell">
      <Sidebar
        sections={sections}
        person={person}
        role={roleOf(mine)}
        initials={initialsOf(person)}
        tools={<ThemeToggle />}
      />
      <main className="w-main">
        <div className="frame">{children}</div>
      </main>
    </div>
  );
}
