import { PAGE_HASH_PREFIX_CHARS } from "./page-url";
import { getSettings } from "./settings";
import type {
  BackgroundRequest,
  ChatResponse,
  Entitlement,
  PageAnalysis,
  Submission,
} from "./types";

/**
 * Minerval API client. Runs in the background service worker only, so page
 * scripts never see the API key. Both agentic endpoints authenticate with the
 * user's API key and are metered per-token server-side (#70).
 */

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  body?: unknown
): Promise<{ status: number; data: T }> {
  const settings = await getSettings();
  // The localhost carve-out is deliberate: a keyless local API takes the dev
  // bypass (server/plugins/auth.ts), so a developer pointing here shouldn't be
  // made to mint a key. It only misfired because the DEFAULT base URL was
  // localhost, which sent fresh installs down the dev path and left them with a
  // bare network error instead of this message. With the default now pointing at
  // the hosted API, the carve-out only applies to someone who asked for it.
  if (!settings.apiKey && !settings.apiBaseUrl.includes("localhost")) {
    throw new ApiError(
      "No API key configured. Create one in your Minerval dashboard and paste it in the extension settings.",
      401
    );
  }

  const url = `${settings.apiBaseUrl.replace(/\/$/, "")}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(settings.apiKey ? { "x-api-key": settings.apiKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // A network-level failure surfaces in Chrome as a bare "Failed to fetch",
    // which background.ts forwards verbatim to the panel. Say which host could
    // not be reached, since a misconfigured base URL is the usual cause and the
    // raw message gives the user nothing to act on.
    throw new ApiError(
      `Could not reach the Minerval API at ${settings.apiBaseUrl}. Check the API base URL in the extension settings.`,
      0
    );
  }

  if (!res.ok) {
    let detail = `${res.status}`;
    try {
      const parsed = await res.json();
      detail = parsed?.error?.message ?? parsed?.error ?? detail;
      if (parsed?.code === "QUOTA_EXCEEDED") {
        detail =
          "Monthly free-tier allowance exhausted; it resets next month.";
      }
      if (res.status === 429) {
        detail = "Rate limited — try again in a little while.";
      }
    } catch {
      // non-JSON error body
    }
    throw new ApiError(detail, res.status);
  }

  return { status: res.status, data: (await res.json()) as T };
}

export type AnalyzeApiResult =
  | { status: "ready"; analysis: PageAnalysis }
  | { status: "running"; contentHash: string };

/** Start (or join) a page analysis; 202 means poll getAnalysisStatus. */
export async function analyzePage(input: {
  url: string;
  title: string;
  content: string;
  share: boolean;
}): Promise<AnalyzeApiResult> {
  const { status, data } = await request<
    PageAnalysis & { content_hash: string }
  >("/extension/analyze", input);
  if (status === 202) {
    return { status: "running", contentHash: data.content_hash };
  }
  return { status: "ready", analysis: data };
}

/** Poll a started analysis. Throws ApiError on failed/expired runs. */
export async function getAnalysisStatus(
  contentHash: string
): Promise<AnalyzeApiResult> {
  const { status, data } = await request<
    PageAnalysis & { content_hash: string }
  >(`/extension/analysis/${contentHash}`);
  if (status === 202) return { status: "running", contentHash };
  return { status: "ready", analysis: data };
}

export async function chat(
  input: Extract<BackgroundRequest, { type: "chat" }>
): Promise<ChatResponse> {
  const { data } = await request<ChatResponse>("/extension/chat", {
    messages: input.messages,
    page: input.page,
  });
  return data;
}

/** Free (non-agentic) read used by the click-through panel. */
export async function getClaimDetail(claimId: string): Promise<unknown> {
  const settings = await getSettings();
  const res = await fetch(
    `${settings.apiBaseUrl.replace(/\/$/, "")}/claims/${claimId}?information_depth=deep`
  );
  if (!res.ok) throw new ApiError(`Failed to load claim (${res.status})`, res.status);
  return res.json();
}

/**
 * Propose one claim for the graph (POST /claims/propose). Governed intake: it
 * is queued for review, and only an accept matches it against the graph and
 * admits it. Charged the claim_proposal price, refunded if declined. The
 * caller sends the claim's wording and the reader's note, nothing from the
 * page itself.
 */
export async function proposeClaim(input: {
  claim: string;
  argument: string;
}): Promise<Submission> {
  const { data } = await request<{
    contribution?: { id: string; submitted_at: string };
  }>("/claims/propose", input);
  return submissionFrom(data.contribution?.id, data.contribution?.submitted_at);
}

function submissionFrom(id?: string, at?: string): Submission {
  return {
    contribution_id: id ?? null,
    submitted_at: at ?? new Date().toISOString(),
  };
}

/** Owl balance and prices, shown before a paid submission. */
export async function getEntitlement(): Promise<Entitlement> {
  const { data } = await request<{ entitlement: Entitlement }>("/usage?days=1");
  return data.entitlement;
}

// Prefix bucket → the full hashes in it, briefly, so browsing a site doesn't
// re-ask for the same bucket on every page.
const bucketCache = new Map<string, { hashes: Set<string>; expires: number }>();
const BUCKET_TTL_MS = 10 * 60 * 1000;

async function publicGet(path: string): Promise<Response> {
  const settings = await getSettings();
  // No API key: a lookup must not say who is asking.
  return fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}${path}`, {
    credentials: "omit",
  });
}

/**
 * Another reader's analysis of this page, or null. Private by construction:
 * only the hash's first few characters leave the browser unless the page is
 * in the shared cache, which holds public pages only.
 */
export async function lookupSharedAnalysis(urlHash: string): Promise<PageAnalysis | null> {
  const prefix = urlHash.slice(0, PAGE_HASH_PREFIX_CHARS);
  let bucket = bucketCache.get(prefix);
  if (!bucket || bucket.expires < Date.now()) {
    const res = await publicGet(`/extension/shared?prefix=${prefix}`);
    if (!res.ok) return null;
    const { hashes } = (await res.json()) as { hashes: string[] };
    bucket = { hashes: new Set(hashes), expires: Date.now() + BUCKET_TTL_MS };
    bucketCache.set(prefix, bucket);
  }
  if (!bucket.hashes.has(urlHash)) return null;

  const res = await publicGet(`/extension/shared/${urlHash}`);
  if (!res.ok) return null;
  return (await res.json()) as PageAnalysis;
}
