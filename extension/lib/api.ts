import { PAGE_HASH_PREFIX_CHARS } from "./page-url";
import { getSettings, isCustomApiBaseUrl } from "./settings";
import type {
  BackgroundRequest,
  ChatResponse,
  Entitlement,
  PageAnalysis,
  PageLookup,
  RecordedPage,
  Submission,
  SubmissionProgress,
} from "./types";

/**
 * Minerval API client. Runs in the background service worker only, so page
 * scripts never see the API key. Both agentic endpoints authenticate with the
 * user's API key and are metered per-token server-side (#70).
 */

const WEB_BASE = "https://minerval.ai";

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
  const res = await send(path, body);
  return { status: res.status, data: (await res.json()) as T };
}

/** Make an API call; a non-2xx answer throws ApiError with a readable message. */
async function send(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<Response> {
  const settings = await getSettings();
  // The localhost carve-out is deliberate: a keyless local API takes the dev
  // bypass (server/plugins/auth.ts), so a developer pointing here shouldn't be
  // made to mint a key. It only misfired because the DEFAULT base URL was
  // localhost, which sent fresh installs down the dev path and left them with a
  // bare network error instead of this message. With the default now pointing at
  // the hosted API, the carve-out only applies to someone who asked for it.
  if (!settings.apiKey && !settings.apiBaseUrl.includes("localhost")) {
    throw new ApiError(
      "No API key configured. Create one at minerval.ai/account and paste it in the extension settings.",
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
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    // A network-level failure surfaces in Chrome as a bare "Failed to fetch",
    // which background.ts forwards verbatim to the panel. Say which host could
    // not be reached, since a misconfigured base URL is the usual cause and the
    // raw message gives the user nothing to act on.
    throw new ApiError(
      isCustomApiBaseUrl(settings)
        ? `Could not reach the Minerval API at ${settings.apiBaseUrl}. Check the API base URL under Settings → Developer.`
        : "Could not reach Minerval. Check your connection and try again.",
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

  return res;
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

/** The most page findings sent with a new conversation (the route's limit). */
const MAX_PAGE_CLAIMS = 200;
// The server saves the reply-so-far about once a second.
const POLL_MS = 1_200;

interface AssistantConversation {
  id: string;
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    citations?: Array<{ id: string; text: string; status: string | null; url: string }>;
    cost_micro_usd?: number;
    cards?: Array<{ type: string; id: string }>;
    stopped?: "user" | "balance";
  }>;
  held_actions: Array<{ id: string; status: string }>;
  turn: { state: "replying" | "idle" | "failed"; error: string | null; partial: string | null; note: string | null };
}

/**
 * Ask the Assistant, the agent that works for the user's account, from the
 * page being read. The question opens a conversation (told which page it
 * came from and what the extension found on it) or continues the tab's one;
 * the reply is written on the server and read here until it is finished.
 * `onText` gets the reply so far, each time with a new turn number, since
 * each reading replaces the last; `onConversation` gets the conversation's
 * id as soon as it exists, so the reply can be stopped while it runs.
 *
 * The work is charged to the user's owl balance as it runs, at what it
 * costs. Anything the Assistant prepares that would spend owls on the graph
 * or publish under the user's name waits for them on minerval.ai: the
 * extension holds only an API key, which cannot release it.
 */
export async function chat(
  input: Extract<BackgroundRequest, { type: "chat" }>,
  onText: (delta: string, turn: number) => void = () => {},
  onConversation: (id: string) => void = () => {}
): Promise<ChatResponse> {
  const question = input.messages.at(-1)?.content ?? "";
  const started = input.conversationId
    ? await request<{ conversation: AssistantConversation }>(
        `/assistant/conversations/${encodeURIComponent(input.conversationId)}/messages`,
        { message: question }
      )
    : await request<{ conversation: AssistantConversation }>("/assistant/conversations", {
        message: question,
        page: { ...input.page, claims: input.page.claims.slice(0, MAX_PAGE_CLAIMS) },
      });
  let convo = started.data.conversation;
  onConversation(convo.id);

  let reads = 0;
  let shown = "";
  while (convo.turn.state === "replying") {
    await new Promise((r) => setTimeout(r, POLL_MS));
    try {
      convo = (
        await request<{ conversation: AssistantConversation }>(
          `/assistant/conversations/${encodeURIComponent(convo.id)}`
        )
      ).data.conversation;
    } catch (err) {
      // A dropped read is retried; a refusal is not.
      if (err instanceof ApiError && err.status !== 0 && err.status < 500) throw err;
      continue;
    }
    const partial = convo.turn.partial || convo.turn.note || "";
    if (convo.turn.state === "replying" && partial && partial !== shown) {
      shown = partial;
      onText(partial, reads++);
    }
  }
  if (convo.turn.state === "failed") {
    throw new ApiError(
      `The Assistant could not reply${convo.turn.error ? ` (${convo.turn.error})` : ""}. Your question is saved; ask again.`,
      502
    );
  }
  const reply = convo.messages.at(-1);
  if (!reply || reply.role !== "assistant") {
    throw new ApiError("The answer stopped before it finished. Please try again.", 502);
  }
  const held = new Set(convo.held_actions.filter((h) => h.status === "held").map((h) => h.id));
  const cards = reply.cards ?? [];
  return {
    reply: reply.content,
    citations: (reply.citations ?? []).map((c) => ({
      id: c.id,
      canonical_form: c.text,
      status: c.status,
      url: c.url,
    })),
    conversation_id: convo.id,
    ...(typeof reply.cost_micro_usd === "number" ? { cost_micro_usd: reply.cost_micro_usd } : {}),
    waiting: cards.filter((c) => c.type === "held" && held.has(c.id)).length,
    pages: cards.filter((c) => c.type === "page").map((c) => c.id),
    ...(reply.stopped ? { stopped: reply.stopped } : {}),
  };
}

/** Ask a conversation's running reply to stop at its next step. */
export async function stopChat(conversationId: string): Promise<void> {
  await request(`/assistant/conversations/${encodeURIComponent(conversationId)}/stop`, {});
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

/**
 * Where a proposal stands (GET /contributions/:id), and, once it is accepted
 * and admitted, the claim it became with that claim's current status (a
 * cursory GET /claims/:id). Both are free reads.
 */
export async function getSubmissionProgress(
  contributionId: string
): Promise<SubmissionProgress> {
  const { data } = await request<{
    contribution: {
      review_status: string;
      became_claim_id: string | null;
      page_url: string | null;
    };
  }>(`/contributions/${contributionId}`);
  const c = data.contribution;
  if (c.review_status !== "accepted" || !c.became_claim_id) {
    return { review_status: c.review_status, claim: null };
  }
  const { data: detail } = await request<{
    claim: { id: string; text: string };
    assessment: { status: string; confidence: number } | null;
    subclaim_count?: number;
  }>(`/claims/${c.became_claim_id}?information_depth=cursory`);
  return {
    review_status: c.review_status,
    claim: {
      id: detail.claim.id,
      canonical_form: detail.claim.text,
      // Not yet assessed is not an assessed "unknown"; say which it is.
      status: detail.assessment?.status ?? "unassessed",
      status_confidence: detail.assessment?.confidence ?? 0,
      subclaim_count: detail.subclaim_count ?? 0,
      url: c.page_url ?? `${WEB_BASE}/claims/${detail.claim.id}`,
    },
  };
}

/** Owl balance and prices, shown before a paid submission. */
export async function getEntitlement(): Promise<Entitlement> {
  const { data } = await request<{ entitlement: Entitlement }>("/usage?days=1");
  return data.entitlement;
}

// Prefix bucket → the full hashes in it, briefly, so browsing a site doesn't
// re-ask for the same bucket on every page.
const bucketCache = new Map<
  string,
  { hashes: Set<string>; recorded: Set<string>; expires: number }
>();
const BUCKET_TTL_MS = 10 * 60 * 1000;

async function publicGet(path: string): Promise<Response> {
  const settings = await getSettings();
  // No API key: a lookup must not say who is asking.
  return fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}${path}`, {
    credentials: "omit",
  });
}

/**
 * What is already known about this page: another reader's analysis of it,
 * and the passages the graph recorded if it read the page as a source.
 * Private by construction: only the hash's first few characters leave the
 * browser unless the page is in the shared cache or the graph's sources,
 * both of which hold public pages only.
 */
export async function lookupPage(urlHash: string): Promise<PageLookup> {
  const prefix = urlHash.slice(0, PAGE_HASH_PREFIX_CHARS);
  let bucket = bucketCache.get(prefix);
  if (!bucket || bucket.expires < Date.now()) {
    const res = await publicGet(`/extension/shared?prefix=${prefix}`);
    if (!res.ok) return { analysis: null, recorded: null };
    const { hashes, recorded } = (await res.json()) as {
      hashes: string[];
      // Absent from an API older than this lookup.
      recorded?: string[];
    };
    bucket = {
      hashes: new Set(hashes),
      recorded: new Set(recorded ?? []),
      expires: Date.now() + BUCKET_TTL_MS,
    };
    bucketCache.set(prefix, bucket);
  }

  const get = async <T>(path: string): Promise<T | null> => {
    const res = await publicGet(path);
    return res.ok ? ((await res.json()) as T) : null;
  };
  const [analysis, recorded] = await Promise.all([
    bucket.hashes.has(urlHash) ? get<PageAnalysis>(`/extension/shared/${urlHash}`) : null,
    bucket.recorded.has(urlHash) ? get<RecordedPage>(`/extension/recorded/${urlHash}`) : null,
  ]);
  return { analysis, recorded };
}
