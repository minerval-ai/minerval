/**
 * Source facts (#507, phase 3) over real SQL: the fetcher fills each fact
 * once and never overwrites, Crossref's notices become dated source events
 * exactly once, the facts view shows versions and copies the right way
 * round, and the retraction join finds a source by its recorded DOI.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import {
  getSourceFacts,
  recordSourceEvent,
  refreshSourceFacts,
} from "../../src/services/source-facts-service.js";
import { sourcesForDois, type DoiCheck } from "../../src/services/source-watch-service.js";

async function seedSource(input: { url?: string; title?: string; content?: string; type?: string; publisher?: string }): Promise<string> {
  const url = input.url ?? `https://dbtest.example/${randomUUID()}`;
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content, source_type, publisher) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [url, input.title ?? url, input.content ?? null, input.type ?? "unknown", input.publisher ?? null]
  );
  return rows[0]!.id;
}

function work(doi: string, over: Partial<DoiCheck> = {}): DoiCheck {
  return {
    doi, found: true, title: "Registered title", type: "dataset", published: "2021-06",
    cited_by: 3, authors: ["Jane Smith"], publisher: "Registry Press", container: null,
    updates: [], updates_to: [], ...over,
  };
}

describe("refreshSourceFacts", () => {
  it("fills facts from Crossref over the page, keeps what was already set, and records notices once", async () => {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const page = `<html><head><meta name="citation_author" content="Page Author">
      <meta name="citation_doi" content="${doi}"><meta name="citation_publication_date" content="2020"></head></html>`;
    const id = await seedSource({ content: page, publisher: "Already Known" });
    const notice = `10.5555/notice-${randomUUID().slice(0, 8)}`;
    const checkDoi = async (d: string) =>
      work(d, { updates: [{ doi: notice, type: "correction", label: "Correction", updated: "2026-08-12T00:00:00Z", source: "publisher" }] });

    const first = await refreshSourceFacts(id, { checkDoi, archive: false });
    expect(first.doi).toBe(doi);
    expect(first.filled.sort()).toEqual(["authors", "doi", "published_date", "source_type", "title"].sort());
    expect(first.events_recorded).toBe(1);

    const facts = (await getSourceFacts(id))!;
    expect(facts.source).toMatchObject({
      title: "Registered title",
      authors: ["Jane Smith"],
      publisher: "Already Known",
      published_date: "2021-06",
      doi,
      source_type: "dataset",
    });
    expect(facts.source.facts_checked_at).not.toBeNull();
    expect(facts.events).toEqual([
      expect.objectContaining({ kind: "correction", notice_url: `https://doi.org/${notice}`, detected_by: "facts_fetch" }),
    ]);

    // A second pass with different answers changes nothing and records nothing new.
    const again = await refreshSourceFacts(id, {
      checkDoi: async (d) => work(d, { authors: ["Someone Else"], type: "journal-article", published: "1999" }),
      archive: false,
    });
    expect(again.filled).toEqual([]);
    expect((await getSourceFacts(id))!.source).toMatchObject({ authors: ["Jane Smith"], source_type: "dataset", published_date: "2021-06" });
  });

  it("works from the page alone when there is no DOI, and finds an archived copy", async () => {
    const id = await seedSource({
      title: "Given title",
      content: `<html><head><meta property="og:site_name" content="Daily Paper"><meta name="author" content="A Reporter"></head></html>`,
    });
    const result = await refreshSourceFacts(id, {
      fetch: async () => JSON.stringify({ archived_snapshots: { closest: { available: true, status: "200", url: "http://web.archive.org/web/1/x" } } }),
    });
    expect(result.doi).toBeNull();
    const facts = (await getSourceFacts(id))!;
    expect(facts.source).toMatchObject({
      title: "Given title", publisher: "Daily Paper", authors: ["A Reporter"],
      archived_url: "https://web.archive.org/web/1/x", source_type: "unknown",
    });
  });
});

describe("recordSourceEvent and getSourceFacts", () => {
  it("records an event once per kind and notice, and shows versions and copies the right way round", async () => {
    const paper = await seedSource({ title: "Paper" });
    const preprint = await seedSource({ title: "Preprint" });
    const mirror = await seedSource({ title: "Mirror" });
    await rawQuery(
      `INSERT INTO source_relationships (parent_source_id, child_source_id, relation_type, reasoning)
       VALUES ($1, $2, 'version_of', 'r'), ($1, $3, 'republishes', 'r')`,
      [paper, preprint, mirror]
    );
    const event = { sourceId: paper, kind: "retraction", occurredAt: "2026-09-01T00:00:00Z", noticeUrl: "https://doi.org/10.1/n", detectedBy: "crossref_poll" };
    expect(await recordSourceEvent(event)).toEqual({ recorded: true });
    expect(await recordSourceEvent(event)).toEqual({ recorded: false });
    await expect(recordSourceEvent({ ...event, kind: "verdict" })).rejects.toThrow(/Unknown source event kind/);

    const p = (await getSourceFacts(paper))!;
    expect(p.versions).toEqual([{ id: preprint, title: "Preprint", url: expect.any(String), later: false }]);
    expect(p.copies.map((c) => c.id)).toEqual([mirror]);
    expect(p.events).toHaveLength(1);
    const pre = (await getSourceFacts(preprint))!;
    expect(pre.versions[0]).toMatchObject({ id: paper, later: true });
    expect((await getSourceFacts(mirror))!.copy_of.map((c) => c.id)).toEqual([paper]);
    expect(await getSourceFacts(randomUUID())).toBeNull();
  });
});

describe("sourcesForDois", () => {
  it("finds a source by its recorded DOI when its URL does not carry one", async () => {
    const doi = `10.5555/${randomUUID().slice(0, 8)}`;
    const id = await seedSource({ url: `https://publisher.example/article/${randomUUID()}` });
    await rawQuery(`UPDATE sources SET doi = $2 WHERE id = $1`, [id, doi]);
    const [m] = await sourcesForDois([doi]);
    expect(m!.source_id).toBe(id);
  });
});
