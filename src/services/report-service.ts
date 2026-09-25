/**
 * Agent reports (#366): the one channel every agent has for telling the
 * humans who own the tools that something is wrong with the machinery.
 *
 * Two front doors write here — the raise_issue LLM tool (report-tools.ts,
 * in every internal agent's toolbelt) and the raise_issue MCP tool (external
 * agents) — and both go through raiseIssue(), which enforces the
 * commitments that decide whether the channel gets used:
 *
 *   - Fire-and-forget. raiseIssue never throws. A validation problem, a DB
 *     outage, a malformed context ref: all of it is logged and swallowed,
 *     and the caller gets an acknowledgment either way. An agent that has
 *     just hit a blocking failure must be able to report it and continue;
 *     a reporting channel that can itself fail is not a reporting channel.
 *   - Dedupe by construction. The same failure recurs across thousands of
 *     runs, so the write is an upsert keyed on (origin, agent, kind, surface,
 *     normalized title): repeats bump occurrence_count and last_seen_at on
 *     one row instead of minting thousands. Frequency × severity is what
 *     triage ranks by.
 *   - Navigable, not gated. Wording drifts, so the exact key alone would
 *     mint paraphrases; but whether two reports are the same problem is a
 *     judgement for whoever has the record in front of them, so the write
 *     never waits on it (#432). The agent has the tools a maintainer has:
 *     search the reports on record by keyword and by meaning, list what is
 *     recent on a surface, read one report with its sightings and its
 *     duplicates, and say `joins` when it has found its predecessor. A
 *     report that is written anyway comes back with the near reports on
 *     record as advice, with their status and the maintainers' note; the
 *     Audit Agent's triage collapses what the agent did not.
 *   - Filed where maintainers look. Every report written on first sighting
 *     is filed as a GitHub issue (github-issue-service.ts), labelled as
 *     agent-generated; sightings, notes, withdrawals, and triage decisions
 *     follow it there. All of it asynchronous: the report never waits on
 *     GitHub.
 *
 * Reports are about the system, not the graph: they carry ids in
 * context_refs, never quoted content, and body is capped here so a report
 * cannot become a copy of the page the agent was reading.
 */
import { createHash } from "node:crypto";
import { loadConfig } from "../config.js";
import { rawQuery } from "../db/client.js";
import {
  reportKindEnum,
  reportOriginEnum,
  reportSeverityEnum,
  reportStatusEnum,
} from "../schemas/common.js";
import { generateEmbedding } from "./embedding-service.js";
import {
  fileIssueForReport,
  syncSightingToIssue,
  syncTriageToIssue,
} from "./github-issue-service.js";

export type ReportKind = (typeof reportKindEnum.options)[number];
export type ReportSeverity = (typeof reportSeverityEnum.options)[number];
export type ReportOrigin = (typeof reportOriginEnum.options)[number];
export type ReportStatus = (typeof reportStatusEnum.options)[number];

export const REPORT_KINDS = reportKindEnum.options;
export const REPORT_SEVERITIES = reportSeverityEnum.options;
export const REPORT_STATUSES = reportStatusEnum.options;

/** Write-time caps: a report is a bug report, not a transcript. */
export const REPORT_TITLE_MAX_CHARS = 200;
export const REPORT_BODY_MAX_CHARS = 4000;
export const REPORT_SURFACE_MAX_CHARS = 200;
/** How many related reports a raise_issue result carries back. */
export const REPORT_MATCH_CANDIDATES = 5;
/** How many results a search_issues call returns at most. */
export const REPORT_SEARCH_MAX_RESULTS = 10;
/** How many sightings get_issue shows, latest first. */
export const REPORT_SIGHTINGS_SHOWN = 10;
const CONTEXT_REF_MAX_KEYS = 12;
const CONTEXT_REF_MAX_VALUE_CHARS = 500;

/** Attribution snapshotted from the usage context at write time. */
export interface ReportAttribution {
  /** Reporting agent name; 'mcp' for external callers. */
  agent: string;
  model?: string | null;
  reporterContributorId?: string | null;
  runId?: string | null;
  jobId?: string | null;
  claimId?: string | null;
}

export interface RaiseIssueInput extends ReportAttribution {
  kind: string;
  severity: string;
  title: string;
  body?: string;
  surface?: string | null;
  /** Ids only (claim id, contribution id, source url, job id). */
  contextRefs?: Record<string, unknown> | null;
  origin?: ReportOrigin;
  /**
   * The report on record this one is a sighting of, when the agent found
   * its predecessor (search_issues, get_issue, or a related report from an
   * earlier raise). No new row; the account lands on that report.
   */
  joins?: string | null;
}

/** A report on record, as the match search and search_issues describe it. */
export interface ReportMatch {
  id: string;
  title: string;
  kind: string;
  severity: string;
  status: string;
  /** The maintainers' (or the Audit Agent's) reading, when triaged. */
  triage_note: string | null;
  agent: string;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  github_issue_url: string | null;
  /** When triaged as a duplicate: the report it repeats. */
  duplicate_of_id: string | null;
  /**
   * Cosine similarity of the query to the report's title + body; 0 when the
   * report has no embedding, the query could not be embedded, or there was
   * no query.
   */
  similarity: number;
  /**
   * What found it: `meaning` (the embedding, at or above the bar), `wording`
   * (every content word of the query appears in the report's title or
   * body), `both`, or `recent` (listed without a query). A wording hit is
   * shown even when the report has no embedding, so a report on record is
   * never invisible to its own title.
   */
  matched_by: "meaning" | "wording" | "both" | "recent";
}

export interface RaiseIssueResult {
  /** Always true: the channel acknowledges even when the write failed. */
  acknowledged: true;
  /** Null when the report was not persisted (invalid input, DB failure). */
  reportId: string | null;
  /** How many times this report has now been seen, when persisted. */
  occurrenceCount: number | null;
  /** True when the write collapsed into an existing row (repeat or joins). */
  deduplicated: boolean;
  /** Set when the write collapsed: what the record says about that report. */
  existing?: {
    status: string;
    triageNote: string | null;
    githubIssueUrl: string | null;
    /** True when this sighting moved an actioned report back to new. */
    reopened: boolean;
  };
  /**
   * Set on a new report: the reports on record that read like it, with
   * their status and the maintainers' note. Advice, not a gate; the report
   * is recorded either way.
   */
  related?: ReportMatch[];
  /** Set when the report was not persisted; agent-facing wording. */
  problem?: string;
}

/** Validation failure — internal to raiseIssue, which converts it to a result. */
class ReportValidationError extends Error {}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The dedupe key: what "the same report" means. Same origin, same reporting
 * agent, same kind, same surface, same title modulo case and punctuation.
 * Wording drift across runs is what the match-before-write search is for;
 * this catches the exact repeats without spending an embedding on them.
 */
export function computeDedupeKey(input: {
  origin: string;
  agent: string;
  kind: string;
  surface: string | null;
  title: string;
}): string {
  const material = [
    input.origin,
    input.agent.trim().toLowerCase(),
    input.kind,
    (input.surface ?? "").trim().toLowerCase(),
    normalizeTitle(input.title),
  ].join(" ");
  return createHash("sha256").update(material).digest("hex");
}

/** Embedding text: the title carries the identity, the body the detail. */
export function reportEmbeddingText(title: string, body: string): string {
  return `${title.trim()}\n\n${body.trim()}`.slice(0, 4000);
}

function toVectorLiteral(v: number[]): string {
  return `[${v.join(",")}]`;
}

function sanitizeContextRefs(
  refs: Record<string, unknown> | null | undefined
): Record<string, string | number | boolean> {
  if (!refs || typeof refs !== "object" || Array.isArray(refs)) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(refs)) {
    if (Object.keys(out).length >= CONTEXT_REF_MAX_KEYS) break;
    if (typeof key !== "string" || !key.trim()) continue;
    if (typeof value === "number" || typeof value === "boolean") {
      out[key.slice(0, 64)] = value;
    } else if (typeof value === "string" && value.trim()) {
      out[key.slice(0, 64)] = value.trim().slice(0, CONTEXT_REF_MAX_VALUE_CHARS);
    }
    // Nested objects and arrays are dropped: refs are pointers, not payload.
  }
  return out;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOrNull(value: string | null | undefined): string | null {
  return value && UUID_RE.test(value) ? value : null;
}

function iso(d: Date | string | null | undefined): string | null {
  return d instanceof Date ? d.toISOString() : d ? String(d) : null;
}

function validate(input: RaiseIssueInput): {
  kind: ReportKind;
  severity: ReportSeverity;
  origin: ReportOrigin;
  title: string;
  body: string;
  surface: string | null;
  agent: string;
} {
  const kind = reportKindEnum.safeParse(input.kind);
  if (!kind.success) {
    throw new ReportValidationError(
      `kind must be one of ${REPORT_KINDS.join(", ")}`
    );
  }
  const severity = reportSeverityEnum.safeParse(input.severity);
  if (!severity.success) {
    throw new ReportValidationError(
      `severity must be one of ${REPORT_SEVERITIES.join(", ")}`
    );
  }
  const title = String(input.title ?? "").trim();
  if (!title) throw new ReportValidationError("title is required");
  const agent = String(input.agent ?? "").trim();
  if (!agent) throw new ReportValidationError("agent is required");
  const surface = String(input.surface ?? "").trim();
  return {
    kind: kind.data,
    severity: severity.data,
    origin: input.origin ?? "internal",
    title: title.slice(0, REPORT_TITLE_MAX_CHARS),
    body: String(input.body ?? "").trim().slice(0, REPORT_BODY_MAX_CHARS),
    surface: surface ? surface.slice(0, REPORT_SURFACE_MAX_CHARS) : null,
    agent: agent.slice(0, 64),
  };
}

/** Log a fire-and-forget follow-up's failure; never let it surface. */
function background(label: string, work: Promise<unknown>): void {
  void work.catch((err: unknown) => {
    console.error(
      `[reports] ${label} failed:`,
      err instanceof Error ? err.message : String(err)
    );
  });
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface AgentReportRow {
  id: string;
  kind: string;
  severity: string;
  title: string;
  body: string;
  surface: string | null;
  origin: string;
  agent: string;
  model: string | null;
  reporter_contributor_id: string | null;
  context_refs: Record<string, unknown>;
  run_id: string | null;
  job_id: string | null;
  claim_id: string | null;
  status: string;
  triage_note: string | null;
  triaged_by: string | null;
  triaged_at: Date | null;
  duplicate_of_id: string | null;
  github_issue_number: number | null;
  github_issue_url: string | null;
  github_synced_at: Date | null;
  occurrence_count: number;
  first_seen_at: Date;
  last_seen_at: Date;
}

export interface AgentReportSightingRow {
  id: string;
  report_id: string;
  kind: string;
  body: string;
  context_refs: Record<string, unknown>;
  agent: string;
  model: string | null;
  run_id: string | null;
  job_id: string | null;
  claim_id: string | null;
  seen_at: Date;
}

const REPORT_COLUMNS = `id, kind, severity, title, body, surface, origin, agent,
  model, reporter_contributor_id, context_refs, run_id, job_id, claim_id,
  status, triage_note, triaged_by, triaged_at, duplicate_of_id,
  github_issue_number, github_issue_url, github_synced_at,
  occurrence_count, first_seen_at, last_seen_at`;

/** The same columns qualified for a statement that joins agent_reports. */
const REPORT_COLUMNS_R = REPORT_COLUMNS.split(",")
  .map((c) => `r.${c.trim()}`)
  .join(", ");

const SIGHTING_COLUMNS = `id, report_id, kind, body, context_refs, agent, model,
  run_id, job_id, claim_id, seen_at`;

// ---------------------------------------------------------------------------
// Match search
// ---------------------------------------------------------------------------

type MatchRow = AgentReportRow & {
  similarity: number;
  by_meaning: boolean;
  by_wording: boolean;
};

function toMatch(r: MatchRow): ReportMatch {
  return {
    id: r.id,
    title: r.title,
    kind: r.kind,
    severity: r.severity,
    status: r.status,
    triage_note: r.triage_note,
    agent: r.agent,
    occurrence_count: Number(r.occurrence_count),
    first_seen_at: iso(r.first_seen_at) ?? "",
    last_seen_at: iso(r.last_seen_at) ?? "",
    github_issue_url: r.github_issue_url,
    duplicate_of_id: r.duplicate_of_id,
    similarity: Number(r.similarity),
    matched_by: r.by_meaning && r.by_wording
      ? "both"
      : r.by_wording
        ? "wording"
        : r.by_meaning
          ? "meaning"
          : "recent",
  };
}

/**
 * The match-before-write search and the search_issues backend: reports of
 * the same origin, found two ways and unioned. By meaning: cosine
 * similarity of the query's embedding to the report's title + body, at or
 * above the bar. By wording: the query's content words (the title, as the
 * agent would write it) all appear, stemmed, in the report's title or
 * body. The wording match is what keeps the record honest when the
 * embedding cannot (#432): a report written while embedding was down has
 * no vector and would otherwise never be found, not even by its own title,
 * and a report whose paraphrase outscores it would otherwise hide behind
 * that paraphrase; wording hits sort first for the same reason. Either
 * side may be absent: a null embedding (the embedder is down) searches by
 * wording alone, and a query with no content words searches by meaning
 * alone. Origin-scoped so an external caller never sees the internal
 * agents' reports, which quote the machinery's failures. Withdrawn reports
 * are excluded: a report its own author took back is not a thing to join.
 */
export async function findNearReports(
  embedding: number[] | null,
  opts: {
    origin: ReportOrigin;
    minSimilarity: number;
    /** The query as words, for the wording match; the title when raising. */
    text?: string | null;
    exclude?: string[];
    surface?: string | null;
    status?: string | null;
    limit?: number;
  }
): Promise<ReportMatch[]> {
  const text = String(opts.text ?? "").trim();
  if (!embedding && !text) return [];
  const values: unknown[] = [
    embedding ? toVectorLiteral(embedding) : null,
    opts.minSimilarity,
    opts.origin,
    opts.exclude ?? [],
    text,
  ];
  let surfaceClause = "";
  if (opts.surface) {
    values.push(opts.surface);
    surfaceClause = `AND r.surface = $${values.length}`;
  }
  if (opts.status) {
    values.push(opts.status);
    surfaceClause += ` AND r.status = $${values.length}`;
  }
  const rows = await rawQuery<MatchRow>(
    `WITH q AS (
       SELECT $1::vector AS v, websearch_to_tsquery('english', $5::text) AS tsq
     ),
     scored AS (
       SELECT ${REPORT_COLUMNS_R},
              COALESCE(1 - (r.embedding <=> q.v), 0) AS similarity,
              (r.embedding IS NOT NULL AND q.v IS NOT NULL
                 AND 1 - (r.embedding <=> q.v) >= $2) AS by_meaning,
              (numnode(q.tsq) > 0
                 AND to_tsvector('english', r.title || ' ' || r.body) @@ q.tsq) AS by_wording
         FROM agent_reports r, q
        WHERE r.origin = $3
          AND r.status <> 'withdrawn'
          AND NOT (r.id = ANY($4::uuid[]))
          ${surfaceClause}
     )
     SELECT * FROM scored
      WHERE by_meaning OR by_wording
      ORDER BY by_wording DESC, similarity DESC
      LIMIT ${Math.max(1, Math.min(REPORT_SEARCH_MAX_RESULTS, opts.limit ?? REPORT_MATCH_CANDIDATES))}`,
    values
  );
  return rows.map(toMatch);
}

export interface SearchReportsOptions {
  origin?: ReportOrigin;
  surface?: string | null;
  status?: string | null;
  limit?: number;
}

/**
 * search_issues: what an agent calls on purpose, to ask whether a problem
 * is known and what the maintainers said. With a query, a keyword and
 * meaning search at a lower bar than the write-time advice, since the
 * caller asked to look; an embedding failure narrows it to wording rather
 * than emptying it, because the caller is usually holding a title and a
 * title finds its own report. Without a query, the recent reports, most
 * recently seen first, so an agent can read what is on record about a
 * surface before it starts. Never throws.
 */
export async function searchReports(
  query: string | null | undefined,
  opts: SearchReportsOptions = {}
): Promise<{ matches: ReportMatch[]; problem?: string }> {
  const text = String(query ?? "").trim();
  const origin = opts.origin ?? "internal";
  const limit = Math.max(1, Math.min(REPORT_SEARCH_MAX_RESULTS, opts.limit ?? REPORT_SEARCH_MAX_RESULTS));
  try {
    if (!text) {
      const rows = await listAgentReports({
        origin,
        surface: opts.surface ?? undefined,
        status: opts.status ?? undefined,
        limit,
      });
      return {
        matches: rows
          .filter((r) => r.status !== "withdrawn")
          .map((r) => toMatch({ ...r, similarity: 0, by_meaning: false, by_wording: false })),
      };
    }
    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbedding(text.slice(0, 4000));
    } catch (err) {
      console.error(
        "[reports] search embedding failed; searching by wording only:",
        err instanceof Error ? err.message : String(err)
      );
    }
    const matches = await findNearReports(embedding, {
      origin,
      minSimilarity: Math.max(0, loadConfig().reportMatchSimilarity - 0.2),
      text,
      surface: opts.surface ?? null,
      status: opts.status ?? null,
      limit,
    });
    return { matches };
  } catch (err) {
    console.error(
      "[reports] search failed:",
      err instanceof Error ? err.message : String(err)
    );
    return { matches: [], problem: "the search is unavailable right now" };
  }
}

/** One report as get_issue shows it: the row, its record, and its links. */
export interface ReportView {
  report: AgentReportRow;
  /** Latest first, at most REPORT_SIGHTINGS_SHOWN. */
  sightings: AgentReportSightingRow[];
  /** Reports triaged as duplicates of this one. */
  duplicates: Array<Pick<AgentReportRow, "id" | "title" | "status" | "agent" | "last_seen_at">>;
  /** When this report is itself a duplicate: the report it repeats. */
  duplicate_of: Pick<AgentReportRow, "id" | "title" | "status" | "triage_note" | "github_issue_url"> | null;
}

/**
 * get_issue: read one report in full, the way a maintainer would follow a
 * link: body, triage note, the latest sightings with their accounts, the
 * reports collapsed onto it, and the report it was collapsed onto.
 * Origin-scoped like the search. Null when there is no such report.
 */
export async function getReportView(
  id: string,
  opts: { origin?: ReportOrigin } = {}
): Promise<ReportView | null> {
  const reportId = uuidOrNull(id);
  if (!reportId) return null;
  const origin = opts.origin ?? "internal";
  const [report] = await rawQuery<AgentReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1 AND origin = $2`,
    [reportId, origin]
  );
  if (!report) return null;
  const [sightings, duplicates, parents] = await Promise.all([
    rawQuery<AgentReportSightingRow>(
      `SELECT ${SIGHTING_COLUMNS} FROM agent_report_sightings
        WHERE report_id = $1
        ORDER BY seen_at DESC
        LIMIT $2`,
      [reportId, REPORT_SIGHTINGS_SHOWN]
    ),
    rawQuery<Pick<AgentReportRow, "id" | "title" | "status" | "agent" | "last_seen_at">>(
      `SELECT id, title, status, agent, last_seen_at FROM agent_reports
        WHERE duplicate_of_id = $1 AND origin = $2
        ORDER BY last_seen_at DESC
        LIMIT 20`,
      [reportId, origin]
    ),
    report.duplicate_of_id
      ? rawQuery<Pick<AgentReportRow, "id" | "title" | "status" | "triage_note" | "github_issue_url">>(
          `SELECT id, title, status, triage_note, github_issue_url FROM agent_reports
            WHERE id = $1 AND origin = $2`,
          [report.duplicate_of_id, origin]
        )
      : Promise.resolve([]),
  ]);
  return { report, sightings, duplicates, duplicate_of: parents[0] ?? null };
}

/**
 * The embedding backfill (#432): reports recorded while the embedder was
 * down, or before the column existed, carry no vector, so the meaning
 * search cannot see them and the match-before-write files their repeats
 * as new. Embed a bounded batch, oldest first; a row that fails stays
 * pending for the next tick. Exported for the worker and for tests.
 */
export async function backfillReportEmbeddings(
  limit: number
): Promise<{ pending: number; embedded: number; failed: number }> {
  const rows = await rawQuery<Pick<AgentReportRow, "id" | "title" | "body">>(
    `SELECT id, title, body FROM agent_reports
      WHERE embedding IS NULL
      ORDER BY first_seen_at ASC
      LIMIT $1`,
    [Math.max(1, limit)]
  );
  const result = { pending: rows.length, embedded: 0, failed: 0 };
  for (const row of rows) {
    try {
      const embedding = await generateEmbedding(reportEmbeddingText(row.title, row.body));
      await rawQuery(
        `UPDATE agent_reports SET embedding = $2::vector
          WHERE id = $1 AND embedding IS NULL`,
        [row.id, toVectorLiteral(embedding)]
      );
      result.embedded++;
    } catch (err) {
      result.failed++;
      console.error(
        `[reports] embedding backfill failed for ${row.id}:`,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Sightings
// ---------------------------------------------------------------------------

interface SightingInput extends ReportAttribution {
  body: string;
  contextRefs: Record<string, unknown> | null | undefined;
  /** The caller's origin: a sighting never crosses from external to internal. */
  origin: ReportOrigin;
}

/**
 * Record that a report on record was seen again: bump the count, keep the
 * freshest detail on the parent, write the sighting, and if the report had
 * been actioned, reopen it — a recurrence after a fix is a regression, and
 * the maintainers should hear about it without an agent having to know the
 * report's history. Origin-checked: an external caller's `joins` cannot
 * land an account on an internal report (and from there in the tracker).
 * Returns null when no such report exists for this origin.
 */
async function recordSighting(
  reportId: string,
  input: SightingInput
): Promise<{ row: AgentReportRow; reopened: boolean } | null> {
  const rows = await rawQuery<AgentReportRow & { previous_status: string }>(
    `UPDATE agent_reports AS r
        SET occurrence_count = r.occurrence_count + 1,
            last_seen_at = now(),
            -- The latest sighting's detail is the freshest evidence; keep it.
            body = CASE WHEN $2::text <> '' THEN $2::text ELSE r.body END,
            model = COALESCE($3::text, r.model),
            context_refs = CASE WHEN $4::jsonb <> '{}'::jsonb THEN $4::jsonb
                                ELSE r.context_refs END,
            run_id = COALESCE($5::uuid, r.run_id),
            job_id = COALESCE($6::uuid, r.job_id),
            claim_id = COALESCE($7::uuid, r.claim_id),
            status = CASE WHEN r.status = 'actioned' THEN 'new' ELSE r.status END
       FROM (SELECT id, status AS previous_status FROM agent_reports
              WHERE id = $1 AND origin = $8) AS prev
      WHERE r.id = prev.id
      RETURNING ${REPORT_COLUMNS_R}, prev.previous_status`,
    [
      reportId,
      input.body,
      input.model ?? null,
      JSON.stringify(sanitizeContextRefs(input.contextRefs)),
      uuidOrNull(input.runId),
      uuidOrNull(input.jobId),
      uuidOrNull(input.claimId),
      input.origin,
    ]
  );
  const row = rows[0];
  if (!row) return null;
  await rawQuery(
    `INSERT INTO agent_report_sightings
       (report_id, kind, body, context_refs, agent, model, run_id, job_id, claim_id)
     VALUES ($1, 'sighting', $2, $3, $4, $5, $6, $7, $8)`,
    [
      row.id,
      input.body,
      JSON.stringify(sanitizeContextRefs(input.contextRefs)),
      input.agent,
      input.model ?? null,
      uuidOrNull(input.runId),
      uuidOrNull(input.jobId),
      uuidOrNull(input.claimId),
    ]
  );
  const reopened = row.previous_status === "actioned";
  const { previous_status: _previous, ...report } = row;
  background(
    "sighting sync",
    syncSightingToIssue(report, {
      reopened,
      account: input.body,
      agent: input.agent,
      explicit: input.body.trim().length > 0,
    })
  );
  return { row: report, reopened };
}

function collapsed(
  row: AgentReportRow,
  reopened: boolean
): RaiseIssueResult {
  return {
    acknowledged: true,
    reportId: row.id,
    occurrenceCount: Number(row.occurrence_count),
    deduplicated: true,
    existing: {
      status: row.status,
      triageNote: row.triage_note,
      githubIssueUrl: row.github_issue_url,
      reopened,
    },
  };
}

// ---------------------------------------------------------------------------
// Write side
// ---------------------------------------------------------------------------

/**
 * Record a report. Never throws; see the file header for the commitments
 * this enforces. The order of the checks is the cost order: the exact
 * dedupe key (one indexed read) before the embedding, the embedding before
 * the insert, and GitHub after everything, off the caller's path.
 */
export async function raiseIssue(
  input: RaiseIssueInput
): Promise<RaiseIssueResult> {
  try {
    const v = validate(input);
    const attribution: SightingInput = {
      body: v.body,
      contextRefs: input.contextRefs,
      origin: v.origin,
      agent: v.agent,
      model: input.model ?? null,
      reporterContributorId: input.reporterContributorId ?? null,
      runId: input.runId ?? null,
      jobId: input.jobId ?? null,
      claimId: input.claimId ?? null,
    };

    // Second call, joining a report on record: a sighting, no new row.
    const joins = uuidOrNull(input.joins);
    if (joins) {
      const joined = await recordSighting(joins, attribution);
      if (!joined) {
        throw new ReportValidationError(`joins names no report on record (${joins})`);
      }
      return collapsed(joined.row, joined.reopened);
    }

    // An exact repeat collapses without spending an embedding on it.
    const dedupeKey = computeDedupeKey({
      origin: v.origin,
      agent: v.agent,
      kind: v.kind,
      surface: v.surface,
      title: v.title,
    });
    const [existing] = await rawQuery<{ id: string }>(
      `SELECT id FROM agent_reports WHERE dedupe_key = $1`,
      [dedupeKey]
    );
    if (existing) {
      const seen = await recordSighting(existing.id, attribution);
      if (seen) return collapsed(seen.row, seen.reopened);
    }

    // The embedding, for the record and for the related-reports search.
    // An embedding failure is not the agent's problem: the report is
    // recorded without one (the backfill worker embeds it later) and the
    // search falls back to the title's wording.
    let embedding: number[] | null = null;
    try {
      embedding = await generateEmbedding(reportEmbeddingText(v.title, v.body));
    } catch (err) {
      console.error(
        "[reports] embedding failed; recording without one:",
        err instanceof Error ? err.message : String(err)
      );
    }
    // The reports on record that read like this one, carried back as
    // advice (#432): the write never waits on the agent's answer, and a
    // search failure is not a reason to lose the report.
    let related: ReportMatch[] = [];
    try {
      related = await findNearReports(embedding, {
        origin: v.origin,
        minSimilarity: loadConfig().reportMatchSimilarity,
        text: v.title,
        limit: REPORT_MATCH_CANDIDATES,
      });
    } catch (err) {
      console.error(
        "[reports] related-report search failed:",
        err instanceof Error ? err.message : String(err)
      );
    }

    // The upsert stays: two processes can pass the exact-key check at once,
    // and the loser must collapse rather than fail.
    const rows = await rawQuery<AgentReportRow & { inserted: boolean }>(
      `INSERT INTO agent_reports
         (kind, severity, title, body, surface, origin, agent, model,
          reporter_contributor_id, context_refs, run_id, job_id, claim_id,
          dedupe_key, embedding)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
               $15::vector)
       ON CONFLICT (dedupe_key) DO UPDATE SET
         occurrence_count = agent_reports.occurrence_count + 1,
         last_seen_at = now(),
         body = CASE WHEN EXCLUDED.body <> '' THEN EXCLUDED.body
                     ELSE agent_reports.body END,
         model = COALESCE(EXCLUDED.model, agent_reports.model),
         context_refs = EXCLUDED.context_refs,
         run_id = COALESCE(EXCLUDED.run_id, agent_reports.run_id),
         job_id = COALESCE(EXCLUDED.job_id, agent_reports.job_id),
         claim_id = COALESCE(EXCLUDED.claim_id, agent_reports.claim_id)
       RETURNING ${REPORT_COLUMNS}, (xmax = 0) AS inserted`,
      [
        v.kind,
        v.severity,
        v.title,
        v.body,
        v.surface,
        v.origin,
        v.agent,
        input.model ?? null,
        uuidOrNull(input.reporterContributorId),
        JSON.stringify(sanitizeContextRefs(input.contextRefs)),
        uuidOrNull(input.runId),
        uuidOrNull(input.jobId),
        uuidOrNull(input.claimId),
        dedupeKey,
        embedding ? toVectorLiteral(embedding) : null,
      ]
    );
    const row = rows[0];
    if (!row) {
      return {
        acknowledged: true,
        reportId: null,
        occurrenceCount: null,
        deduplicated: false,
        problem: "the report was not persisted",
      };
    }
    const { inserted, ...report } = row;
    if (inserted !== false) {
      background("issue filing", fileIssueForReport(report));
      return {
        acknowledged: true,
        reportId: report.id,
        occurrenceCount: Number(report.occurrence_count),
        deduplicated: false,
        ...(related.length ? { related } : {}),
      };
    }
    return collapsed(report, false);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!(err instanceof ReportValidationError)) {
      // A DB failure must not become the agent's failure. Log and move on.
      console.error("[reports] failed to record agent report:", message);
    }
    return {
      acknowledged: true,
      reportId: null,
      occurrenceCount: null,
      deduplicated: false,
      problem:
        err instanceof ReportValidationError
          ? message
          : "the report could not be persisted right now",
    };
  }
}

export interface UpdateReportInput extends ReportAttribution {
  /** The caller's origin; an update never crosses origins. Default internal. */
  origin?: ReportOrigin;
  /** A re-rating, when the agent has seen more than it had when it raised. */
  severity?: string | null;
  /** An amendment: what was found since (the cause, a workaround, a repro id). */
  note?: string | null;
  /** True when the report was the reporter's own mistake. */
  withdraw?: boolean;
  contextRefs?: Record<string, unknown> | null;
}

export interface UpdateReportResult {
  acknowledged: true;
  reportId: string | null;
  status: string | null;
  githubIssueUrl: string | null;
  problem?: string;
}

/**
 * update_issue: the reporter's own edit path. Never throws. Withdrawing is
 * the one status change an agent may make, and it is recorded as such
 * (status withdrawn, triaged_by the agent) rather than as a maintainer's
 * wontfix, so the Audit Agent can tell the two apart.
 */
export async function updateReport(
  reportId: string,
  input: UpdateReportInput
): Promise<UpdateReportResult> {
  const nothing = (problem: string): UpdateReportResult => ({
    acknowledged: true,
    reportId: null,
    status: null,
    githubIssueUrl: null,
    problem,
  });
  try {
    const id = uuidOrNull(reportId);
    if (!id) return nothing("report_id must be a report id");
    const agent = String(input.agent ?? "").trim().slice(0, 64);
    if (!agent) return nothing("agent is required");
    const note = String(input.note ?? "").trim().slice(0, REPORT_BODY_MAX_CHARS);
    let severity: ReportSeverity | null = null;
    if (input.severity != null && input.severity !== "") {
      const parsed = reportSeverityEnum.safeParse(input.severity);
      if (!parsed.success) {
        return nothing(`severity must be one of ${REPORT_SEVERITIES.join(", ")}`);
      }
      severity = parsed.data;
    }
    if (!severity && !note && !input.withdraw) {
      return nothing("nothing to update: give a severity, a note, or withdraw");
    }

    const rows = await rawQuery<AgentReportRow>(
      `UPDATE agent_reports
          SET severity = COALESCE($2::text, severity),
              status = CASE WHEN $3::boolean THEN 'withdrawn' ELSE status END,
              triage_note = CASE WHEN $3::boolean THEN $4::text ELSE triage_note END,
              triaged_by = CASE WHEN $3::boolean THEN $5::text ELSE triaged_by END,
              triaged_at = CASE WHEN $3::boolean THEN now() ELSE triaged_at END
        WHERE id = $1 AND origin = $6
        RETURNING ${REPORT_COLUMNS}`,
      [
        id,
        severity,
        Boolean(input.withdraw),
        note || "withdrawn by the reporter",
        `agent:${agent}`,
        input.origin ?? "internal",
      ]
    );
    const row = rows[0];
    if (!row) return nothing(`no report on record with id ${id}`);

    if (note) {
      await rawQuery(
        `INSERT INTO agent_report_sightings
           (report_id, kind, body, context_refs, agent, model, run_id, job_id, claim_id)
         VALUES ($1, 'note', $2, $3, $4, $5, $6, $7, $8)`,
        [
          row.id,
          note,
          JSON.stringify(sanitizeContextRefs(input.contextRefs)),
          agent,
          input.model ?? null,
          uuidOrNull(input.runId),
          uuidOrNull(input.jobId),
          uuidOrNull(input.claimId),
        ]
      );
    }
    if (input.withdraw) {
      background("withdrawal sync", syncTriageToIssue(row));
    } else {
      background(
        "note sync",
        syncSightingToIssue(row, {
          reopened: false,
          account: note,
          agent,
          explicit: note.length > 0,
          note: true,
          severityChanged: severity !== null,
        })
      );
    }
    return {
      acknowledged: true,
      reportId: row.id,
      status: row.status,
      githubIssueUrl: row.github_issue_url,
    };
  } catch (err) {
    console.error(
      "[reports] failed to update agent report:",
      err instanceof Error ? err.message : String(err)
    );
    return nothing("the report could not be updated right now");
  }
}

// ---------------------------------------------------------------------------
// External-caller rate limit
// ---------------------------------------------------------------------------

// contributorId → timestamps (ms) of reports within the last hour. In-memory
// sliding window, same construction as the contribution rate limit: a blunt
// backstop against a rejected contributor's agent filing "your reviewer is
// broken" in a loop, not an accounting system.
const windows = new Map<string, number[]>();

/** Test hook. */
export function resetReportRateLimiter(): void {
  windows.clear();
}

export function checkReportRateLimit(contributorId: string): {
  limited: boolean;
  limitPerHour: number;
} {
  const limitPerHour = loadConfig().reportRateLimitPerHour;
  if (limitPerHour <= 0) return { limited: false, limitPerHour };
  const now = Date.now();
  const cutoff = now - 3_600_000;
  const hits = (windows.get(contributorId) ?? []).filter((t) => t > cutoff);
  if (hits.length >= limitPerHour) {
    windows.set(contributorId, hits);
    return { limited: true, limitPerHour };
  }
  hits.push(now);
  windows.set(contributorId, hits);
  return { limited: false, limitPerHour };
}

// ---------------------------------------------------------------------------
// Reads and triage
// ---------------------------------------------------------------------------

export interface ListAgentReportsParams {
  status?: string;
  kind?: string;
  severity?: string;
  origin?: string;
  agent?: string;
  surface?: string;
  /** Only reports seen since this instant. */
  since?: Date;
  limit?: number;
  offset?: number;
}

/**
 * List reports, most recently seen first. The default ordering is the
 * triage ordering: what is happening now, then how often.
 */
export async function listAgentReports(
  params: ListAgentReportsParams = {}
): Promise<AgentReportRow[]> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  const add = (column: string, value: unknown) => {
    values.push(value);
    conditions.push(`${column} = $${values.length}`);
  };
  if (params.status) add("status", params.status);
  if (params.kind) add("kind", params.kind);
  if (params.severity) add("severity", params.severity);
  if (params.origin) add("origin", params.origin);
  if (params.agent) add("agent", params.agent);
  if (params.surface) add("surface", params.surface);
  if (params.since) {
    values.push(params.since);
    conditions.push(`last_seen_at >= $${values.length}`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(100, params.limit ?? 20));
  const offset = Math.max(0, params.offset ?? 0);
  values.push(limit, offset);
  return rawQuery<AgentReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM agent_reports
     ${where}
     ORDER BY last_seen_at DESC, occurrence_count DESC
     LIMIT $${values.length - 1} OFFSET $${values.length}`,
    values
  );
}

export async function getAgentReportById(
  id: string
): Promise<AgentReportRow | null> {
  const rows = await rawQuery<AgentReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM agent_reports WHERE id = $1`,
    [id]
  );
  return rows[0] ?? null;
}

/** The sightings and notes on one report, oldest first. */
export async function listReportSightings(
  reportId: string,
  limit = 50
): Promise<AgentReportSightingRow[]> {
  return rawQuery<AgentReportSightingRow>(
    `SELECT ${SIGHTING_COLUMNS} FROM agent_report_sightings
      WHERE report_id = $1
      ORDER BY seen_at ASC
      LIMIT $2`,
    [reportId, Math.max(1, Math.min(200, limit))]
  );
}

/** Count of reports in status 'new' seen since `since`. Feeds the triage gate. */
export async function countNewReportsSince(since: Date): Promise<number> {
  const [row] = await rawQuery<{ count: number }>(
    `SELECT count(*)::int AS count FROM agent_reports
     WHERE status = 'new' AND last_seen_at > $1`,
    [since]
  );
  return row?.count ?? 0;
}

/**
 * Open reports with no GitHub issue yet, oldest first: the sync worker's
 * backlog. Withdrawn reports are never filed; closed statuses are, so the
 * tracker carries the record, but after the open ones.
 */
export async function listReportsAwaitingIssue(
  limit: number,
  opts: { includeExternal: boolean }
): Promise<AgentReportRow[]> {
  return rawQuery<AgentReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM agent_reports
      WHERE github_issue_number IS NULL
        AND status <> 'withdrawn'
        AND ($2::boolean OR origin = 'internal')
      ORDER BY (status IN ('new', 'triaged')) DESC, first_seen_at ASC
      LIMIT $1`,
    [Math.max(1, limit), opts.includeExternal]
  );
}

/**
 * Longest triage note the record keeps, in characters. A longer note is
 * rejected on write (never silently cut): the note is what maintainers act
 * on, so its tail must not go missing without the writer knowing (#439).
 */
export const TRIAGE_NOTE_MAX_LENGTH = 4000;

export interface TriageReportInput {
  status: ReportStatus;
  /** Free text up to TRIAGE_NOTE_MAX_LENGTH characters after trimming. */
  triageNote?: string | null;
  /** Required when status is 'duplicate'. */
  duplicateOfId?: string | null;
  triagedBy: string;
}

/**
 * Move a report's status. Returns the updated row, or null when no such
 * report exists. The decision follows the report to its GitHub issue.
 */
export async function triageAgentReport(
  id: string,
  input: TriageReportInput
): Promise<AgentReportRow | null> {
  const status = reportStatusEnum.parse(input.status);
  const duplicateOfId =
    status === "duplicate" ? uuidOrNull(input.duplicateOfId) : null;
  if (status === "duplicate" && !duplicateOfId) {
    throw new Error("a duplicate report must name the report it duplicates");
  }
  if (duplicateOfId === id) {
    throw new Error("a report cannot duplicate itself");
  }
  const triageNote = input.triageNote?.trim() || null;
  if (triageNote && triageNote.length > TRIAGE_NOTE_MAX_LENGTH) {
    throw new Error(
      `triage note is ${triageNote.length} characters; the limit is ` +
        `${TRIAGE_NOTE_MAX_LENGTH}. Shorten it rather than lose the tail.`
    );
  }
  const rows = await rawQuery<AgentReportRow>(
    `UPDATE agent_reports
     SET status = $2,
         triage_note = $3,
         duplicate_of_id = $4,
         triaged_by = $5,
         triaged_at = now()
     WHERE id = $1
     RETURNING ${REPORT_COLUMNS}`,
    [
      id,
      status,
      triageNote,
      duplicateOfId,
      input.triagedBy.slice(0, 128),
    ]
  );
  const row = rows[0] ?? null;
  if (row) background("triage sync", syncTriageToIssue(row));
  return row;
}

/** Wire shape for the API and the triage tools: snake_case, ISO dates. */
export function formatAgentReport(row: AgentReportRow): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    severity: row.severity,
    title: row.title,
    body: row.body,
    surface: row.surface,
    origin: row.origin,
    agent: row.agent,
    model: row.model,
    reporter_contributor_id: row.reporter_contributor_id,
    context_refs: row.context_refs ?? {},
    run_id: row.run_id,
    job_id: row.job_id,
    claim_id: row.claim_id,
    status: row.status,
    triage_note: row.triage_note,
    triaged_by: row.triaged_by,
    triaged_at: iso(row.triaged_at),
    duplicate_of_id: row.duplicate_of_id,
    github_issue_number: row.github_issue_number ?? null,
    github_issue_url: row.github_issue_url ?? null,
    github_synced_at: iso(row.github_synced_at),
    occurrence_count: Number(row.occurrence_count),
    first_seen_at: iso(row.first_seen_at),
    last_seen_at: iso(row.last_seen_at),
  };
}

export function formatReportSighting(
  row: AgentReportSightingRow
): Record<string, unknown> {
  return {
    id: row.id,
    report_id: row.report_id,
    kind: row.kind,
    body: row.body,
    context_refs: row.context_refs ?? {},
    agent: row.agent,
    model: row.model,
    run_id: row.run_id,
    job_id: row.job_id,
    claim_id: row.claim_id,
    seen_at: iso(row.seen_at),
  };
}
