import "server-only";
import type {
  ArgumentPage,
  ClaimCard,
  AttemptStats,
  AttemptSummary,
  ClaimCitationPayload,
  ClaimDetail,
  ClaimEventsPage,
  ClaimFilters,
  ContributionDetail,
  ContributionExchange,
  ContributorProfile,
  LeaderboardContributor,
  PrizeListItem, PrizeMandateNumbers,
  Finding,
  FindingSighting,
  FindingFacets,
  CitedAssessment,
  SearchResultItem,
  SourcePage,
  TagSummary,
  TrajectoryPoint,
  ProvenanceStory,
  RequestItem,
  SourceFacts,
  SourceDocument,
  Examination,
  SourceContext,
  SetupPart,
  SetupPartDetail,
  RunSummary,
  WithheldRun,
  RunStepSummary,
  RunStep,
} from "./types";
import { ALL_FEATURES_ON, featuresFromResponse, type Features } from "./features";
import { membersOnly } from "./members";
import { viewerExternalId } from "./viewer";

// Server-only client for the Minerval Fastify API. The API key is read from the
// environment and attached here, on the server — it is never shipped to the
// browser. This module is the "BFF": React Server Components and route handlers
// call it; the browser never talks to the backend directly.

const BASE = process.env.MINERVAL_API_URL?.replace(/\/$/, "");
const KEY = process.env.MINERVAL_API_KEY;

export function apiConfigured(): boolean {
  return Boolean(BASE);
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    // The API's own code for a refusal, where its answer carried one.
    readonly code?: string,
  ) {
    super(message);
  }
}

// The code in an error answer, in either shape the API uses: flat
// { error, code }, or an { error: { code, message } } envelope.
async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown; error?: { code?: unknown } | string };
    const code = typeof body.error === "object" && body.error ? body.error.code ?? body.code : body.code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

// What a read sends and how long its answer may be kept.
//
// On the public graph a read is for anybody: the service key alone, and the
// answer shared between readers for a short window, because the graph
// changes as claims are reassessed.
//
// In a members-only deployment (lib/members.ts) the API answers by who is
// reading, so the read names the signed-in reader and its answer is kept
// for no one. A visitor who is not signed in is named as nobody, and the
// API refuses the read.
async function readOptions(): Promise<RequestInit & { next?: { revalidate: number } }> {
  const key: Record<string, string> = KEY ? { "x-api-key": KEY } : {};
  if (!membersOnly()) return { headers: key, next: { revalidate: 30 } };
  const viewer = await viewerExternalId();
  return {
    headers: { ...key, ...(viewer ? { "x-acting-user": viewer } : {}) },
    cache: "no-store",
  };
}

// An id as exactly one segment of a backend path. Ids arrive from route
// params, which Next has already percent-decoded, and every request here
// carries the service key, so a raw "/", "?" or "#" in an id would rewrite
// the path or query of a privileged request. Encoding keeps those inside the
// segment; "." and ".." are refused because URL parsing resolves them as dot
// segments even when encoded. The API's ids are UUIDs, which encoding leaves
// unchanged; a refused id reads as unknown (404), as a missing one does.
function pathSegment(id: string): string {
  if (id === "." || id === "..") {
    throw new ApiError(`Minerval API: no resource has id ${JSON.stringify(id)}`, 404);
  }
  return encodeURIComponent(id);
}

import type { PublishedPageSummary, PublishedPageView } from "./published";

async function apiGet<T>(path: string): Promise<T> {
  if (!BASE) throw new Error("MINERVAL_API_URL is not set");
  const res = await fetch(`${BASE}${path}`, await readOptions());
  if (!res.ok) {
    throw new ApiError(
      `Minerval API ${res.status} ${res.statusText} for ${path}`,
      res.status,
      await errorCode(res),
    );
  }
  return (await res.json()) as T;
}

// --- features ----------------------------------------------------------------

// Which optional parts of the product this deployment has on (GET
// /setup/features; lib/features.ts). The answer changes only when the API is
// redeployed, and it rides the same short cache as every other read, so a
// deployment that switches a feature off shows it here within half a minute.
//
// A failed read answers "every feature is on" instead of throwing. That is
// how the site behaved before features could be switched off, so a passing
// error costs at worst a link that leads nowhere for half a minute. Failing
// the other way would make part of the site vanish from a deployment that
// has it. The offline design preview, with no API to ask, shows everything
// for the same reason.
export async function fetchFeatures(): Promise<Features> {
  if (!BASE) return ALL_FEATURES_ON;
  try {
    return featuresFromResponse(await apiGet<unknown>("/setup/features"));
  } catch (err) {
    console.error("[minerval] features read failed, treating every feature as on:", err);
    return ALL_FEATURES_ON;
  }
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
    research_runs: Array.isArray(raw.research_runs) ? raw.research_runs : [],
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    requests: Array.isArray(raw.requests) ? raw.requests : [],
  };
}

function withListDefaults(items: SearchResultItem[]): SearchResultItem[] {
  return items.map((c) => ({
    ...c,
    prize_micro_usd: c.prize_micro_usd ?? null,
    checked: c.checked ?? null,
    tags: Array.isArray(c.tags) ? c.tags : [],
  }));
}

interface TrajectoryResponse {
  current: TrajectoryPoint | null;
  history: TrajectoryPoint[];
  total_assessments: number;
  status_transitions: number;
}

export async function fetchClaimDetail(id: string): Promise<ClaimDetail> {
  const seg = pathSegment(id);
  // Detail (deep), trajectory, and the contribution record (#171) are separate
  // endpoints; fetch in parallel. Trajectory and record degrade to absent
  // rather than failing the page (e.g. an API deploy racing the frontend).
  const [detail, trajectory, record, findings, provenanceStory] = await Promise.all([
    apiGet<RawDetail>(`/claims/${seg}?information_depth=deep`),
    apiGet<TrajectoryResponse>(`/claims/${seg}/assessments/trajectory`).catch(() => null),
    apiGet<{ record: ContributionExchange[] }>(`/claims/${seg}/record`).catch(() => null),
    // Findings noted on this claim (#394); absent rather than failing the page.
    fetchFindings({ claimId: id, limit: 10 }).catch(() => [] as Finding[]),
    // The origins-first provenance map (#507); absent rather than failing the page.
    apiGet<ProvenanceStory>(`/claims/${seg}/provenance`).catch(() => null),
  ]);
  return {
    ...withMathDefaults(detail),
    provenance_story: provenanceStory,
    ...(trajectory ? { trajectory } : {}),
    ...(record ? { record: record.record } : {}),
    findings,
  };
}

// Requests (Part VIII): the index and one request with its work. The index
// shows the ones still open to work first; a request with no node of its own
// appears only here.
// With `q`, a search by meaning and keyword, ranked by meaning.
export async function fetchRequests(limit = 100, q?: string): Promise<RequestItem[]> {
  const p = new URLSearchParams({ limit: String(limit) });
  if (q) p.set("q", q);
  const res = await apiGet<{ requests: RequestItem[] }>(`/requests?${p.toString()}`);
  return res.requests;
}

export async function fetchRequest(id: string): Promise<RequestItem | null> {
  try {
    return await apiGet<RequestItem>(`/requests/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

// A source page (#507): the facts, the document as annotated text, and the
// examinations. Facts are the page; the other two degrade to absent rather
// than failing it. Null when the source does not exist.
export async function fetchSourcePage(id: string): Promise<SourcePage | null> {
  let facts: SourceFacts;
  let seg: string;
  try {
    seg = pathSegment(id);
    facts = await apiGet<SourceFacts>(`/sources/${seg}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
  const [document, examinations, context] = await Promise.all([
    apiGet<SourceDocument>(`/sources/${seg}/document`).catch(() => null),
    apiGet<{ examinations: Examination[] }>(`/sources/${seg}/examinations`)
      .then((r) => r.examinations)
      .catch(() => [] as Examination[]),
    apiGet<SourceContext>(`/sources/${seg}/context`).catch(() => null),
  ]);
  return { facts, document, examinations, context };
}

// An argument's page (#541): the view get_argument serves, with its
// evaluation history, premises and instances. Null when no argument has
// this id.
export const ARGUMENT_PAGE_INSTANCES = 100;
export async function fetchArgumentPage(id: string): Promise<ArgumentPage | null> {
  try {
    const seg = pathSegment(id);
    return await apiGet<ArgumentPage>(
      `/arguments/${seg}?include=evaluation&include=premises&include=instances&instances_limit=${ARGUMENT_PAGE_INSTANCES}`
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// The unified per-claim history (#175): assessments, contributions, decisions,
// steward notes, newest-first. The API caps a window at 200 events.
export async function fetchClaimEvents(id: string): Promise<ClaimEventsPage> {
  return apiGet<ClaimEventsPage>(`/claims/${pathSegment(id)}/events?limit=200`);
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
    await apiGet<RawDetail>(`/claims/${pathSegment(id)}?information_depth=standard&depth=8`),
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
  if (filters?.tag) p.set("tag", filters.tag);
  if (filters?.kind) p.set("kind", filters.kind);
  return p;
}

// --- topic tags (#272) -------------------------------------------------------

// The vocabulary, most-used first (GET /tags). An API without the route
// yields an empty listing rather than a failed page.
export async function fetchTags(limit = 100, q?: string): Promise<TagSummary[]> {
  const p = new URLSearchParams({ limit: String(limit) });
  if (q) p.set("q", q);
  try {
    const r = await apiGet<{ tags: TagSummary[] }>(`/tags?${p.toString()}`);
    return r.tags;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

// The findings feed (#394): public, newest first by default. A 404 (an API
// that predates the route) reads as an empty feed so the page renders.
export async function fetchFindings(
  opts: { claimId?: string; tag?: string; minImportance?: number; order?: "recent" | "importance"; limit?: number } = {},
): Promise<Finding[]> {
  const p = new URLSearchParams({ limit: String(opts.limit ?? 50) });
  if (opts.claimId) p.set("claim_id", opts.claimId);
  if (opts.tag) p.set("tag", opts.tag);
  if (typeof opts.minImportance === "number") p.set("min_importance", String(opts.minImportance));
  if (opts.order) p.set("order", opts.order);
  try {
    const r = await apiGet<{ findings: Finding[] }>(`/findings?${p.toString()}`);
    return r.findings;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

// One page of the findings list with its total and facets: what the index
// at /findings reads. An API that predates totals and facets answers with the
// findings alone; the page then shows the list without counts.
export interface FindingsQuery {
  q?: string;
  tag?: string;
  minImportance?: number;
  agents?: string[];
  claimStatus?: string;
  since?: string;
  order?: "recent" | "importance" | "relevance";
  limit?: number;
  offset?: number;
}

export async function fetchFindingsPage(
  opts: FindingsQuery = {},
): Promise<{ findings: Finding[]; total: number | null; facets: FindingFacets | null }> {
  const p = new URLSearchParams({ limit: String(opts.limit ?? 50), facets: "true" });
  if (opts.q) p.set("q", opts.q);
  if (opts.tag) p.set("tag", opts.tag);
  if (typeof opts.minImportance === "number") p.set("min_importance", String(opts.minImportance));
  if (opts.agents && opts.agents.length > 0) p.set("agent", opts.agents.join(","));
  if (opts.claimStatus) p.set("claim_status", opts.claimStatus);
  if (opts.since) p.set("since", opts.since);
  if (opts.order) p.set("order", opts.order);
  if (opts.offset) p.set("offset", String(opts.offset));
  try {
    const r = await apiGet<{ findings: Finding[]; total?: number; facets?: FindingFacets | null }>(
      `/findings?${p.toString()}`,
    );
    return {
      findings: r.findings,
      total: typeof r.total === "number" ? r.total : null,
      facets: r.facets ?? null,
    };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return { findings: [], total: 0, facets: null };
    throw err;
  }
}

export async function fetchFinding(
  id: string,
): Promise<{
  finding: Finding;
  sightings: FindingSighting[];
  cited_assessments: CitedAssessment[];
} | null> {
  try {
    const r = await apiGet<{
      finding: Finding;
      sightings: FindingSighting[];
      cited_assessments?: CitedAssessment[];
    }>(`/findings/${encodeURIComponent(id)}`);
    return { ...r, cited_assessments: r.cited_assessments ?? [] };
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// One tag by slug (GET /tags/:slug); null when there is none. A merged slug
// resolves to its survivor, so the name shown is the live one.
export async function fetchTag(slug: string): Promise<TagSummary | null> {
  try {
    const r = await apiGet<{ tag: TagSummary }>(`/tags/${encodeURIComponent(slug)}`);
    return r.tag;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
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

// Open bounties across the graph, largest first (GET /prizes), with the
// prize numbers of every mandate that posts them (docs/mathematics.md
// §8.1). The route ships with the mathematics API; until it does, a 404 is
// an empty listing rather than a failed page, and any other failure
// degrades the same way.
export async function fetchOpenPrizes(
  limit = 50,
): Promise<{ prizes: PrizeListItem[]; mandates: PrizeMandateNumbers[] }> {
  try {
    const r = await apiGet<
      | { prizes?: PrizeListItem[]; results?: PrizeListItem[]; mandates?: PrizeMandateNumbers[] }
      | PrizeListItem[]
    >(`/prizes?limit=${limit}`);
    const items = Array.isArray(r) ? r : (r.prizes ?? r.results ?? []);
    const mandates = Array.isArray(r) ? [] : (r.mandates ?? []);
    return {
      prizes: items
        .filter((p) => p && p.bounty)
        .map((p) => ({ ...p, checked: p.checked ?? null }))
        .sort((a, b) => b.bounty.amount_micro_usd - a.bounty.amount_micro_usd),
      mandates: mandates.filter((m) => m && m.grant_id),
    };
  } catch (err) {
    if (!(err instanceof ApiError && err.status === 404)) {
      console.error("[minerval] prizes fetch failed:", err);
    }
    return { prizes: [], mandates: [] };
  }
}

// One house attempt with its report and notebook once published
// (GET /attempts/:id). Null for an unknown id or an API that predates it.
// The platform's attempt record (docs/mathematics.md §7.10); scoped to one
// mandate's attempts when a grant id is given. Absent rather than failing
// the page when the API does not serve it.
export async function fetchAttemptStats(grantId?: string | null): Promise<AttemptStats | null> {
  const path = grantId
    ? `/attempts/stats?grant_id=${encodeURIComponent(grantId)}`
    : "/attempts/stats";
  try {
    const r = await apiGet<AttemptStats>(path);
    if (!r || typeof r !== "object" || !r.totals) return null;
    return {
      ...r,
      by_outcome: Array.isArray(r.by_outcome) ? r.by_outcome : [],
      by_variant: Array.isArray(r.by_variant) ? r.by_variant : [],
      calibration: r.calibration ?? null,
      novel_proofs: r.novel_proofs ?? { count: 0, items: [] },
      rediscoveries: r.rediscoveries ?? { count: 0, items: [] },
    };
  } catch {
    return null;
  }
}

export async function fetchAttempt(id: string): Promise<AttemptSummary | null> {
  try {
    const r = await apiGet<{ attempt?: AttemptSummary } | AttemptSummary>(
      `/attempts/${pathSegment(id)}`,
    );
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
  return apiGet<ClaimCitationPayload>(`/claims/${pathSegment(id)}/citation`);
}

// The claim card: the judgment whole, in one small shape (the API's
// claim-card-service). The embed page, the badge and the oEmbed endpoint all
// read it. Null when the graph holds no such node; an id that is not a
// well-formed one (the API answers 400) is equally a node that does not
// exist. Any other failure throws, so an outage is not shown as "not found".
export async function fetchClaimCard(id: string): Promise<ClaimCard | null> {
  try {
    return await apiGet<ClaimCard>(`/claims/${pathSegment(id)}/card`);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
    throw err;
  }
}

// The cards of several claims at once (GET /claims/cards), for pages that
// hold claim ids and want to name them and say where they stand: the account
// page's history, the findings list. An id the graph no longer holds, or a
// failed read, is simply absent from the map; the caller falls back to a
// plain link.
const CLAIM_CARDS_PER_REQUEST = 100;

export async function fetchClaimCards(ids: string[]): Promise<Map<string, ClaimCard>> {
  const cards = new Map<string, ClaimCard>();
  const unique = [...new Set(ids)];
  const batches: string[][] = [];
  for (let i = 0; i < unique.length; i += CLAIM_CARDS_PER_REQUEST) {
    batches.push(unique.slice(i, i + CLAIM_CARDS_PER_REQUEST));
  }
  await Promise.all(
    batches.map(async (batch) => {
      try {
        const r = await apiGet<{ cards: ClaimCard[] }>(
          `/claims/cards?ids=${batch.map(encodeURIComponent).join(",")}`
        );
        for (const card of r.cards) cards.set(card.id, card);
      } catch {
        // Names are a courtesy; the page reads without them.
      }
    })
  );
  return cards;
}

/** The wording alone of several claims at once. */
export async function fetchClaimTexts(ids: string[]): Promise<Map<string, string>> {
  const cards = await fetchClaimCards(ids);
  return new Map([...cards].map(([id, card]) => [id, card.text]));
}

// A source's facts alone (GET /sources/:id), for naming a source linked in
// prose. Null when there is no such source or the read fails.
export async function fetchSourceFacts(id: string): Promise<SourceFacts | null> {
  try {
    return await apiGet<SourceFacts>(`/sources/${pathSegment(id)}`);
  } catch {
    return null;
  }
}

export async function fetchContribution(
  id: string,
): Promise<ContributionDetail | null> {
  try {
    // A contribution's status flips when its review lands; the default
    // 30-second window is fresh enough and keeps repeat reads cheap.
    return await apiGet<ContributionDetail>(`/contributions/${pathSegment(id)}`);
  } catch {
    // 404 (unknown contribution) renders as not-found upstream.
    return null;
  }
}

// Where a just-submitted proposal stands, read fresh (no revalidate window):
// the propose form polls this so the link to the node a proposal became
// appears as soon as review accepts it.
export async function fetchContributionStatus(id: string): Promise<{
  review_status: string;
  became_claim_id: string | null;
} | null> {
  if (!BASE) return null;
  try {
    const res = await fetch(`${BASE}/contributions/${pathSegment(id)}`, {
      // Read fresh in every deployment; in a members-only one, for the reader.
      headers: (await readOptions()).headers,
      cache: "no-store",
    });
    if (!res.ok) return null;
    const { contribution: c } = (await res.json()) as ContributionDetail;
    if (!c?.review_status) return null;
    const became =
      c.became_claim_id ??
      (c.claim_id &&
      (c.contribution_type === "propose_claim" ||
        c.contribution_type === "propose_question" ||
        c.contribution_type === "propose_quantity")
        ? c.claim_id
        : null);
    return { review_status: c.review_status, became_claim_id: became };
  } catch {
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
    return await apiGet<ContributorProfile>(`/contributors/${pathSegment(id)}`);
  } catch {
    // 404 (unknown contributor) renders as not-found upstream.
    return null;
  }
}

// --- a mandate's operations (docs/allocation.md) ----------------------------
// What a mandate commissioned, under what written policy, and what its
// officers decided: GET /mandates/:id/allocation, rendered on its page.

export interface OperationsKindRow {
  kind: string;
  /** commissioned: an agent, a plan item or the funder chose the run and its budget; self_funded: the mandate's own upkeep. */
  funding: "commissioned" | "self_funded";
  runs: number;
  running: number;
  budget_owls: number;
  spent_owls: number;
}

export interface OperationsCommissionRow {
  action_id: string;
  kind: string;
  claim_id: string | null;
  label: string;
  commissioned_by: string;
  budget_owls: number;
  spent_owls: number;
  state: "waiting" | "running" | "settled";
  reason: string | null;
  created_at: string;
}

export interface OperationsDecisionRow {
  decided_by: string;
  item_kind: string;
  decision: string;
  target: string | null;
  owls: number | null;
  reason: string | null;
  created_at: string;
}

export interface MandateAllocationView {
  grant_id: string;
  title: string;
  operating_policy: string;
  officer_limit: { owls: number; reason: string };
  review_pass?: { owls: number; reason: string };
  budget: {
    escrow_owls: number;
    spent_owls: number;
    /** The part of spent_owls metered outside the ledger: in no kind's row, not held to the daily rate. */
    outside_ledger_owls: number;
    daily_rate_owls: number;
    used_today_owls: number;
    held_owls: number;
    regranted_owls: number;
    prizes_owls: number;
    remaining_owls: number;
  };
  window_days: number;
  kinds: OperationsKindRow[];
  commissions: OperationsCommissionRow[];
  more: number;
  decisions: OperationsDecisionRow[];
  petitions: { received: number; granted: number; refused: number; follow_up: number; escalated: number; pending: number };
  inbox_waiting: number;
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
      `/mandates/${pathSegment(mandateId)}/allocation${qs}`,
    );
    return r.allocation;
  } catch {
    return null;
  }
}

// The setups agent runs ran under (#552 groundwork). A 404 (an API that
// predates the route) reads as none recorded.
export async function fetchSetupParts(): Promise<SetupPart[]> {
  try {
    return (await apiGet<{ parts: SetupPart[] }>(`/setup/parts`)).parts;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return [];
    throw err;
  }
}

export async function fetchSetupPart(
  kind: string,
  name: string,
  version: number,
): Promise<SetupPartDetail | null> {
  try {
    return await apiGet<SetupPartDetail>(
      `/setup/parts/${encodeURIComponent(kind)}/${encodeURIComponent(name)}/${version}`,
    );
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// Agent runs (#553). A 404 (no such run, or an API that predates the
// route) reads as null.
export async function fetchRun(id: string): Promise<RunSummary | WithheldRun | null> {
  try {
    return await apiGet<RunSummary | WithheldRun>(`/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchRunSteps(
  id: string,
  after?: number,
): Promise<{ steps: RunStepSummary[]; next_after: number | null } | null> {
  const q = after != null ? `?after=${after}&limit=200` : "?limit=200";
  try {
    const r = await apiGet<{ steps: RunStepSummary[]; next_after: number | null } | WithheldRun>(
      `/runs/${encodeURIComponent(id)}/steps${q}`,
    );
    return "steps" in r ? r : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function fetchRunStep(id: string, seq: number): Promise<RunStep | null> {
  try {
    const r = await apiGet<RunStep | WithheldRun>(`/runs/${encodeURIComponent(id)}/steps/${seq}`);
    return "content" in r ? r : null;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

// --- published pages (docs/published-pages.md) ---------------------------------

// The pages other graphs publish of one node, each with its state and where
// it stands on the node.
export async function fetchPublishedPages(nodeId: string): Promise<PublishedPageSummary[]> {
  const res = await apiGet<{ published_pages: PublishedPageSummary[] }>(`/published-pages?node_id=${encodeURIComponent(nodeId)}`);
  return res.published_pages ?? [];
}

// One published page in the shape of a node's page, with its record.
export async function fetchPublishedPage(id: string, pkg?: number): Promise<PublishedPageView> {
  return apiGet<PublishedPageView>(`/published-pages/${pathSegment(id)}${pkg ? `?package=${pkg}` : ""}`);
}

// One package exactly as signed, with the publisher's key as the graph holds it.
export async function fetchPublishedPackage(id: string, pkg?: number): Promise<{ sequence: number; package: unknown; publisher_key: string | null }> {
  return apiGet(`/published-pages/${pathSegment(id)}/package${pkg ? `?package=${pkg}` : ""}`);
}

// A publisher's public record; null for an account that has registered no key.
export async function fetchPublisher(accountId: string): Promise<PublisherRecord | null> {
  try {
    return await apiGet<PublisherRecord>(`/publishers/${pathSegment(accountId)}`);
  } catch {
    return null;
  }
}

export interface PublisherRecord {
  account_id: string;
  name: string;
  registrations: Array<{ key_id: string; public_key: string; runs_on: string; attested_by: string; declared_interest: string | null; registered_at: string; retired_at: string | null }>;
  published_pages: PublishedPageSummary[];
  /** What this graph's own record holds of the publisher, as counts and dates in sentences (docs/outward-acts.md). */
  record?: { in_words: string[] };
  record_note?: string;
  note: string;
}
