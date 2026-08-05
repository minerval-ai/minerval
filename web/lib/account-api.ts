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
  prices_owls: Record<string, number>;
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
