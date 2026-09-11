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
  recordSourceRelationship,
  writeSourceMap,
} from "../../services/source-map-service.js";
import {
  CLAIM_PROVENANCE_RELATION_GUIDANCE,
  INSTANCE_SUPPORT_GUIDANCE,
  PROVENANCE_FIDELITY_GUIDANCE,
  SOURCE_RELATION_GUIDANCE,
} from "../../schemas/common.js";

export const PROVENANCE_TOOL_NAMES: readonly string[] = [
  "provenance_get_map",
  "provenance_read_source",
  "provenance_record_reading",
  "provenance_record_edge",
  "provenance_record_source_relationship",
  "provenance_write_map",
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
    if (err instanceof SourceMapError) return refuse(err.message);
    throw err;
  }
}

export const executeGetMap: SkillToolExecutor = async (input, ctx) =>
  guarded(async () => {
    const claimId = claimFor(input, ctx);
    if (!claimId) return refuse("claim_id is required outside a claim-scoped run.");
    const [instances, map] = await Promise.all([
      listInstancesForMapping(claimId),
      getClaimSourceMap(claimId),
    ]);
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
      note:
        "Instance and source ids here are the ones the provenance_record_* tools take. " +
        "A reading says whether a source's own evidence bears what it asserts, not " +
        "whether the claim is true; that judgment is yours. Nothing here is a score.",
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
    return JSON.stringify({
      success: true,
      ...result,
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
};

export function registerProvenanceTools(
  register: (name: string, executor: SkillToolExecutor) => void
): void {
  register("provenance_get_map", executeGetMap);
  register("provenance_read_source", executeReadSource);
  register("provenance_record_reading", executeRecordReading);
  register("provenance_record_edge", executeRecordEdge);
  register("provenance_record_source_relationship", executeRecordSourceRelationship);
  register("provenance_write_map", executeWriteMap);
}
