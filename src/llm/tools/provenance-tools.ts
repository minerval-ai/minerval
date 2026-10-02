/**
 * Executors for the tools the Provenance skill declares in
 * skills/provenance/tools.json (#286). The skill is a method skill: every
 * Steward run carries it, so these tools are always in the Steward's
 * toolset, and the skill text carries the judgment about when the work is
 * worth doing.
 *
 *  - `provenance_get_map` reads everything recorded about what a claim's
 *    support rests on, with the instance and source ids the write tools
 *    take.
 *  - `provenance_read_source` returns a source's text, windowed, fetching
 *    and storing it when the graph holds no copy: the way a Steward opens
 *    a document and reads it whole (§9).
 *  - `provenance_record_reading`, `provenance_record_edge`, and
 *    `provenance_record_source_relationship` record judgments about one
 *    instance, one dependency, and one pair of documents.
 *  - `provenance_record_root` records where the claim's story begins, or
 *    that a source which looks like a beginning is untraced (#507), where
 *    the derivation from the source's kind is wrong.
 *  - `provenance_write_map` records the reader-facing account and whether
 *    it is material enough to show.
 *
 * Every executor returns a string and never throws, like the other tool
 * families: a refusal is a structured result the agent routes around.
 */
import type { SkillToolContext, SkillToolExecutor } from "./skill-tools.js";
import {
  SourceMapError,
  getClaimSourceMap,
  listInstancesForMapping,
  readSourceContent,
  recordInstanceReading,
  recordProvenanceEdge,
  recordProvenanceRoot,
  recordSourceRelationship,
  writeSourceMap,
} from "../../services/source-map-service.js";
import { getProvenanceStory } from "../../services/provenance-story-service.js";
import { getSourceFacts } from "../../services/source-facts-service.js";
import {
  ExaminationError,
  citeFindings,
  getExaminationOutline,
  listExaminations,
  noteFinding,
  recordCoverage,
  recordFinding,
} from "../../services/examination-service.js";
import {
  CLAIM_PROVENANCE_RELATION_GUIDANCE,
  INSTANCE_SUPPORT_GUIDANCE,
  PROVENANCE_FIDELITY_GUIDANCE,
  PROVENANCE_ROOT_GUIDANCE,
  SOURCE_RELATION_GUIDANCE,
} from "../../schemas/common.js";

export const PROVENANCE_TOOL_NAMES: readonly string[] = [
  "provenance_get_map",
  "provenance_read_source",
  "provenance_record_reading",
  "provenance_record_edge",
  "provenance_record_source_relationship",
  "provenance_record_root",
  "provenance_write_map",
  "examination_outline",
  "examination_record_coverage",
  "examination_record_finding",
  "provenance_cite_findings",
  "examination_note_finding",
];

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function refuse(message: string): string {
  return JSON.stringify({ success: false, message });
}

/** The agent key recorded as the writer: the role's key in the graph's own spelling. */
export function writerFor(ctx: SkillToolContext): string {
  return ctx.role.replace(/-/g, "_");
}

function claimFor(input: Record<string, unknown>, ctx: SkillToolContext): string | null {
  return str(input.claim_id) || ctx.claimId || null;
}

async function guarded(fn: () => Promise<string>): Promise<string> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SourceMapError || err instanceof ExaminationError) return refuse(err.message);
    throw err;
  }
}

export const executeGetMap: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("claim_id is required outside a claim-scoped run.");
    const [instances, map, story] = await Promise.all([
      listInstancesForMapping(claimId),
      getClaimSourceMap(claimId),
      getProvenanceStory(claimId),
    ]);
    const examinations = await listExaminations(story.nodes.map((n) => n.source.id));
    const readings = map.readings;
    return JSON.stringify({
      success: true,
      claim_id: claimId,
      source_map: map.map,
      instances: instances.map((i) => ({
        ...i,
        reading: readings[i.instance_id] ?? null,
        draws_on: map.edges
          .filter((e) => e.from_instance_id === i.instance_id)
          .map((e) => ({
            edge_id: e.id,
            to_source: e.to_source,
            to_instance_id: e.to_instance_id,
            relation_type: e.relation_type,
            fidelity: e.fidelity,
            evidence: e.evidence,
            reasoning: e.reasoning,
            confidence: e.confidence,
            target_read: e.target_read,
          })),
      })),
      source_relationships: map.source_relationships,
      // The top of the claim's story as the claim page will draw it: every
      // source with nothing recorded upstream, and each underlying source.
      // Derived sources are left out; they are the instances above.
      top_of_story: story.nodes
        .filter((n) => n.standing !== "derived" || n.underlying)
        .map((n) => ({
          source: { id: n.source.id, title: n.source.title, source_type: n.source.source_type },
          standing: n.standing,
          basis: n.basis,
          root_basis: n.root?.basis ?? null,
          underlying: n.underlying,
          downstream_total: n.downstream_total,
        })),
      // In-depth checks of the claim's documents, by this claim's Steward or
      // any other, with their findings. A finding is the examination's, not
      // a verdict: cite the ones your reading relies on.
      examinations: examinations.map((x) => ({
        examination_id: x.id,
        source_id: x.source_id,
        scope: x.scope,
        commissioned_for: x.claim ? (x.claim.id === claimId ? "this claim" : x.claim.text) : "a review of the document",
        facets: x.facets,
        segments_covered: new Set(x.coverage.map((c) => c.segment_id)).size,
        findings: x.findings.map((f) => ({
          finding_id: f.id,
          segment_label: f.segment_label,
          facet: f.facet,
          statement: f.statement,
          evidence: f.evidence,
          audit_notes: f.audit_notes.map((n) => n.note),
        })),
      })),
      note:
        "Instance and source ids here are the ones the provenance_record_* tools take. " +
        "A reading says whether a source's own evidence bears what it asserts, not " +
        "whether the claim is true; that judgment is yours. Nothing here is a score. " +
        "In top_of_story, an origin's basis is 'steward' (recorded) or 'primary_source_kind' " +
        "(derived from its kind); an untraced source has nothing recorded upstream and " +
        "nothing saying it is where the claim begins.",
    });
  });

export const executeReadSource: SkillToolExecutor = async (input) =>
  guarded(async () => {
    const sourceId = str(input.source_id) || undefined;
    const url = str(input.url) || undefined;
    if (!sourceId && !url) return refuse("Pass a source_id (from provenance_get_map) or a url.");
    const offsetRaw = Number(input.offset);
    const maxRaw = Number(input.max_chars);
    const result = await readSourceContent({
      sourceId,
      url,
      offset: Number.isFinite(offsetRaw) ? offsetRaw : undefined,
      maxChars: Number.isFinite(maxRaw) ? maxRaw : undefined,
    });
    // On the first window, what is known about the document without
    // judgment (#507): who, where, when, and any correction or retraction.
    const facts = result.offset === 0 ? await getSourceFacts(result.source.id).catch(() => null) : null;
    return JSON.stringify({
      success: true,
      ...result,
      ...(facts
        ? {
            facts: {
              authors: facts.source.authors,
              publisher: facts.source.publisher,
              published_date: facts.source.published_date,
              doi: facts.source.doi,
              archived_url: facts.source.archived_url,
              events: facts.events.map((e) => ({ kind: e.kind, occurred_at: e.occurred_at, notice_url: e.notice_url, note: e.note })),
              versions: facts.versions,
              copy_of: facts.copy_of,
            },
          }
        : {}),
      note: result.truncated
        ? `More text follows; call again with offset ${result.offset + result.content.length} to continue.`
        : "This is the end of the stored text.",
    });
  });

export const executeRecordReading: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("This tool records on the claim you steward; no claim is in scope.");
    const result = await recordInstanceReading({
      claimId,
      instanceId: str(input.instance_id),
      support: str(input.support),
      deployment: str(input.deployment) || null,
      note: str(input.note) || null,
      worthReading: input.worth_reading === true,
      worthReadingReason: str(input.worth_reading_reason) || null,
      sourceRead: input.source_read === true,
      model: ctx.run?.model ?? null,
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({
      success: true,
      ...result,
      quote_check_note:
        result.quote_check === "verbatim" || result.quote_check === "normalized_match"
          ? "The recorded passage is present in the stored text of its source."
          : result.quote_check === "not_found"
            ? "The recorded passage was NOT found in the stored text of its source. Read the source before relying on the quote; if the instance misquotes it, say so in your reasoning."
            : "The graph holds no text for this source, so the quote could not be checked; provenance_read_source fetches and stores it.",
    });
  });

export const executeRecordEdge: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("This tool records on the claim you steward; no claim is in scope.");
    const confidenceRaw = input.confidence;
    const result = await recordProvenanceEdge({
      claimId,
      fromInstanceId: str(input.from_instance_id),
      toSourceId: str(input.to_source_id) || null,
      toSourceUrl: str(input.to_source_url) || null,
      toSourceTitle: str(input.to_source_title) || null,
      relationType: str(input.relation_type),
      fidelity: str(input.fidelity) || null,
      evidence: str(input.evidence),
      reasoning: str(input.reasoning),
      confidence: confidenceRaw === undefined || confidenceRaw === null ? null : Number(confidenceRaw),
      targetRead: input.target_read === true,
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({
      success: true,
      ...result,
      note: result.to_instance_id
        ? "The upstream document also asserts this claim; the edge links to that instance."
        : "The upstream document is not recorded as asserting this claim itself, which is common: a study states a narrower finding than the assertion built on it.",
    });
  });

export const executeRecordSourceRelationship: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const confidenceRaw = input.confidence;
    const result = await recordSourceRelationship({
      parentSourceId: str(input.parent_source_id),
      childSourceId: str(input.child_source_id),
      relationType: str(input.relation_type),
      reasoning: str(input.reasoning),
      confidence: confidenceRaw === undefined || confidenceRaw === null ? null : Number(confidenceRaw),
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({ success: true, ...result });
  });

export const executeRecordRoot: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("This tool records on the claim you steward; no claim is in scope.");
    const result = await recordProvenanceRoot({
      claimId,
      sourceId: str(input.source_id),
      status: str(input.status),
      basis: str(input.basis),
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({
      success: true,
      ...result,
      note:
        result.status === "untraced" && result.has_upstream
          ? "Recorded, but this source has an upstream edge, so the map shows it below what it draws on rather than as untraced."
          : result.status === "origin" && result.has_upstream
            ? "Recorded. This source also has an upstream edge; the map shows it as an origin on your say-so, with its upstream still listed."
            : result.status === "origin"
              ? "The map shows this source in the origins row, with your basis on its card."
              : "The map shows this source as untraced, apart from the origins.",
    });
  });

function examinationFor(ctx: SkillToolContext): string | null {
  return ctx.examinationId ?? null;
}

const NO_EXAMINATION =
  "This run was not launched to examine a document; the examination tools record only on the examination a run carries out.";

export const executeExaminationOutline: SkillToolExecutor = async (_input, ctx) =>
  guarded(async () => {
    const id = examinationFor(ctx);
    if (!id) return refuse(NO_EXAMINATION);
    const outline = await getExaminationOutline(id);
    return JSON.stringify({
      success: true,
      ...outline,
      note:
        outline.segments.length === 0
          ? "The document has no stored text yet. Open it with provenance_read_source (source_id above), which fetches and divides it, then call this again."
          : "Read a segment's text with provenance_read_source at its char_start. Record coverage only for segments you examined, and anchor each finding to its passage.",
    });
  });

export const executeRecordCoverage: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const id = examinationFor(ctx);
    if (!id) return refuse(NO_EXAMINATION);
    const result = await recordCoverage({ examinationId: id, segmentIds: input.segment_ids, facet: input.facet });
    return JSON.stringify({ success: true, ...result });
  });

export const executeRecordFinding: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const id = examinationFor(ctx);
    if (!id) return refuse(NO_EXAMINATION);
    const result = await recordFinding({
      examinationId: id,
      segmentId: input.segment_id,
      facet: input.facet,
      statement: input.statement,
      evidence: input.evidence,
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({ success: true, finding_id: result.id });
  });

export const executeCiteFindings: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("This tool records on the claim you steward; no claim is in scope.");
    const result = await citeFindings({
      claimId,
      instanceId: input.instance_id,
      findingIds: input.finding_ids,
      createdBy: writerFor(ctx),
    });
    return JSON.stringify({ success: true, ...result });
  });

export const executeNoteFinding: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const result = await noteFinding({ findingId: input.finding_id, note: input.note, createdBy: writerFor(ctx) });
    return JSON.stringify({ success: true, note_id: result.id });
  });

export const executeWriteMap: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("This tool writes the map of the claim you steward; no claim is in scope.");
    if (typeof input.material !== "boolean") {
      return refuse(
        "material is required and must be true or false: whether the structure of the support is worth showing a reader of this claim."
      );
    }
    const result = await writeSourceMap({
      claimId,
      summary: str(input.summary),
      material: input.material,
      model: ctx.run?.model ?? null,
      mappedBy: writerFor(ctx),
    });
    return JSON.stringify({
      success: true,
      ...result,
      note: input.material
        ? "The summary will appear on the claim page above the instances."
        : "Recorded as immaterial: the summary is kept for the audit trail and does not appear on the claim page.",
    });
  });

/** The vocabulary guidance, re-exported so the tool descriptions and the skill text cannot drift. */
export const PROVENANCE_GUIDANCE = {
  relation: CLAIM_PROVENANCE_RELATION_GUIDANCE,
  fidelity: PROVENANCE_FIDELITY_GUIDANCE,
  support: INSTANCE_SUPPORT_GUIDANCE,
  sourceRelation: SOURCE_RELATION_GUIDANCE,
  root: PROVENANCE_ROOT_GUIDANCE,
};

export function registerProvenanceTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  register("provenance_get_map", executeGetMap);
  register("provenance_read_source", executeReadSource);
  register("provenance_record_reading", executeRecordReading);
  register("provenance_record_edge", executeRecordEdge);
  register("provenance_record_source_relationship", executeRecordSourceRelationship);
  register("provenance_record_root", executeRecordRoot);
  register("provenance_write_map", executeWriteMap);
  register("examination_outline", executeExaminationOutline);
  register("examination_record_coverage", executeRecordCoverage);
  register("examination_record_finding", executeRecordFinding);
  register("provenance_cite_findings", executeCiteFindings);
  register("examination_note_finding", executeNoteFinding);
}
