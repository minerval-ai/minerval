import "server-only";
import type {
  AttemptSummary,
  ClaimCitationPayload,
  ClaimDetail,
  ClaimEventsPage,
  ClaimFilters,
  ContributionDetail,
  ContributionExchange,
  ContributorProfile,
  LeaderboardContributor,
  PrizeListItem,
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

class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  if (!BASE) throw new Error("MINERVAL_API_URL is not set");
  const res = await fetch(`${BASE}${path}`, {
    headers: KEY ? { "x-api-key": KEY } : {},
    // The graph changes as claims are reassessed; revalidate on a short window.
    next: { revalidate: 30 },
  });
  if (!res.ok) {
    throw new ApiError(`Minerval API ${res.status} ${res.statusText} for ${path}`, res.status);
  }
  return (await res.json()) as T;
}

// --- mathematics: field defaults ---------------------------------------------
// The formal statement, the derived badge, the bounty, the attempts, and the
// prize claims (docs/mathematics.md §11.1) arrive on the same routes the
// loaders already read. Each defaults here when the API omits it, so every
// section renders nothing rather than throwing before the API serves it.

type RawDetail = ClaimDetail & { domains?: string[] };

function withMathDefaults(raw: RawDetail): ClaimDetail {
  return {
    ...raw,
    claim: {
      ...raw.claim,
      // The domains tag rides on the claim row; accept it at either level.
      domains: raw.claim?.domains ?? raw.domains ?? [],
    },
    formalization: raw.formalization ?? null,
    verification: raw.verification ?? null,
    bounty: raw.bounty ?? null,
    attempts: Array.isArray(raw.attempts) ? raw.attempts : [],
    prize_claims: Array.isArray(raw.prize_claims) ? raw.prize_claims : [],
  };
}

function withListDefaults(items: SearchResultItem[]): SearchResultItem[] {
  return items.map((c) => ({
    ...c,
    prize_micro_usd: c.prize_micro_usd ?? null,
    checked: c.checked ?? null,
  }));
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
    apiGet<RawDetail>(`/claims/${id}?information_depth=deep`),
    apiGet<TrajectoryResponse>(`/claims/${id}/assessments/trajectory`).catch(() => null),
    apiGet<{ record: ContributionExchange[] }>(`/claims/${id}/record`).catch(() => null),
  ]);
  return {
    ...withMathDefaults(detail),
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
// carries the tree.
//
// This one DOES send an explicit depth. The API's default dropped to 3 to stop
// agent readers paying for tree they didn't ask for, but the territory counts
// are computed over the subtree, so they would silently shallow out on the
// server default. Stating the depth here keeps a rendering surface's needs
// independent of agent-context tuning. 8 is inside both the new cap and the
// old one, so it is safe whichever of Vercel and the API deploys first.
export async function fetchClaimTree(id: string): Promise<ClaimDetail> {
  return withMathDefaults(
    await apiGet<RawDetail>(`/claims/${id}?information_depth=standard&depth=8`),
  );
}

// Serialize the active filters into API query params. Defaults (all / 0) are
// omitted so the URL stays clean and matches the API's own defaults.
function filterParams(filters?: ClaimFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (filters?.assessed && filters.assessed !== "all") p.set("assessed", filters.assessed);
  if (filters?.minImportance && filters.minImportance > 0) {
    p.set("min_importance", String(filters.minImportance));
  }
  if (filters?.withPrizes) p.set("with_prizes", "true");
  if (filters?.claimType) p.set("claim_type", filters.claimType);
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
  return withListDefaults(r.results);
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
  return withListDefaults(r.results);
}

// --- mathematics: prizes and attempts ----------------------------------------

// Open bounties across the graph, largest first (GET /prizes). The route
// ships with the mathematics API; until it does, a 404 is an empty listing
// rather than a failed page, and any other failure degrades the same way.
export async function fetchOpenPrizes(limit = 50): Promise<PrizeListItem[]> {
  try {
    const r = await apiGet<
      { prizes?: PrizeListItem[]; results?: PrizeListItem[] } | PrizeListItem[]
    >(`/prizes?limit=${limit}`);
    const items = Array.isArray(r) ? r : (r.prizes ?? r.results ?? []);
    return items
      .filter((p) => p && p.bounty)
      .map((p) => ({ ...p, checked: p.checked ?? null }))
      .sort((a, b) => b.bounty.amount_micro_usd - a.bounty.amount_micro_usd);
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      console.error("[minerval] prizes fetch failed:", err);
    }
    return [];
  }
}

// One house attempt with its report and notebook once published
// (GET /attempts/:id). Null for an unknown id or an API that predates it.
export async function fetchAttempt(id: string): Promise<AttemptSummary | null> {
  try {
    const r = await apiGet<{ attempt?: AttemptSummary } | AttemptSummary>(`/attempts/${id}`);
    const a = "attempt" in r && r.attempt ? r.attempt : (r as AttemptSummary);
    if (!a || typeof a.id !== "string") return null;
    return { ...a, report: a.report ?? null, notebook: a.notebook ?? null };
  } catch {
    return null;
  }
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
// The EV/EC computation belongs to the mandates, so the public surface is
// per-mandate: GET /mandates/:id/allocation, rendered on the mandate page.

export interface AllocationKindTile {
  kind: string;
  candidates: number;
  valued: number;
  covered: number;
  allocated_owls: number;
  est_total_cost_owls: number;
}

export interface AllocationActionRow {
  action_id: string;
  kind: string;
  variant: string;
  claim_id: string | null;
  label: string;
  value_est: number;
  cost_owls: number;
  value_per_owl: number;
  backing_owls: number;
  covered: boolean;
  my_allocation_owls: number;
  marginal_ratio: number | null;
}

export interface MandateAllocationView {
  grant_id: string;
  title: string;
  policy: Record<string, number>;
  budget: {
    escrow_owls: number;
    spent_owls: number;
    daily_rate_owls: number;
    allocated_today_owls: number;
    today_bar: number | null;
  };
  kinds: AllocationKindTile[];
  histogram: Array<{ min: number; max: number; count: number }>;
  top: AllocationActionRow[];
  more: number;
}

export async function fetchMandateAllocation(
  mandateId: string,
  opts: { kind?: string; offset?: number; limit?: number } = {},
): Promise<MandateAllocationView | null> {
  const params = new URLSearchParams();
  if (opts.kind) params.set("kind", opts.kind);
  if (opts.offset) params.set("offset", String(opts.offset));
  if (opts.limit) params.set("limit", String(opts.limit));
  const qs = params.size > 0 ? `?${params}` : "";
  try {
    const r = await apiGet<{ allocation: MandateAllocationView }>(
      `/mandates/${mandateId}/allocation${qs}`,
    );
    return r.allocation;
  } catch {
    return null;
  }
}
