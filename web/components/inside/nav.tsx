import Link from "next/link";
import { type Mine, pageOf, workSections } from "../../lib/work-sections";

// The pages a member works in, beyond the public graph's own, in four
// sections. The band under the masthead (components/MembersBand.tsx) names
// the sections and marks the one the reader is in; the column down the left
// side of a page lists the pages of that section alone, with the current one
// marked. One list feeds both, so the two can neither repeat each other nor
// disagree about where a page belongs.
//
// A person is shown what they can do: a page whose `shown` says no is not
// listed, and a section with no page left is not named.

/**
 * The pages of the section `current` is in, down the left side of the page
 * (as a line of links above it on a phone). `current` is the page's own
 * address; a page under a listed one (a showing, a file set) marks its parent.
 */
export function WorkNav({ who, current }: { who: { mine: Mine }; current: string }) {
  const sections = workSections(who.mine);
  const here = pageOf(sections, current);
  const section = sections.find((s) => s.pages.some((p) => p.href === here));
  // A section of one page has nothing to move between.
  if (!section || section.pages.length < 2) return null;
  return (
    <nav className="acct-nav admin-nav" aria-label={section.name}>
      {section.pages.map((page) =>
        page.href === current ? (
          <span key={page.href} aria-current="page">
            {page.name}
          </span>
        ) : (
          <Link key={page.href} href={page.href} aria-current={page.href === here ? "true" : undefined}>
            {page.name}
          </Link>
        ),
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
    : d.toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
        timeZone: "UTC",
      });
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
