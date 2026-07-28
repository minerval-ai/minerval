/**
 * Extension analysis pipeline (issue #72).
 *
 * Orchestrates the browser extension's page analysis: extract claims from the
 * page text, match each against the graph (the Matcher is the single decider
 * of claim identity), pull the matched claims' graph state, and let the
 * extension agent decide what markup each claim deserves.
 *
 * Results are cached in-memory by url + content hash: pages are re-analyzed
 * only when their content actually changes, and concurrent requests for the
 * same page share one pipeline run. Most claims on most pages are already in
 * the graph — the cache exploits that redundancy at the page level.
 */
import crypto from "crypto";
import { loadConfig } from "../config.js";
import { extractClaims } from "../llm/agents/extractor.js";
import { matchClaim } from "../llm/agents/matcher.js";
import {
  assessPageClaims,
  type ClaimForAssessment,
  type ClaimVerdict,
} from "../llm/agents/extension-agent.js";
import { extensionChat, type ChatTurn } from "../llm/agents/extension-agent.js";
import { getClaimById } from "./claim-service.js";
import { getCurrentAssessment } from "./assessment-service.js";
import { rawQuery } from "../db/client.js";

/** Verdict the client can filter on; "unknown" = claim not in the graph. */
export type AnnotationVerdict =
  | "egregious"
  | "contested"
  | "oversimplified"
  | "noteworthy"
  | "fine"
  | "unknown";

export interface PageAnnotation {
  /** Exact text from the page, used by the extension to anchor markup. */
  original_text: string;
  context: string | null;
  source_location: string | null;
  verdict: AnnotationVerdict;
  /** One-line reader-facing explanation (hover card). */
  why: string;
  confidence: number;
  /** Whether the page affirms or denies the canonical claim. */
  stance: "affirms" | "denies";
  /** Matched canonical claim, or null when the claim is new/unknown. */
  claim: {
    id: string;
    canonical_form: string;
    status: string;
    status_confidence: number;
    subclaim_count: number;
    url: string;
  } | null;
}

export interface PageAnalysis {
  url: string;
  content_hash: string;
  annotations: PageAnnotation[];
  stats: {
    extracted: number;
    matched: number;
  };
  analyzed_at: string;
}

export function pageCacheKey(url: string, content: string): string {
  return crypto
    .createHash("sha256")
    .update(url)
    .update("\n")
    .update(content)
    .digest("hex");
}

/**
 * Small TTL cache with FIFO eviction. Page analyses are a few KB each, so a
 * few hundred entries is a negligible footprint for a large repeat-view win.
 */
export class AnalysisCache<T> {
  private entries = new Map<string, { value: T; expiresAt: number }>();

  constructor(
    private ttlMs: number,
    private maxEntries: number
  ) {}

  get(key: string, now = Date.now()): T | null {
    const hit = this.entries.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= now) {
      this.entries.delete(key);
      return null;
    }
    return hit.value;
  }

  set(key: string, value: T, now = Date.now()): void {
    if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
  }

  clear(): void {
    this.entries.clear();
  }
}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_ENTRIES = 500;
// Failures are cached briefly so pollers see "failed" instead of 404, but a
// fresh POST retries quickly rather than replaying a stale error.
const FAILURE_TTL_MS = 2 * 60 * 1000;

const cache = new AnalysisCache<PageAnalysis>(CACHE_TTL_MS, CACHE_MAX_ENTRIES);
// Concurrent requests for the same page share one pipeline run instead of
// each paying for extraction + matching.
const inFlight = new Map<string, Promise<PageAnalysis>>();
const failedRuns = new AnalysisCache<string>(FAILURE_TTL_MS, 100);

/** Test hook. */
export function resetAnalysisCache(): void {
  cache.clear();
  inFlight.clear();
  failedRuns.clear();
}

/** Link to the claim's page on the public site (same knob as the MCP server, #73). */
export function claimPageUrl(claimId: string): string {
  const base = loadConfig().publicWebBaseUrl.replace(/\/$/, "");
  return `${base}/claims/${claimId}`;
}

/** Run `fn` over items with at most `limit` concurrent executions. */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]!, i);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

/**
 * Assemble the final annotation list from the pipeline's intermediate stages.
 * Exported for tests; pure.
 */
export function buildAnnotations(input: {
  claims: Array<{
    original_text: string;
    context: string | null;
    source_location: string | null;
    stance: "affirms" | "denies";
    matched: {
      claimId: string;
      canonicalForm: string;
      status: string;
      statusConfidence: number;
      subclaimCount: number;
      claimUrl: string;
    } | null;
  }>;
  /** Verdicts keyed by claim index; missing/matched-less indices degrade. */
  verdicts: Map<number, ClaimVerdict>;
}): PageAnnotation[] {
  return input.claims.map((c, i) => {
    if (!c.matched) {
      // New/unknown to the graph: nothing to judge against. The extension
      // renders no markup for these (graceful degradation; ingestion from the
      // extension is a follow-up).
      return {
        original_text: c.original_text,
        context: c.context,
        source_location: c.source_location,
        verdict: "unknown" as const,
        why: "This claim isn't in the Minerval graph yet.",
        confidence: 0,
        stance: c.stance,
        claim: null,
      };
    }
    const v = input.verdicts.get(i);
    return {
      original_text: c.original_text,
      context: c.context,
      source_location: c.source_location,
      // If the assessor dropped the claim, fail safe to no markup.
      verdict: (v?.verdict ?? "fine") as AnnotationVerdict,
      why: v?.why ?? "",
      confidence: v?.confidence ?? 0,
      stance: c.stance,
      claim: {
        id: c.matched.claimId,
        canonical_form: c.matched.canonicalForm,
        status: c.matched.status,
        status_confidence: c.matched.statusConfidence,
        subclaim_count: c.matched.subclaimCount,
        url: c.matched.claimUrl,
      },
    };
  });
}

const CITATION_RE =
  /\[claim:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/gi;

/** Claim ids cited inline in a chat reply as [claim:<uuid>]. Exported for tests. */
export function extractCitedClaimIds(reply: string): string[] {
  return [...new Set([...reply.matchAll(CITATION_RE)].map((m) => m[1]!.toLowerCase()))];
}

export interface ChatCitation {
  id: string;
  canonical_form: string;
  status: string | null;
  url: string;
}

export async function chatAboutPage(input: {
  messages: ChatTurn[];
  page: {
    url: string | null;
    title: string | null;
    claims: Array<{
      original_text: string;
      verdict: string;
      claim_id: string | null;
      canonical_form: string | null;
      status: string | null;
    }>;
  };
}): Promise<{ reply: string; citations: ChatCitation[] }> {
  const config = loadConfig();
  const result = await extensionChat({
    messages: input.messages,
    pageUrl: input.page.url,
    pageTitle: input.page.title,
    pageClaims: input.page.claims,
    model: config.extensionModel,
  });

  // Hydrate every cited id that resolves in the graph. An id fabricated from
  // thin air virtually never resolves, so it is still dropped; an id the
  // agent legitimately saw anywhere (search results, other tool outputs, the
  // page context, an earlier turn) links correctly instead of being silently
  // deleted from the rendered reply (#181).
  const citedIds = extractCitedClaimIds(result.reply);

  const citations: ChatCitation[] = [];
  for (const id of citedIds.slice(0, 20)) {
    const [claim, assessment] = await Promise.all([
      getClaimById(id),
      getCurrentAssessment(id),
    ]);
    if (!claim) continue;
    citations.push({
      id,
      canonical_form: claim.text,
      status: assessment?.status ?? null,
      url: claimPageUrl(id),
    });
  }

  return { reply: result.reply, citations };
}

async function getSubclaimCount(claimId: string): Promise<number> {
  const rows = await rawQuery<{ count: string }>(
    `SELECT COUNT(*) AS count FROM claim_relationships WHERE parent_claim_id = $1`,
    [claimId]
  );
  return Number(rows[0]?.count ?? 0);
}

/**
 * Async analyze protocol (#93). A page analysis can run for minutes — longer
 * than any sane load-balancer timeout — so POST /extension/analyze no longer
 * blocks for the whole pipeline. startAnalysis() launches (or joins) the run,
 * waits a short grace window so small/cached pages still return in one round
 * trip, and otherwise reports "running"; the client polls getAnalysisByHash().
 */
export type AnalysisState =
  | { state: "ready"; analysis: PageAnalysis; cached: boolean }
  | { state: "running"; content_hash: string }
  | { state: "failed"; content_hash: string; error: string }
  | { state: "unknown" };

/** How long a POST waits before handing the client off to polling. */
const ANALYZE_GRACE_MS = 20_000;

/** Await `p` for at most `ms`, reporting how (or whether) it settled. */
async function settleWithin<T>(
  p: Promise<T>,
  ms: number
): Promise<
  { done: true; ok: true; value: T } | { done: true; ok: false; error: unknown } | { done: false }
> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p.then(
        (value) => ({ done: true as const, ok: true as const, value }),
        (error) => ({ done: true as const, ok: false as const, error })
      ),
      new Promise<{ done: false }>((resolve) => {
        timer = setTimeout(() => resolve({ done: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Launch the pipeline detached from the request: the run outlives the HTTP
 * response (the caller may already hold a 202), landing in the result cache
 * or the failure cache. The ambient usage context at launch time carries
 * user/key attribution through the whole run (AsyncLocalStorage).
 */
function launchRun(
  input: { url: string; title?: string; content: string },
  key: string
): Promise<PageAnalysis> {
  const run = analyzePageUncached(input, key)
    .then((analysis) => {
      cache.set(key, analysis);
      return analysis;
    })
    .catch((err) => {
      failedRuns.set(key, errorMessage(err));
      throw err;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, run);
  // A detached run's rejection is reported via the failure cache; without
  // this no-op handler it would also crash the process as unhandled.
  run.catch(() => {});
  return run;
}

export async function startAnalysis(
  input: { url: string; title?: string; content: string },
  opts: { graceMs?: number } = {}
): Promise<Exclude<AnalysisState, { state: "unknown" }>> {
  const key = pageCacheKey(input.url, input.content);

  const hit = cache.get(key);
  if (hit) return { state: "ready", analysis: hit, cached: true };

  const existing = inFlight.get(key);
  const run = existing ?? launchRun(input, key);

  const settled = await settleWithin(run, opts.graceMs ?? ANALYZE_GRACE_MS);
  if (!settled.done) return { state: "running", content_hash: key };
  if (!settled.ok) {
    return { state: "failed", content_hash: key, error: errorMessage(settled.error) };
  }
  return { state: "ready", analysis: settled.value, cached: existing !== undefined };
}

/** Poll a previously started run by its content hash. */
export function getAnalysisByHash(contentHash: string): AnalysisState {
  const hit = cache.get(contentHash);
  if (hit) return { state: "ready", analysis: hit, cached: true };
  if (inFlight.has(contentHash)) {
    return { state: "running", content_hash: contentHash };
  }
  const failure = failedRuns.get(contentHash);
  if (failure !== null) {
    return { state: "failed", content_hash: contentHash, error: failure };
  }
  return { state: "unknown" };
}

async function analyzePageUncached(
  input: { url: string; title?: string; content: string },
  contentHash: string
): Promise<PageAnalysis> {
  const config = loadConfig();

  const extracted = await extractClaims({
    content: input.content,
    sourceType: "webpage",
    additionalContext: input.title
      ? `Page title: ${input.title} (URL: ${input.url})`
      : `URL: ${input.url}`,
    maxClaims: config.extensionMaxClaims,
  });

  // Low-confidence extractions aren't worth a Matcher run from a live page.
  const candidates = extracted.filter((c) => c.confidence >= 0.5);

  // Matching dominates analyze wall-clock: one multi-turn Haiku loop per
  // claim. Haiku tolerates this parallelism comfortably; 8 roughly halves
  // page-analysis latency vs 4 (#92).
  const matchStages = await mapWithConcurrency(candidates, 8, async (c) => {
    const decision = await matchClaim({
      extractedText: c.original_text,
      proposedCanonical: c.proposed_canonical_form,
    });

    const base = {
      original_text: c.original_text,
      context: c.context,
      source_location: c.source_location,
      stance: decision.instance_stance,
      matchConfidence: decision.confidence,
    };

    if (!decision.is_match || !decision.matched_claim_id) {
      return { ...base, matched: null };
    }

    const claimId = decision.matched_claim_id;
    const [claim, assessment, subclaimCount] = await Promise.all([
      getClaimById(claimId),
      getCurrentAssessment(claimId),
      getSubclaimCount(claimId),
    ]);
    // The matcher can hallucinate an id; treat a missing claim as no match.
    if (!claim) return { ...base, matched: null };

    return {
      ...base,
      matched: {
        claimId,
        canonicalForm: claim.text,
        status: assessment?.status ?? "unknown",
        statusConfidence: assessment?.confidence ?? 0,
        reasoningExcerpt: assessment?.reasoningTrace?.slice(0, 600) ?? null,
        subclaimCount,
        claimUrl: claimPageUrl(claimId),
      },
    };
  });

  // Only matched claims go to the assessor — for unknown claims there is no
  // graph state to judge against.
  const forAssessment: ClaimForAssessment[] = [];
  matchStages.forEach((s, i) => {
    if (!s.matched) return;
    forAssessment.push({
      index: i,
      on_page_text: s.original_text,
      canonical_form: s.matched.canonicalForm,
      stance: s.stance,
      match_confidence: s.matchConfidence,
      graph: {
        status: s.matched.status,
        confidence: s.matched.statusConfidence,
        reasoning_excerpt: s.matched.reasoningExcerpt,
        subclaim_count: s.matched.subclaimCount,
      },
    });
  });

  const verdictList =
    forAssessment.length > 0
      ? await assessPageClaims({
          pageUrl: input.url,
          pageTitle: input.title ?? null,
          claims: forAssessment,
          model: config.extensionModel,
        })
      : [];
  const verdicts = new Map(verdictList.map((v) => [v.index, v]));

  return {
    url: input.url,
    content_hash: contentHash,
    annotations: buildAnnotations({ claims: matchStages, verdicts }),
    stats: {
      extracted: extracted.length,
      matched: matchStages.filter((s) => s.matched).length,
    },
    analyzed_at: new Date().toISOString(),
  };
}
