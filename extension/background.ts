import { analyzePage, chat, getAnalysisStatus, getClaimDetail } from "~lib/api";
import type {
  AnalyzeProgress,
  BackgroundRequest,
  PageAnalysis,
  Result,
} from "~lib/types";

/**
 * Background service worker: the only place that talks to the Minerval API
 * (so the API key never enters page contexts), plus a per-worker analysis
 * cache and the toolbar badge.
 *
 * Analyze is asynchronous (#93): "analyze" starts (or joins) a server run and
 * may report not-done with a content hash; the content script then sends
 * short "check-analysis" messages. Each poll survives this worker being
 * killed between messages — the local cache is only an accelerator, the
 * server's cache (keyed by the same hash) is the source of truth.
 */

// Server content_hash → analysis. Mirrors the server cache for instant SPA
// back/forward; safe to lose on worker restart.
const analysisCache = new Map<string, PageAnalysis>();
const CACHE_MAX = 50;

function cacheAnalysis(analysis: PageAnalysis): void {
  if (analysisCache.size >= CACHE_MAX) {
    const oldest = analysisCache.keys().next().value;
    if (oldest !== undefined) analysisCache.delete(oldest);
  }
  analysisCache.set(analysis.content_hash, analysis);
}

async function handleAnalyze(
  req: Extract<BackgroundRequest, { type: "analyze" }>
): Promise<AnalyzeProgress> {
  const result = await analyzePage(req);
  if (result.status === "ready") {
    cacheAnalysis(result.analysis);
    return { done: true, analysis: result.analysis };
  }
  return { done: false, content_hash: result.contentHash };
}

async function handleCheckAnalysis(contentHash: string): Promise<AnalyzeProgress> {
  const hit = analysisCache.get(contentHash);
  if (hit) return { done: true, analysis: hit };

  const result = await getAnalysisStatus(contentHash);
  if (result.status === "ready") {
    cacheAnalysis(result.analysis);
    return { done: true, analysis: result.analysis };
  }
  return { done: false, content_hash: contentHash };
}

function setBadge(tabId: number | undefined, count: number): void {
  if (tabId === undefined) return;
  void chrome.action.setBadgeBackgroundColor({ color: "#8c2f24" });
  void chrome.action.setBadgeText({
    tabId,
    text: count > 0 ? String(count) : "",
  });
}

chrome.runtime.onMessage.addListener(
  (message: BackgroundRequest, sender, sendResponse) => {
    const respond = (result: Result<unknown>) => sendResponse(result);

    (async () => {
      try {
        switch (message.type) {
          case "analyze":
            respond({ ok: true, data: await handleAnalyze(message) });
            break;
          case "check-analysis":
            respond({
              ok: true,
              data: await handleCheckAnalysis(message.contentHash),
            });
            break;
          case "chat":
            respond({ ok: true, data: await chat(message) });
            break;
          case "claim-detail":
            respond({ ok: true, data: await getClaimDetail(message.claimId) });
            break;
          case "badge":
            setBadge(sender.tab?.id, message.count);
            respond({ ok: true, data: null });
            break;
        }
      } catch (err) {
        respond({
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    // Keep the message channel open for the async response.
    return true;
  }
);
