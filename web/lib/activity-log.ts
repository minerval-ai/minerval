import "server-only";
import { accountFetch } from "./account-api";
import type { LogEntry } from "./admin-api";

// The log of every administrative act (GET /permissions/log), as the Activity
// log page (app/admin/activity) reads it: filtered by the API by kind, by who
// acted and by text, before its limit, and paged back from `next_before`. Any
// member may read it; a name the reader is not entitled to comes back
// withheld, and a text search never finds one.

/** Entries on one page of the Activity log. */
export const LOG_PAGE = 200;

export interface LogFilters {
  /** A kind, as the API names it (LOG_TYPES in lib/admin-words.ts). */
  type?: string | null;
  /** An account's id, or operator, first_administrator or deployment. */
  by?: string | null;
  q?: string | null;
  before?: string | null;
}

export async function fetchLogPage(
  externalId: string,
  filters: LogFilters = {},
): Promise<{ entries: LogEntry[]; next_before: string | null }> {
  const query = new URLSearchParams({ limit: String(LOG_PAGE) });
  for (const key of ["type", "by", "q", "before"] as const) {
    const value = filters[key];
    if (value) query.set(key, value);
  }
  const r = await accountFetch<{ entries: LogEntry[]; next_before?: string | null }>(`/permissions/log?${query}`, {
    actingUser: externalId,
  });
  return { entries: r.entries, next_before: r.next_before ?? null };
}
