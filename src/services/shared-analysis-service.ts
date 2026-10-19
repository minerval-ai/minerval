/**
 * The browser extension's shared page cache: an analysis of a PUBLIC page,
 * kept so the next reader of that page sees the already-checked claims
 * without re-running (and paying for) extraction and matching.
 *
 * This is the one place the extension's work outlives the request, so the
 * privacy line from #356 is drawn here, narrowly:
 *
 *  - Only public pages. After an analysis the reader agreed to share, the
 *    server fetches the URL itself, with no cookies or credentials, and keeps
 *    the analysis only if most of its on-page phrases appear in that copy.
 *    An inbox, a logged-in view, a draft in an editor, a paywalled article:
 *    the anonymous fetch can't see them, so they never enter. The extension
 *    also withholds drafts (text in an editable region) and pages the reader
 *    opts out, before any of this runs.
 *  - Only what the markup needs. The normalized URL, and per claim the short
 *    on-page phrase that anchors the underline, the verdict and its one-line
 *    why, and the matched claim's id. No page text beyond those phrases, no
 *    title, and nothing about who analyzed it.
 *  - Nothing enters the graph from here. Claim statuses are not stored at
 *    all; they are re-read from the graph whenever an entry is served.
 *
 * Lookups are private by construction: the extension sends only a short
 * prefix of the URL's hash (PAGE_HASH_PREFIX_CHARS), gets back every stored
 * hash in that bucket, and asks for an entry only on an exact match, which
 * by the rule above is a public page.
 */
import { eq, and, gte, lt, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sharedPageAnalyses } from "../db/schema.js";
import { fetchPublicUrl } from "./url-guard.js";
import { htmlToText, normalizeForQuoteCheck } from "./source-map-service.js";
import {
  normalizePageUrl,
  pageUrlHash,
  PAGE_HASH_PREFIX_CHARS,
} from "./page-url.js";
import {
  AnalysisCache,
  loadMatchedClaim,
  type AnnotationVerdict,
  type PageAnalysis,
  type PageAnnotation,
} from "./extension-service.js";
import type { InstanceStance } from "../schemas/common.js";

/** What the cache keeps per claim: enough to anchor and explain, no more. */
export interface StoredAnnotation {
  verbatim_text: string;
  stance: InstanceStance;
  verdict: AnnotationVerdict;
  why: string;
  confidence: number;
  claim_id: string | null;
  proposed_canonical_form: string | null;
}

export function toStoredAnnotations(analysis: PageAnalysis): StoredAnnotation[] {
  return analysis.annotations.map((a) => ({
    verbatim_text: a.verbatim_text,
    stance: a.stance,
    verdict: a.verdict,
    why: a.why,
    confidence: a.confidence,
    claim_id: a.claim?.id ?? null,
    proposed_canonical_form: a.proposed_canonical_form,
  }));
}

/**
 * Share of the phrases found in the page text, both reduced to the
 * quote-check normal form (case, quotes, dashes and punctuation forgiven).
 */
export function phrasesFoundFraction(pageText: string, phrases: string[]): number {
  if (phrases.length === 0) return 0;
  const haystack = normalizeForQuoteCheck(pageText);
  const found = phrases.filter((p) => {
    const needle = normalizeForQuoteCheck(p);
    return needle.length > 0 && haystack.includes(needle);
  }).length;
  return found / phrases.length;
}

/**
 * How much of an analysis the anonymous copy must contain to count as the
 * same, public page. Not 1: a page's anonymous render can differ at the
 * edges (a logged-in reader sees comments or a sidebar a crawler doesn't).
 */
export const MIN_FOUND_FRACTION = 0.8;

export type ShareOutcome =
  | { shared: true; urlHash: string }
  | { shared: false; reason: "not_a_page" | "no_claims" | "not_public" | "fetch_failed" };

// One verification per page at a time: concurrent readers of the same page
// share it rather than each fetching the URL. A settled outcome is reused
// for a while too, so cache hits on a popular page don't each re-fetch it.
const verifying = new Map<string, Promise<ShareOutcome>>();
const recentOutcomes = new AnalysisCache<ShareOutcome>(15 * 60 * 1000, 2_000);

/**
 * Store an analysis in the shared cache if its page is public. Best-effort
 * and detached from any request: a failure only means the page isn't
 * shared. Replaces the page's previous entry, so a re-analysis of a changed
 * page refreshes it.
 */
export function shareIfPublic(
  rawUrl: string,
  analysis: PageAnalysis,
  deps: { fetchText?: (url: string) => Promise<string> } = {}
): Promise<ShareOutcome> {
  const url = normalizePageUrl(rawUrl);
  if (!url) return Promise.resolve({ shared: false, reason: "not_a_page" });
  if (analysis.annotations.length === 0) {
    return Promise.resolve({ shared: false, reason: "no_claims" });
  }
  const urlHash = pageUrlHash(url);
  const existing = verifying.get(urlHash);
  if (existing) return existing;
  // Keyed by the analysis too: a fresh analysis of a changed page must not
  // be turned away by the previous one's outcome.
  const recentKey = `${urlHash}:${analysis.content_hash}`;
  const recent = recentOutcomes.get(recentKey);
  if (recent) return Promise.resolve(recent);

  const run = (async (): Promise<ShareOutcome> => {
    let body: string;
    try {
      // The reader's own URL, not the normalized one: it is the address that
      // served them this page. SSRF-guarded like every server-side fetch.
      body = await (deps.fetchText ?? fetchPublicUrl)(rawUrl);
    } catch {
      return { shared: false, reason: "fetch_failed" };
    }
    const phrases = analysis.annotations.map((a) => a.verbatim_text);
    if (phrasesFoundFraction(htmlToText(body), phrases) < MIN_FOUND_FRACTION) {
      return { shared: false, reason: "not_public" };
    }

    const row = {
      urlHash,
      url,
      annotations: toStoredAnnotations(analysis),
      extracted: analysis.stats.extracted,
      analyzedAt: new Date(analysis.analyzed_at),
      verifiedAt: new Date(),
    };
    await getDb()
      .insert(sharedPageAnalyses)
      .values(row)
      .onConflictDoUpdate({
        target: sharedPageAnalyses.urlHash,
        set: {
          url: row.url,
          annotations: row.annotations,
          extracted: row.extracted,
          analyzedAt: row.analyzedAt,
          verifiedAt: row.verifiedAt,
        },
      });
    return { shared: true, urlHash };
  })()
    .then((outcome) => {
      if (outcome.shared || outcome.reason !== "fetch_failed") {
        recentOutcomes.set(recentKey, outcome);
      }
      return outcome;
    })
    .finally(() => verifying.delete(urlHash));
  verifying.set(urlHash, run);
  return run;
}

const PREFIX_RE = new RegExp(`^[0-9a-f]{${PAGE_HASH_PREFIX_CHARS}}$`);
const HASH_RE = /^[0-9a-f]{64}$/;
/** A bucket is ~1/65,536 of the cache; this only bounds a pathological one. */
const MAX_BUCKET = 1_000;

/** Every stored URL hash sharing a prefix. */
export async function listSharedHashes(prefix: string): Promise<string[]> {
  if (!PREFIX_RE.test(prefix)) throw new Error("invalid prefix");
  const rows = await getDb()
    .select({ urlHash: sharedPageAnalyses.urlHash })
    .from(sharedPageAnalyses)
    .where(
      and(
        gte(sharedPageAnalyses.urlHash, prefix),
        // 'g' sorts after every hex digit, so this closes the prefix range.
        lt(sharedPageAnalyses.urlHash, `${prefix}g`)
      )
    )
    .orderBy(sql`${sharedPageAnalyses.urlHash}`)
    .limit(MAX_BUCKET);
  return rows.map((r) => r.urlHash);
}

export interface SharedPageAnalysis extends PageAnalysis {
  shared: true;
}

/**
 * A stored analysis as the extension renders it, with each matched claim's
 * graph state read now. A claim that has since disappeared (merged away)
 * degrades to "not in the graph", the same as a fresh analysis would show.
 */
export async function getSharedAnalysis(urlHash: string): Promise<SharedPageAnalysis | null> {
  if (!HASH_RE.test(urlHash)) return null;
  const [row] = await getDb()
    .select()
    .from(sharedPageAnalyses)
    .where(eq(sharedPageAnalyses.urlHash, urlHash))
    .limit(1);
  if (!row) return null;

  const stored = row.annotations as StoredAnnotation[];
  const ids = [...new Set(stored.map((a) => a.claim_id).filter((x): x is string => !!x))];
  const claims = new Map(
    await Promise.all(ids.map(async (id) => [id, await loadMatchedClaim(id)] as const))
  );

  const annotations: PageAnnotation[] = stored.map((a) => {
    const matched = a.claim_id ? claims.get(a.claim_id) ?? null : null;
    const base = {
      verbatim_text: a.verbatim_text,
      context: null,
      source_location: null,
      stance: a.stance,
    };
    if (!matched) {
      return {
        ...base,
        verdict: "unknown" as const,
        why: "This claim isn't in the Minerval graph yet.",
        confidence: 0,
        proposed_canonical_form: a.proposed_canonical_form,
        claim: null,
      };
    }
    return {
      ...base,
      verdict: a.verdict,
      why: a.why,
      confidence: a.confidence,
      proposed_canonical_form: null,
      claim: {
        id: matched.claimId,
        canonical_form: matched.canonicalForm,
        status: matched.status,
        status_confidence: matched.statusConfidence,
        subclaim_count: matched.subclaimCount,
        url: matched.claimUrl,
      },
    };
  });

  return {
    url: row.url,
    content_hash: row.urlHash,
    annotations,
    stats: {
      extracted: row.extracted,
      matched: annotations.filter((a) => a.claim).length,
    },
    analyzed_at: row.analyzedAt.toISOString(),
    shared: true,
  };
}

/** Test hook. */
export function resetSharing(): void {
  verifying.clear();
  recentOutcomes.clear();
}
