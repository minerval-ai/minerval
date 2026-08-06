import "server-only";

// Server-only client for the account/keys/usage half of the API (#70).
// Authenticates with the frontend's service key and acts on behalf of the
// signed-in user via x-acting-user. Nothing here ever reaches the browser.
//
// Account data must never be cached across users — every call is no-store
// (unlike the public claim reads in api.ts, which revalidate on a window).

// EPISTEME_* is the pre-rebrand spelling, kept as a fallback (see lib/api.ts).
const BASE = (process.env.MINERVAL_API_URL ?? process.env.EPISTEME_API_URL)?.replace(/\/$/, "");
const KEY = process.env.MINERVAL_API_KEY ?? process.env.EPISTEME_API_KEY;

export function accountApiConfigured(): boolean {
  return Boolean(BASE);
}

class AccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string
  ) {
    super(message);
  }
}
export { AccountApiError };

async function accountFetch<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    actingUser?: string;
  } = {}
): Promise<T> {
  if (!BASE) throw new Error("MINERVAL_API_URL is not set");
  const res = await fetch(`${BASE}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(KEY ? { "x-api-key": KEY } : {}),
      ...(options.actingUser ? { "x-acting-user": options.actingUser } : {}),
      ...(options.body !== undefined
        ? { "content-type": "application/json" }
        : {}),
    },
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    cache: "no-store",
  });
  if (!res.ok) {
    let code: string | undefined;
    let message = `Minerval API ${res.status} for ${path}`;
    try {
      // Two error shapes exist: flat { error, code } on the account routes and
      // an { error: { code, message } } envelope on the governed write routes.
      const payload = (await res.json()) as {
        error?: string | { code?: string; message?: string };
        code?: string;
      };
      if (typeof payload.error === "string") {
        code = payload.code;
        message = payload.error;
      } else if (payload.error) {
        code = payload.error.code ?? payload.code;
        if (payload.error.message) message = payload.error.message;
      }
    } catch {
      // non-JSON error body; keep the generic message
    }
    throw new AccountApiError(message, res.status, code);
  }
  return (await res.json()) as T;
}

// --- shapes (the API speaks snake_case) -------------------------------------

export interface AccountUser {
  id: string;
  external_id: string | null;
  display_name: string;
  email: string | null;
  avatar_url: string | null;
  reputation_score: number;
  trust_level: string;
  owls_earned: number;
  contribution_standing: string;
  bad_faith_flags: number;
  contributions_accepted: number;
  contributions_rejected: number;
  contributions_escalated: number;
  is_verified: boolean;
  is_suspended: boolean;
  created_at: string;
  last_active_at: string;
}

export interface Entitlement {
  owl_balance: number;
  owl_balance_micro_usd: number;
  owl_price_micro_usd: number;
  /** What one owl of spend covers, in micro-USD of metered cost ($1). */
  owl_cost_micro_usd: number;
  /** Per-operation ceilings in owls. The charge is metered cost, never more. */
  caps_owls: Record<string, number>;
  credits_enabled: boolean;
  signup_grant_owls: number;
  monthly_grant_owls: number;
}

export interface OwlPack {
  id: string;
  owls: number;
  price_cents: number;
  discount_percent: number;
}

export interface OwlLedgerEntry {
  id: string;
  amount_micro_usd: number;
  reason: string;
  op: string | null;
  claim_id: string | null;
  contribution_id: string | null;
  job_id: string | null;
  created_at: string;
}

export interface ApiKeyMeta {
  id: string;
  name: string;
  key_prefix: string;
  scope: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export interface UsageBucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  cost_micro_usd: number;
}

export interface UsageSummary {
  days: number;
  totals: UsageBucket;
  by_day: Array<{ date: string } & UsageBucket>;
  by_key: Array<
    { api_key_id: string | null; key_name: string | null } & UsageBucket
  >;
  by_agent: Array<{ agent: string } & UsageBucket>;
  entitlement: Entitlement;
}

// --- calls -------------------------------------------------------------------

export async function provisionUser(input: {
  externalId: string;
  displayName: string;
  email?: string | null;
  avatarUrl?: string | null;
}): Promise<AccountUser> {
  const r = await accountFetch<{ user: AccountUser }>("/users/provision", {
    method: "POST",
    body: {
      external_id: input.externalId,
      display_name: input.displayName,
      ...(input.email ? { email: input.email } : {}),
      ...(input.avatarUrl ? { avatar_url: input.avatarUrl } : {}),
    },
  });
  return r.user;
}

export async function fetchAccount(
  externalId: string
): Promise<{ user: AccountUser; entitlement: Entitlement; packs: OwlPack[] }> {
  return accountFetch("/users/me", { actingUser: externalId });
}

export async function fetchUsage(
  externalId: string,
  days = 30
): Promise<UsageSummary> {
  return accountFetch(`/usage?days=${days}`, { actingUser: externalId });
}

export async function listApiKeys(externalId: string): Promise<ApiKeyMeta[]> {
  const r = await accountFetch<{ keys: ApiKeyMeta[] }>("/api-keys", {
    actingUser: externalId,
  });
  return r.keys;
}

export async function createApiKey(
  externalId: string,
  name: string
): Promise<ApiKeyMeta & { key: string }> {
  return accountFetch("/api-keys", {
    method: "POST",
    body: { name },
    actingUser: externalId,
  });
}

// --- Owls --------------------------------------------------------------------

/** Start a Stripe Checkout session for an owl pack; returns the payment URL. */
export async function createOwlPackCheckout(
  externalId: string,
  packId: string
): Promise<string> {
  const r = await accountFetch<{ checkout_url: string }>("/billing/checkout", {
    method: "POST",
    body: { pack_id: packId },
    actingUser: externalId,
  });
  return r.checkout_url;
}

export async function fetchOwlLedger(
  externalId: string
): Promise<OwlLedgerEntry[]> {
  const r = await accountFetch<{ entries: OwlLedgerEntry[] }>(
    "/billing/ledger",
    { actingUser: externalId }
  );
  return r.entries;
}

export async function revokeApiKey(
  externalId: string,
  keyId: string
): Promise<void> {
  await accountFetch(`/api-keys/${keyId}`, {
    method: "DELETE",
    actingUser: externalId,
  });
}

// --- Assessment orders & budget jobs (owl economy, demand side) --------------

export interface AssessmentOrderView {
  id: string;
  claim_id: string;
  contribution_id: string | null;
  status: string;
  /** The quoted ceiling for this order; the settled charge can be less. */
  price_cap_owls: number;
  charged: boolean;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

/** Order a (re)assessment of a claim. Charged when the run starts. */
export async function createAssessmentOrder(
  externalId: string,
  claimId: string
): Promise<AssessmentOrderView> {
  const r = await accountFetch<{ order: AssessmentOrderView }>(
    `/claims/${claimId}/order`,
    { method: "POST", actingUser: externalId }
  );
  return r.order;
}

/** The user's open order for one claim (the claim-page poll), or null. */
export async function getOpenOrderForClaim(
  externalId: string,
  claimId: string
): Promise<AssessmentOrderView | null> {
  const r = await accountFetch<{ orders: AssessmentOrderView[] }>(
    `/orders?claim_id=${claimId}`,
    { actingUser: externalId }
  );
  return r.orders[0] ?? null;
}

export async function listAssessmentOrders(
  externalId: string
): Promise<AssessmentOrderView[]> {
  const r = await accountFetch<{ orders: AssessmentOrderView[] }>("/orders", {
    actingUser: externalId,
  });
  return r.orders;
}

/** Cancel a pending order (free — pending orders are uncharged). */
export async function cancelAssessmentOrder(
  externalId: string,
  orderId: string
): Promise<{ cancelled: boolean; refunded: boolean }> {
  return accountFetch(`/orders/${orderId}`, {
    method: "DELETE",
    actingUser: externalId,
  });
}

export interface BudgetJobView {
  id: string;
  kind: string;
  claim_id: string | null;
  status: string;
  budget_owls: number;
  spent_owls: number;
  checkpoint: {
    assessed?: number;
    subtree?: { pending: number; deferred: number; done: number };
    note?: string;
    last_claim_id?: string;
  } | null;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

/** Fund deep decomposition of a claim's subtree with an owl budget. */
export async function createDecompositionJob(
  externalId: string,
  claimId: string,
  budgetOwls: number
): Promise<BudgetJobView> {
  const r = await accountFetch<{ job: BudgetJobView }>(
    `/claims/${claimId}/decompose`,
    {
      method: "POST",
      body: { budget_owls: budgetOwls },
      actingUser: externalId,
    }
  );
  return r.job;
}

export async function listBudgetJobs(
  externalId: string
): Promise<BudgetJobView[]> {
  const r = await accountFetch<{ jobs: BudgetJobView[] }>("/budget-jobs", {
    actingUser: externalId,
  });
  return r.jobs;
}

export async function getBudgetJob(
  externalId: string,
  jobId: string
): Promise<BudgetJobView> {
  const r = await accountFetch<{ job: BudgetJobView }>(
    `/budget-jobs/${jobId}`,
    { actingUser: externalId }
  );
  return r.job;
}

export async function topUpBudgetJob(
  externalId: string,
  jobId: string,
  owls: number
): Promise<BudgetJobView> {
  const r = await accountFetch<{ job: BudgetJobView }>(
    `/budget-jobs/${jobId}/topup`,
    { method: "POST", body: { owls }, actingUser: externalId }
  );
  return r.job;
}

export async function cancelBudgetJob(
  externalId: string,
  jobId: string
): Promise<{ cancelled: boolean; refunded_owls: number }> {
  return accountFetch(`/budget-jobs/${jobId}/cancel`, {
    method: "POST",
    actingUser: externalId,
  });
}

// --- Grants (grantmakers) ----------------------------------------------------

export interface GrantView {
  id: string;
  name: string;
  policy: string;
  status: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_owls: number;
  spent_owls: number;
  budget_status: string | null;
  budget_job_id: string;
  plan: {
    strategy?: string;
    items?: Array<{ claim_id: string; action: string; rationale: string }>;
  } | null;
  plan_cursor: number;
  funded_assessments: Array<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: string;
  }>;
  created_at: string;
  updated_at: string;
}

export async function createGrant(
  externalId: string,
  input: {
    name: string;
    policy: string;
    budgetOwls: number;
    scopeClaimId?: string | null;
    scopeQuery?: string | null;
  }
): Promise<GrantView> {
  const r = await accountFetch<{ grant: GrantView }>("/grants", {
    method: "POST",
    actingUser: externalId,
    body: {
      name: input.name,
      policy: input.policy,
      budget_owls: input.budgetOwls,
      ...(input.scopeClaimId ? { scope_claim_id: input.scopeClaimId } : {}),
      ...(input.scopeQuery ? { scope_query: input.scopeQuery } : {}),
    },
  });
  return r.grant;
}

export async function listGrants(externalId: string): Promise<GrantView[]> {
  const r = await accountFetch<{ grants: GrantView[] }>("/grants", {
    actingUser: externalId,
  });
  return r.grants;
}

export async function getGrant(
  externalId: string,
  grantId: string
): Promise<GrantView> {
  const r = await accountFetch<{ grant: GrantView }>(`/grants/${grantId}`, {
    actingUser: externalId,
  });
  return r.grant;
}

export async function approveGrant(
  externalId: string,
  grantId: string
): Promise<GrantView> {
  const r = await accountFetch<{ grant: GrantView }>(
    `/grants/${grantId}/approve`,
    { method: "POST", actingUser: externalId }
  );
  return r.grant;
}

export async function topUpGrant(
  externalId: string,
  grantId: string,
  owls: number
): Promise<GrantView> {
  const r = await accountFetch<{ grant: GrantView }>(
    `/grants/${grantId}/topup`,
    { method: "POST", body: { owls }, actingUser: externalId }
  );
  return r.grant;
}

export async function cancelGrant(
  externalId: string,
  grantId: string
): Promise<{ cancelled: boolean; refunded_owls: number }> {
  return accountFetch(`/grants/${grantId}/cancel`, {
    method: "POST",
    actingUser: externalId,
  });
}

// --- Contributions (#174) ----------------------------------------------------

export interface SubmittedContribution {
  id: string;
  claim_id: string | null;
  contribution_type: string;
  content: string;
  evidence_urls: string[];
  submitted_at: string;
  review_status: string;
}

export async function submitContribution(
  externalId: string,
  input: {
    claimId: string;
    contributionType: string;
    content: string;
    evidenceUrls?: string[];
    mergeTargetClaimId?: string;
    proposedCanonicalForm?: string;
    displayName?: string;
  }
): Promise<SubmittedContribution> {
  const r = await accountFetch<{ contribution: SubmittedContribution }>(
    "/contributions",
    {
      method: "POST",
      actingUser: externalId,
      body: {
        claim_id: input.claimId,
        contribution_type: input.contributionType,
        content: input.content,
        ...(input.evidenceUrls?.length
          ? { evidence_urls: input.evidenceUrls }
          : {}),
        ...(input.mergeTargetClaimId
          ? { merge_target_claim_id: input.mergeTargetClaimId }
          : {}),
        ...(input.proposedCanonicalForm
          ? { proposed_canonical_form: input.proposedCanonicalForm }
          : {}),
        ...(input.displayName
          ? { contributor_display_name: input.displayName }
          : {}),
      },
    }
  );
  return r.contribution;
}

/** Intake (#157): propose a claim not yet in the graph; reviewed before it materializes. */
export async function proposeClaimIntake(
  externalId: string,
  input: { claim: string; argument: string }
): Promise<{ id: string; review_status: string }> {
  const r = await accountFetch<{
    contribution: { id: string; review_status: string };
  }>("/claims/propose", {
    method: "POST",
    actingUser: externalId,
    body: { claim: input.claim, argument: input.argument },
  });
  return r.contribution;
}

// --- OAuth consent (remote MCP connectors) -----------------------------------

export interface OAuthRequestView {
  id: string;
  status: string;
  expired: boolean;
  scope: string | null;
  client: {
    name: string;
    uri: string | null;
    logo_uri: string | null;
    redirect_host: string;
  };
}

export async function fetchOAuthRequest(
  requestId: string
): Promise<OAuthRequestView> {
  return accountFetch(`/oauth/requests/${requestId}`);
}

/** Approve as the signed-in user; returns the client redirect URL. */
export async function approveOAuthRequest(
  externalId: string,
  requestId: string
): Promise<string> {
  const r = await accountFetch<{ redirect_to: string }>(
    `/oauth/requests/${requestId}/approve`,
    { method: "POST", actingUser: externalId }
  );
  return r.redirect_to;
}

export async function denyOAuthRequest(requestId: string): Promise<string> {
  const r = await accountFetch<{ redirect_to: string }>(
    `/oauth/requests/${requestId}/deny`,
    { method: "POST" }
  );
  return r.redirect_to;
}

// --- granting conversations (the way grants are created) ---------------------

export interface GrantConversationMessage {
  role: "user" | "assistant";
  content: string;
  at: string;
}

export interface GrantMandateView {
  title: string;
  objective: string;
  scope_claim_id: string | null;
  scope_query: string | null;
  plan: {
    strategy: string;
    items: Array<{
      action: "assess" | "reassess" | "deepen" | "ingest";
      claim_id?: string;
      url?: string;
      rationale: string;
    }>;
  };
  expected_cost_owls: number;
  expected_cost_usd: number;
  notes: string | null;
}

export interface GrantConversationView {
  id: string;
  status: "active" | "proposed" | "funded" | "declined" | "abandoned";
  messages: GrantConversationMessage[];
  mandate: GrantMandateView | null;
  grant_id: string | null;
  created_at: string;
  updated_at: string;
}

export async function startGrantConversation(
  externalId: string,
  message: string
): Promise<GrantConversationView> {
  const r = await accountFetch<{ conversation: GrantConversationView }>(
    "/grant-conversations",
    { method: "POST", body: { message }, actingUser: externalId }
  );
  return r.conversation;
}

export async function continueGrantConversation(
  externalId: string,
  conversationId: string,
  message: string
): Promise<GrantConversationView> {
  const r = await accountFetch<{ conversation: GrantConversationView }>(
    `/grant-conversations/${conversationId}/messages`,
    { method: "POST", body: { message }, actingUser: externalId }
  );
  return r.conversation;
}

export async function fundGrantConversation(
  externalId: string,
  conversationId: string,
  budgetOwls: number
): Promise<{ conversation: GrantConversationView; grant_id: string }> {
  return accountFetch(`/grant-conversations/${conversationId}/fund`, {
    method: "POST",
    body: { budget_owls: budgetOwls },
    actingUser: externalId,
  });
}

export async function getGrantConversation(
  externalId: string,
  conversationId: string
): Promise<GrantConversationView> {
  const r = await accountFetch<{ conversation: GrantConversationView }>(
    `/grant-conversations/${conversationId}`,
    { actingUser: externalId }
  );
  return r.conversation;
}

// --- public mandates ---------------------------------------------------------

export interface MandateSummaryView {
  id: string;
  title: string;
  objective: string | null;
  is_platform: boolean;
  status: string;
  manager: string;
  budget_owls: number;
  spent_owls: number;
  contributor_count: number;
  action_mix: Record<string, number>;
  created_at: string | null;
}

export interface MandatePipelineRow {
  source_id: string;
  url: string;
  title: string | null;
  ingested_at: string | null;
  extraction_status: string | null;
  claims_linked: number;
  claims_assessed: number;
  avg_importance: number | null;
  max_importance: number | null;
  contested_claims: number;
  importance_histogram: number[];
}

export interface MandateRegrantEdge {
  grant_id: string;
  title: string;
  owls: number;
  note: string | null;
}

export interface MandateDetailView extends MandateSummaryView {
  strategy: string | null;
  notes: string | null;
  scope_claim_id: string | null;
  scope_query: string | null;
  budget_status: string;
  funded_by_mandates: MandateRegrantEdge[];
  regrants_out: MandateRegrantEdge[];
  last_review: { at: string; note: string } | null;
  plan_items: Array<{
    action: "assess" | "reassess" | "deepen" | "ingest";
    claim_id?: string;
    url?: string;
    rationale: string;
    state: "done" | "current" | "queued";
  }>;
  contributors: Array<{ name: string; owls: number; is_manager: boolean }>;
  funded_assessments: Array<{
    claim_id: string;
    text: string;
    status: string;
    assessed_at: string | null;
  }>;
  pipeline: MandatePipelineRow[];
  conversation_id?: string;
  is_manager?: boolean;
}

export async function listMandates(): Promise<MandateSummaryView[]> {
  const r = await accountFetch<{ mandates: MandateSummaryView[] }>("/mandates");
  return r.mandates;
}

export async function fetchMandateView(
  mandateId: string,
  externalId?: string | null
): Promise<MandateDetailView> {
  const r = await accountFetch<{ mandate: MandateDetailView }>(
    `/mandates/${mandateId}`,
    externalId ? { actingUser: externalId } : {}
  );
  return r.mandate;
}

export async function contributeToMandateApi(
  externalId: string,
  mandateId: string,
  owls: number
): Promise<MandateDetailView> {
  const r = await accountFetch<{ mandate: MandateDetailView }>(
    `/mandates/${mandateId}/contribute`,
    { method: "POST", body: { owls }, actingUser: externalId }
  );
  return r.mandate;
}

// --- claim allocations (chip in toward one assessment) -----------------------

export interface ClaimAllocationResult {
  allocated_owls: number;
  unspent_owls: number;
  covered: boolean;
}

export async function allocateToClaim(
  externalId: string,
  claimId: string,
  owls: number
): Promise<ClaimAllocationResult> {
  return accountFetch(`/claims/${claimId}/contribute`, {
    method: "POST",
    body: { owls },
    actingUser: externalId,
  });
}
