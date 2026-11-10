/**
 * The source backfill (#507) over real SQL: one pass, in id order, over the
 * sources missing facts or (with text) segments; each source filled once
 * and anchored; a batch claimed by moving the cursor, so a second claim
 * takes the next sources, not the same ones; a source that yields nothing
 * passed over rather than retaken; and a finished pass marked done.
 *
 * The facts fetch is stubbed (it calls Crossref and the Wayback Machine);
 * segmentation and anchoring run for real.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";

vi.mock("../../src/services/source-facts-service.js", async () => {
  const { rawQuery } = await import("../../src/db/client.js");
  return {
    refreshSourceFactsOnce: vi.fn(async (id: string) => {
      await rawQuery(`UPDATE sources SET facts_checked_at = now() WHERE id = $1 AND facts_checked_at IS NULL`, [id]);
    }),
  };
});
vi.mock("../../src/config.js", async (orig) => {
  const actual = await orig<typeof import("../../src/config.js")>();
  return { ...actual, loadConfig: () => ({ ...actual.loadConfig(), sourceBackfillPerTick: 500 }) };
});

import { rawQuery } from "../../src/db/client.js";
import { seedClaim } from "./helpers.js";
import { refreshSourceFactsOnce } from "../../src/services/source-facts-service.js";
import {
  SOURCE_BACKFILL_FLAG,
  claimSourceBatch,
  sourceBackfillTick,
} from "../../src/workers/source-backfill.js";

const HTML = `<html><body><h1>Night work and diabetes</h1>
  <p>Shift workers have long been suspected of higher metabolic risk.</p>
  <h2>Results</h2><p>Rotating night work was associated with a 1.4-fold higher risk.</p></body></html>`;

async function seedSource(content: string | null, factsChecked = false): Promise<string> {
  const rows = await rawQuery<{ id: string }>(
    `INSERT INTO sources (url, title, raw_content, facts_checked_at)
     VALUES ($1, 'Paper', $2, ${factsChecked ? "now()" : "NULL"}) RETURNING id`,
    [`https://dbtest.example/${randomUUID()}`, content]
  );
  return rows[0]!.id;
}

async function mark(): Promise<{ after: string | null; done: boolean } | null> {
  const [row] = await rawQuery<{ value: { after: string | null; done: boolean } }>(
    `SELECT value FROM platform_flags WHERE key = $1`,
    [SOURCE_BACKFILL_FLAG]
  );
  return row?.value ?? null;
}

beforeEach(async () => {
  await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_BACKFILL_FLAG]);
  vi.mocked(refreshSourceFactsOnce).mockClear();
});

describe("source backfill", () => {
  it("fills facts and segments once, anchors instances, passes over what yields nothing, and finishes", async () => {
    const legacy = await seedSource(HTML);
    const claim = await seedClaim("night work raises diabetes risk");
    const [inst] = await rawQuery<{ id: string }>(
      `INSERT INTO claim_instances (claim_id, source_id, verbatim_text)
       VALUES ($1, $2, 'Rotating night work was associated with a 1.4-fold higher risk') RETURNING id`,
      [claim, legacy]
    );
    const textless = await seedSource(null);
    const empty = await seedSource("<html><body>   </body></html>", true);
    const done = await seedSource(HTML, true);
    await sourceBackfillTick(); // segments `done` too: it has text but no segments
    const doneSegs = await rawQuery(`SELECT id FROM source_segments WHERE source_id = $1`, [done]);

    // Start a fresh pass over what is left.
    await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_BACKFILL_FLAG]);
    vi.mocked(refreshSourceFactsOnce).mockClear();
    const again = await sourceBackfillTick();

    const facts = await rawQuery<{ id: string; facts_checked_at: Date | null }>(
      `SELECT id, facts_checked_at FROM sources WHERE id = ANY($1::uuid[])`,
      [[legacy, textless]]
    );
    expect(facts.every((f) => f.facts_checked_at !== null)).toBe(true);
    const [seg] = await rawQuery<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM source_segments WHERE source_id = $1`,
      [legacy]
    );
    expect(seg!.n).toBeGreaterThan(0);
    const [anchored] = await rawQuery<{ segment_id: string | null }>(
      `SELECT segment_id FROM claim_instances WHERE id = $1`,
      [inst!.id]
    );
    expect(anchored!.segment_id).not.toBeNull();

    // The second pass retakes only the page with no passages, once, and
    // leaves the already-segmented source's segments as they were.
    const retaken = vi.mocked(refreshSourceFactsOnce).mock.calls.map((c) => c[0]);
    expect(retaken).toContain(empty);
    expect(retaken).not.toContain(legacy);
    expect(again.done).toBe(true);
    expect(await mark()).toMatchObject({ done: true });
    expect(
      (await rawQuery(`SELECT id FROM source_segments WHERE source_id = $1`, [done])).map((r: any) => r.id).sort()
    ).toEqual(doneSegs.map((r: any) => r.id).sort());

    // A finished pass takes nothing more.
    expect(await sourceBackfillTick()).toEqual({ taken: 0, facts: 0, segmented: 0, done: true });
  });

  it("claims each batch by moving the cursor, so a second claim takes the next sources", async () => {
    await seedSource(null);
    await seedSource(null);
    await seedSource(null);
    const first = await claimSourceBatch(1);
    const second = await claimSourceBatch(1);
    expect(first.ids).toHaveLength(1);
    expect(second.ids).toHaveLength(1);
    expect(second.ids[0]! > first.ids[0]!).toBe(true);
    expect((await mark())!.after).toBe(second.ids[0]);

    // Concurrent claims never overlap.
    await rawQuery(`DELETE FROM platform_flags WHERE key = $1`, [SOURCE_BACKFILL_FLAG]);
    const [a, b] = await Promise.all([claimSourceBatch(2), claimSourceBatch(2)]);
    expect(a.ids.filter((id) => b.ids.includes(id))).toEqual([]);
  });
});
