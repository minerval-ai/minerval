/**
 * Examinations of a document (#507, phase 5): in-depth checks recorded as
 * records of their own, scoped, attributed, and anchored to passages.
 *
 * An examination is opened when an administrator launches the researcher
 * on a document (delegate_research with examine_source_id): a Steward
 * while assessing its claim, or a Grantmaker reviewing the document for a
 * mandate. The researcher records what it examined (coverage, by segment
 * and facet) and what it found (findings, each on a passage). Nothing here
 * rules on a finding or on the source. A claim's Steward cites the findings
 * its reading relies on; the Audit agent may annotate a finding about the
 * document. The rest is a reader's.
 *
 * Every write validates its inputs and throws an ExaminationError with a
 * message written for the agent; the tool executors turn it into a
 * structured refusal.
 */
import { rawQuery } from "../db/client.js";
import { EXAMINATION_SCOPES, EXAMINATION_TRIGGERS } from "../schemas/common.js";
import { segmentSourceOnce } from "./source-segment-service.js";
import { htmlToText } from "./source-map-service.js";

export class ExaminationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExaminationError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FACETS = 8;

function uuid(value: unknown, field: string): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!UUID_RE.test(v)) throw new ExaminationError(`${field} must be a uuid (got "${v}").`);
  return v;
}

function text(value: unknown, field: string, max: number): string {
  const v = typeof value === "string" ? value.trim() : "";
  if (!v) throw new ExaminationError(`${field} is required.`);
  if (v.length > max) throw new ExaminationError(`${field} is too long (${v.length} characters; at most ${max}).`);
  return v;
}

/**
 * Facets as short lower-case labels, deduplicated: "data", "quotation",
 * "method", "attribution". Free labels rather than a fixed list, because
 * what is worth checking differs by kind of document.
 */
export function normalizeFacets(value: unknown): string[] {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const facets = [
    ...new Set(
      raw
        .map((f) => (typeof f === "string" ? f.trim().toLowerCase().replace(/\s+/g, "_") : ""))
        .filter(Boolean)
    ),
  ];
  if (facets.length === 0) {
    throw new ExaminationError('facets is required: what to check, as short labels such as "data", "quotation", "method".');
  }
  if (facets.length > MAX_FACETS) throw new ExaminationError(`At most ${MAX_FACETS} facets; scope the examination.`);
  for (const f of facets) {
    if (!/^[a-z0-9_-]{1,40}$/.test(f)) {
      throw new ExaminationError(`Facet "${f}" must be a short label of letters, digits, hyphens, or underscores.`);
    }
  }
  return facets;
}

export interface ExaminationRow {
  id: string;
  scope: string;
  trigger: string;
  claim_id: string | null;
  grant_id: string | null;
  source_id: string;
  source_title: string;
  source_url: string | null;
  brief: string;
  facets: string[];
  requested_by: string;
  created_at: string;
}

/**
 * Open an examination of a document. A claim-scoped one must examine a
 * document in that claim's map (an instance's source, or one an edge draws
 * on): a Steward commissions work on what its claim rests on.
 */
export async function openExamination(input: {
  scope: string;
  trigger: string;
  claimId: string | null;
  grantId: string | null;
  sourceId: string;
  brief: string;
  facets: unknown;
  requestedBy: string;
}): Promise<ExaminationRow> {
  if (!(EXAMINATION_SCOPES as readonly string[]).includes(input.scope)) {
    throw new ExaminationError(`scope must be one of ${EXAMINATION_SCOPES.join(", ")}.`);
  }
  if (!(EXAMINATION_TRIGGERS as readonly string[]).includes(input.trigger)) {
    throw new ExaminationError(`trigger must be one of ${EXAMINATION_TRIGGERS.join(", ")}.`);
  }
  const sourceId = uuid(input.sourceId, "examine_source_id");
  const facets = normalizeFacets(input.facets);
  const brief = text(input.brief, "brief", 20_000);
  const [source] = await rawQuery<{ id: string; title: string; url: string | null }>(
    `SELECT id, title, url FROM sources WHERE id = $1`,
    [sourceId]
  );
  if (!source) throw new ExaminationError(`No source ${sourceId} exists. Take source ids from provenance_get_map.`);
  if (input.scope === "claim") {
    if (!input.claimId) throw new ExaminationError("A claim-scoped examination needs the claim it serves.");
    const [inMap] = await rawQuery<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM claim_instances WHERE claim_id = $1 AND source_id = $2)
           OR EXISTS (SELECT 1 FROM claim_provenance_edges e
                        JOIN claim_instances ci ON ci.id = e.from_instance_id
                       WHERE ci.claim_id = $1 AND e.to_source_id = $2) AS ok`,
      [input.claimId, sourceId]
    );
    if (!inMap?.ok) {
      throw new ExaminationError(
        "That source is not in this claim's map: examine a document the claim's sources state it in or draw on."
      );
    }
  }
  const rows = await rawQuery<{ id: string; created_at: Date }>(
    `INSERT INTO examinations (scope, trigger, claim_id, grant_id, source_id, brief, facets, requested_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [input.scope, input.trigger, input.claimId, input.grantId, sourceId, brief, facets, input.requestedBy]
  );
  return {
    id: rows[0]!.id,
    scope: input.scope,
    trigger: input.trigger,
    claim_id: input.claimId,
    grant_id: input.grantId,
    source_id: sourceId,
    source_title: source.title,
    source_url: source.url,
    brief,
    facets,
    requested_by: input.requestedBy,
    created_at: new Date(rows[0]!.created_at).toISOString(),
  };
}

export async function linkResearchRun(examinationId: string, researchRunId: string): Promise<void> {
  await rawQuery(`UPDATE research_runs SET examination_id = $2 WHERE id = $1`, [researchRunId, examinationId]);
}

async function examination(id: string): Promise<{ id: string; source_id: string; facets: string[] }> {
  const [row] = await rawQuery<{ id: string; source_id: string; facets: string[] }>(
    `SELECT id, source_id, facets FROM examinations WHERE id = $1`,
    [id]
  );
  if (!row) throw new ExaminationError(`No examination ${id} exists.`);
  return row;
}

function facetOf(exam: { facets: string[] }, value: unknown): string {
  const f = typeof value === "string" ? value.trim().toLowerCase().replace(/\s+/g, "_") : "";
  if (!exam.facets.includes(f)) {
    throw new ExaminationError(`facet must be one this examination checks: ${exam.facets.join(", ")} (got "${f}").`);
  }
  return f;
}

export interface OutlineSegment {
  segment_id: string;
  parent_id: string | null;
  kind: string;
  label: string | null;
  char_start: number;
  char_end: number;
  preview: string;
}

/**
 * The examined document's segments, with ids the recording tools take and
 * the offsets provenance_read_source pages by. Segments the document on
 * first use; a source with no stored text has none until it is read.
 */
export async function getExaminationOutline(examinationId: string): Promise<{
  examination_id: string;
  source_id: string;
  facets: string[];
  segments: OutlineSegment[];
  covered: Array<{ segment_id: string; facet: string }>;
  findings: number;
}> {
  const exam = await examination(examinationId);
  await segmentSourceOnce(exam.source_id);
  const [segments, covered, findings] = await Promise.all([
    rawQuery<{
      id: string;
      parent_id: string | null;
      kind: string;
      label: string | null;
      char_start: number;
      char_end: number;
    }>(
      `SELECT id, parent_id, kind, label, char_start, char_end
         FROM source_segments WHERE source_id = $1 ORDER BY ordinal`,
      [exam.source_id]
    ),
    rawQuery<{ segment_id: string; facet: string }>(
      `SELECT segment_id, facet FROM examination_coverage WHERE examination_id = $1 ORDER BY created_at`,
      [examinationId]
    ),
    rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM examination_findings WHERE examination_id = $1`, [examinationId]),
  ]);
  let previewText = "";
  if (segments.length > 0) {
    const [src] = await rawQuery<{ raw_content: string | null }>(`SELECT raw_content FROM sources WHERE id = $1`, [exam.source_id]);
    previewText = htmlToText(src?.raw_content ?? "");
  }
  return {
    examination_id: examinationId,
    source_id: exam.source_id,
    facets: exam.facets,
    segments: segments.map((s) => {
      const body = previewText.slice(s.char_start, Math.min(s.char_end, s.char_start + 160)).replace(/\s+/g, " ");
      return {
        segment_id: s.id,
        parent_id: s.parent_id,
        kind: s.kind,
        label: s.label,
        char_start: s.char_start,
        char_end: s.char_end,
        preview: s.char_end - s.char_start > 160 ? `${body}…` : body,
      };
    }),
    covered,
    findings: Number(findings[0]?.n ?? 0),
  };
}

async function segmentsOfSource(sourceId: string, ids: string[]): Promise<void> {
  const found = await rawQuery<{ id: string }>(
    `SELECT id FROM source_segments WHERE source_id = $1 AND id = ANY($2::uuid[])`,
    [sourceId, ids]
  );
  if (found.length !== ids.length) {
    const known = new Set(found.map((f) => f.id));
    const bad = ids.filter((i) => !known.has(i));
    throw new ExaminationError(
      `Not segments of the examined document: ${bad.join(", ")}. Take segment ids from examination_outline.`
    );
  }
}

/** Record which segments the examination actually looked at, for one facet. Idempotent. */
export async function recordCoverage(input: {
  examinationId: string;
  segmentIds: unknown;
  facet: unknown;
}): Promise<{ recorded: number; facet: string }> {
  const exam = await examination(input.examinationId);
  const facet = facetOf(exam, input.facet);
  const ids = [...new Set((Array.isArray(input.segmentIds) ? input.segmentIds : []).map((v) => uuid(v, "segment_ids[]")))];
  if (ids.length === 0) throw new ExaminationError("segment_ids is required: the segments you examined for this facet.");
  if (ids.length > 500) throw new ExaminationError("At most 500 segments per call.");
  await segmentsOfSource(exam.source_id, ids);
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO examination_coverage (examination_id, segment_id, facet)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT (examination_id, segment_id, facet) DO NOTHING
     RETURNING id`,
    [exam.id, ids, facet]
  );
  return { recorded: rows.length, facet };
}

/** Record one finding, anchored to the passage it is about. */
export async function recordFinding(input: {
  examinationId: string;
  segmentId: unknown;
  facet: unknown;
  statement: unknown;
  evidence: unknown;
  createdBy: string;
}): Promise<{ id: string; covered: boolean }> {
  const exam = await examination(input.examinationId);
  const facet = facetOf(exam, input.facet);
  const segmentId = uuid(input.segmentId, "segment_id");
  await segmentsOfSource(exam.source_id, [segmentId]);
  const statement = text(input.statement, "statement", 4000);
  const evidence = text(input.evidence, "evidence", 8000);
  if (statement.includes("—")) {
    throw new ExaminationError("Findings are read on the source page: no em-dashes. Use a comma, a colon, or a new sentence.");
  }
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO examination_findings (examination_id, segment_id, facet, statement, evidence, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [exam.id, segmentId, facet, statement, evidence, input.createdBy]
  );
  // A finding on a passage means the passage was examined for that facet.
  await rawQuery(
    `INSERT INTO examination_coverage (examination_id, segment_id, facet) VALUES ($1, $2, $3)
     ON CONFLICT (examination_id, segment_id, facet) DO NOTHING`,
    [exam.id, segmentId, facet]
  );
  return { id: row!.id, covered: true };
}

/**
 * A claim Steward's reading cites findings it relied on. The reading must
 * exist (record it first) and the findings must be about the reading's own
 * source. Idempotent.
 */
export async function citeFindings(input: {
  claimId: string;
  instanceId: unknown;
  findingIds: unknown;
  createdBy: string;
}): Promise<{ reading_id: string; cited: number }> {
  const instanceId = uuid(input.instanceId, "instance_id");
  const ids = [...new Set((Array.isArray(input.findingIds) ? input.findingIds : []).map((v) => uuid(v, "finding_ids[]")))];
  if (ids.length === 0) throw new ExaminationError("finding_ids is required.");
  const [inst] = await rawQuery<{ claim_id: string; source_id: string; reading_id: string | null }>(
    `SELECT ci.claim_id, ci.source_id, r.id AS reading_id
       FROM claim_instances ci LEFT JOIN claim_instance_readings r ON r.instance_id = ci.id
      WHERE ci.id = $1`,
    [instanceId]
  );
  if (!inst) throw new ExaminationError(`No instance ${instanceId} exists.`);
  if (inst.claim_id !== input.claimId) {
    throw new ExaminationError("That instance belongs to another claim; you cite findings from your own claim's readings.");
  }
  if (!inst.reading_id) {
    throw new ExaminationError("Record a reading of this instance first (provenance_record_reading); citations hang from it.");
  }
  const findings = await rawQuery<{ id: string }>(
    `SELECT f.id FROM examination_findings f JOIN examinations x ON x.id = f.examination_id
      WHERE f.id = ANY($1::uuid[]) AND x.source_id = $2`,
    [ids, inst.source_id]
  );
  if (findings.length !== ids.length) {
    throw new ExaminationError("Every finding cited must be about this instance's source. Take finding ids from provenance_get_map.");
  }
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO reading_citations (reading_id, finding_id, created_by)
     SELECT $1, unnest($2::uuid[]), $3
     ON CONFLICT (reading_id, finding_id) DO NOTHING RETURNING id`,
    [inst.reading_id, ids, input.createdBy]
  );
  return { reading_id: inst.reading_id, cited: rows.length };
}

/** The Audit agent's attributed note on a finding. */
export async function noteFinding(input: { findingId: unknown; note: unknown; createdBy: string }): Promise<{ id: string }> {
  const findingId = uuid(input.findingId, "finding_id");
  const note = text(input.note, "note", 4000);
  const [exists] = await rawQuery<{ id: string }>(`SELECT id FROM examination_findings WHERE id = $1`, [findingId]);
  if (!exists) throw new ExaminationError(`No finding ${findingId} exists.`);
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO audit_notes (finding_id, note, created_by) VALUES ($1, $2, $3) RETURNING id`,
    [findingId, note, input.createdBy]
  );
  return { id: row!.id };
}

export interface FindingView {
  id: string;
  segment_id: string | null;
  segment_label: string | null;
  facet: string;
  statement: string;
  evidence: string;
  created_by: string;
  created_at: string;
  audit_notes: Array<{ note: string; created_by: string; created_at: string }>;
  /** The claims whose Stewards cite this finding in a reading. */
  cited_by_claims: string[];
}

export interface ExaminationView {
  id: string;
  scope: string;
  trigger: string;
  claim: { id: string; text: string } | null;
  grant_id: string | null;
  source_id: string;
  brief: string;
  facets: string[];
  requested_by: string;
  created_at: string;
  runs: Array<{ id: string; status: string; model: string; spent_usd: number; finished_at: string | null }>;
  coverage: Array<{ segment_id: string; facet: string }>;
  findings: FindingView[];
}

/** Every examination of the given sources, with coverage, findings, notes, and citations. */
export async function listExaminations(sourceIds: string[]): Promise<ExaminationView[]> {
  const ids = sourceIds.filter((s) => UUID_RE.test(s));
  if (ids.length === 0) return [];
  const exams = await rawQuery<{
    id: string;
    scope: string;
    trigger: string;
    claim_id: string | null;
    claim_text: string | null;
    grant_id: string | null;
    source_id: string;
    brief: string;
    facets: string[];
    requested_by: string;
    created_at: Date;
  }>(
    `SELECT x.id, x.scope, x.trigger, x.claim_id, c.text AS claim_text, x.grant_id, x.source_id,
            x.brief, x.facets, x.requested_by, x.created_at
       FROM examinations x LEFT JOIN claims c ON c.id = x.claim_id
      WHERE x.source_id = ANY($1::uuid[])
      ORDER BY x.created_at`,
    [ids]
  );
  if (exams.length === 0) return [];
  const examIds = exams.map((e) => e.id);
  const [runs, coverage, findings, notes, citations] = await Promise.all([
    rawQuery<{ id: string; examination_id: string; status: string; model: string; spent_micro_usd: string; finished_at: Date | null }>(
      `SELECT id, examination_id, status, model, spent_micro_usd, finished_at
         FROM research_runs WHERE examination_id = ANY($1::uuid[]) ORDER BY started_at`,
      [examIds]
    ),
    rawQuery<{ examination_id: string; segment_id: string; facet: string }>(
      `SELECT examination_id, segment_id, facet FROM examination_coverage
        WHERE examination_id = ANY($1::uuid[]) ORDER BY created_at`,
      [examIds]
    ),
    rawQuery<{
      id: string;
      examination_id: string;
      segment_id: string | null;
      segment_label: string | null;
      facet: string;
      statement: string;
      evidence: string;
      created_by: string;
      created_at: Date;
    }>(
      `SELECT f.id, f.examination_id, f.segment_id, g.label AS segment_label, f.facet, f.statement,
              f.evidence, f.created_by, f.created_at
         FROM examination_findings f LEFT JOIN source_segments g ON g.id = f.segment_id
        WHERE f.examination_id = ANY($1::uuid[])
        ORDER BY g.ordinal NULLS LAST, f.created_at`,
      [examIds]
    ),
    rawQuery<{ finding_id: string; note: string; created_by: string; created_at: Date }>(
      `SELECT n.finding_id, n.note, n.created_by, n.created_at FROM audit_notes n
         JOIN examination_findings f ON f.id = n.finding_id
        WHERE f.examination_id = ANY($1::uuid[]) ORDER BY n.created_at`,
      [examIds]
    ),
    rawQuery<{ finding_id: string; claim_id: string }>(
      `SELECT DISTINCT rc.finding_id, ci.claim_id FROM reading_citations rc
         JOIN examination_findings f ON f.id = rc.finding_id
         JOIN claim_instance_readings r ON r.id = rc.reading_id
         JOIN claim_instances ci ON ci.id = r.instance_id
        WHERE f.examination_id = ANY($1::uuid[])`,
      [examIds]
    ),
  ]);
  return exams.map((e) => ({
    id: e.id,
    scope: e.scope,
    trigger: e.trigger,
    claim: e.claim_id && e.claim_text ? { id: e.claim_id, text: e.claim_text } : null,
    grant_id: e.grant_id,
    source_id: e.source_id,
    brief: e.brief,
    facets: e.facets,
    requested_by: e.requested_by,
    created_at: new Date(e.created_at).toISOString(),
    runs: runs
      .filter((r) => r.examination_id === e.id)
      .map((r) => ({
        id: r.id,
        status: r.status,
        model: r.model,
        spent_usd: Math.round(Number(r.spent_micro_usd) / 10_000) / 100,
        finished_at: r.finished_at ? new Date(r.finished_at).toISOString() : null,
      })),
    coverage: coverage.filter((c) => c.examination_id === e.id).map((c) => ({ segment_id: c.segment_id, facet: c.facet })),
    findings: findings
      .filter((f) => f.examination_id === e.id)
      .map((f) => ({
        id: f.id,
        segment_id: f.segment_id,
        segment_label: f.segment_label,
        facet: f.facet,
        statement: f.statement,
        evidence: f.evidence,
        created_by: f.created_by,
        created_at: new Date(f.created_at).toISOString(),
        audit_notes: notes
          .filter((n) => n.finding_id === f.id)
          .map((n) => ({ note: n.note, created_by: n.created_by, created_at: new Date(n.created_at).toISOString() })),
        cited_by_claims: citations.filter((c) => c.finding_id === f.id).map((c) => c.claim_id),
      })),
  }));
}
