/**
 * Source kinds over real SQL: the column holds only the list; an agent that
 * cites a source fills its kind where none more specific is recorded and is
 * told when its kind was not taken; an agent that read the document corrects
 * it; the reading and edge tools apply that rule by whether the document was
 * opened; and a source of a primary kind then reads as an origin in the
 * claim's story, where one of unknown kind reads as untraced.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { recordSourceKind } from "../../src/services/source-service.js";
import { recordInstanceReading, recordProvenanceEdge } from "../../src/services/source-map-service.js";
import { getProvenanceStory } from "../../src/services/provenance-story-service.js";
import { SOURCE_KINDS } from "../../src/schemas/common.js";

async function seedSource(kind?: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    kind
      ? `INSERT INTO sources (url, title, source_type) VALUES ($1, 'A source', $2) RETURNING id`
      : `INSERT INTO sources (url, title) VALUES ($1, 'A source') RETURNING id`,
    kind ? [`https://dbtest.example/${randomUUID()}`, kind] : [`https://dbtest.example/${randomUUID()}`]
  );
  return row!.id;
}

async function kindOf(sourceId: string): Promise<string> {
  const [row] = await rawQuery<{ source_type: string }>(`SELECT source_type FROM sources WHERE id = $1`, [sourceId]);
  return row!.source_type;
}

async function seedInstance(claimId: string, sourceId: string): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'Prices rose 6.5 percent') RETURNING id`,
    [claimId, sourceId]
  );
  return row!.id;
}

describe("source kinds", () => {
  it("the column takes every kind on the list and nothing else", async () => {
    for (const kind of SOURCE_KINDS) expect(await kindOf(await seedSource(kind))).toBe(kind);
    expect(await kindOf(await seedSource())).toBe("unknown");
    await expect(seedSource("peer_reviewed")).rejects.toThrow(/ck_sources_source_type/);
  });

  it("a citing agent fills the kind where none more specific is recorded, and is told when it was not taken", async () => {
    const id = await seedSource();
    expect(await recordSourceKind(id, "webpage")).toEqual({ source_kind: "webpage" });
    // A specific kind replaces a generic one.
    expect(await recordSourceKind(id, "news_article")).toEqual({ source_kind: "news_article" });
    // A second citing agent's different kind is not taken, and it is told what stands and how to correct it.
    const kept = await recordSourceKind(id, "opinion");
    expect(kept.source_kind).toBe("news_article");
    expect(kept.source_kind_note).toMatch(/already recorded as "news_article"/);
    expect(kept.source_kind_note).toMatch(/provenance_record_reading/);
    expect(await kindOf(id)).toBe("news_article");
    // A generic kind never replaces a specific one, and stating the same kind is quiet.
    expect((await recordSourceKind(id, "webpage")).source_kind).toBe("news_article");
    expect(await recordSourceKind(id, "news_article")).toEqual({ source_kind: "news_article" });
  });

  it("an agent that read the document corrects the kind", async () => {
    const id = await seedSource("news_article");
    expect(await recordSourceKind(id, "press_release", { read: true })).toEqual({ source_kind: "press_release" });
    expect(await kindOf(id)).toBe("press_release");
  });

  it("a reading corrects the source's kind only when the source was read, and refuses a kind off the list", async () => {
    const claim = await seedClaim("consumer prices rose 6.5 percent in 2022");
    const source = await seedSource("blog_post");
    const instance = await seedInstance(claim, source);
    const reading = { claimId: claim, instanceId: instance, support: "supports", createdBy: "claim_steward" };

    const unread = await recordInstanceReading({ ...reading, sourceKind: "report", sourceRead: false });
    expect(unread.source_kind).toBe("blog_post");
    expect(unread.source_kind_note).toMatch(/was not taken/);

    const read = await recordInstanceReading({ ...reading, sourceKind: "report", sourceRead: true });
    expect(read).toMatchObject({ source_kind: "report" });
    expect(read.source_kind_note).toBeUndefined();
    expect(await kindOf(source)).toBe("report");

    await expect(recordInstanceReading({ ...reading, sourceKind: "government" })).rejects.toThrow(/source_kind must be one of/);
    // A reading that states no kind says nothing about it.
    expect((await recordInstanceReading(reading)).source_kind).toBeUndefined();
  });

  it("an edge names the upstream document's kind, and a primary kind makes it where the story begins", async () => {
    const claim = await seedClaim("consumer prices rose 6.5 percent over the year");
    const article = await seedSource();
    const instance = await seedInstance(claim, article);

    // Nobody has named a kind: the article is untraced.
    let story = await getProvenanceStory(claim);
    expect(story.nodes.find((n) => n.source.id === article)).toMatchObject({ standing: "untraced", basis: "none" });

    const releaseUrl = `https://dbtest.example/${randomUUID()}`;
    const edge = await recordProvenanceEdge({
      claimId: claim,
      fromInstanceId: instance,
      toSourceUrl: releaseUrl,
      toSourceTitle: "Consumer Price Index release",
      toSourceKind: "official_statistics",
      relationType: "derives_from",
      evidence: "according to figures released Thursday",
      reasoning: "The article reports the release's figure.",
      targetRead: false,
      createdBy: "claim_steward",
    });
    expect(edge.to_source_kind).toBe("official_statistics");
    expect(await kindOf(edge.to_source_id)).toBe("official_statistics");

    story = await getProvenanceStory(claim);
    expect(story.nodes.find((n) => n.source.id === edge.to_source_id)).toMatchObject({
      standing: "origin",
      basis: "primary_source_kind",
    });
    expect(story.nodes.find((n) => n.source.id === article)).toMatchObject({ standing: "derived" });
    expect(story.counts).toMatchObject({ origins: 1, untraced: 0, derived: 1 });
  });
});
