import { cache } from "react";
import {
  apiConfigured, fetchArgumentPage, fetchAttempt, fetchClaimCard, fetchClaimDetail, fetchClaimEvents, fetchClaimTree,
  fetchFeatures, fetchList, fetchOpenPrizes, fetchRequest, fetchRequests, fetchSearch, fetchSourcePage,
  fetchTag, fetchTags, fetchPublishedPage, fetchPublishedPages,
} from "./api";
import type { PublishedPageSummary, PublishedPageView } from "./published";
import { claimWithoutOffFeatures, listWithoutOffFeatures } from "./features";
import { membersOnly } from "./members";
import { refusedByMembersOnly } from "./viewer";
import { getSourcePageFixture } from "./fixtures-source";
import { getArgumentPageFixture } from "./fixtures-argument";
import { REQUESTS, getRequest } from "./fixtures-kinds";
import {
  getAttempt, getClaim, getClaimEvents, listClaims, listOpenPrizeMandates, listOpenPrizes,
} from "./fixtures";
import type {
  ArgumentPage, AttemptSummary, ClaimDetail, ClaimEventsPage, ClaimFilters, PrizeListItem, PrizeMandateNumbers,
  RequestItem, ResolvedFrom, SearchResultItem, SourcePage, TagSummary,
} from "./types";
import {
  TERRITORIES, computeListingStats, computeTerritoryStats, type Territory,
} from "./territories";

// Whether a node carries a current verdict of its kind: a claim's status, a
// question's standing, a quantity's estimate (the backend's ASSESSED_SQL).
function hasVerdict(c: SearchResultItem): boolean {
  if (c.kind === "question") return !!c.standing;
  if (c.kind === "quantity") return !!c.estimate;
  return !!c.assessment_status;
}

// The same filter predicate the API applies, used for the fixture fallback so
// the controls behave identically offline. "unassessed" keys off a missing
// verdict, matching the badge rule and the backend.
function applyFilters(items: SearchResultItem[], filters?: ClaimFilters): SearchResultItem[] {
  if (!filters) return items;
  return items.filter((c) => {
    if (filters.assessed === "assessed" && !hasVerdict(c)) return false;
    if (filters.assessed === "unassessed" && hasVerdict(c)) return false;
    if (filters.kind && (c.kind ?? "claim") !== filters.kind) return false;
    if (filters.minImportance && (c.importance ?? 0) < filters.minImportance) return false;
    if (filters.withPrizes && c.prize_micro_usd == null) return false;
    if (filters.claimType && c.claim_type !== filters.claimType) return false;
    if (filters.tag && !(c.tags ?? []).some((t) => t.slug === filters.tag)) return false;
    return true;
  });
}

// Single seam the pages call. When MINERVAL_API_URL is configured we serve live
// data; otherwise we fall back to the design fixtures, so the UI is always
// viewable. Live errors degrade to fixtures rather than crashing the page.
//
// A members-only deployment (lib/members.ts) never shows a fixture. The
// fixtures are the public site's demo content, and inside a private
// deployment a read that was refused, or that failed, must show nothing: a
// reader who may not see a claim must not be shown a different one in its
// place. So every fallback below asks `fixturesOff` first, and answers with
// nothing found.

export type DataSource = "live" | "fixture";

// Whether the fixtures are off for this read: always in a members-only
// deployment, and for any read the API refused as one, whatever this web
// app was told about the deployment.
function fixturesOff(err?: unknown): boolean {
  return membersOnly() || refusedByMembersOnly(err);
}

// Which features this deployment has on (lib/features.ts). Every page that
// shows something belonging to a feature asks here first. Memoized for the
// length of one render, so a page, its metadata and its sections ask once
// between them. A failed read means every feature is on (see fetchFeatures).
export const loadFeatures = cache(fetchFeatures);

// Memoized for the length of one render, so a page and its generateMetadata
// read the claim once between them. What the claim carries about a feature
// that is off is emptied here, including on the fixture fallback, so no
// surface that reads a claim shows a formal statement or a prize the
// deployment does not have.
export const loadClaim = cache(async (
  id: string,
): Promise<{ detail: ClaimDetail | null; source: DataSource }> => {
  if (!apiConfigured()) {
    return fixturesOff() ? { detail: null, source: "live" } : { detail: getClaim(id), source: "fixture" };
  }
  const features = await loadFeatures();
  try {
    return { detail: claimWithoutOffFeatures(await fetchClaimDetail(id), features), source: "live" };
  } catch (err) {
    if (fixturesOff(err)) {
      console.error("[minerval] live claim fetch failed:", err);
      return { detail: null, source: "live" };
    }
    console.error("[minerval] live claim fetch failed, using fixture:", err);
    const fixture = getClaim(id);
    return { detail: fixture && claimWithoutOffFeatures(fixture, features), source: "fixture" };
  }
});

// The "merged from" line's facts (#884): what the claim at `aliasId` was,
// when a reader was redirected from its address to `survivorId`'s page. Read
// from the alias's card, which the API answers with the survivor's card and
// `resolved_from`; null unless that card really is this survivor's, so a
// hand-written `merged_from` in a URL shows nothing. Offline there are no
// merged claims.
export async function loadMergedFrom(
  survivorId: string,
  aliasId: string | null,
): Promise<ResolvedFrom | null> {
  if (!aliasId || !apiConfigured()) return null;
  const card = await fetchClaimCard(aliasId).catch(() => null);
  if (!card?.resolved_from || card.id !== survivorId) return null;
  return card.resolved_from;
}

// Offline stand-in for the API's search, which also matches by meaning:
// every word of the query somewhere in what the request asks, why, or what
// would satisfy it.
function matchesRequest(r: RequestItem, q: string): boolean {
  const hay = [r.ask, r.why, r.satisfied_by, r.bears_on_text ?? ""].join(" ").toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

// Requests (Part VIII). Offline, the fixtures stand in so the pages can be
// seen. Live, a failure shows none rather than the design fixtures, which
// would read as real requests.
export async function loadRequests(q?: string): Promise<{ requests: RequestItem[]; source: DataSource }> {
  const query = q?.trim() || undefined;
  if (!apiConfigured()) {
    if (fixturesOff()) return { requests: [], source: "live" };
    return { requests: query ? REQUESTS.filter((r) => matchesRequest(r, query)) : REQUESTS, source: "fixture" };
  }
  try {
    return { requests: await fetchRequests(100, query), source: "live" };
  } catch (err) {
    console.error("[minerval] live requests fetch failed:", err);
    return { requests: [], source: "live" };
  }
}

export async function loadRequest(id: string): Promise<{ request: RequestItem | null; source: DataSource }> {
  if (!apiConfigured()) {
    return fixturesOff() ? { request: null, source: "live" } : { request: getRequest(id), source: "fixture" };
  }
  return { request: await fetchRequest(id), source: "live" };
}

// The unified per-claim history (#175). A null result with a non-null claim
// means the record could not be loaded, not that nothing ever happened — the
// history page renders the two cases differently.
export async function loadClaimEvents(
  id: string,
): Promise<{ events: ClaimEventsPage | null; source: DataSource }> {
  if (!apiConfigured()) {
    return fixturesOff() ? { events: null, source: "live" } : { events: getClaimEvents(id), source: "fixture" };
  }
  try {
    return { events: await fetchClaimEvents(id), source: "live" };
  } catch (err) {
    if (fixturesOff(err)) {
      console.error("[minerval] live claim events fetch failed:", err);
      return { events: null, source: "live" };
    }
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
    if (fixturesOff()) return { results: [], source: "live" };
    return { results: applyFilters(listClaims(), filters), source: "fixture" };
  }
  // The cards' prize chip and machine-checked badge go with their features,
  // as the claim page's sections do (loadClaim).
  const features = await loadFeatures();
  try {
    // With a query, search by meaning; without one, browse the most recent.
    const results = query
      ? await fetchSearch(query, filters)
      : await fetchList(40, filters);
    return { results: listWithoutOffFeatures(results, features), source: "live" };
  } catch (err) {
    if (fixturesOff(err)) {
      console.error("[minerval] live claim list failed:", err);
      return { results: [], source: "live" };
    }
    console.error("[minerval] live claim list failed, using fixture:", err);
    return {
      results: listWithoutOffFeatures(applyFilters(listClaims(), filters), features),
      source: "fixture",
    };
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
    if (fixturesOff()) return { prizes: [], mandates: [], source: "live" };
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
    if (fixturesOff()) return { attempt: null, source: "live" };
    const a = getAttempt(attemptId);
    return { attempt: a && a.claim_id === claimId ? a : null, source: "fixture" };
  }
  const a = await fetchAttempt(attemptId);
  return { attempt: a && a.claim_id === claimId ? a : null, source: "live" };
}

// --- topic tags (#272) -------------------------------------------------------

// The vocabulary, most-used first: the /tags page and the topics strip on
// the /claims overview. Offline there is no vocabulary to show; live, a
// failure degrades to an empty strip rather than a failed page.
export async function loadTags(
  limit = 100,
): Promise<{ tags: TagSummary[]; source: DataSource }> {
  if (!apiConfigured()) return { tags: [], source: "fixture" };
  try {
    return { tags: await fetchTags(limit), source: "live" };
  } catch (err) {
    console.error("[minerval] live tags fetch failed:", err);
    return { tags: [], source: "live" };
  }
}

// One tag for the active-filter lever on /claims?tag=…; null when unknown
// (the lever then shows the slug as typed).
export async function loadTag(slug: string): Promise<TagSummary | null> {
  if (!apiConfigured()) return null;
  try {
    return await fetchTag(slug);
  } catch (err) {
    console.error(`[minerval] tag "${slug}" fetch failed:`, err);
    return null;
  }
}

// --- source pages (#507) -----------------------------------------------------

// One source page: facts, the document as annotated text, and examinations.
// Offline, the sample sources; live, a failed fetch degrades to the fixture
// like the claim page does.
export async function loadSourcePage(
  id: string,
): Promise<{ page: SourcePage | null; source: DataSource }> {
  if (!apiConfigured()) {
    return fixturesOff() ? { page: null, source: "live" } : { page: getSourcePageFixture(id), source: "fixture" };
  }
  try {
    return { page: await fetchSourcePage(id), source: "live" };
  } catch (err) {
    if (fixturesOff(err)) {
      console.error("[minerval] live source fetch failed:", err);
      return { page: null, source: "live" };
    }
    console.error("[minerval] live source fetch failed, using fixture:", err);
    return { page: getSourcePageFixture(id), source: "fixture" };
  }
}

// An argument's page (#541), with the offline sample when the API is not
// configured or the live fetch fails.
export async function loadArgument(
  id: string,
): Promise<{ page: ArgumentPage | null; source: DataSource }> {
  if (!apiConfigured()) {
    return fixturesOff() ? { page: null, source: "live" } : { page: getArgumentPageFixture(id), source: "fixture" };
  }
  try {
    return { page: await fetchArgumentPage(id), source: "live" };
  } catch (err) {
    if (fixturesOff(err)) {
      console.error("[minerval] live argument fetch failed:", err);
      return { page: null, source: "live" };
    }
    console.error("[minerval] live argument fetch failed, using fixture:", err);
    return { page: getArgumentPageFixture(id), source: "fixture" };
  }
}

// The pages other graphs publish of a node (docs/published-pages.md). There
// is no sample of one: without the API, or when the read fails, a claim page
// simply has none.
export async function loadPublishedPages(nodeId: string): Promise<PublishedPageSummary[]> {
  if (!apiConfigured()) return [];
  try {
    return await fetchPublishedPages(nodeId);
  } catch {
    return [];
  }
}

export async function loadPublishedPage(id: string, pkg?: number): Promise<PublishedPageView | null> {
  if (!apiConfigured()) return null;
  try {
    return await fetchPublishedPage(id, pkg);
  } catch {
    return null;
  }
}
