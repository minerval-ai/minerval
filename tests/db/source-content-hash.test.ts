/**
 * A source's content hash (#547): written when its text is first stored,
 * the same value in code and in SQL, and carried into what a judgment
 * records it was made against.
 */
import { describe, it, expect } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { rawQuery } from "../../src/db/client.js";
import { getOrCreateSource } from "../../src/services/source-service.js";
import { fetchAndStoreSource } from "../../src/services/source-map-service.js";
import { getSourceFacts } from "../../src/services/source-facts-service.js";
import { sourceContentHash } from "../../src/services/source-content.js";
import { recordJudgmentInputs } from "../../src/services/judgment-inputs-service.js";
import { seedClaim } from "./helpers.js";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const url = () => `https://example.org/content-hash/${randomUUID()}`;
const TEXT = "A study of naïve estimators — with a ‘quoted’ line.\nSecond line: 10 µg/L.";

async function storedHash(id: string): Promise<string | null> {
  const [row] = await rawQuery<{ content_hash: string | null }>(`SELECT content_hash FROM sources WHERE id = $1`, [id]);
  return row!.content_hash;
}

describe("a source's content hash", () => {
  it("is written with the text when a source is created with it", async () => {
    const source = await getOrCreateSource({ url: url(), content: TEXT });
    expect(source.contentHash).toBe(sha(TEXT));
    expect(sourceContentHash(TEXT)).toBe(sha(TEXT));
    expect((await getSourceFacts(source.id))!.source.content_hash).toBe(sha(TEXT));
  });

  it("is null while a source holds no text, and written when the text is filled in", async () => {
    const address = url();
    const empty = await getOrCreateSource({ url: address });
    expect(empty.contentHash).toBeNull();
    const filled = await getOrCreateSource({ url: address, content: TEXT });
    expect(filled.id).toBe(empty.id);
    expect(await storedHash(empty.id)).toBe(sha(TEXT));
    // Text already stored is not replaced, so neither is its hash.
    await getOrCreateSource({ url: address, content: "a different text" });
    expect(await storedHash(empty.id)).toBe(sha(TEXT));
  });

  it("is written by a fetch that stores the text", async () => {
    const address = url();
    const source = await getOrCreateSource({ url: address });
    const raw = await fetchAndStoreSource({ id: source.id, url: address }, async () => `<p>${TEXT}</p>`);
    expect(await storedHash(source.id)).toBe(sha(raw));
  });

  it("is the value the migration's SQL computes, for text that is not ASCII", async () => {
    const source = await getOrCreateSource({ url: url(), content: TEXT });
    const [row] = await rawQuery<{ h: string }>(
      `SELECT encode(sha256(convert_to(raw_content, 'UTF8')), 'hex') AS h FROM sources WHERE id = $1`,
      [source.id]
    );
    expect(row!.h).toBe(source.contentHash);
  });

  it("lets two addresses hold the same text", async () => {
    const a = await getOrCreateSource({ url: url(), content: TEXT });
    const b = await getOrCreateSource({ url: url(), content: TEXT });
    expect(a.id).not.toBe(b.id);
    expect(b.contentHash).toBe(a.contentHash);
  });

  it("is recorded with a judgment made on the source", async () => {
    const claim = await seedClaim("content hash claim");
    const source = await getOrCreateSource({ url: url(), content: TEXT });
    await rawQuery(`INSERT INTO claim_instances (claim_id, source_id, verbatim_text) VALUES ($1, $2, 'a passage')`, [
      claim,
      source.id,
    ]);
    const [judgment] = await rawQuery<{ id: string }>(
      `INSERT INTO assessments (claim_id, status, confidence, reasoning_trace)
       VALUES ($1, 'supported', 0.7, 'dbtest') RETURNING id`,
      [claim]
    );
    await recordJudgmentInputs(rawQuery, "assessment", judgment!.id, claim);
    const [input] = await rawQuery<{ content_hash: string | null }>(
      `SELECT content_hash FROM judgment_inputs WHERE judgment_id = $1 AND input_kind = 'source'`,
      [judgment!.id]
    );
    expect(input!.content_hash).toBe(sha(TEXT));
  });
});
