import { describe, it, expect, vi, beforeEach } from "vitest";

// The Provenance skill's executors (#286) over a mocked service: each takes
// the claim from the run's context, stamps the writer from the role, turns
// a SourceMapError into a structured refusal, and never throws.

const mocks = vi.hoisted(() => ({
  getClaimSourceMap: vi.fn(),
  listInstancesForMapping: vi.fn(),
  readSourceContent: vi.fn(),
  recordInstanceReading: vi.fn(),
  recordProvenanceEdge: vi.fn(),
  recordSourceRelationship: vi.fn(),
  writeSourceMap: vi.fn(),
}));

vi.mock("../../../../src/services/source-map-service.js", () => {
  class SourceMapError extends Error {}
  return { SourceMapError, ...mocks };
});
vi.mock("../../../../src/db/client.js", () => ({ getDb: vi.fn(), rawQuery: vi.fn() }));

import { SourceMapError } from "../../../../src/services/source-map-service.js";
import {
  PROVENANCE_TOOL_NAMES,
  executeGetMap,
  executeReadSource,
  executeRecordEdge,
  executeRecordReading,
  executeRecordSourceRelationship,
  executeWriteMap,
  registerProvenanceTools,
  writerFor,
} from "../../../../src/llm/tools/provenance-tools.js";
import { executeSkillTool } from "../../../../src/llm/tools/skill-tools.js";
import type { SkillToolContext } from "../../../../src/llm/tools/skill-tools.js";

const CLAIM = "aaaaaaaa-0000-4000-8000-000000000001";
const steward: SkillToolContext = {
  role: "claim-steward",
  claimId: CLAIM,
  run: { trigger: "structure_and_assess", context: "", model: "model-x" },
};

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
});

describe("registration", () => {
  it("registers every tool the skill declares, under the names in tools.json", async () => {
    const names: string[] = [];
    registerProvenanceTools((name) => names.push(name));
    expect(names).toEqual(PROVENANCE_TOOL_NAMES);
    // The real registry refuses an undeclared name and runs a declared one.
    expect(JSON.parse(await executeSkillTool("provenance_nope", {}, steward)).success).toBe(false);
    mocks.readSourceContent.mockResolvedValue({
      source: { id: "s1" }, origin: "stored", total_chars: 1, offset: 0, content: "x", truncated: false,
    });
    expect(JSON.parse(await executeSkillTool("provenance_read_source", { source_id: "s1" }, steward)).success).toBe(true);
  });

  it("stamps the writer from the role, in the graph's own spelling", () => {
    expect(writerFor(steward)).toBe("claim_steward");
    expect(writerFor({ role: "audit-agent" })).toBe("audit_agent");
  });
});

describe("provenance_get_map", () => {
  it("joins the instances with their readings and edges and takes the claim from the run", async () => {
    mocks.listInstancesForMapping.mockResolvedValue([
      { instance_id: "i1", source: { id: "s1", title: "A", url: null, source_type: "unknown", has_stored_text: true } },
      { instance_id: "i2", source: { id: "s2", title: "B", url: null, source_type: "unknown", has_stored_text: false } },
    ]);
    mocks.getClaimSourceMap.mockResolvedValue({
      map: { summary: "x", material: false },
      readings: { i1: { support: "supports" } },
      edges: [
        { id: "e1", from_instance_id: "i2", to_source: { id: "s1", title: "A", url: null }, to_instance_id: "i1",
          relation_type: "derives_from", fidelity: "faithful", evidence: "p", reasoning: "r", confidence: 0.7, target_read: true },
      ],
      source_relationships: [],
    });
    const out = JSON.parse(await executeGetMap({}, steward));
    expect(mocks.listInstancesForMapping).toHaveBeenCalledWith(CLAIM);
    expect(out.success).toBe(true);
    expect(out.claim_id).toBe(CLAIM);
    expect(out.source_map).toEqual({ summary: "x", material: false });
    expect(out.instances[0].reading).toEqual({ support: "supports" });
    expect(out.instances[0].draws_on).toEqual([]);
    expect(out.instances[1].reading).toBeNull();
    expect(out.instances[1].draws_on[0]).toMatchObject({ edge_id: "e1", relation_type: "derives_from" });
    expect(out.note).toMatch(/Nothing here is a score/);
  });

  it("needs a claim_id outside a claim-scoped run", async () => {
    const out = JSON.parse(await executeGetMap({}, { role: "audit-agent" }));
    expect(out).toEqual({ success: false, message: expect.stringMatching(/claim_id is required/) });
    mocks.listInstancesForMapping.mockResolvedValue([]);
    mocks.getClaimSourceMap.mockResolvedValue({ map: null, readings: {}, edges: [], source_relationships: [] });
    const ok = JSON.parse(await executeGetMap({ claim_id: CLAIM }, { role: "audit-agent" }));
    expect(ok.success).toBe(true);
  });
});

describe("provenance_read_source", () => {
  it("passes the window through and says how to continue", async () => {
    mocks.readSourceContent.mockResolvedValue({
      source: { id: "s1" }, origin: "stored", total_chars: 100, offset: 0, content: "x".repeat(40), truncated: true,
    });
    const out = JSON.parse(await executeReadSource({ source_id: "s1", offset: 0, max_chars: 40 }, steward));
    expect(mocks.readSourceContent).toHaveBeenCalledWith({ sourceId: "s1", url: undefined, offset: 0, maxChars: 40 });
    expect(out.success).toBe(true);
    expect(out.note).toMatch(/offset 40/);
    const refused = JSON.parse(await executeReadSource({}, steward));
    expect(refused.success).toBe(false);
  });

  it("turns a service refusal into a structured result rather than throwing", async () => {
    mocks.readSourceContent.mockRejectedValue(new SourceMapError("No source s9 exists."));
    const out = JSON.parse(await executeReadSource({ source_id: "s9" }, steward));
    expect(out).toEqual({ success: false, message: "No source s9 exists." });
  });
});

describe("the write tools", () => {
  it("record_reading stamps the claim, the model, and the writer, and explains the quote check", async () => {
    mocks.recordInstanceReading.mockResolvedValue({ id: "r1", quote_check: "not_found", replaced: false });
    const out = JSON.parse(
      await executeRecordReading(
        { instance_id: "i1", support: "overstates", note: "n", worth_reading: true, worth_reading_reason: "why", source_read: true },
        steward
      )
    );
    expect(mocks.recordInstanceReading).toHaveBeenCalledWith({
      claimId: CLAIM,
      instanceId: "i1",
      support: "overstates",
      deployment: null,
      note: "n",
      worthReading: true,
      worthReadingReason: "why",
      sourceRead: true,
      model: "model-x",
      createdBy: "claim_steward",
    });
    expect(out.success).toBe(true);
    expect(out.quote_check_note).toMatch(/NOT found/);
  });

  it("record_edge forwards the target by id or URL and reports whether the upstream instance was linked", async () => {
    mocks.recordProvenanceEdge.mockResolvedValue({ id: "e1", to_source_id: "s2", to_instance_id: null, replaced: false });
    const out = JSON.parse(
      await executeRecordEdge(
        {
          from_instance_id: "i1",
          to_source_url: "https://x.example/study",
          to_source_title: "Study",
          relation_type: "derives_from",
          fidelity: "strengthened",
          evidence: "p",
          reasoning: "r",
          confidence: 0.9,
          target_read: false,
        },
        steward
      )
    );
    expect(mocks.recordProvenanceEdge).toHaveBeenCalledWith({
      claimId: CLAIM,
      fromInstanceId: "i1",
      toSourceId: null,
      toSourceUrl: "https://x.example/study",
      toSourceTitle: "Study",
      relationType: "derives_from",
      fidelity: "strengthened",
      evidence: "p",
      reasoning: "r",
      confidence: 0.9,
      targetRead: false,
      createdBy: "claim_steward",
    });
    expect(out.note).toMatch(/not recorded as asserting this claim itself/);
  });

  it("record_source_relationship and write_map forward their inputs; write_map insists on a boolean material", async () => {
    mocks.recordSourceRelationship.mockResolvedValue({ id: "sr1", parent_source_id: "a", child_source_id: "b", replaced: false });
    const rel = JSON.parse(
      await executeRecordSourceRelationship(
        { parent_source_id: "a", child_source_id: "b", relation_type: "shares_authorship", reasoning: "byline" },
        steward
      )
    );
    expect(rel.success).toBe(true);
    expect(mocks.recordSourceRelationship).toHaveBeenCalledWith(
      expect.objectContaining({ relationType: "shares_authorship", confidence: null, createdBy: "claim_steward" })
    );

    const noMaterial = JSON.parse(await executeWriteMap({ summary: "s" }, steward));
    expect(noMaterial.success).toBe(false);
    expect(noMaterial.message).toMatch(/material is required/);

    mocks.writeSourceMap.mockResolvedValue({ id: "m1", sources_considered: 2, sources_read: 1, edges_recorded: 1, replaced: true });
    const written = JSON.parse(await executeWriteMap({ summary: "s", material: false }, steward));
    expect(mocks.writeSourceMap).toHaveBeenCalledWith({
      claimId: CLAIM,
      summary: "s",
      material: false,
      model: "model-x",
      mappedBy: "claim_steward",
    });
    expect(written.note).toMatch(/immaterial/);
  });

  it("refuses to write outside a claim-scoped run", async () => {
    for (const fn of [executeRecordReading, executeRecordEdge, executeWriteMap]) {
      const out = JSON.parse(await fn({ material: true }, { role: "audit-agent" }));
      expect(out.success).toBe(false);
      expect(out.message).toMatch(/no claim is in scope/);
    }
  });
});
