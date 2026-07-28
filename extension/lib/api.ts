import { getSettings } from "./settings";
import type {
  BackgroundRequest,
  ChatResponse,
  PageAnalysis,
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
  if (!settings.apiKey && !settings.apiBaseUrl.includes("localhost")) {
    throw new ApiError(
      "No API key configured. Create one in your Minerval dashboard and paste it in the extension settings.",
      401
    );
  }

  const res = await fetch(`${settings.apiBaseUrl.replace(/\/$/, "")}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(settings.apiKey ? { "x-api-key": settings.apiKey } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

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
