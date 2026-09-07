import {
  apiConfigured, fetchAttempt, fetchClaimDetail, fetchClaimEvents, fetchClaimTree,
  fetchList, fetchOpenPrizes, fetchSearch,
} from "./api";
import {
  getAttempt, getClaim, getClaimEvents, listClaims, listOpenPrizeMandates, listOpenPrizes,
} from "./fixtures";
import type {
  AttemptSummary, ClaimDetail, ClaimEventsPage, ClaimFilters, PrizeListItem, PrizeMandateNumbers,
  SearchResultItem,
} from "./types";
import {
  TERRITORIES, computeListingStats, computeTerritoryStats, type Territory,
} from "./territories";

// The same filter predicate the API applies, used for the fixture fallback so
// the controls behave identically offline. "unassessed" keys off a missing
// status, matching the badge rule and the backend's `a.status IS NULL`.
function applyFilters(items: SearchResultItem[], filters?: ClaimFilters): SearchResultItem[] {
  if (!filters) return items;
  return items.filter((c) => {
    if (filters.assessed === "assessed" && !c.assessment_status) return false;
    if (filters.assessed === "unassessed" && c.assessment_status) return false;
    if (filters.minImportance && (c.importance ?? 0) < filters.minImportance) return false;
    if (filters.withPrizes && c.prize_micro_usd == null) return false;
    if (filters.claimType && c.claim_type !== filters.claimType) return false;
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
// counts and a verdict mix derived from its anchor's subtree — or, for a
// listing-backed territory, from the list endpoint filtered by claim type.
// Anchors are fetched in parallel; a failed anchor degrades to a stats-less
// card (name + question + core claim + map link) rather than dropping the
// territory or failing the page. Offline (no API) the whole set degrades to
// curated config.
export async function loadTerritories(): Promise<Territory[]> {
  if (!apiConfigured()) {
    return TERRITORIES.map((t) => ({ ...t, stats: null }));
  }
  return Promise.all(
    TERRITORIES.map(async (t) => {
      try {
        if (t.listing) {
          const items = await fetchList(200, { assessed: "all", claimType: t.listing.claimType });
          return { ...t, stats: computeListingStats(items) };
        }
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

// Open bounties, largest first (docs/mathematics.md §8.3), with the prize
// numbers of the mandates that post them (§8.1): the /prizes page and the
// strip under the territories. Live, an API without the route yields an
// empty strip; offline, the sample theorem's bounty and its mandate.
export async function loadOpenPrizes(
  limit = 50,
): Promise<{ prizes: PrizeListItem[]; mandates: PrizeMandateNumbers[]; source: DataSource }> {
  if (!apiConfigured()) {
    return { prizes: listOpenPrizes().slice(0, limit), mandates: listOpenPrizeMandates(), source: "fixture" };
  }
  const { prizes, mandates } = await fetchOpenPrizes(limit);
  return { prizes, mandates, source: "live" };
}

// One house attempt with its report and notebook (§7.7). The claim id is a
// guard: an attempt is addressed under the claim it ran on, so an id that
// belongs to another claim renders as not found rather than out of place.
export async function loadAttempt(
  claimId: string,
  attemptId: string,
): Promise<{ attempt: AttemptSummary | null; source: DataSource }> {
  if (!apiConfigured()) {
    const a = getAttempt(attemptId);
    return { attempt: a && a.claim_id === claimId ? a : null, source: "fixture" };
  }
  const a = await fetchAttempt(attemptId);
  return { attempt: a && a.claim_id === claimId ? a : null, source: "live" };
}
