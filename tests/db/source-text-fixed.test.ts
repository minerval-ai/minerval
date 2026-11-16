/**
 * A source's stored text is fixed once stored (#547; constitution §9: "A
 * source is whatever the admin read, fixed as it was when it was read").
 * The application only ever fills text where none is held; the database
 * refuses other text in its place (`minerval_source_text_fixed`, MVL08), so
 * that what a judgment or a shown page's fingerprint rests on cannot be
 * swapped under it. Against a database with the wall up, so that a source
 * at a private label is covered as well as a public one.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { C, sqlState, caught, system, unwall, wall } from "./review-3-common.js";

const TEXT = "Run 4471, October. Of 500 transcripts, 0 were flagged by the monitor. Threshold: 0.8.";
const id: Record<string, string> = {};

async function source(label: string, url: string, text: string): Promise<string> {
  const [row] = await system(() =>
    rawQuery<{ id: string }>(
      `INSERT INTO sources (url, title, raw_content, content_hash, page_url_hash, facts_checked_at, sensitivity_label)
       VALUES ($1, 'A document', $2, $3, '', now(), $4) RETURNING id`,
      [url, text, `hash-${randomUUID()}`, label]
    )
  );
  return row!.id;
}

beforeAll(async () => {
  await wall();
  id.atC = await source(C, `fileset:october/${randomUUID()}.txt`, TEXT);
  id.atPublic = await source("public", `https://example.org/${randomUUID()}`, "What a public page says, which every reader reads.");
}, 180_000);

afterAll(async () => {
  await system(() => rawQuery(`DELETE FROM sources WHERE id = ANY($1::uuid[])`, [[id.atC, id.atPublic]])).catch((err: unknown) =>
    console.warn("[source-text-fixed] cleanup:", err instanceof Error ? err.message : err)
  );
  await unwall();
}, 180_000);

describe("a source's stored text (#547)", () => {
  it("is fixed once stored: other text is refused, on a private source and on a public one", async () => {
    for (const sourceId of [id.atC!, id.atPublic!]) {
      const err = await caught(() =>
        system(() => rawQuery(`UPDATE sources SET raw_content = 'Other text, put in its place.' WHERE id = $1`, [sourceId]))
      );
      expect(sqlState(err)).toBe("MVL08");
    }
    const [row] = await system(() => rawQuery<{ raw_content: string }>(`SELECT raw_content FROM sources WHERE id = $1`, [id.atC]));
    expect(row!.raw_content).toBe(TEXT);
  });

  it("is still filled where none is held, and the same text written again changes nothing", async () => {
    const [stub] = await system(() =>
      rawQuery<{ id: string }>(`INSERT INTO sources (url, title, sensitivity_label) VALUES ($1, 'Not yet read', 'public') RETURNING id`, [
        `https://example.org/${randomUUID()}`,
      ])
    );
    await system(() => rawQuery(`UPDATE sources SET raw_content = 'First text.', content_hash = 'h1' WHERE id = $1`, [stub!.id]));
    await system(() => rawQuery(`UPDATE sources SET raw_content = 'First text.' WHERE id = $1`, [stub!.id]));
    // A document found unreadable has its text cleared, and what is fetched afterwards is stored.
    await system(() => rawQuery(`UPDATE sources SET raw_content = NULL, content_hash = NULL WHERE id = $1`, [stub!.id]));
    await system(() => rawQuery(`UPDATE sources SET raw_content = 'The document itself.', content_hash = 'h2' WHERE id = $1`, [stub!.id]));
    await system(() => rawQuery(`DELETE FROM sources WHERE id = $1`, [stub!.id]));
  });
});
