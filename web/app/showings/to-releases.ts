import { redirect } from "next/navigation";

// What was called a showing is a release (docs/releasing-a-page.md), and its
// pages moved from /showings to /releases. The old addresses keep working:
// each redirects to the same page under /releases, with its query.

export type Query = Record<string, string | string[] | undefined>;

export function toReleases(path: string, query: Query): never {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) params.append(key, v);
  }
  const qs = params.toString();
  redirect(`/releases${path}${qs ? `?${qs}` : ""}`);
}
