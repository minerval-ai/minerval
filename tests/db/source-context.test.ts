/**
 * A source across the graph (#507) over real SQL: lineage aggregates edges
 * by document and claim in both directions, prominence counts copies,
 * standing in each claim's story and what Stewards found, and history is a
 * dated log in which a re-reading does not erase the earlier one.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { recordInstanceReading, recordProvenanceRoot } from "../../src/services/source-map-service.js";
import { getSourceContext } from "../../src/services/source-context-service.js";

async function seedSource(title: string, sourceType = "unknown"): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, source_type) VALUES ($1, $2, $3) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, title, sourceType]
  );
  return rows[0]!.id;
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'x') RETURNING id`,
    [claimId, sourceId]
  );
  return rows[0]!.id;
}

async function edge(fromInstance: string, toSource: string, relation: string, fidelity: string): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, fidelity, evidence, reasoning)
     VALUES ($1, $2, $3, $4, 'passage', 'why')`,
    [fromInstance, toSource, relation, fidelity]
  );
}

describe("getSourceContext", () => {
  it("reads lineage, prominence, and history for a report across two claims", async () => {
    const stats = await seedSource("Statistics release", "official_statistics");
    const report = await seedSource("Think-tank report", "report");
    const wire = await seedSource("Wire story", "news");
    const copy = await seedSource("Syndicated copy", "news");
    const copyOfCopy = await seedSource("Copy of the copy", "news");
    const half = await seedClaim("half of new jobs are part-time");
    const prefer = await seedClaim("most part-time workers want full-time hours");

    const reportOnHalf = await seedInstance(half, report);
    const reportOnPrefer = await seedInstance(prefer, report);
    await edge(reportOnHalf, stats, "derives_from", "distorted");
    await edge(reportOnPrefer, stats, "cites_as_evidence", "faithful");
    await edge(await seedInstance(half, wire), report, "repeats", "faithful");
    await rawQuery(
      `INSERT INTO source_relationships (parent_source_id, child_source_id, relation_type, reasoning)
       VALUES ($1, $2, 'republishes', 'm'), ($2, $3, 'republishes', 'm')`,
      [report, copy, copyOfCopy]
    );
    await recordProvenanceRoot({ claimId: prefer, sourceId: report, status: "origin", basis: "First statement of it.", createdBy: "claim_steward" });

    await recordInstanceReading({
      claimId: half, instanceId: reportOnHalf, support: "supports", note: "Reads as sound.", sourceRead: false, createdBy: "claim_steward",
    });
    await recordInstanceReading({
      claimId: half, instanceId: reportOnHalf, support: "overstates", note: "Its own figure is 38 percent.", sourceRead: true, createdBy: "claim_steward",
    });

    const ctx = (await getSourceContext(report))!;

    // Lineage: one upstream document on two claims, divergent on one; one downstream.
    expect(ctx.lineage.draws_on.total).toBe(1);
    expect(ctx.lineage.draws_on.entries[0]).toMatchObject({
      source: { id: stats, source_type: "official_statistics" }, claims: 2, diverges: true,
    });
    expect(ctx.lineage.draws_on.entries[0]!.relations).toEqual(
      expect.arrayContaining([
        { relation_type: "derives_from", fidelity: "distorted", claims: 1 },
        { relation_type: "cites_as_evidence", fidelity: "faithful", claims: 1 },
      ])
    );
    expect(ctx.lineage.drawn_on_by.entries.map((e) => e.source.id)).toEqual([wire]);

    // Prominence: two copies (one direct), origin on one claim by the Steward's say-so.
    expect(ctx.prominence.reach).toEqual({ copies: 2, direct_copies: 1 });
    expect(ctx.prominence.structure).toMatchObject({
      claims: 2, claims_read: 2, origin_on: 1, origin_by_steward: 1, underlying_on: 0,
    });
    expect(ctx.prominence.structure.downstream).toBeGreaterThanOrEqual(1);
    expect(ctx.prominence.evidence.readings_by_support).toEqual({ overstates: 1 });
    expect(ctx.prominence.evidence.read_whole).toBe(1);
    expect(ctx.prominence.evidence.notes).toEqual([
      expect.objectContaining({ claim: expect.objectContaining({ id: half }), support: "overstates", note: "Its own figure is 38 percent." }),
    ]);

    // History: both readings, newest first, and the arrival in the graph.
    const readings = ctx.history.filter((h) => h.kind === "reading");
    expect(readings.map((r) => r.text)).toEqual(["overstates, read whole", "supports, from the excerpt"]);
    expect(ctx.history.some((h) => h.kind === "retrieved")).toBe(true);
  });

  it("is null for a source that does not exist", async () => {
    expect(await getSourceContext(randomUUID())).toBeNull();
    expect(await getSourceContext("nope")).toBeNull();
  });
});
