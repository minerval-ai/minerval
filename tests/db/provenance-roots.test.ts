/**
 * Origins (#507) over real SQL: the Steward's root rows, the guard that a
 * root must be a place in the claim's map, and the story loader reading
 * instances, edges, copies, and roots together.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { SourceMapError, recordProvenanceRoot } from "../../src/services/source-map-service.js";
import { getProvenanceStory } from "../../src/services/provenance-story-service.js";

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

async function edge(fromInstance: string, toSource: string, relation: string, fidelity = "faithful"): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, fidelity, evidence, reasoning)
     VALUES ($1, $2, $3, $4, 'passage', 'why')`,
    [fromInstance, toSource, relation, fidelity]
  );
}

describe("recordProvenanceRoot", () => {
  it("records an origin on an underlying source, replaces it in place, and reports an upstream edge", async () => {
    const claim = await seedClaim("roots");
    const transcript = await seedSource("Council meeting video");
    const paper = await seedSource("Local paper");
    const paperInstance = await seedInstance(claim, paper);
    await edge(paperInstance, transcript, "derives_from");

    const first = await recordProvenanceRoot({
      claimId: claim, sourceId: transcript, status: "origin", basis: "The remark was made at the meeting.", createdBy: "claim_steward",
    });
    expect(first).toMatchObject({ source_id: transcript, status: "origin", has_upstream: false, replaced: false });

    const again = await recordProvenanceRoot({
      claimId: claim, sourceId: transcript, status: "untraced", basis: "The video is an edited cut.", createdBy: "claim_steward",
    });
    expect(again).toMatchObject({ id: first.id, status: "untraced", replaced: true });

    const onPaper = await recordProvenanceRoot({
      claimId: claim, sourceId: paper, status: "origin", basis: "b", createdBy: "claim_steward",
    });
    expect(onPaper.has_upstream).toBe(true);

    const rows = await rawQuery<{ n: string }>(`SELECT COUNT(*) AS n FROM claim_provenance_roots WHERE claim_id = $1`, [claim]);
    expect(Number(rows[0]!.n)).toBe(2);
  });

  it("refuses a source outside the claim's map, a bad status, and an empty basis", async () => {
    const claim = await seedClaim("roots-refuse");
    const stranger = await seedSource("Unrelated");
    const own = await seedSource("Own");
    await seedInstance(claim, own);
    const base = { claimId: claim, sourceId: own, status: "origin", basis: "b", createdBy: "claim_steward" };
    await expect(recordProvenanceRoot({ ...base, sourceId: stranger })).rejects.toThrow(SourceMapError);
    await expect(recordProvenanceRoot({ ...base, status: "primary" })).rejects.toThrow(/status must be one of/);
    await expect(recordProvenanceRoot({ ...base, basis: "  " })).rejects.toThrow(/basis is required/);
  });
});

describe("getProvenanceStory", () => {
  it("reads instances, edges, copies, and roots into the origins-first story", async () => {
    const claim = await seedClaim("story");
    const stats = await seedSource("Statistics release", "official_statistics");
    const report = await seedSource("Think-tank report");
    const wire = await seedSource("Wire story");
    const copy = await seedSource("Syndicated copy");
    const post = await seedSource("A post");
    const elsewhere = await seedSource("Copy outside the claim");

    await edge(await seedInstance(claim, report), stats, "derives_from", "distorted");
    await edge(await seedInstance(claim, wire), report, "repeats");
    await seedInstance(claim, copy);
    await seedInstance(claim, post);
    await rawQuery(
      `INSERT INTO source_relationships (parent_source_id, child_source_id, relation_type, reasoning)
       VALUES ($1, $2, 'republishes', 'masthead'), ($1, $3, 'republishes', 'masthead')`,
      [wire, copy, elsewhere]
    );
    await recordProvenanceRoot({
      claimId: claim, sourceId: post, status: "untraced", basis: "The post cites nothing.", createdBy: "claim_steward",
    });

    const s = await getProvenanceStory(claim);
    expect(s.nodes.map((n) => n.source.title)).toEqual([
      "Statistics release", "A post", "Think-tank report", "Wire story", "Syndicated copy",
    ]);
    const n = new Map(s.nodes.map((x) => [x.source.title, x]));
    expect(n.get("Statistics release")).toMatchObject({
      standing: "origin", basis: "primary_source_kind", underlying: true, depth: 0, downstream_total: 3,
    });
    expect(n.get("A post")).toMatchObject({ standing: "untraced", basis: "steward", root: { basis: "The post cites nothing." } });
    expect(n.get("Think-tank report")).toMatchObject({ depth: 1, diverges: true });
    expect(n.get("Wire story")).toMatchObject({ depth: 2, copies: 2, downstream: 1 });
    expect(n.get("Syndicated copy")).toMatchObject({ standing: "derived", copy_of: [wire], depth: 3 });
    expect(s.counts).toEqual({ sources: 5, origins: 1, untraced: 1, derived: 3, underlying: 1 });
  });

  it("is empty for a claim with no instances", async () => {
    const claim = await seedClaim("story-empty");
    expect((await getProvenanceStory(claim)).nodes).toEqual([]);
  });
});
