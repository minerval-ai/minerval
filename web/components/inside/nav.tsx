import type { Mine } from "../../lib/work-sections";

// Helpers shared by the pages a member works in. The pages themselves sit in
// the workspace's sidebar (components/work/Sidebar.tsx, lib/work-sections.ts).

/**
 * The column of a section's pages that once ran down the side of each page.
 * The sidebar lists every page now, so this draws nothing; it stays only so a
 * page not yet redrawn for the workspace still builds.
 * @deprecated The sidebar replaces it; a page drawn with WorkPage does not call it.
 */
export function WorkNav(_props: { who: { mine: Mine }; current: string }) {
  return null;
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
