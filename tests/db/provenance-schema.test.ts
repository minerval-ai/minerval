/**
 * The source provenance schema (#286), exercised against a database migrated
 * from zero: the four tables exist with the backstops the design relies on
 * (one reading per instance, one edge per instance-source-relation, one map
 * per claim, no self-relation between sources, a located passage on every
 * edge), the rows follow their instance through a merge-style reassignment
 * rather than keeping a stale claim of their own, and the service's writes
 * and reads run end to end over real SQL.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim, pgCode } from "./helpers.js";
import {
  getClaimSourceMap,
  listInstancesForMapping,
  readSourceContent,
  recordInstanceReading,
  recordProvenanceEdge,
  recordSourceRelationship,
  writeSourceMap,
} from "../../src/services/source-map-service.js";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const NOT_NULL_VIOLATION = "23502";

async function seedSource(input: { title: string; content?: string | null }): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content) VALUES ($1, $2, $3) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, input.title, input.content ?? null]
  );
  return rows[0]!.id;
}

async function seedInstance(input: { claimId: string; sourceId: string; text: string }): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, original_text) VALUES ($1, $2, $3) RETURNING id`,
    [input.claimId, input.sourceId, input.text]
  );
  return rows[0]!.id;
}

describe("provenance tables", () => {
  it("exist with the columns the service writes", async () => {
    const cols = await rawQuery<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_name IN ('claim_provenance_edges', 'source_relationships',
                             'claim_instance_readings', 'claim_source_maps')`
    );
    const byTable = new Map<string, Set<string>>();
    for (const c of cols) {
      if (!byTable.has(c.table_name)) byTable.set(c.table_name, new Set());
      byTable.get(c.table_name)!.add(c.column_name);
    }
    expect([...byTable.keys()].sort()).toEqual([
      "claim_instance_readings",
      "claim_provenance_edges",
      "claim_source_maps",
      "source_relationships",
    ]);
    // The claim is reached through the instance, never denormalized.
    expect(byTable.get("claim_provenance_edges")!.has("claim_id")).toBe(false);
    expect(byTable.get("claim_instance_readings")!.has("claim_id")).toBe(false);
    for (const c of ["from_instance_id", "to_source_id", "to_instance_id", "relation_type", "fidelity",
      "evidence", "reasoning", "confidence", "target_read", "created_by"]) {
      expect(byTable.get("claim_provenance_edges")!.has(c)).toBe(true);
    }
    for (const c of ["instance_id", "support", "deployment", "note", "quote_check", "worth_reading",
      "worth_reading_reason", "source_read", "model", "created_by"]) {
      expect(byTable.get("claim_instance_readings")!.has(c)).toBe(true);
    }
  });

  it("hold their backstops: evidence required, one edge per key, no self-relation, one map per claim", async () => {
    const claimId = await seedClaim("prov");
    const a = await seedSource({ title: "A" });
    const b = await seedSource({ title: "B" });
    const inst = await seedInstance({ claimId, sourceId: a, text: "x" });

    await expect(
      rawQuery(
        `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, reasoning)
         VALUES ($1, $2, 'repeats', 'r')`,
        [inst, b]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === NOT_NULL_VIOLATION);

    await rawQuery(
      `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, evidence, reasoning)
       VALUES ($1, $2, 'repeats', 'p', 'r')`,
      [inst, b]
    );
    await expect(
      rawQuery(
        `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, evidence, reasoning)
         VALUES ($1, $2, 'repeats', 'p2', 'r2')`,
        [inst, b]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);

    await expect(
      rawQuery(
        `INSERT INTO source_relationships (parent_source_id, child_source_id, relation_type, reasoning)
         VALUES ($1, $1, 'republishes', 'r')`,
        [a]
      )
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === CHECK_VIOLATION);

    await rawQuery(`INSERT INTO claim_source_maps (claim_id, summary) VALUES ($1, 's')`, [claimId]);
    await expect(
      rawQuery(`INSERT INTO claim_source_maps (claim_id, summary) VALUES ($1, 's2')`, [claimId])
    ).rejects.toSatisfy((e: unknown) => pgCode(e) === UNIQUE_VIOLATION);
  });

  it("follow their instance to another claim, and die with it", async () => {
    const claimA = await seedClaim("prov-a");
    const claimB = await seedClaim("prov-b");
    const a = await seedSource({ title: "A", content: "The passage is here." });
    const b = await seedSource({ title: "B" });
    const inst = await seedInstance({ claimId: claimA, sourceId: a, text: "The passage is here." });

    await recordInstanceReading({
      claimId: claimA, instanceId: inst, support: "supports", sourceRead: true, createdBy: "claim_steward",
    });
    await recordProvenanceEdge({
      claimId: claimA, fromInstanceId: inst, toSourceId: b, relationType: "derives_from",
      fidelity: "faithful", evidence: "p", reasoning: "r", targetRead: true, createdBy: "claim_steward",
    });
    expect((await getClaimSourceMap(claimA)).edges).toHaveLength(1);
    expect((await getClaimSourceMap(claimB)).edges).toHaveLength(0);

    // A split or merge moves the instance; the reading and edge go with it.
    await rawQuery(`UPDATE claim_instances SET claim_id = $1 WHERE id = $2`, [claimB, inst]);
    const movedFrom = await getClaimSourceMap(claimA);
    const movedTo = await getClaimSourceMap(claimB);
    expect(movedFrom.edges).toHaveLength(0);
    expect(Object.keys(movedFrom.readings)).toEqual([]);
    expect(movedTo.edges).toHaveLength(1);
    expect(movedTo.readings[inst]?.support).toBe("supports");

    await rawQuery(`DELETE FROM claim_instances WHERE id = $1`, [inst]);
    const [edges] = await rawQuery<{ n: string }>(
      `SELECT COUNT(*) AS n FROM claim_provenance_edges WHERE from_instance_id = $1`,
      [inst]
    );
    expect(Number(edges!.n)).toBe(0);
  });
});

describe("the service over real SQL", () => {
  it("records readings with a mechanical quote check, edges with a found upstream instance, and a map with derived counts", async () => {
    const claimId = await seedClaim("prov-svc");
    const study = await seedSource({
      title: "The study",
      content: "<html><body><p>Cases rose 12 percent in the treated group.</p></body></html>",
    });
    const report = await seedSource({
      title: "The report",
      content: "<p>A new study found cases rose 12 percent. Officials said more.</p>",
    });
    const studyInst = await seedInstance({ claimId, sourceId: study, text: "Cases rose 12 percent in the treated group." });
    const reportInst = await seedInstance({ claimId, sourceId: report, text: "cases rose 12 per cent" });

    const r1 = await recordInstanceReading({
      claimId, instanceId: studyInst, support: "supports", sourceRead: true, createdBy: "claim_steward",
    });
    expect(r1.quote_check).toBe("verbatim");
    const r2 = await recordInstanceReading({
      claimId, instanceId: reportInst, support: "asserts_without_evidence", sourceRead: true,
      note: "The report restates the study's figure.", createdBy: "claim_steward",
    });
    expect(r2.quote_check).toBe("not_found");
    // Replacing a reading keeps one row per instance.
    const r2b = await recordInstanceReading({
      claimId, instanceId: reportInst, support: "unclear", sourceRead: false, createdBy: "claim_steward",
    });
    expect(r2b.replaced).toBe(true);
    expect(r2b.id).toBe(r2.id);

    const edge = await recordProvenanceEdge({
      claimId, fromInstanceId: reportInst, toSourceId: study, relationType: "derives_from",
      fidelity: "faithful", evidence: "A new study found cases rose 12 percent.", reasoning: "Names the study.",
      confidence: 0.9, targetRead: true, createdBy: "claim_steward",
    });
    expect(edge.to_instance_id).toBe(studyInst);

    const rel = await recordSourceRelationship({
      parentSourceId: report, childSourceId: study, relationType: "shares_authorship",
      reasoning: "Same byline.", createdBy: "claim_steward",
    });
    expect(rel.parent_source_id < rel.child_source_id).toBe(true);

    const map = await writeSourceMap({
      claimId, summary: "Both appearances rest on one study; the report adds nothing of its own.",
      material: true, mappedBy: "claim_steward",
    });
    expect(map).toMatchObject({ sources_considered: 2, sources_read: 1, edges_recorded: 1, replaced: false });

    const full = await getClaimSourceMap(claimId);
    expect(full.map?.material).toBe(true);
    expect(full.map?.sources_read).toBe(1);
    expect(full.edges[0]).toMatchObject({
      from_instance_id: reportInst,
      to_source: { id: study, title: "The study" },
      to_instance_id: studyInst,
      relation_type: "derives_from",
      fidelity: "faithful",
      target_read: true,
    });
    expect(full.source_relationships).toHaveLength(1);
    expect(full.readings[studyInst]?.quote_check).toBe("verbatim");

    const listed = await listInstancesForMapping(claimId);
    expect(listed.map((i) => i.source.has_stored_text)).toEqual([true, true]);

    const read = await readSourceContent({ sourceId: study });
    expect(read.origin).toBe("stored");
    expect(read.content).toBe("Cases rose 12 percent in the treated group.");
  });
});
