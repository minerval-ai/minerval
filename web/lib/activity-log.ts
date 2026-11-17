import "server-only";
import { accountFetch } from "./account-api";
import type { LogEntry } from "./admin-api";

// The log of every administrative act (GET /permissions/log), as the Activity
// log page (app/admin/activity) reads it: a page of up to the API's most at
// once, and older pages by the time of the last entry. Any member may read
// it; a name the reader is not entitled to comes back withheld.

/** The most entries GET /permissions/log returns at once. */
export const LOG_PAGE = 500;

export async function fetchLogPage(externalId: string, before?: string | null): Promise<LogEntry[]> {
  const query = new URLSearchParams({ limit: String(LOG_PAGE) });
  if (before) query.set("before", before);
  const r = await accountFetch<{ entries: LogEntry[] }>(`/permissions/log?${query}`, { actingUser: externalId });
  return r.entries;
}
