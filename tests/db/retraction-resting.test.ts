/**
 * Retraction propagation (#507, #286's retraction payoff) over real SQL: a
 * watched source reaches the claims that assert it directly (active ones
 * only), and, through claimsRestingOnSources, the claims whose recorded
 * provenance runs through its work — a source drawing on it by an edge,
 * or an instance on a republished copy or another version of it.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { claimsRestingOnSources, sourcesForDois } from "../../src/services/source-watch-service.js";

async function seedSource(title: string, url?: string): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title) VALUES ($1, $2) RETURNING id`,
    [url ?? `https://dbtest.example/${randomUUID()}`, title]
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

async function edge(fromInstance: string, toSource: string, relation: string): Promise<void> {
  await rawQuery(
    `INSERT INTO claim_provenance_edges (from_instance_id, to_source_id, relation_type, evidence, reasoning)
     VALUES ($1, $2, $3, 'passage', 'why')`,
    [fromInstance, toSource, relation]
  );
}

async function relate(parent: string, child: string, relation: string): Promise<void> {
  await rawQuery(
    `INSERT INTO source_relationships (parent_source_id, child_source_id, relation_type, reasoning)
     VALUES ($1, $2, $3, 'why')`,
    [parent, child, relation]
  );
}

describe("sourcesForDois", () => {
  it("lists only active claims among those asserting the source", async () => {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const paper = await seedSource("Paper", `https://doi.org/${doi}`);
    const live = await seedClaim("live");
    const retired = await seedClaim("retired");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [retired]);
    await seedInstance(live, paper);
    await seedInstance(retired, paper);

    const [m] = await sourcesForDois([doi]);
    expect(m!.source_id).toBe(paper);
    expect(m!.claim_ids).toEqual([live]);
  });
});

describe("claimsRestingOnSources", () => {
  it("follows edges, copies and versions to the claims resting on a work, and leaves out direct assertions", async () => {
    const paper = await seedSource("Paper");
    const preprint = await seedSource("Preprint");
    const mirror = await seedSource("Mirror");
    const news = await seedSource("News");
    const unrelated = await seedSource("Unrelated");
    await relate(paper, preprint, "version_of"); // paper is the later version
    await relate(paper, mirror, "republishes"); // mirror is a copy of paper

    const direct = await seedClaim("direct"); // asserts the paper itself
    const viaEdge = await seedClaim("edge"); // a news story drawing on the paper
    const viaPreprintEdge = await seedClaim("preprint-edge"); // draws on the earlier version
    const viaCopy = await seedClaim("copy"); // asserts the mirror
    const bystander = await seedClaim("bystander"); // draws on something else
    const retired = await seedClaim("retired"); // draws on the paper, but merged

    await seedInstance(direct, paper);
    await edge(await seedInstance(viaEdge, news), paper, "repeats");
    await edge(await seedInstance(viaPreprintEdge, news), preprint, "cites_as_evidence");
    await seedInstance(viaCopy, mirror);
    await edge(await seedInstance(bystander, news), unrelated, "repeats");
    await edge(await seedInstance(retired, news), paper, "repeats");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [retired]);
    // A claim that asserts the paper AND draws on it is a direct hit only.
    await edge(await seedInstance(direct, news), paper, "repeats");

    const rows = await claimsRestingOnSources([paper]);
    const byClaim = new Map(rows.map((r) => [r.claim_id, r]));
    expect([...byClaim.keys()].sort()).toEqual([viaEdge, viaPreprintEdge, viaCopy].sort());
    expect(byClaim.get(viaEdge)).toMatchObject({
      source_id: paper, via: "draws_on", through_source_id: news,
      through_source_title: "News", relation_type: "repeats",
    });
    expect(byClaim.get(viaPreprintEdge)).toMatchObject({ via: "draws_on", relation_type: "cites_as_evidence" });
    expect(byClaim.get(viaCopy)).toMatchObject({ via: "copy_or_version", through_source_id: mirror, relation_type: null });
  });

  it("does not run backwards from a copy to the original", async () => {
    const original = await seedSource("Original");
    const copy = await seedSource("Copy");
    await relate(original, copy, "republishes");
    const onOriginal = await seedClaim("orig");
    await seedInstance(onOriginal, original);
    // A notice against the copy says nothing about the original's text.
    expect(await claimsRestingOnSources([copy])).toEqual([]);
  });

  it("ignores ids that are not uuids", async () => {
    expect(await claimsRestingOnSources(["not-a-uuid"])).toEqual([]);
  });
});
