import "server-only";
import type {
  ClaimCitationPayload,
  ClaimDetail,
  ClaimEventsPage,
  ClaimFilters,
  ContributionDetail,
  ContributionExchange,
  ContributorProfile,
  LeaderboardContributor,
  SearchResultItem,
  TrajectoryPoint,
} from "./types";

// Server-only client for the Minerval Fastify API. The API key is read from the
// environment and attached here, on the server — it is never shipped to the
// browser. This module is the "BFF": React Server Components and route handlers
// call it; the browser never talks to the backend directly.

// The EPISTEME_* names are the pre-rebrand spelling, still read as a fallback so
// a deploy that has not had its env renamed yet keeps working. Drop them once
// MINERVAL_API_URL / MINERVAL_API_KEY are set everywhere.
const BASE = (process.env.MINERVAL_API_URL ?? process.env.EPISTEME_API_URL)?.replace(/\/$/, "");
const KEY = process.env.MINERVAL_API_KEY ?? process.env.EPISTEME_API_KEY;

export function apiConfigured(): boolean {
  return Boolean(BASE);
}

async function apiGet<T>(path: string): Promise<T> {
  if (!BASE) throw new Error("MINERVAL_API_URL is not set");
  const res = await fetch(`${BASE}${path}`, {
    headers: KEY ? { "x-api-key": KEY } : {},
    // The graph changes as claims are reassessed; revalidate on a short window.
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    throw new Error(`Minerval API ${res.status} ${res.statusText} for ${path}`);
  }
  return (await res.json()) as T;
}

interface TrajectoryResponse {
  current: TrajectoryPoint | null;
  history: TrajectoryPoint[];
  total_assessments: number;
  status_transitions: number;
}

export async function fetchClaimDetail(id: string): Promise<ClaimDetail> {
  // Detail (deep), trajectory, and the contribution record (#171) are separate
  // endpoints; fetch in parallel. Trajectory and record degrade to absent
  // rather than failing the page (e.g. an API deploy racing the frontend).
  const [detail, trajectory, record] = await Promise.all([
    apiGet<ClaimDetail>(`/claims/${id}?information_depth=deep`),
    apiGet<TrajectoryResponse>(`/claims/${id}/assessments/trajectory`).catch(() => null),
    apiGet<{ record: ContributionExchange[] }>(`/claims/${id}/record`).catch(() => null),
  ]);
  return {
    ...detail,
    ...(trajectory ? { trajectory } : {}),
    ...(record ? { record: record.record } : {}),
  };
}

// The unified per-claim history (#175): assessments, contributions, decisions,
// steward notes, newest-first. The API caps a window at 200 events.
export async function fetchClaimEvents(id: string): Promise<ClaimEventsPage> {
  return apiGet<ClaimEventsPage>(`/claims/${id}/events?limit=200`);
}

// The claim plus its decomposition tree, without the deep payload (arguments,
// instances, dependents). Used by the /claims territory overview (#206), which
// only needs the subtree to derive counts and the verdict mix. `standard`
// carries the tree. We deliberately send NO explicit depth: the API clamps the
// walk to its own default, which this change raises from 5 to 10. Passing an
// explicit depth would 400 against an API that still enforces the old cap
// (Vercel and the API deploy independently), so relying on the server default
// keeps the overview working across the deploy and deepens automatically once
// the API side lands.
export async function fetchClaimTree(id: string): Promise<ClaimDetail> {
  return apiGet<ClaimDetail>(`/claims/${id}?information_depth=standard`);
}

// Serialize the active filters into API query params. Defaults (all / 0) are
// omitted so the URL stays clean and matches the API's own defaults.
function filterParams(filters?: ClaimFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters?.assessed && filters.assessed !== "all") p.set("assessed", filters.assessed);
  if (filters?.minImportance && filters.minImportance > 0) {
    p.set("min_importance", String(filters.minImportance));
  }
  return p;
}

export async function fetchSearch(
  query: string,
  filters?: ClaimFilters,
): Promise<SearchResultItem[]> {
  const qs = filterParams(filters).toString();
  const r = await apiGet<{ results: SearchResultItem[]; total: number }>(
    `/claims/search/${encodeURIComponent(query)}${qs ? `?${qs}` : ""}`,
  );
  return r.results;
}

export async function fetchList(
  limit = 40,
  filters?: ClaimFilters,
): Promise<SearchResultItem[]> {
  const p = filterParams(filters);
  p.set("limit", String(limit));
  const r = await apiGet<{ results: SearchResultItem[]; total: number }>(
    `/claims?${p.toString()}`,
  );
  return r.results;
}

// "Cite this claim" (#290): the citation in every format plus the evidence
// record, pinned to the current assessment version. Fetched on demand when a
// reader opens the cite panel, not with the page.
export async function fetchClaimCitation(id: string): Promise<ClaimCitationPayload> {
  return apiGet<ClaimCitationPayload>(`/claims/${id}/citation`);
}

export async function fetchContribution(
  id: string,
): Promise<ContributionDetail | null> {
  try {
    // A contribution's status flips when its review lands; the default
    // 30-second window is fresh enough and keeps repeat reads cheap.
    return await apiGet<ContributionDetail>(`/contributions/${id}`);
  } catch {
    // 404 (unknown contribution) renders as not-found upstream.
    return null;
  }
}

export async function fetchLeaderboard(
  limit = 20,
): Promise<LeaderboardContributor[]> {
  const r = await apiGet<{ contributors: LeaderboardContributor[] }>(
    `/contributors?limit=${limit}`,
  );
  return r.contributors;
}

export async function fetchContributorProfile(
  id: string,
): Promise<ContributorProfile | null> {
  try {
    return await apiGet<ContributorProfile>(`/contributors/${id}`);
  } catch {
    // 404 (unknown contributor) renders as not-found upstream.
    return null;
  }
}

// --- allocation transparency (owl economy, §15) ------------------------------

export interface QueueSnapshot {
  depth: {
    pending: number;
    running: number;
    done: number;
    error: number;
    deferred: number;
  };
  formula: {
    contestation_floor: number;
    staleness_saturation_days: number;
    user_provenance_boost: number;
  };
  cost_estimates: {
    standard_owls: number;
    strong_owls: number;
    strong_min_value: number | null;
  };
  general_mandate: {
    grant_id: string;
    daily_rate_owls: number;
    allocated_today_owls: number;
  } | null;
  pending: Array<{
    claim_id: string;
    text: string;
    expected_value: number;
    expected_cost_owls: number;
    allocated_owls: number;
    remaining_owls: number;
    covered: boolean;
    value_per_owl: number | null;
    inputs: {
      importance: number;
      marginal_yield: number | null;
      contestation: number | null;
      days_since_assessed: number | null;
      user_proposed: boolean;
    };
  }>;
}

export async function fetchQueue(limit = 50): Promise<QueueSnapshot | null> {
  try {
    return await apiGet<QueueSnapshot>(`/queue?limit=${limit}`);
  } catch {
    return null;
  }
}
