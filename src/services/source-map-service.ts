/**
 * Source provenance (#286): what a claim's support rests on, made legible.
 *
 * Four tables carry it (src/db/schema.ts): `claim_provenance_edges`, from one
 * source's assertion of a claim (a claim_instances row) to the document that
 * assertion draws on; `source_relationships`, facts about a pair of documents
 * that hold whatever claim is traced; `claim_instance_readings`, the judgment
 * from actually opening one source and reading it against the claim; and
 * `claim_source_maps`, the per-claim reader-facing account, refreshed in
 * place. Every row is a recorded judgment of the agent that wrote it, never
 * an import of a citation index, and nothing here computes a verdict: no
 * independence score, no concentration index, no discount. The map makes
 * structure visible; the Steward adjudicates it (Part VIII, §9).
 *
 * The one mechanical thing in this module is the quote check: whether an
 * instance's recorded passage is actually in the stored text of its source.
 * A substring test is exact, free, and auditable where a model is none of
 * the three, so it is never delegated to one.
 *
 * Every write here validates its inputs and throws a SourceMapError with a
 * message written for the agent; the tool executors turn that into a
 * structured refusal (§20).
 */
import { rawQuery } from "../db/client.js";
import { fetchPublicUrl } from "./url-guard.js";
import { getOrCreateSource } from "./source-service.js";
import {
  CLAIM_PROVENANCE_RELATION_TYPES,
  INSTANCE_SUPPORT_READINGS,
  PROVENANCE_FIDELITY,
  QUOTE_CHECK_RESULTS,
  SOURCE_RELATION_TYPES,
  SYMMETRIC_SOURCE_RELATIONS,
} from "../schemas/common.js";

export class SourceMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceMapError";
  }
}

export type QuoteCheckResult = (typeof QUOTE_CHECK_RESULTS)[number];

// ---------------------------------------------------------------------------
// Text handling
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Whether stored content looks like an HTML document rather than plain text. */
export function looksLikeHtml(content: string): boolean {
  const head = content.slice(0, 4000);
  return /<(!doctype\s+html|html|head|body)[\s>]/i.test(head) || /<\/?(p|div|span|a|br|h[1-6])[\s>]/i.test(head);
}

/**
 * Reduce an HTML document to readable text: scripts, styles, and markup
 * removed, block boundaries kept as line breaks, entities decoded, and
 * whitespace collapsed. Plain text passes through with only its whitespace
 * normalized. Good enough to read a page and to test a quote against; not
 * a layout engine.
 */
export function htmlToText(content: string): string {
  if (!looksLikeHtml(content)) return content.replace(/\r\n?/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  let text = content
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(head|script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/\s*(p|div|li|tr|h[1-6]|blockquote|section|article|header|footer|pre|table|ul|ol|dd|dt|figcaption)\s*>/gi, "\n\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The normal form both sides of a quote check are reduced to: lower case,
 * every dash a hyphen, every quotation mark straight, no punctuation at all,
 * one space between words. Generous on purpose: a quotation that survived a
 * copy with curly quotes and a soft hyphen is still the quotation.
 */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‐-―−]/g, "-")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/­/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Whether `quote` appears in `content`: verbatim, after normalization, or
 * not at all. `no_stored_content` when there is nothing to check against.
 * Mechanical, and the only judgment-free field on a reading.
 */
export function quoteCheck(quote: string, content: string | null | undefined): QuoteCheckResult {
  if (!content || !content.trim()) return "no_stored_content";
  const q = quote.trim();
  if (!q) return "not_found";
  if (content.includes(q)) return "verbatim";
  const text = looksLikeHtml(content) ? htmlToText(content) : content;
  if (text.includes(q)) return "verbatim";
  const nq = normalizeForQuoteCheck(q);
  if (!nq) return "not_found";
  return normalizeForQuoteCheck(text).includes(nq) ? "normalized_match" : "not_found";
}

// ---------------------------------------------------------------------------
// Reading a source
// ---------------------------------------------------------------------------

/** The most text one read returns; the caller pages with `offset`. */
export const SOURCE_READ_MAX_CHARS = 20_000;
export const SOURCE_READ_DEFAULT_CHARS = 12_000;

export interface SourceReadResult {
  source: { id: string; url: string | null; title: string; source_type: string };
  /** Where the text came from: the stored copy, or a fetch made for this read and stored. */
  origin: "stored" | "fetched";
  total_chars: number;
  offset: number;
  content: string;
  /** True when more text follows this window. */
  truncated: boolean;
}

interface SourceRow {
  id: string;
  url: string | null;
  title: string;
  source_type: string;
  raw_content: string | null;
}

async function findSource(ref: { sourceId?: string; url?: string }): Promise<SourceRow | null> {
  if (ref.sourceId) {
    const [row] = await rawQuery<SourceRow>(
      `SELECT id, url, title, source_type, raw_content FROM sources WHERE id = $1`,
      [ref.sourceId]
    );
    return row ?? null;
  }
  if (ref.url) {
    const [row] = await rawQuery<SourceRow>(
      `SELECT id, url, title, source_type, raw_content FROM sources WHERE url = $1`,
      [ref.url]
    );
    return row ?? null;
  }
  return null;
}

/**
 * The readable text of a source, windowed. A source with no stored copy is
 * fetched through the same guarded path ingestion uses and the copy is
 * stored, so the next read and the quote check see the same text the agent
 * read. A URL not yet in the graph is created as a source first, without
 * enqueueing extraction, exactly as record_claim_instance does.
 */
export async function readSourceContent(input: {
  sourceId?: string;
  url?: string;
  offset?: number;
  maxChars?: number;
  /** Test seam and policy hook: replace the network fetch. */
  fetch?: (url: string) => Promise<string>;
}): Promise<SourceReadResult> {
  let source = await findSource(input);
  if (!source && input.url) {
    const created = await getOrCreateSource({ url: input.url });
    source = {
      id: created.id,
      url: created.url,
      title: created.title,
      source_type: created.sourceType,
      raw_content: created.rawContent,
    };
  }
  if (!source) {
    throw new SourceMapError(
      input.sourceId
        ? `No source ${input.sourceId} exists. Take source ids from provenance_get_map.`
        : "Pass a source_id or a url."
    );
  }
  let origin: SourceReadResult["origin"] = "stored";
  let raw = source.raw_content;
  if (!raw || !raw.trim()) {
    if (!source.url) {
      throw new SourceMapError(
        `Source "${source.title}" has no stored text and no URL to fetch it from.`
      );
    }
    const fetcher = input.fetch ?? ((u: string) => fetchPublicUrl(u));
    raw = await fetcher(source.url);
    origin = "fetched";
    await rawQuery(
      `UPDATE sources SET raw_content = $2, retrieved_at = now()
        WHERE id = $1 AND (raw_content IS NULL OR raw_content = '')`,
      [source.id, raw]
    );
  }
  const text = htmlToText(raw);
  const offset = Math.max(0, Math.floor(input.offset ?? 0));
  const maxChars = Math.min(
    SOURCE_READ_MAX_CHARS,
    Math.max(1, Math.floor(input.maxChars ?? SOURCE_READ_DEFAULT_CHARS))
  );
  const content = text.slice(offset, offset + maxChars);
  return {
    source: { id: source.id, url: source.url, title: source.title, source_type: source.source_type },
    origin,
    total_chars: text.length,
    offset,
    content,
    truncated: offset + content.length < text.length,
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function oneOf<T extends readonly string[]>(
  value: unknown,
  allowed: T,
  field: string
): T[number] {
  const v = typeof value === "string" ? value.trim() : "";
  if (!(allowed as readonly string[]).includes(v)) {
    throw new SourceMapError(`${field} must be one of ${allowed.join(", ")} (got "${v}").`);
  }
  return v as T[number];
}

function requiredText(value: unknown, field: string, max = 4000): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new SourceMapError(`${field} is required.`);
  if (v.length > max) throw new SourceMapError(`${field} is too long (${v.length} characters; at most ${max}).`);
  return v;
}

function optionalText(value: unknown, field: string, max = 4000): string | null {
  if (value === undefined || value === null) return null;
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) return null;
  if (v.length > max) throw new SourceMapError(`${field} is too long (${v.length} characters; at most ${max}).`);
  return v;
}

function unitConfidence(value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new SourceMapError("confidence must be a number between 0 and 1.");
  }
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: unknown, field: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!UUID_RE.test(v)) throw new SourceMapError(`${field} must be a uuid (got "${v}").`);
  return v;
}

interface InstanceRow {
  id: string;
  claim_id: string;
  source_id: string;
  verbatim_text: string;
  raw_content: string | null;
}

async function instanceOfClaim(instanceId: string, claimId: string): Promise<InstanceRow> {
  const [row] = await rawQuery<InstanceRow>(
    `SELECT ci.id, ci.claim_id, ci.source_id, ci.verbatim_text, s.raw_content
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE ci.id = $1`,
    [instanceId]
  );
  if (!row) {
    throw new SourceMapError(
      `No instance ${instanceId} exists. Take instance ids from provenance_get_map.`
    );
  }
  if (row.claim_id !== claimId) {
    throw new SourceMapError(
      `Instance ${instanceId} belongs to another claim; you may only record provenance on the claim you steward.`
    );
  }
  return row;
}

export interface RecordInstanceReadingInput {
  claimId: string;
  instanceId: string;
  support: string;
  deployment?: string | null;
  note?: string | null;
  worthReading?: boolean;
  worthReadingReason?: string | null;
  sourceRead?: boolean;
  model?: string | null;
  createdBy: string;
}

/**
 * Record (or replace) the reading of one instance: whether the source's own
 * evidence bears the assertion it makes, what it deploys the claim for, and
 * whether the Steward should open it. The quote check is computed here from
 * the stored text, never taken from the caller.
 */
export async function recordInstanceReading(input: RecordInstanceReadingInput): Promise<{
  id: string;
  quote_check: QuoteCheckResult;
  replaced: boolean;
}> {
  const instanceId = uuid(input.instanceId, "instance_id");
  const instance = await instanceOfClaim(instanceId, input.claimId);
  const support = oneOf(input.support, INSTANCE_SUPPORT_READINGS, "support");
  const deployment = optionalText(input.deployment, "deployment", 2000);
  const note = optionalText(input.note, "note", 4000);
  const worthReading = input.worthReading === true;
  const worthReadingReason = optionalText(input.worthReadingReason, "worth_reading_reason", 2000);
  if (worthReading && !worthReadingReason) {
    throw new SourceMapError(
      "worth_reading_reason is required when worth_reading is true: say what a close reading would settle."
    );
  }
  const check = quoteCheck(instance.verbatim_text, instance.raw_content);
  const rows = await rawQuery<{ id: string; inserted: boolean }>(
    `INSERT INTO claim_instance_readings
       (instance_id, support, deployment, note, quote_check, worth_reading,
        worth_reading_reason, source_read, model, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (instance_id) DO UPDATE SET
       support = EXCLUDED.support,
       deployment = EXCLUDED.deployment,
       note = EXCLUDED.note,
       quote_check = EXCLUDED.quote_check,
       worth_reading = EXCLUDED.worth_reading,
       worth_reading_reason = EXCLUDED.worth_reading_reason,
       source_read = EXCLUDED.source_read,
       model = EXCLUDED.model,
       created_by = EXCLUDED.created_by,
       updated_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      instanceId,
      support,
      deployment,
      note,
      check,
      worthReading,
      worthReadingReason,
      input.sourceRead === true,
      input.model ?? null,
      input.createdBy,
    ]
  );
  const row = rows[0]!;
  return { id: row.id, quote_check: check, replaced: !row.inserted };
}

export interface RecordProvenanceEdgeInput {
  claimId: string;
  fromInstanceId: string;
  /** The document drawn upon: by id, or by URL (created as a source when new). */
  toSourceId?: string | null;
  toSourceUrl?: string | null;
  toSourceTitle?: string | null;
  relationType: string;
  fidelity?: string | null;
  evidence: string;
  reasoning: string;
  confidence?: number | null;
  targetRead?: boolean;
  createdBy: string;
}

/**
 * Record (or replace) one provenance edge. The target instance, where the
 * upstream document also asserts the claim, is found rather than supplied:
 * an instance of the same claim on the target source, when one exists.
 */
export async function recordProvenanceEdge(input: RecordProvenanceEdgeInput): Promise<{
  id: string;
  to_source_id: string;
  to_instance_id: string | null;
  replaced: boolean;
}> {
  const fromInstanceId = uuid(input.fromInstanceId, "from_instance_id");
  const from = await instanceOfClaim(fromInstanceId, input.claimId);
  const relationType = oneOf(input.relationType, CLAIM_PROVENANCE_RELATION_TYPES, "relation_type");
  const fidelity = input.fidelity == null || input.fidelity === ""
    ? "unclear"
    : oneOf(input.fidelity, PROVENANCE_FIDELITY, "fidelity");
  const evidence = requiredText(input.evidence, "evidence", 4000);
  const reasoning = requiredText(input.reasoning, "reasoning", 4000);
  const confidence = unitConfidence(input.confidence, 0.5);

  let toSourceId: string;
  if (input.toSourceId) {
    toSourceId = uuid(input.toSourceId, "to_source_id");
    const [target] = await rawQuery<{ id: string }>(`SELECT id FROM sources WHERE id = $1`, [toSourceId]);
    if (!target) {
      throw new SourceMapError(
        `No source ${toSourceId} exists. Pass to_source_url instead to record a document not yet in the graph.`
      );
    }
  } else if (input.toSourceUrl) {
    const url = requiredText(input.toSourceUrl, "to_source_url", 2000);
    if (!/^https?:\/\//i.test(url)) {
      throw new SourceMapError("to_source_url must be an http(s) URL.");
    }
    const created = await getOrCreateSource({
      url,
      title: optionalText(input.toSourceTitle, "to_source_title", 500) ?? undefined,
    });
    toSourceId = created.id;
  } else {
    throw new SourceMapError("Pass to_source_id (a source already in the graph) or to_source_url.");
  }
  if (toSourceId === from.source_id) {
    throw new SourceMapError(
      "An assertion cannot draw on its own document. If two passages in one source relate, that is not a provenance edge."
    );
  }

  // Where the upstream document also asserts this claim, link the instance
  // so the propagation chain is a join away.
  const [toInstance] = await rawQuery<{ id: string }>(
    `SELECT id FROM claim_instances WHERE claim_id = $1 AND source_id = $2 ORDER BY created_at LIMIT 1`,
    [input.claimId, toSourceId]
  );

  const rows = await rawQuery<{ id: string; inserted: boolean }>(
    `INSERT INTO claim_provenance_edges
       (from_instance_id, to_source_id, to_instance_id, relation_type, fidelity,
        evidence, reasoning, confidence, target_read, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (from_instance_id, to_source_id, relation_type) DO UPDATE SET
       to_instance_id = EXCLUDED.to_instance_id,
       fidelity = EXCLUDED.fidelity,
       evidence = EXCLUDED.evidence,
       reasoning = EXCLUDED.reasoning,
       confidence = EXCLUDED.confidence,
       target_read = EXCLUDED.target_read,
       created_by = EXCLUDED.created_by,
       created_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [
      fromInstanceId,
      toSourceId,
      toInstance?.id ?? null,
      relationType,
      fidelity,
      evidence,
      reasoning,
      confidence,
      input.targetRead === true,
      input.createdBy,
    ]
  );
  const row = rows[0]!;
  return {
    id: row.id,
    to_source_id: toSourceId,
    to_instance_id: toInstance?.id ?? null,
    replaced: !row.inserted,
  };
}

export interface RecordSourceRelationshipInput {
  parentSourceId: string;
  childSourceId: string;
  relationType: string;
  reasoning: string;
  confidence?: number | null;
  createdBy: string;
}

/**
 * Record (or replace) a claim-independent relation between two documents.
 * Symmetric relations are stored canonically, smaller id first, so one fact
 * cannot enter twice as its own mirror.
 */
export async function recordSourceRelationship(input: RecordSourceRelationshipInput): Promise<{
  id: string;
  parent_source_id: string;
  child_source_id: string;
  replaced: boolean;
}> {
  let parent = uuid(input.parentSourceId, "parent_source_id");
  let child = uuid(input.childSourceId, "child_source_id");
  const relationType = oneOf(input.relationType, SOURCE_RELATION_TYPES, "relation_type");
  const reasoning = requiredText(input.reasoning, "reasoning", 4000);
  const confidence = unitConfidence(input.confidence, 0.5);
  if (parent === child) {
    throw new SourceMapError("A source cannot be related to itself.");
  }
  if (SYMMETRIC_SOURCE_RELATIONS.has(relationType) && child < parent) {
    [parent, child] = [child, parent];
  }
  const found = await rawQuery<{ id: string }>(
    `SELECT id FROM sources WHERE id = $1 OR id = $2`,
    [parent, child]
  );
  if (found.length !== 2) {
    throw new SourceMapError("Both sources must already exist in the graph; take their ids from provenance_get_map.");
  }
  const rows = await rawQuery<{ id: string; inserted: boolean }>(
    `INSERT INTO source_relationships
       (parent_source_id, child_source_id, relation_type, reasoning, confidence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (parent_source_id, child_source_id, relation_type) DO UPDATE SET
       reasoning = EXCLUDED.reasoning,
       confidence = EXCLUDED.confidence,
       created_by = EXCLUDED.created_by,
       created_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [parent, child, relationType, reasoning, confidence, input.createdBy]
  );
  const row = rows[0]!;
  return { id: row.id, parent_source_id: parent, child_source_id: child, replaced: !row.inserted };
}

export interface WriteSourceMapInput {
  claimId: string;
  summary: string;
  material: boolean;
  model?: string | null;
  mappedBy: string;
}

/**
 * Write (or replace) the claim's source map: the reader-facing account of
 * what the support rests on, and whether it is worth surfacing at all. The
 * counts are bookkeeping derived from the tables at write time.
 */
export async function writeSourceMap(input: WriteSourceMapInput): Promise<{
  id: string;
  sources_considered: number;
  sources_read: number;
  edges_recorded: number;
  replaced: boolean;
}> {
  const claimId = uuid(input.claimId, "claim_id");
  const summary = requiredText(input.summary, "summary", 6000);
  if (summary.includes("—")) {
    throw new SourceMapError(
      "The summary is reader-facing prose in the graph's voice: no em-dashes (§12). Use a comma, a colon, or a new sentence."
    );
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(summary)) {
    throw new SourceMapError(
      "The summary must refer to sources by what they say, never by identifier (§12)."
    );
  }
  const [counts] = await rawQuery<{
    sources_considered: number | string;
    sources_read: number | string;
    edges_recorded: number | string;
  }>(
    `SELECT
       (SELECT COUNT(DISTINCT ci.source_id) FROM claim_instances ci WHERE ci.claim_id = $1) AS sources_considered,
       (SELECT COUNT(*) FROM claim_instance_readings r
          JOIN claim_instances ci ON ci.id = r.instance_id
         WHERE ci.claim_id = $1 AND r.source_read) AS sources_read,
       (SELECT COUNT(*) FROM claim_provenance_edges e
          JOIN claim_instances ci ON ci.id = e.from_instance_id
         WHERE ci.claim_id = $1) AS edges_recorded`,
    [claimId]
  );
  const sourcesConsidered = Number(counts?.sources_considered ?? 0);
  const sourcesRead = Number(counts?.sources_read ?? 0);
  const edgesRecorded = Number(counts?.edges_recorded ?? 0);
  const rows = await rawQuery<{ id: string; inserted: boolean }>(
    `INSERT INTO claim_source_maps
       (claim_id, summary, material, sources_considered, sources_read, edges_recorded, model, mapped_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (claim_id) DO UPDATE SET
       summary = EXCLUDED.summary,
       material = EXCLUDED.material,
       sources_considered = EXCLUDED.sources_considered,
       sources_read = EXCLUDED.sources_read,
       edges_recorded = EXCLUDED.edges_recorded,
       model = EXCLUDED.model,
       mapped_by = EXCLUDED.mapped_by,
       mapped_at = now()
     RETURNING id, (xmax = 0) AS inserted`,
    [claimId, summary, input.material === true, sourcesConsidered, sourcesRead, edgesRecorded, input.model ?? null, input.mappedBy]
  );
  const row = rows[0]!;
  return {
    id: row.id,
    sources_considered: sourcesConsidered,
    sources_read: sourcesRead,
    edges_recorded: edgesRecorded,
    replaced: !row.inserted,
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SourceMapSummary {
  summary: string;
  material: boolean;
  sources_considered: number;
  sources_read: number;
  edges_recorded: number;
  mapped_by: string;
  mapped_at: string;
}

export interface InstanceReadingView {
  support: string;
  deployment: string | null;
  note: string | null;
  quote_check: QuoteCheckResult;
  worth_reading: boolean;
  worth_reading_reason: string | null;
  source_read: boolean;
  read_at: string;
}

export interface ProvenanceEdgeView {
  id: string;
  from_instance_id: string;
  to_source: { id: string; title: string; url: string | null };
  to_instance_id: string | null;
  relation_type: string;
  fidelity: string;
  evidence: string;
  reasoning: string;
  confidence: number;
  target_read: boolean;
  created_by: string;
}

export interface SourceRelationshipView {
  id: string;
  parent_source: { id: string; title: string; url: string | null };
  child_source: { id: string; title: string; url: string | null };
  relation_type: string;
  reasoning: string;
  confidence: number;
}

export interface ClaimSourceMap {
  map: SourceMapSummary | null;
  readings: Record<string, InstanceReadingView>;
  edges: ProvenanceEdgeView[];
  /** Relations among the sources that bear on this claim, either as an instance's source or as an edge target. */
  source_relationships: SourceRelationshipView[];
}

/** The current source map row for a claim, or null when none has been written. */
export async function getSourceMapSummary(claimId: string): Promise<SourceMapSummary | null> {
  const [row] = await rawQuery<{
    summary: string;
    material: boolean;
    sources_considered: number;
    sources_read: number;
    edges_recorded: number;
    mapped_by: string;
    mapped_at: Date;
  }>(
    `SELECT summary, material, sources_considered, sources_read, edges_recorded, mapped_by, mapped_at
       FROM claim_source_maps WHERE claim_id = $1`,
    [claimId]
  );
  if (!row) return null;
  return {
    summary: row.summary,
    material: row.material,
    sources_considered: Number(row.sources_considered),
    sources_read: Number(row.sources_read),
    edges_recorded: Number(row.edges_recorded),
    mapped_by: row.mapped_by,
    mapped_at: new Date(row.mapped_at).toISOString(),
  };
}

/**
 * Everything recorded about what a claim's support rests on: the map
 * summary, the readings keyed by instance id, the edges with their targets
 * named, and the relations among the documents involved. Shared by the
 * Steward's read tool, the claim API, and the MCP server, so they cannot
 * drift apart.
 */
export async function getClaimSourceMap(claimId: string): Promise<ClaimSourceMap> {
  const map = await getSourceMapSummary(claimId);

  const readingRows = await rawQuery<{
    instance_id: string;
    support: string;
    deployment: string | null;
    note: string | null;
    quote_check: QuoteCheckResult;
    worth_reading: boolean;
    worth_reading_reason: string | null;
    source_read: boolean;
    updated_at: Date;
  }>(
    `SELECT r.instance_id, r.support, r.deployment, r.note, r.quote_check,
            r.worth_reading, r.worth_reading_reason, r.source_read, r.updated_at
       FROM claim_instance_readings r
       JOIN claim_instances ci ON ci.id = r.instance_id
      WHERE ci.claim_id = $1`,
    [claimId]
  );
  const readings: Record<string, InstanceReadingView> = {};
  for (const r of readingRows) {
    readings[r.instance_id] = {
      support: r.support,
      deployment: r.deployment,
      note: r.note,
      quote_check: r.quote_check,
      worth_reading: r.worth_reading,
      worth_reading_reason: r.worth_reading_reason,
      source_read: r.source_read,
      read_at: new Date(r.updated_at).toISOString(),
    };
  }

  const edgeRows = await rawQuery<{
    id: string;
    from_instance_id: string;
    to_source_id: string;
    to_title: string;
    to_url: string | null;
    to_instance_id: string | null;
    relation_type: string;
    fidelity: string;
    evidence: string;
    reasoning: string;
    confidence: number;
    target_read: boolean;
    created_by: string;
  }>(
    `SELECT e.id, e.from_instance_id, e.to_source_id, s.title AS to_title, s.url AS to_url,
            e.to_instance_id, e.relation_type, e.fidelity, e.evidence, e.reasoning,
            e.confidence, e.target_read, e.created_by
       FROM claim_provenance_edges e
       JOIN claim_instances ci ON ci.id = e.from_instance_id
       JOIN sources s ON s.id = e.to_source_id
      WHERE ci.claim_id = $1
      ORDER BY e.created_at`,
    [claimId]
  );
  const edges: ProvenanceEdgeView[] = edgeRows.map((e) => ({
    id: e.id,
    from_instance_id: e.from_instance_id,
    to_source: { id: e.to_source_id, title: e.to_title, url: e.to_url },
    to_instance_id: e.to_instance_id,
    relation_type: e.relation_type,
    fidelity: e.fidelity,
    evidence: e.evidence,
    reasoning: e.reasoning,
    confidence: Number(e.confidence),
    target_read: e.target_read,
    created_by: e.created_by,
  }));

  const relationRows = await rawQuery<{
    id: string;
    parent_id: string;
    parent_title: string;
    parent_url: string | null;
    child_id: string;
    child_title: string;
    child_url: string | null;
    relation_type: string;
    reasoning: string;
    confidence: number;
  }>(
    `WITH involved AS (
       SELECT ci.source_id AS id FROM claim_instances ci WHERE ci.claim_id = $1
       UNION
       SELECT e.to_source_id FROM claim_provenance_edges e
         JOIN claim_instances ci ON ci.id = e.from_instance_id
        WHERE ci.claim_id = $1
     )
     SELECT sr.id, p.id AS parent_id, p.title AS parent_title, p.url AS parent_url,
            c.id AS child_id, c.title AS child_title, c.url AS child_url,
            sr.relation_type, sr.reasoning, sr.confidence
       FROM source_relationships sr
       JOIN sources p ON p.id = sr.parent_source_id
       JOIN sources c ON c.id = sr.child_source_id
      WHERE sr.parent_source_id IN (SELECT id FROM involved)
        AND sr.child_source_id IN (SELECT id FROM involved)
      ORDER BY sr.created_at`,
    [claimId]
  );
  const source_relationships: SourceRelationshipView[] = relationRows.map((r) => ({
    id: r.id,
    parent_source: { id: r.parent_id, title: r.parent_title, url: r.parent_url },
    child_source: { id: r.child_id, title: r.child_title, url: r.child_url },
    relation_type: r.relation_type,
    reasoning: r.reasoning,
    confidence: Number(r.confidence),
  }));

  return { map, readings, edges, source_relationships };
}

/**
 * The instances of a claim as the provenance tools present them: with ids,
 * the source's id and whether it has stored text, and any reading already
 * recorded. Built for the Steward's read tool.
 */
export async function listInstancesForMapping(claimId: string): Promise<
  Array<{
    instance_id: string;
    source: { id: string; title: string; url: string | null; source_type: string; has_stored_text: boolean };
    verbatim_text: string;
    context: string | null;
    stance: string;
    speaker: string | null;
    publication: string | null;
    source_date: string | null;
    link: string | null;
    recorded_by: string;
  }>
> {
  const rows = await rawQuery<{
    id: string;
    source_id: string;
    title: string;
    url: string | null;
    source_type: string;
    has_stored_text: boolean;
    verbatim_text: string;
    context: string | null;
    stance: string;
    speaker: string | null;
    publication: string | null;
    source_date: string | null;
    link: string | null;
    created_by: string;
  }>(
    `SELECT ci.id, ci.source_id, s.title, s.url, s.source_type,
            (s.raw_content IS NOT NULL AND s.raw_content <> '') AS has_stored_text,
            ci.verbatim_text, ci.context, ci.stance, ci.speaker, ci.publication,
            ci.source_date, ci.link, ci.created_by
       FROM claim_instances ci
       JOIN sources s ON s.id = ci.source_id
      WHERE ci.claim_id = $1
      ORDER BY ci.created_at`,
    [claimId]
  );
  return rows.map((r) => ({
    instance_id: r.id,
    source: {
      id: r.source_id,
      title: r.title,
      url: r.url,
      source_type: r.source_type,
      has_stored_text: r.has_stored_text,
    },
    verbatim_text: r.verbatim_text,
    context: r.context,
    stance: r.stance,
    speaker: r.speaker,
    publication: r.publication,
    source_date: r.source_date,
    link: r.link,
    recorded_by: r.created_by,
  }));
}
