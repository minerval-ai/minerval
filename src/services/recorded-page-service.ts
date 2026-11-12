/**
 * What the graph itself recorded from a web page: the browser extension's
 * view of a page the graph holds as a source.
 *
 * A page enters the graph as a source when someone submits it, a grant's
 * research ingests it, or a Steward finds and cites it while assessing a
 * claim. Each passage the graph took from it is a claim instance: the
 * source's own words, attached to the claim, quantity or question they
 * state. A reader of that page can be shown those passages where they sit,
 * with what the graph currently says about each, without anyone running the
 * extension's analysis on it (#356's rule is untouched: nothing here comes
 * from a reader's page, and nothing a reader sends is kept).
 *
 * This is not an analysis and carries no verdict on the page. The extension
 * agent judges how a page's wording relates to the graph; no agent has done
 * that here. Each passage is served with the node's current state, read now,
 * and the stance the instance records, and the extension says only that.
 *
 * Everything served is already public on the source's page. Lookups go
 * through the same private prefix bucket as shared analyses
 * (services/shared-analysis-service.ts): the extension sends a short prefix
 * of the page URL's hash and asks for a page only on an exact match.
 */
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import { readerKey } from "../db/clearance.js";
import { PAGE_HASH_PREFIX_CHARS } from "./page-url.js";
import { AnalysisCache, loadMatchedClaim, type MatchedClaim } from "./extension-service.js";
import type { NodeKind } from "../schemas/kinds.js";

const PREFIX_RE = new RegExp(`^[0-9a-f]{${PAGE_HASH_PREFIX_CHARS}}$`);
const HASH_RE = /^[0-9a-f]{64}$/;
/** A bucket is ~1/65,536 of the sources; this only bounds a pathological one. */
const MAX_BUCKET = 1_000;
/**
 * Passages served for one page, oldest first. A heavily cited paper can
 * carry hundreds; past this the page is already dense with marks, and the
 * source's page on the site lists them all.
 */
export const MAX_RECORDED_PASSAGES = 200;

/**
 * A passage counts when it is there to find and still belongs to a live
 * node: it has text (a figure read from a table has none), its Steward has
 * not detached it, and its claim is active.
 */
const LIVE_INSTANCE_SQL = `
  ci.detached_at IS NULL
  AND btrim(ci.verbatim_text) <> ''
  AND EXISTS (SELECT 1 FROM claims c WHERE c.id = ci.claim_id AND c.state = 'active')`;

/** The page hashes, sharing a prefix, of sources the graph holds passages from. */
export async function listRecordedHashes(prefix: string): Promise<string[]> {
  if (!PREFIX_RE.test(prefix)) throw new Error("invalid prefix");
  const rows = await rawQuery<{ page_url_hash: string }>(
    `SELECT DISTINCT s.page_url_hash
       FROM sources s
      WHERE s.page_url_hash >= $1 AND s.page_url_hash < $2
        AND EXISTS (SELECT 1 FROM claim_instances ci
                     WHERE ci.source_id = s.id AND ${LIVE_INSTANCE_SQL})
      ORDER BY s.page_url_hash
      LIMIT ${MAX_BUCKET}`,
    // 'g' sorts after every hex digit, so this closes the prefix range.
    [prefix, `${prefix}g`]
  );
  return rows.map((r) => r.page_url_hash);
}

export interface RecordedPassage {
  /** The source's words as recorded: what the extension anchors on the page. */
  verbatim_text: string;
  /**
   * How the passage stands toward the node, as the instance records it:
   * affirms, denies, poses or mentions a claim; states a quantity's value;
   * asks or answers a question.
   */
  stance: string;
  instance_id: string;
  source_id: string;
  claim: {
    id: string;
    kind: NodeKind;
    canonical_form: string;
    /**
     * A claim's current status, or "unassessed" when it has no assessment
     * yet (which is not an assessed "unknown"). A quantity or question has
     * no status: for those this says only "assessed" or "unassessed", and
     * the summary carries what the graph holds.
     */
    status: string;
    status_confidence: number;
    /** The reader-facing summary of the current assessment, estimate or standing. */
    summary: string | null;
    subclaim_count: number;
    url: string;
  };
}

export interface RecordedPage {
  /** The rows the graph holds for this page (more than one when their URLs normalize alike). */
  sources: Array<{ id: string; title: string; url: string; retrieved_at: string }>;
  passages: RecordedPassage[];
  /** Passages the graph holds from the page, before the cap. */
  total: number;
}

function sourcePageUrl(sourceId: string): string {
  return `${loadConfig().publicWebBaseUrl.replace(/\/$/, "")}/sources/${sourceId}`;
}

function nodeStatus(m: MatchedClaim): string {
  if (m.kind === "claim") return m.assessed ? m.status : "unassessed";
  return m.assessed ? "assessed" : "unassessed";
}

// The endpoint is public and each page costs a few reads per node, so a
// page's answer is reused briefly; statuses are at most this stale. An
// answer is reused only for a reader of the same clearance (readerKey): the
// passages and nodes in it are the ones the first asker could read.
const recent = new AnalysisCache<RecordedPage>(60 * 1000, 500);

/** Claims loaded at once for one page. */
const LOAD_CONCURRENCY = 8;

/**
 * The passages the graph recorded from a page, by the hash of its normalized
 * URL, each with its node's state read now. Null when the graph holds no
 * such page, or holds it with nothing recorded from it.
 */
export async function getRecordedPage(urlHash: string): Promise<RecordedPage | null> {
  if (!HASH_RE.test(urlHash)) return null;
  const slot = `${readerKey()}:${urlHash}`;
  const hit = recent.get(slot);
  if (hit) return hit;

  const rows = await rawQuery<{
    id: string;
    verbatim_text: string;
    stance: string;
    claim_id: string;
    source_id: string;
    source_title: string;
    retrieved_at: Date;
    total: string;
  }>(
    `SELECT ci.id, ci.verbatim_text, ci.stance, ci.claim_id, ci.source_id,
            s.title AS source_title, s.retrieved_at,
            COUNT(*) OVER () AS total
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE s.page_url_hash = $1 AND ${LIVE_INSTANCE_SQL}
      ORDER BY ci.created_at, ci.id
      LIMIT ${MAX_RECORDED_PASSAGES}`,
    [urlHash]
  );
  if (rows.length === 0) return null;

  const ids = [...new Set(rows.map((r) => r.claim_id))];
  const nodes = new Map<string, MatchedClaim | null>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOAD_CONCURRENCY, ids.length) }, async () => {
      while (next < ids.length) {
        const id = ids[next++]!;
        nodes.set(id, await loadMatchedClaim(id));
      }
    })
  );

  const sources = new Map<string, RecordedPage["sources"][number]>();
  const passages: RecordedPassage[] = [];
  // One mark per passage and node: two rows for the same page (or a passage
  // recorded twice) would otherwise stack identical marks.
  const seen = new Set<string>();
  for (const r of rows) {
    const node = nodes.get(r.claim_id);
    if (!node) continue;
    const key = `${r.claim_id}\n${r.verbatim_text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.set(r.source_id, {
      id: r.source_id,
      title: r.source_title,
      url: sourcePageUrl(r.source_id),
      retrieved_at: new Date(r.retrieved_at).toISOString(),
    });
    passages.push({
      verbatim_text: r.verbatim_text,
      stance: r.stance,
      instance_id: r.id,
      source_id: r.source_id,
      claim: {
        id: node.claimId,
        kind: node.kind,
        canonical_form: node.canonicalForm,
        status: nodeStatus(node),
        status_confidence: node.statusConfidence,
        summary: node.summary,
        subclaim_count: node.subclaimCount,
        url: node.claimUrl,
      },
    });
  }
  if (passages.length === 0) return null;

  const page: RecordedPage = {
    sources: [...sources.values()],
    passages,
    total: Number(rows[0]!.total),
  };
  recent.set(slot, page);
  return page;
}

/** Test hook. */
export function resetRecordedPages(): void {
  recent.clear();
}
