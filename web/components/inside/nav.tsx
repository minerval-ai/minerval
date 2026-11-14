import Link from "next/link";
import type { Viewer } from "../admin/access";

// The links down the left side of the pages a member works in once the
// deployment holds material at more than one label: showings, the gates,
// sending outside, file sets and the redaction policies. A person is
// shown a link for what they can do: what waits on them at a gate for
// whoever holds release for a party, sending outside and file sets for whoever directs
// (file sets for administrators too, who register directories), and one
// line for the administration pages for whoever administers. Showings and
// the policies are read by every member, each as far as their labels go.
//
// It takes the administration pages' own markup and class (admin/access.tsx),
// so it sits down the left side on a wide screen and is a line of links
// above the page on a phone, exactly as theirs does.

export const WORK_PAGES: Array<{ href: string; name: string; needs?: string[] }> = [
  { href: "/showings", name: "Showings" },
  { href: "/gates", name: "Gates" },
  { href: "/gate", name: "At the gate", needs: ["release"] },
  // Pages leave in signed packages, listed here. Everything else that passes between this deployment and the
  // public graph (its account there, mandates, requests, reports) is on the page after it (docs/outward-acts.md).
  { href: "/outbound", name: "Pages sent outside", needs: ["direct"] },
  { href: "/admin/outside", name: "The public graph", needs: ["direct", "release"] },
  { href: "/redaction-policies", name: "Redaction policies" },
  { href: "/file-sets", name: "File sets", needs: ["direct", "administer"] },
  { href: "/sources/new", name: "Add a source", needs: ["direct"] },
  { href: "/admin", name: "Administration", needs: ["administer"] },
];

export function WorkNav({ who, current }: { who: Viewer; current: string }) {
  const pages = WORK_PAGES.filter((p) => !p.needs || p.needs.some((n) => who.mine.permissions.includes(n)));
  return (
    <nav className="acct-nav admin-nav" aria-label="This deployment">
      {pages.map((page) =>
        page.href === current ? (
          <span key={page.href} aria-current="page">
            {page.name}
          </span>
        ) : (
          <Link key={page.href} href={page.href}>
            {page.name}
          </Link>
        )
      )}
    </nav>
  );
}

/** A day as these pages write it: 4 November 2026. */
export function day(iso: string | null | undefined): string {
  if (!iso) return "a date not recorded";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? "a date not recorded"
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** How long something has waited, in whole hours up to two days and whole days after. */
export function waited(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "a time not recorded";
  const hours = Math.max(0, Math.floor((now - new Date(iso).getTime()) / 3_600_000));
  if (hours < 1) return "less than an hour";
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  return `${Math.floor(hours / 24)} days`;
}

/** A hash as a page shows it: the first sixteen characters, with the whole in the title. */
export function Hash({ value }: { value: string | null | undefined }) {
  if (!value) return <span className="acct-detail">not recorded</span>;
  return (
    <code title={value} className="inside-hash">
      {value.slice(0, 16)}
    </code>
  );
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-GB")} ${n === 1 ? one : many}`;
}
