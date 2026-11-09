/**
 * What the graph recorded from a page, as the browser extension reads it,
 * against real SQL: a source is found by its page hash through the prefix
 * bucket, served with each node's state read now, and a passage that no
 * longer belongs to a live node (detached, empty, on a merged claim) is
 * neither served nor enough to list the page.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import {
  getRecordedPage,
  listRecordedHashes,
  resetRecordedPages,
} from "../../src/services/recorded-page-service.js";
import {
  fillSourcePageHashes,
  getOrCreateSource,
  pageHashOf,
} from "../../src/services/source-service.js";

async function instance(
  sourceId: string,
  claimId: string,
  text: string,
  extra: { stance?: string; detached?: boolean } = {}
): Promise<string> {
  const [row] = await rawQuery<{ id: string }>(
    `INSERT INTO claim_instances (claim_id, source_id, verbatim_text, stance, detached_at)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [claimId, sourceId, text, extra.stance ?? "affirms", extra.detached ? new Date() : null]
  );
  return row!.id;
}

describe("pages the graph recorded", () => {
  beforeEach(() => resetRecordedPages());

  it("serves a source's passages by the page's hash, however the reader arrived", async () => {
    const url = `https://www.example.org/paper/${randomUUID()}`;
    const source = await getOrCreateSource({ url, title: "A paper" });
    const assessed = await seedClaim("recorded-assessed");
    const fresh = await seedClaim("recorded-fresh");
    await rawQuery(
      `INSERT INTO assessments (claim_id, status, confidence, summary, reasoning_trace)
       VALUES ($1, 'doubtful', 0.8, 'The evidence runs against it.', 'trace')`,
      [assessed]
    );
    await instance(source.id, assessed, "The effect holds in every cohort.", { stance: "denies" });
    await instance(source.id, fresh, "Nobody has measured this before.");

    // The reader's address differs from the stored one in ways normalization drops.
    const hash = pageHashOf(`http://example.org/paper/${url.split("/").pop()}/?utm_source=feed#s2`);
    expect(hash).toBe(source.pageUrlHash);
    expect(await listRecordedHashes(hash.slice(0, 4))).toContain(hash);

    const page = await getRecordedPage(hash);
    expect(page?.total).toBe(2);
    expect(page?.sources).toEqual([
      expect.objectContaining({ id: source.id, title: "A paper", url: expect.stringContaining(`/sources/${source.id}`) }),
    ]);
    const [first, second] = page!.passages;
    expect(first).toMatchObject({
      verbatim_text: "The effect holds in every cohort.",
      stance: "denies",
      source_id: source.id,
      claim: {
        id: assessed,
        kind: "claim",
        status: "doubtful",
        summary: "The evidence runs against it.",
      },
    });
    // No assessment yet is not an assessed "unknown".
    expect(second!.claim.status).toBe("unassessed");
  });

  it("leaves out passages that no longer belong to a live node, and pages with nothing else", async () => {
    const source = await getOrCreateSource({ url: `https://example.org/gone/${randomUUID()}` });
    const live = await seedClaim("recorded-live");
    const merged = await seedClaim("recorded-merged");
    await rawQuery(`UPDATE claims SET state = 'merged' WHERE id = $1`, [merged]);
    await instance(source.id, live, "A detached passage.", { detached: true });
    await instance(source.id, live, "   ");
    await instance(source.id, merged, "A passage on a merged claim.");

    const hash = source.pageUrlHash!;
    expect(await listRecordedHashes(hash.slice(0, 4))).not.toContain(hash);
    expect(await getRecordedPage(hash)).toBeNull();

    await instance(source.id, live, "A passage that stands.");
    await instance(source.id, live, "A passage that stands.");
    expect(await listRecordedHashes(hash.slice(0, 4))).toContain(hash);
    // Recorded twice, marked once.
    expect((await getRecordedPage(hash))!.passages.map((p) => p.verbatim_text)).toEqual([
      "A passage that stands.",
    ]);
  });

  it("fills the hash of sources written without one, and marks a URL that is no page", async () => {
    const url = `https://example.org/old/${randomUUID()}`;
    const [page] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title) VALUES ($1, 'Old') RETURNING id`,
      [url]
    );
    const [notPage] = await rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title) VALUES ($1, 'A DOI') RETURNING id`,
      [`doi:10.1000/${randomUUID()}`]
    );
    expect(await fillSourcePageHashes(1)).toBeGreaterThanOrEqual(2);
    const rows = await rawQuery<{ id: string; page_url_hash: string }>(
      `SELECT id, page_url_hash FROM sources WHERE id = ANY($1::uuid[])`,
      [[page!.id, notPage!.id]]
    );
    const byId = new Map(rows.map((r) => [r.id, r.page_url_hash]));
    expect(byId.get(page!.id)).toBe(pageHashOf(url));
    expect(byId.get(notPage!.id)).toBe("");
    expect(await fillSourcePageHashes()).toBe(0);
  });
});
