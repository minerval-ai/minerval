import "server-only";
import { accountFetch } from "./account-api";

// The list of sources a members' deployment holds (GET /sources): each with
// its label, whose material it is, where its admission and reading stand,
// who added it and when. The shapes are the API's own
// (src/services/source-list-service.ts).

export type SourceStatus =
  | "pending_review"
  | "not_admitted"
  | "queued"
  | "reading"
  | "extracted"
  | "failed"
  | "recorded";

export interface SourceRow {
  id: string;
  title: string;
  url: string | null;
  kind: string;
  label: string;
  party: { id: string; name: string } | null;
  status: SourceStatus;
  contribution_id: string | null;
  added_by: string | null;
  added_at: string;
}

export interface SourceList {
  sources: SourceRow[];
  counts: { sources: number; with_no_party: number; pending_review: number };
  total: number;
}

export function fetchSources(
  externalId: string,
  options: { limit?: number; offset?: number; label?: string; party?: string } = {}
): Promise<SourceList> {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50), offset: String(options.offset ?? 0) });
  if (options.label) params.set("at_label", options.label);
  if (options.party) params.set("party", options.party);
  return accountFetch(`/sources?${params}`, { actingUser: externalId });
}

/** How a status is said in the list, and its tone. */
export const SOURCE_STATUS: Record<SourceStatus, { text: string; tone: "ok" | "warn" | "bad" | "info" | "neu"; title: string }> = {
  pending_review: { text: "Waiting for review", tone: "warn", title: "Nothing is read from it until it is admitted" },
  not_admitted: { text: "Not admitted", tone: "bad", title: "The review did not admit it; nothing was read and what was held returned" },
  queued: { text: "Queued", tone: "info", title: "Admitted; its reading waits in the extraction lane" },
  reading: { text: "Being read", tone: "info", title: "The Extractor is reading it now" },
  extracted: { text: "Read", tone: "ok", title: "Read for the claims, figures and questions it holds" },
  failed: { text: "Reading failed", tone: "bad", title: "Its reading stopped with an error" },
  recorded: { text: "Kept by an agent", tone: "neu", title: "No one submitted it: an agent kept it as a source, or the system recorded it" },
};

/** The host of an address, without "www.", or the address itself where it is not one. */
export function domainOf(url: string | null): string {
  if (!url) return "";
  try {
    const u = new URL(url);
    return `${u.host.replace(/^www\./, "")}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return url;
  }
}
