import { apiConfigured, fetchClaimDetail, fetchClaimEvents, fetchClaimTree, fetchSearch, fetchList } from "./api";
import { getClaim, getClaimEvents, listClaims } from "./fixtures";
import type { ClaimDetail, ClaimEventsPage, ClaimFilters, SearchResultItem } from "./types";
import { TERRITORIES, computeTerritoryStats, type Territory } from "./territories";

// The same filter predicate the API applies, used for the fixture fallback so
// the controls behave identically offline. "unassessed" keys off a missing
// status, matching the badge rule and the backend's `a.status IS NULL`.
function applyFilters(items: SearchResultItem[], filters?: ClaimFilters): SearchResultItem[] {
  if (!filters) return items;
  return items.filter((c) => {
    if (filters.assessed === "assessed" && !c.assessment_status) return false;
    if (filters.assessed === "unassessed" && c.assessment_status) return false;
    if (filters.minImportance && (c.importance ?? 0) < filters.minImportance) return false;
    return true;
  });
}

// Single seam the pages call. When MINERVAL_API_URL is configured we serve live
// data; otherwise we fall back to the design fixtures, so the UI is always
// viewable. Live errors degrade to fixtures rather than crashing the page.

export type DataSource = "live" | "fixture";

export async function loadClaim(
  id: string,
): Promise<{ detail: ClaimDetail | null; source: DataSource }> {
  if (!apiConfigured()) return { detail: getClaim(id), source: "fixture" };
  try {
    return { detail: await fetchClaimDetail(id), source: "live" };
  } catch (err) {
    console.error("[minerval] live claim fetch failed, using fixture:", err);
    return { detail: getClaim(id), source: "fixture" };
  }
}

// The unified per-claim history (#175). A null result with a non-null claim
// means the record could not be loaded, not that nothing ever happened — the
// history page renders the two cases differently.
export async function loadClaimEvents(
  id: string,
): Promise<{ events: ClaimEventsPage | null; source: DataSource }> {
  if (!apiConfigured()) return { events: getClaimEvents(id), source: "fixture" };
  try {
    return { events: await fetchClaimEvents(id), source: "live" };
  } catch (err) {
    console.error("[minerval] live claim events fetch failed, using fixture:", err);
    return { events: getClaimEvents(id), source: "fixture" };
  }
}

// The curated territories for the pre-search /claims overview (#206), each with
// counts and a verdict mix derived from its anchor's subtree. Anchors are fetched
// in parallel; a failed anchor degrades to a stats-less card (name + question +
// core claim + map link) rather than dropping the territory or failing the page.
// Offline (no API) the whole set degrades to curated config.
export async function loadTerritories(): Promise<Territory[]> {
  if (!apiConfigured()) {
    return TERRITORIES.map((t) => ({ ...t, stats: null }));
  }
  return Promise.all(
    TERRITORIES.map(async (t) => {
      try {
        const detail = await fetchClaimTree(t.anchorId);
        return { ...t, stats: computeTerritoryStats(detail) };
      } catch (err) {
        console.error(`[minerval] territory "${t.key}" fetch failed:`, err);
        return { ...t, stats: null };
      }
    }),
  );
}

export async function loadClaims(
  query?: string,
  filters?: ClaimFilters,
): Promise<{ results: SearchResultItem[]; source: DataSource }> {
  if (!apiConfigured()) {
    return { results: applyFilters(listClaims(), filters), source: "fixture" };
  }
  try {
    // With a query, search by meaning; without one, browse the most recent.
    const results = query
      ? await fetchSearch(query, filters)
      : await fetchList(40, filters);
    return { results, source: "live" };
  } catch (err) {
    console.error("[minerval] live claim list failed, using fixture:", err);
    return { results: applyFilters(listClaims(), filters), source: "fixture" };
  }
}
